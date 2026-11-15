"""파일 저장소 상태 — 종류·위치·연결·쓰기·잠금·여유 공간.

연결 판정은 쓰기 차단(app/middleware/storage_guard.py)과 같은 표식 확인을 쓴다. 끊긴 네트워크 저장소는
읽기가 오류가 아니라 **멈춤**일 수 있으므로, 저장소를 만지는 일은 전부 따로 둔 스레드에서 하고
`timeout` 안에 답이 없으면 사유 `unresponsive` 로 본다. 멈춘 확인은 하나만 둔다.

종류와 위치는 저장소를 만지지 않고 읽는다(끊긴 동안에도 답한다) — 설치 관리자가 아는 값(`GET /internal/storage`)을
먼저 쓰고, 설치 관리자가 없거나 답이 없으면 `/proc/self/mountinfo` 에서 추정한다.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import os
import secrets
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings
from app.middleware import storage_guard

MOUNTINFO = "/proc/self/mountinfo"
CACHE_SECONDS = 5.0
PROBE_TIMEOUT = 4.0
PROBE_PREFIX = ".jw-probe-"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ─── 종류·위치 ───


def _unescape(value: str) -> str:
    # mountinfo 는 공백·탭·줄바꿈·역슬래시를 8진수로 적는다
    for code, char in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        value = value.replace(code, char)
    return value


def parse_mountinfo(text: str, path: str) -> dict | None:
    """`path` 를 담은 마운트(가장 긴 마운트 지점) — {mount_point, root, fstype, source}. 못 찾으면 None."""
    path = path.rstrip("/") or "/"
    best: dict | None = None
    for line in text.splitlines():
        left, sep, right = line.partition(" - ")
        fields, tail = left.split(), right.split()
        if not sep or len(fields) < 5 or len(tail) < 2:
            continue
        mount_point = _unescape(fields[4])
        if not (path == mount_point or mount_point == "/" or path.startswith(mount_point.rstrip("/") + "/")):
            continue
        # 같은 지점에 겹쳐 붙은 것은 뒤에 적힌 것이 위에 있다
        if best is None or len(mount_point) >= len(best["mount_point"]):
            best = {"mount_point": mount_point, "root": _unescape(fields[3]),
                    "fstype": tail[0], "source": _unescape(tail[1])}
    return best


def describe(root: str, mountinfo: str | None = None) -> dict:
    """{kind: local|nfs, location} — 위치는 NFS 면 `서버:/내보낸 경로`, 아니면 호스트 쪽 폴더(알 수 있을 때)."""
    if mountinfo is None:
        try:
            mountinfo = Path(MOUNTINFO).read_text(encoding="utf-8", errors="replace")
        except OSError:
            mountinfo = ""
    found = parse_mountinfo(mountinfo, root)
    if found and found["fstype"].startswith("nfs"):
        return {"kind": "nfs", "location": found["source"]}
    location = None
    if found and found["mount_point"] != "/" and found["root"] not in ("", "/"):
        location = found["root"]
    return {"kind": "local", "location": location}


INSTALLER_TIMEOUT = 3.0            # 상태 카드를 붙잡지 않게 짧게
INSTALLER_CACHE_SECONDS = 60.0     # 종류·위치는 설치 뒤에 바뀌지 않는다
INSTALLER_RETRY_SECONDS = 15.0     # 답이 없었으면 이 시간 동안은 다시 묻지 않는다
_installer_seen: tuple[float, dict | None] | None = None


async def installed_description(force: bool = False) -> dict:
    """설치 관리자가 아는 저장소 — {kind, [location], volume, source: "installer"}.

    컨테이너 안의 마운트 정보로는 호스트 폴더를 정확히 알 수 없는 설치가 있어, 설치 관리자의 답을 먼저 쓴다.
    설치 관리자가 없거나 답이 없으면 {"volume": None, "source": "mountinfo"} — 호출한 쪽은 `describe` 의 추정을 그대로 둔다.
    """
    global _installer_seen
    from app.system import installer_client as installer

    fallback = {"volume": None, "source": "mountinfo"}
    if not installer.configured():
        return fallback
    now = time.monotonic()
    if not force and _installer_seen is not None:
        seen_at, seen = _installer_seen
        if now - seen_at < (INSTALLER_CACHE_SECONDS if seen is not None else INSTALLER_RETRY_SECONDS):
            return dict(seen) if seen is not None else fallback
    found: dict | None = None
    try:
        data = await installer.request("GET", "/internal/storage", timeout=INSTALLER_TIMEOUT)
    except installer.InstallerError:
        data = None
    if isinstance(data, dict) and data.get("kind") in ("local", "nfs"):
        volume = data.get("volume")
        found = {"kind": data["kind"], "volume": volume if isinstance(volume, str) and volume else None,
                 "source": "installer"}
        location = data.get("location")
        if isinstance(location, str) and location:
            found["location"] = location
    _installer_seen = (now, found)
    return dict(found) if found is not None else fallback


# ─── 확인(저장소를 만진다 — 멈출 수 있다) ───


def write_and_lock(root: str) -> tuple[bool, bool | None]:
    """작은 파일을 써 보고 잠가 본 뒤 지운다 — (쓰기, 잠금). 잠금을 확인할 수 없는 환경이면 None."""
    path = os.path.join(root, f"{PROBE_PREFIX}{os.getpid()}-{secrets.token_hex(4)}")
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError:
        return False, None
    lock: bool | None = None
    try:
        try:
            os.write(fd, b"ok")
            os.fsync(fd)
        except OSError:
            return False, None
        try:
            import fcntl
        except ImportError:
            lock = None
        else:
            try:
                fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.lockf(fd, fcntl.LOCK_UN)
                lock = True
            except OSError:
                lock = False
        return True, lock
    finally:
        os.close(fd)
        try:
            os.unlink(path)
        except OSError:
            pass


def probe(root: str, install_id: str, guarded: bool, checker=None) -> dict:
    """표식 → 여유 공간 → 쓰기·잠금. 표식이 안 보이면 거기서 멈춘다(끊긴 자리의 빈 폴더에 쓰지 않는다)."""
    if guarded:
        reason = (checker or storage_guard.check_marker)(root, install_id)
    else:
        reason = None if os.path.isdir(root) else "missing"
    if reason is not None:
        return {"reason": reason}
    try:
        usage = shutil.disk_usage(root)
    except OSError:
        return {"reason": "unreadable"}
    write, lock = write_and_lock(root)
    return {"reason": None, "total_bytes": usage.total, "used_bytes": usage.used, "free_bytes": usage.free,
            "write": write, "lock": lock}


def probe_marker(root: str, install_id: str, guarded: bool, checker=None) -> dict:
    """표식만 본다(쓰지 않는다) — 여러 사용자가 주기적으로 묻는 가벼운 조회용."""
    if not guarded:
        return {"reason": None}
    return {"reason": (checker or storage_guard.check_marker)(root, install_id)}


class StorageProber:
    def __init__(self, root: str | None = None, install_id: str | None = None, guarded: bool | None = None,
                 timeout: float = PROBE_TIMEOUT, cache_seconds: float = CACHE_SECONDS, probe_fn=probe):
        self._root, self._install_id, self._guarded = root, install_id, guarded
        self.timeout = timeout
        self.cache_seconds = cache_seconds
        self.probe_fn = probe_fn
        self._pending: concurrent.futures.Future | None = None
        self._pending_started = 0.0
        self._last: dict | None = None
        self._last_at = 0.0

    @property
    def root(self) -> str:
        return self._root if self._root is not None else get_settings().storage_root

    @property
    def install_id(self) -> str:
        if self._install_id is not None:
            return self._install_id
        return os.environ.get(storage_guard.ENV_INSTALL_ID, "").strip()

    @property
    def guarded(self) -> bool:
        return storage_guard.required() if self._guarded is None else self._guarded

    def _start(self) -> concurrent.futures.Future:
        future: concurrent.futures.Future = concurrent.futures.Future()
        root, install_id, guarded = self.root, self.install_id, self.guarded
        # 스레드를 띄우기 전에 걸어 둔다 — 확인이 곧바로 끝나도 아래 work 가 이 자리를 비울 수 있게
        self._pending = future
        self._pending_started = time.monotonic()

        def work() -> None:
            try:
                result = dict(self.probe_fn(root, install_id, guarded))
            except Exception:  # noqa: BLE001 — 확인하다 난 어떤 오류든 "못 읽음"
                result = {"reason": "unreadable"}
            result["checked_at"] = now_iso()
            self._last, self._last_at = result, time.monotonic()
            if self._pending is future:
                self._pending = None
            future.set_result(result)

        # 기본 스레드 풀을 쓰지 않는다 — 멈춘 확인이 풀의 자리를 차지하지 않게
        threading.Thread(target=work, name="storage-status", daemon=True).start()
        return future

    async def check(self, force: bool = False) -> dict:
        """확인 결과 — {reason, checked_at, [total_bytes, used_bytes, free_bytes, write, lock]}."""
        now = time.monotonic()
        if not force and self._last is not None and now - self._last_at < self.cache_seconds:
            return dict(self._last)
        pending = self._pending
        if pending is None:
            pending = self._start()
        remaining = self.timeout - (now - self._pending_started)
        if remaining > 0 and not pending.done():
            try:
                await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(pending)), remaining)
            except asyncio.TimeoutError:
                pass
        if pending.done():
            return dict(pending.result())
        return {"reason": "unresponsive", "checked_at": now_iso()}

    async def status(self, force: bool = False) -> dict:
        """화면에 내려가는 상태. 끊긴 시각(down_since)은 호출한 쪽이 덧붙인다."""
        result = await self.check(force)
        reason = result.get("reason")
        return {
            "guarded": self.guarded,
            **describe(self.root),
            "state": "ok" if reason is None else "down",
            "reason": reason,
            "write": result.get("write"),
            "lock": result.get("lock"),
            "total_bytes": result.get("total_bytes"),
            "used_bytes": result.get("used_bytes"),
            "free_bytes": result.get("free_bytes"),
            "checked_at": result.get("checked_at"),
        }


prober = StorageProber()
light_prober = StorageProber(probe_fn=probe_marker, cache_seconds=10.0)
