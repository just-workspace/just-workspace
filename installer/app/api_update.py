"""업데이트 내부 API — `/internal/update/*`(8444, 공유 키 + 내부 대역). 계약은 docs/update-api.md.

`register()` 가 내부 앱에 경로를 등록한다. 키 없이 접근 가능한 것은 공개 점검 모드 상태(`GET /internal/update/maintenance`) 하나이며,
이 경우에도 내부 대역 검사는 동일하게 적용된다(외부에서는 nginx 의 `/maintenance/status` 를 경유해야만 접근 가능).
"""

from __future__ import annotations

import asyncio
import queue
import re
import threading

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from app.update_engine import UpdateError, UpdateManager
from app.update_offline import OfflineManager, clean_filename

P = "/internal/update"
VERSION = re.compile(r"\d+\.\d+\.\d+(-beta\.\d+)?")
TICK_SECONDS = 60


def manager(svc) -> UpdateManager:
    """서비스 집합에 속한 업데이트 엔진(최초 호출 시 생성)."""
    if "updates" not in svc.cache:
        svc.cache["updates"] = UpdateManager(svc.engine, zones=svc.zones, registry=svc.registry,
                                             **svc.cache.get("update_kwargs", {}))
    return svc.cache["updates"]


def offline(svc) -> OfflineManager:
    if "offline" not in svc.cache:
        svc.cache["offline"] = OfflineManager(manager(svc))
    return svc.cache["offline"]


async def ticker(svc) -> None:
    """1분 주기 — 채널 확인 주기와 자동 적용 조건을 검사한다."""
    while True:
        await asyncio.sleep(TICK_SECONDS)
        try:
            await asyncio.to_thread(manager(svc).tick)
        except Exception as e:  # noqa: BLE001
            print(f"[update] {type(e).__name__}", flush=True)


async def _pump(request: Request, consume) -> None:
    """요청 본문을 메모리에 적재하지 않고 `consume(조각들)` 에 스트리밍 전달한다(consume 은 별도 스레드에서 실행)."""
    q: queue.Queue = queue.Queue(maxsize=16)
    stop = threading.Event()

    def chunks():
        while True:
            item = q.get()
            if item is None:
                return
            if isinstance(item, Exception):
                raise InterruptedError
            yield item

    def put(item) -> None:
        while not stop.is_set():
            try:
                q.put(item, timeout=0.5)
                return
            except queue.Full:
                continue

    def run() -> None:
        try:
            consume(chunks())
        finally:
            stop.set()

    task = asyncio.create_task(asyncio.to_thread(run))
    try:
        async for chunk in request.stream():
            if task.done():
                break
            if chunk:
                await asyncio.to_thread(put, chunk)
        await asyncio.to_thread(put, None)
    except Exception as e:  # noqa: BLE001 — 업로드 중 연결 종료
        await asyncio.to_thread(put, e)
    try:
        await task
    finally:
        stop.set()


