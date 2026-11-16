"""내장 AI 응답 생성 작업 — 브라우저 연결과 분리한다.

이전 구현은 StreamingResponse 생성기 내에서 모델 호출·도구 실행을 직접 수행하여, 페이지 이동이나 탭 종료 시
생성기가 취소되어 답변이 중단되었다. 현재 구조:

- 생성(``_chat_event_stream``)은 분리된 asyncio 작업(run)이 완료 시까지 수행한다. 연결과 무관하다.
- 작업은 SSE 한 덩어리 단위로 Redis Stream ``ai:run:{message_id}`` 에 XADD 한다(이벤트 종류를 필터링하지 않는다 —
  신규 이벤트도 그대로 통과). 종료 시 종료 표시(``end``) 항목을 추가하고 TTL 을 설정한다.
- POST 응답·재연결(GET .../stream?after=)은 해당 스트림을 읽어 송신하는 구독자에 해당한다. 각 이벤트에
  ``id:`` (Redis stream id)를 부여하여 화면이 재개 위치를 식별한다. uvicorn 워커가 복수이므로 어느 워커에서든
  Redis 만으로 이어 받는다.
- 멈춤은 Redis 키 ``ai:run:{id}:stop`` — 작업을 보유한 워커가 짧은 주기로 확인하여 이벤트 사이에서 중지한다.
- 활성 표시 ``ai:run:{id}:alive`` (짧은 TTL 갱신). 없으면 대화 조회가 streaming 을 interrupted 로 보정한다.
- 수 초 주기로 현재까지의 본문·단계를 DB 행(status=streaming)에 저장 — Redis 가 소실되어도 진행분이 보존된다.
- 서버 종료 시 진행 중 작업을 취소하여 수신분까지 interrupted 로 저장한다(/continue 로 이어 받기).
"""
import asyncio
import json
import logging
import re
import time

from app.db.session import async_session

log = logging.getLogger(__name__)

STREAM_MAXLEN = 50_000   # 항목 수 상한(토큰 1개 = 항목 1개). 초과 시 오래된 항목부터 제거
RUN_TTL = 6 * 3600       # 진행 중 안전 TTL(작업 비정상 종료 시에도 키가 영구 잔존하지 않도록)
DONE_TTL = 3600          # 종료 후 이어 받기용 보존 시간
ALIVE_TTL = 15
ALIVE_EVERY = 5.0
SAVE_EVERY = 2.0
STOP_POLL = 0.5
STOP_GRACE = 3.0         # 멈춤 — 진행 중 작업(토큰·도구)이 이 시간 내 완료되면 이벤트 사이에서 중지, 아니면 취소
READ_BLOCK_MS = 5000

_STREAM_ID = re.compile(r"^\d{1,20}(-\d{1,20})?$")

# 본 워커에서 실행 중인 작업 — 강한 참조(GC 방지) + 동일 워커 멈춤 즉시 전달
_RUNS: dict[str, "Run"] = {}


def k_stream(mid: str) -> str:
    return f"ai:run:{mid}"


def k_stop(mid: str) -> str:
    return f"ai:run:{mid}:stop"


def k_alive(mid: str) -> str:
    return f"ai:run:{mid}:alive"


def k_owner(mid: str) -> str:
    return f"ai:run:{mid}:owner"


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def clean_after(after: str | None) -> str:
    a = (after or "").strip()
    return a if _STREAM_ID.match(a) else "0"


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


def _entries(res):
    """XREAD 결과(RESP2 리스트·RESP3 딕셔너리 모두) → [(id, fields)]."""
    if not res:
        return []
    items = res.items() if isinstance(res, dict) else res
    out = []
    for _key, entries in items:
        for sid, fields in entries or []:
            out.append((sid, fields or {}))
    return out


