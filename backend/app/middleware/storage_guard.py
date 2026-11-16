"""저장소 마커 확인 — 마커가 확인되지 않으면 파일 쓰기를 거부한다.

필요 사유
  파일 저장소가 네트워크 저장소(NFS)이거나 별도로 마운트한 디스크인 경우, 연결이 끊기면 마운트 지점에는
  **빈 폴더**만 남는다. 이 상태에서 쓰기를 허용하면 파일이 서버의 로컬 디스크에 누적되고, 재연결 후에는
  해당 파일이 가려져 소실된 것처럼 보인다. 따라서 설치 시 저장소 루트에 마커 파일(`.jw-storage`)을
  생성하고, 해당 파일이 확인되지 않는 동안에는 쓰기를 거부한다.

활성화 방법
  `STORAGE_MARKER_REQUIRED=1`(설치 관리자가 설정한다). 미설정 시 본 미들웨어는 등록되지 않는다 — 마커 없이
  운영되던 기존 설치는 그대로 동작한다.
  `JW_INSTALL_ID` 가 있으면 마커에 기록된 설치 id 도 일치해야 한다(타 설치의 저장소가 마운트된 경우를 차단한다).

차단 대상 요청
  `GUARDED_PREFIXES` 하위의 POST/PUT/PATCH/DELETE. 읽기는 차단하지 않는다(연결이 끊긴 저장소에서는 어차피 404 이다).
  응답은 503 + `{"code": "storage_unavailable"}`, `Retry-After: 30`.

무응답 저장소
  NFS 를 `hard` 로 마운트하면 서버 연결이 끊긴 동안 해당 지점의 읽기는 **오류가 아니라 정지**이다(복구될 때까지 대기한다).
  마커를 요청 처리 흐름에서 직접 읽으면 해당 요청과 동일 워커의 다른 요청이 함께 정지한다. 따라서 마커는 별도
  스레드에서 읽고 `CHECK_TIMEOUT` 내에 응답이 없으면 사유 `unresponsive` 로 거부한다. 정지된 읽기는 하나만 유지한다 —
  응답 전에 도착한 요청은 새로 읽지 않고 즉시 거부되며, 저장소가 복구되어 해당 읽기가 종료되면 다시 허용한다.

관리자 알림
  차단 시마다 로그 한 줄을 기록하고, 10분에 한 번 관리자 전원에게 알림을 전송한다(실패해도 요청 처리에는 영향 없음).
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import threading
import time
from pathlib import Path

from app.config import get_settings

logger = logging.getLogger(__name__)

ENV_REQUIRED = "STORAGE_MARKER_REQUIRED"
ENV_INSTALL_ID = "JW_INSTALL_ID"
MARKER_NAME = ".jw-storage"
ERROR_CODE = "storage_unavailable"

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
#: 저장소에 파일을 쓰는 API. 경계는 "/" 까지 확인한다("/api/filesx" 는 해당 없음).
GUARDED_PREFIXES = ("/api/files", "/api/wopi/files")

CACHE_SECONDS = 5.0        # 마커 확인 결과의 재사용 시간(요청마다 stat 하지 않도록 함)
CHECK_TIMEOUT = 3.0        # 마커 읽기가 이 시간 동안 응답이 없으면 "응답 없음"으로 판정하여 거부
ALERT_INTERVAL = 600.0     # 관리자 알림 간격(초)
_ALERT_KEY = "storage:marker:alerted"


def required(env: dict[str, str] | None = None) -> bool:
    value = (os.environ if env is None else env).get(ENV_REQUIRED, "")
    return value.strip().lower() in ("1", "true", "yes", "on")


def check_marker(root: str | os.PathLike, install_id: str = "") -> str | None:
    """마커가 정상이면 None, 아니면 사유(`missing` | `unreadable` | `mismatch`)를 반환한다.

    연결이 끊긴 네트워크 저장소에서는 본 호출이 반환되지 않을 수 있다 — 요청 처리 흐름에서는 `problem_async` 로 호출한다
    (해당 함수가 무응답을 `unresponsive` 로 변환한다).
    """
    path = Path(root) / MARKER_NAME
    try:
        # 파일 시스템 통계를 먼저 조회한다 — NFS 에서 이 호출은 캐시 없이 서버까지 도달한다. 마커 파일만 읽으면
        # 서버 연결이 끊긴 직후에는 클라이언트 캐시에서 읽혀 "정상"으로 판정된다(이후의 쓰기는 정지한다).
        if hasattr(os, "statvfs"):
            os.statvfs(root)
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"
    if not install_id:
        return None
    try:
        found = str(json.loads(raw).get("install_id", ""))
    except (ValueError, AttributeError):
        return "unreadable"
    return None if found == install_id else "mismatch"


def _guarded(method: str, path: str) -> bool:
    if method not in UNSAFE_METHODS:
        return False
    return any(path == p or path.startswith(p + "/") for p in GUARDED_PREFIXES)


class StorageMarkerGuard:
    """순수 ASGI 미들웨어 — 업로드 본문을 읽기 전에 거부한다."""

    def __init__(self, app, root: str | None = None, install_id: str | None = None,
                 cache_seconds: float = CACHE_SECONDS, check_timeout: float = CHECK_TIMEOUT, checker=check_marker):
        self.app = app
        self.root = root if root is not None else get_settings().storage_root
        self.install_id = os.environ.get(ENV_INSTALL_ID, "").strip() if install_id is None else install_id
        self.cache_seconds = cache_seconds
        self.check_timeout = check_timeout
        self.checker = checker
        self._checked_at: float | None = None
        self._reason: str | None = None
        self._alerted_at: float | None = None
        self._probe: concurrent.futures.Future | None = None     # 아직 응답이 없는 마커 읽기(하나만 유지)
        self._probe_started = 0.0

    def _cached(self, now: float) -> bool:
        return self._checked_at is not None and now - self._checked_at < self.cache_seconds

    def problem(self) -> str | None:
        """마커를 호출 흐름에서 직접 읽는다(캐시 포함). 무응답 저장소에서는 반환되지 않을 수 있다."""
        now = time.monotonic()
        if self._cached(now):
            return self._reason
        self._reason = self.checker(self.root, self.install_id)
        self._checked_at = now
        return self._reason

    def _start_probe(self, now: float) -> concurrent.futures.Future:
        future: concurrent.futures.Future = concurrent.futures.Future()
        # 스레드 기동 **전에** 기록한다. 읽기가 매우 빨리 종료되면 스레드가 `_probe` 를 초기화하는 동작이 대입보다
        # 먼저 수행되고, 이후의 대입이 종료된 future 를 복원하여 캐시 만료 후에도 이전 결과만 반환하게 된다.
        self._probe = future
        self._probe_started = now

        def work() -> None:
            try:
                reason = self.checker(self.root, self.install_id)
            except Exception:  # noqa: BLE001 — 읽기 중 발생한 모든 오류는 "읽기 불가"로 처리
                reason = "unreadable"
            self._reason = reason
            self._checked_at = time.monotonic()
            if self._probe is future:
                self._probe = None
            future.set_result(reason)

        # 기본 스레드 풀 미사용 — 정지된 읽기가 풀의 슬롯을 점유하여 다른 작업을 차단하는 것을 방지
        threading.Thread(target=work, name="storage-marker", daemon=True).start()
        return future

    async def problem_async(self) -> str | None:
        """마커가 정상이면 None, 아니면 사유를 반환한다. 읽기가 `check_timeout` 내에 종료되지 않으면 `unresponsive`."""
        now = time.monotonic()
        if self._cached(now):
            return self._reason
        probe = self._probe
        if probe is None or probe.done():      # 종료된 읽기가 남아 있으면(발생해서는 안 되는 상태) 새로 읽는다
            probe = self._start_probe(now)
        remaining = self.check_timeout - (now - self._probe_started)
        if remaining > 0 and not probe.done():
            try:
                await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(probe)), remaining)
            except asyncio.TimeoutError:
                pass
        if probe.done():
            return probe.result()
        return "unresponsive"

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not _guarded(scope.get("method", ""), scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        reason = await self.problem_async()
        if reason is None:
            await self.app(scope, receive, send)
            return
        logger.error("[storage] 저장소 표식을 확인하지 못해 쓰기를 거부합니다 — 사유 %s, 요청 %s %s",
                     reason, scope.get("method"), scope.get("path"))
        self._alert(reason)
        body = json.dumps({
            "detail": "파일 저장소에 연결되어 있지 않아 저장할 수 없습니다. 잠시 뒤 다시 시도하세요.",
            "code": ERROR_CODE,
            "reason": reason,
        }, ensure_ascii=False).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 503,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
                (b"retry-after", b"30"),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": body})

    def _alert(self, reason: str) -> None:
        now = time.monotonic()
        if self._alerted_at is not None and now - self._alerted_at < ALERT_INTERVAL:
            return
        self._alerted_at = now
        try:
            asyncio.get_running_loop().create_task(notify_admins(reason))
        except RuntimeError:        # 이벤트 루프 밖
            pass


async def notify_admins(reason: str) -> int:
    """관리자 전원에게 알림을 기록한다. 전송 건수를 반환한다(실패 시 0)."""
    try:
        # 워커가 여러 개여도 1회만 전송 — Redis 접속 불가 시 워커마다 1회
        try:
            from app.chat.redis_client import get_redis
            r = await get_redis()
            if not await r.set(_ALERT_KEY, "1", nx=True, ex=int(ALERT_INTERVAL)):
                return 0
        except Exception:  # noqa: BLE001
            pass
        from sqlalchemy import select

        from app.db.models import User
        from app.db.session import async_session
        from app.notifications.service import create_notification

        async with async_session() as db:
            admin_ids = (await db.execute(
                select(User.id).where(User.is_admin == True, User.is_active == True)  # noqa: E712
            )).scalars().all()
            for user_id in admin_ids:
                await create_notification(
                    db, user_id, "system",
                    "파일 저장소에 연결되어 있지 않습니다",
                    body="저장소 표식을 확인하지 못해 파일 저장을 막았습니다. 저장소 연결(네트워크 저장소·디스크)을 "
                         f"확인하세요. (사유: {reason})",
                    link="/admin/storage",
                )
            return len(admin_ids)
    except Exception as e:  # noqa: BLE001
        logger.warning("[storage] 관리자 알림을 남기지 못했습니다(%s)", type(e).__name__)
        return 0
