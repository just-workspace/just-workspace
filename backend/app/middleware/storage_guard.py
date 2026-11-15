"""저장소 표식 확인 — 표식이 안 보이면 파일 쓰기를 거부한다.

왜 필요한가
  파일 저장소가 네트워크 저장소(NFS)나 따로 붙인 디스크일 때, 그 연결이 끊기면 붙이는 자리에는
  **빈 폴더**만 남는다. 그 상태로 쓰기를 받으면 파일이 서버의 로컬 디스크에 쌓이고, 다시 연결된 뒤에는
  그 파일들이 가려져 사라진 것처럼 보인다. 그래서 설치할 때 저장소 뿌리에 표식 파일(`.jw-storage`)을
  하나 써 두고, 그 파일이 안 보이는 동안에는 쓰기를 받지 않는다.

켜는 법
  `STORAGE_MARKER_REQUIRED=1`(설치 관리자가 넣는다). 없으면 이 미들웨어는 등록되지 않는다 — 표식 없이
  돌던 기존 설치는 그대로 돈다.
  `JW_INSTALL_ID` 가 있으면 표식에 적힌 설치 id 도 같아야 한다(다른 설치의 저장소가 붙은 경우를 막는다).

막는 요청
  `GUARDED_PREFIXES` 아래의 POST/PUT/PATCH/DELETE. 읽기는 막지 않는다(끊긴 저장소에서는 어차피 404 다).
  응답은 503 + `{"code": "storage_unavailable"}`, `Retry-After: 30`.

관리자 알림
  막을 때마다 로그 한 줄, 그리고 10분에 한 번 관리자 전원에게 알림(실패해도 요청 처리에는 영향 없음).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from app.config import get_settings

logger = logging.getLogger(__name__)

ENV_REQUIRED = "STORAGE_MARKER_REQUIRED"
ENV_INSTALL_ID = "JW_INSTALL_ID"
MARKER_NAME = ".jw-storage"
ERROR_CODE = "storage_unavailable"

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
#: 저장소에 파일을 쓰는 API. 경계는 "/" 까지 본다("/api/filesx" 는 해당 없음).
GUARDED_PREFIXES = ("/api/files", "/api/wopi/files")

CACHE_SECONDS = 5.0        # 표식 확인 결과를 이만큼 재사용한다(요청마다 stat 하지 않게)
ALERT_INTERVAL = 600.0     # 관리자 알림 간격(초)
_ALERT_KEY = "storage:marker:alerted"


def required(env: dict[str, str] | None = None) -> bool:
    value = (os.environ if env is None else env).get(ENV_REQUIRED, "")
    return value.strip().lower() in ("1", "true", "yes", "on")


def check_marker(root: str | os.PathLike, install_id: str = "") -> str | None:
    """표식이 정상이면 None, 아니면 사유(`missing` | `unreadable` | `mismatch`)."""
    path = Path(root) / MARKER_NAME
    try:
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
                 cache_seconds: float = CACHE_SECONDS):
        self.app = app
        self.root = root if root is not None else get_settings().storage_root
        self.install_id = os.environ.get(ENV_INSTALL_ID, "").strip() if install_id is None else install_id
        self.cache_seconds = cache_seconds
        self._checked_at: float | None = None
        self._reason: str | None = None
        self._alerted_at: float | None = None

    def problem(self) -> str | None:
        now = time.monotonic()
        if self._checked_at is not None and now - self._checked_at < self.cache_seconds:
            return self._reason
        self._reason = check_marker(self.root, self.install_id)
        self._checked_at = now
        return self._reason

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not _guarded(scope.get("method", ""), scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        reason = self.problem()
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
    """관리자 전원에게 알림을 남긴다. 보낸 수를 돌려준다(실패하면 0)."""
    try:
        # 워커가 여럿이어도 한 번만 — Redis 에 닿지 못하면 워커마다 한 번
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
                    link="/admin",
                )
            return len(admin_ids)
    except Exception as e:  # noqa: BLE001
        logger.warning("[storage] 관리자 알림을 남기지 못했습니다(%s)", type(e).__name__)
        return 0