def register(app: FastAPI, svc, keyed, client_allowed) -> None:
    @app.exception_handler(UpdateError)
    async def _update_error(request: Request, exc: UpdateError):
        return JSONResponse({"code": exc.code, "vars": exc.vars}, status_code=exc.status)

    def updates() -> UpdateManager:
        return manager(svc)

    def total(request: Request) -> int | None:
        length = request.headers.get("content-length", "")
        return int(length) if length.isdigit() else None

    # ── 상태 · 확인 · 설정 ──

    @app.get(f"{P}/status", dependencies=[Depends(keyed)])
    def status():
        return updates().status()

    @app.post(f"{P}/check", dependencies=[Depends(keyed)], status_code=202)
    def check():
        updates()._require_installed()
        updates().check()
        return updates().status()

    @app.get(f"{P}/releases/{{version}}", dependencies=[Depends(keyed)])
    def release(version: str):
        if not VERSION.fullmatch(version):
            raise UpdateError(404, "history_unknown")
        return updates().release_notes(version)

    @app.get(f"{P}/settings", dependencies=[Depends(keyed)])
    def get_settings():
        return updates().settings()

    @app.put(f"{P}/settings", dependencies=[Depends(keyed)])
    def put_settings(body: dict = Body(...)):
        out, started = updates().put_settings(body)
        return JSONResponse(out, status_code=202 if started else 200)

    # ── 적용 · 작업 ──

    @app.post(f"{P}/apply", dependencies=[Depends(keyed)], status_code=202)
    def apply(body: dict = Body(...)):
        return updates().apply(body.get("target"), body.get("start") or "countdown", body.get("actor"))

    @app.get(f"{P}/jobs/{{job_id}}", dependencies=[Depends(keyed)])
    def job(job_id: str):
        found = updates().job_raw(job_id)
        if found is None:
            raise UpdateError(404, "job_unknown")
        return updates().public(found)

    @app.post(f"{P}/jobs/{{job_id}}/action", dependencies=[Depends(keyed)])
    def job_action(job_id: str, body: dict = Body(...)):
        return updates().action(job_id, body.get("action"), body.get("actor"))

    @app.get(f"{P}/jobs/{{job_id}}/log", dependencies=[Depends(keyed)])
    def job_log(job_id: str, tail: int | None = Query(default=None, ge=1, le=100000), format: str | None = None):
        if updates().job_raw(job_id) is None:
            raise UpdateError(404, "job_unknown")
        lines = updates().read_log(job_id, tail)
        if format == "text":
            return PlainTextResponse("\n".join(lines) + ("\n" if lines else ""), headers={"Cache-Control": "no-store"})
        return {"lines": lines}

    @app.post(f"{P}/auto/resume", dependencies=[Depends(keyed)])
    def auto_resume():
        return updates().auto_resume()

    @app.get(f"{P}/restore-points", dependencies=[Depends(keyed)])
    def restore_points():
        return updates().restore_points()

    @app.post(f"{P}/restore", dependencies=[Depends(keyed)], status_code=202)
    def restore(body: dict = Body(...)):
        return updates().start_restore(body.get("point"), body.get("start") or "countdown", body.get("actor"))

    # ── 오프라인 ──

    @app.get(f"{P}/offline", dependencies=[Depends(keyed)])
    def offline_view():
        return offline(svc).view()

    @app.post(f"{P}/offline/bundle", dependencies=[Depends(keyed)], status_code=202)
    async def offline_bundle(request: Request):
        updates()._require_installed()
        name = clean_filename(request.headers.get("x-jw-filename"), "bundle.tar")
        size = total(request)
        await _pump(request, lambda chunks: offline(svc).receive(chunks, name, size))
        return offline(svc).view()

    @app.post(f"{P}/offline/bundle-path", dependencies=[Depends(keyed)])
    def offline_path(body: dict = Body(...)):
        updates()._require_installed()
        path = body.get("path")
        if not isinstance(path, str) or not path.strip() or "\x00" in path or len(path) > 4096:
            raise UpdateError(422, "invalid", field="path")
        offline(svc).use_path(path.strip())
        view = offline(svc).view()
        missing = (view["bundle"] or {}).get("state") == "file_missing"
        return JSONResponse(view, status_code=200 if missing else 202)

    @app.delete(f"{P}/offline/bundle", dependencies=[Depends(keyed)])
    def offline_clear():
        offline(svc).clear()
        return offline(svc).view()

    @app.post(f"{P}/offline/images/{{image_id}}", dependencies=[Depends(keyed)], status_code=202)
    async def offline_image(image_id: str, request: Request):
        size = total(request)
        await _pump(request, lambda chunks: offline(svc).receive_image(image_id, chunks, size))
        return offline(svc).view()

    @app.post(f"{P}/offline/apply", dependencies=[Depends(keyed)], status_code=202)
    def offline_apply(body: dict = Body(default={})):
        return offline(svc).apply(body.get("start"), body.get("actor"))

    # ── 기록 · 앱 ──

    @app.get(f"{P}/history", dependencies=[Depends(keyed)])
    def history(limit: int = Query(default=50, ge=1, le=200), before: str | None = None):
        return updates().history(limit, before)

    @app.get(f"{P}/history/{{entry_id}}", dependencies=[Depends(keyed)])
    def history_entry(entry_id: str):
        return updates().history_entry(entry_id)

    @app.get(f"{P}/apps", dependencies=[Depends(keyed)])
    def apps():
        return updates().apps()

    # ── 점검 모드 상태 ──

    @app.get(f"{P}/maintenance")
    def maintenance(request: Request):
        """키 불필요 — 점검 모드 여부, 시작 시각, 예상 시간, 연락처만 포함한다(버전·단계·오류는 포함하지 않는다)."""
        if not client_allowed(request):
            return JSONResponse({"code": "not_found", "vars": {}}, status_code=404)
        return JSONResponse(updates().maintenance(), headers={"Cache-Control": "no-store"})

    @app.put(f"{P}/maintenance/contact", dependencies=[Depends(keyed)])
    def maintenance_contact(body: dict = Body(...)):
        return updates().set_contact(body.get("contact"))