class Run:
    def __init__(self, msg_id: str, conv_id: str, user_id: str, gen, ctl: dict):
        self.msg_id = msg_id
        self.conv_id = conv_id
        self.user_id = user_id
        self.gen = gen
        self.ctl = ctl
        self.stop_evt = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.done_sent = False
        self._saved_sig = None
        self._xadd_failed = False

    async def _emit(self, chunk: str) -> None:
        try:
            r = await _redis()
            await r.xadd(k_stream(self.msg_id), {"d": chunk}, maxlen=STREAM_MAXLEN, approximate=True)
        except Exception as e:  # noqa: BLE001 — Redis 단절 시에도 생성·DB 저장은 계속 수행
            if not self._xadd_failed:
                log.warning("ai run %s: redis xadd 실패 — %s", self.msg_id, e)
                self._xadd_failed = True

    async def save_progress(self) -> None:
        """현재까지의 본문·단계를 DB 행에 저장 — streaming 상태인 행만 대상(멈춤·확정된 행은 변경하지 않는다)."""
        snap = self.ctl.get("snapshot")
        if snap is None:
            return
        text, meta = snap()
        sig = (len(text), text[-32:], json.dumps(meta.get("steps") or [], ensure_ascii=False, sort_keys=True),
               len(meta.get("citations") or []))
        if sig == self._saved_sig:
            return
        from app.ai.models import AIMessage

        async with async_session() as s:
            m = await s.get(AIMessage, self.msg_id)
            if m is None or (m.status or "") != "streaming":
                return
            m.content = text
            m.meta = json.dumps(meta, ensure_ascii=False)
            await s.commit()
        self._saved_sig = sig

    async def _tick(self) -> None:
        last_alive = last_save = time.monotonic()
        while True:
            await asyncio.sleep(STOP_POLL)
            now = time.monotonic()
            try:
                r = await _redis()
                if await r.exists(k_stop(self.msg_id)):
                    self.stop_evt.set()
                if now - last_alive >= ALIVE_EVERY:
                    await r.set(k_alive(self.msg_id), "1", ex=ALIVE_TTL)
                    last_alive = now
            except Exception:  # noqa: BLE001
                pass
            if now - last_save >= SAVE_EVERY:
                last_save = now
                try:
                    await self.save_progress()
                except Exception as e:  # noqa: BLE001
                    log.debug("ai run %s: 진행 저장 실패 — %s", self.msg_id, e)

    async def _drain(self, nxt: asyncio.Future | None) -> None:
        """진행 중인 다음-이벤트 대기를 취소하고 생성기가 정리(수신분 저장)를 완료할 때까지 대기한다."""
        if nxt is not None and not nxt.done():
            nxt.cancel()
            try:
                await nxt
            except BaseException:  # noqa: BLE001
                pass

    async def main(self) -> None:
        ticker = asyncio.create_task(self._tick())
        end_status = None
        nxt: asyncio.Future | None = None
        agen = self.gen
        try:
            while True:
                if self.stop_evt.is_set():
                    end_status = "stopped"
                    await agen.aclose()  # 이벤트 사이 — 생성기가 수신분을 저장하고 종료한다
                    break
                nxt = asyncio.ensure_future(agen.__anext__())
                stop_w = asyncio.ensure_future(self.stop_evt.wait())
                try:
                    done, _ = await asyncio.wait({nxt, stop_w}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    stop_w.cancel()
                if nxt not in done:
                    # 멈춤 — 진행 중 작업(토큰·도구)이 완료될 때까지 단시간 대기한다
                    done2, _ = await asyncio.wait({nxt}, timeout=STOP_GRACE)
                    if nxt not in done2:
                        await self._drain(nxt)
                        end_status = "stopped"
                        break
                try:
                    chunk = nxt.result()
                except StopAsyncIteration:
                    break
                finally:
                    nxt = None
                if isinstance(chunk, bytes):
                    chunk = chunk.decode()
                if chunk.startswith("event: done"):
                    self.done_sent = True
                await self._emit(chunk)
        except asyncio.CancelledError:
            # 서버 종료 — 생성기를 취소하여 수신분까지 interrupted 로 보존한다
            await self._drain(nxt)
            try:
                await agen.aclose()
            except BaseException:  # noqa: BLE001
                pass
            end_status = end_status or "interrupted"
        except Exception as e:  # noqa: BLE001
            log.exception("ai run %s 실패: %s", self.msg_id, e)
            await self._drain(nxt)
            end_status = "interrupted"
            await self._save_interrupted()
            await self._emit(_sse("error", {"message": str(e), "partial_saved": True}))
        finally:
            ticker.cancel()
            await self._finish(end_status)

    async def _save_interrupted(self) -> None:
        try:
            from app.ai.models import AIMessage

            snap = self.ctl.get("snapshot")
            async with async_session() as s:
                m = await s.get(AIMessage, self.msg_id)
                if m is not None and (m.status or "") == "streaming":
                    if snap is not None:
                        text, meta = snap()
                        m.content = text
                        m.meta = json.dumps(meta, ensure_ascii=False)
                    m.status = "interrupted"
                    await s.commit()
        except Exception:  # noqa: BLE001
            pass

    async def _finish(self, end_status: str | None) -> None:
        if not self.done_sent:
            # 생성기가 done 을 송신하지 못함(멈춤·종료·오류) — 구독 중인 화면에 종료를 통지한다
            await self._emit(_sse("done", {"message_id": self.msg_id, "status": end_status or "interrupted",
                                           "ai_generated": True}))
        try:
            r = await _redis()
            await r.xadd(k_stream(self.msg_id), {"end": "1"}, maxlen=STREAM_MAXLEN, approximate=True)
            await r.expire(k_stream(self.msg_id), DONE_TTL)
            await r.expire(k_owner(self.msg_id), DONE_TTL)
            await r.delete(k_alive(self.msg_id), k_stop(self.msg_id))
        except Exception:  # noqa: BLE001
            pass


async def start(msg_id: str, *, conv_id: str, user_id: str, gen, ctl: dict) -> bool:
    """작업을 기동한다. Redis 사용 불가 시 False(호출자가 이전과 같이 연결에 종속된 스트림으로 송신한다)."""
    try:
        r = await _redis()
        await r.delete(k_stream(msg_id), k_stop(msg_id))
        await r.set(k_owner(msg_id), str(user_id), ex=RUN_TTL)
        await r.set(k_alive(msg_id), "1", ex=ALIVE_TTL)
    except Exception as e:  # noqa: BLE001
        log.warning("ai run: redis 사용 불가 — 연결에 묶인 스트림으로 — %s", e)
        return False
    run = Run(msg_id, conv_id, user_id, gen, ctl)
    _RUNS[msg_id] = run

    def _gone(_t, _mid=msg_id, _run=run):
        if _RUNS.get(_mid) is _run:
            _RUNS.pop(_mid, None)

    run.task = asyncio.create_task(run.main(), name=f"ai-run:{msg_id}")
    run.task.add_done_callback(_gone)
    return True


async def request_stop(msg_id: str) -> None:
    """멈춤 — 워커와 무관하게 Redis 키로 요청하고, 본 워커의 작업에는 즉시 전달한다."""
    run = _RUNS.get(msg_id)
    if run is not None:
        run.stop_evt.set()
    try:
        r = await _redis()
        await r.set(k_stop(msg_id), "1", ex=DONE_TTL)
    except Exception:  # noqa: BLE001
        pass


async def owner(msg_id: str) -> str | None:
    try:
        r = await _redis()
        return await r.get(k_owner(msg_id))
    except Exception:  # noqa: BLE001
        return None


async def alive_set(msg_ids: list[str]) -> set[str]:
    """하트비트가 유효한 메시지 id 집합. Redis 조회 실패 시 빈 집합(= 중단된 것으로 간주)."""
    if not msg_ids:
        return set()
    out: set[str] = set()
    try:
        r = await _redis()
        for mid in msg_ids:
            if mid in _RUNS or await r.exists(k_alive(mid)):
                out.add(mid)
    except Exception:  # noqa: BLE001
        return {m for m in msg_ids if m in _RUNS}
    return out


async def subscribe(msg_id: str, after: str = "0", *, fallback=None):
    """Redis Stream 을 after 다음부터 읽어 SSE 로 송신한다. 종료 표시를 만나면 종료한다.

    작업이 비정상 종료되었거나(하트비트 없음) 스트림이 만료되었으면 ``fallback()`` (DB 최종 내용으로 done)을 송신하고 종료한다.
    연결이 종료되면 본 생성기만 취소된다 — 작업은 계속된다.
    """
    cur = clean_after(after)
    key = k_stream(msg_id)

    async def _fb():
        if fallback is not None:
            async for c in fallback():
                yield c

    try:
        r = await _redis()
    except Exception:  # noqa: BLE001
        async for c in _fb():
            yield c
        return
    while True:
        try:
            res = await r.xread({key: cur}, count=500, block=READ_BLOCK_MS)
        except Exception:  # noqa: BLE001 — Redis 단절: 화면이 재연결한다
            return
        got = _entries(res)
        if got:
            for sid, fields in got:
                cur = sid
                if fields.get("end"):
                    return
                d = fields.get("d")
                if d:
                    yield f"id: {sid}\n{d}"
            continue
        try:
            live = msg_id in _RUNS or bool(await r.exists(k_alive(msg_id)))
        except Exception:  # noqa: BLE001
            return
        if live:
            yield ": ping\n\n"  # 프록시의 유휴 연결 종료 방지
            continue
        # 작업 없음 — 종료 표시 누락 여부를 재확인(작업이 직전에 종료된 경우)
        try:
            tail = _entries(await r.xread({key: cur}, count=500))
        except Exception:  # noqa: BLE001
            tail = []
        for sid, fields in tail:
            if fields.get("end"):
                return
            d = fields.get("d")
            if d:
                yield f"id: {sid}\n{d}"
        async for c in _fb():
            yield c
        return


async def shutdown(timeout: float = 5.0) -> None:
    """서버 종료 — 진행 중 작업을 취소하여 수신분까지 interrupted 로 저장한다."""
    runs = list(_RUNS.values())
    tasks = [r.task for r in runs if r.task is not None and not r.task.done()]
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=timeout)
