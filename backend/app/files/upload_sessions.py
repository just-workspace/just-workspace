"""청크 업로드 세션 — 대용량 파일을 분할 업로드하고(재개 가능) 마지막에 일괄 조립한다.

프로토콜(라우터 `files/router.py`):
    POST   /api/files/upload/sessions            {path, name, size, mtime?} → {id, chunk_size, expires_at}
    PUT    /api/files/upload/sessions/{id}/{n}   raw body = n번째 청크(1부터)
    GET    /api/files/upload/sessions/{id}       받은 청크 목록(재개용)
    POST   /api/files/upload/sessions/{id}/commit → 조립 후 대상 경로로 이동
    DELETE /api/files/upload/sessions/{id}       중단

세션 사용 이유: 단일 multipart POST 는 nginx 2겹(RP·ws-nginx)의 client_max_body_size 에
걸리고, 연결이 끊기면 처음부터 재전송해야 한다. 청크 하나는 해당 상한 미만이므로 통과하고, 연결이 끊긴 후에는 수신된
청크 목록을 조회하여 누락분만 재전송한다.

임시 영역은 `STORAGE_ROOT/.uploads/<session_id>/` — 사용자 저장소(users/, shared/)
외부이며 숨김 접두어이므로 목록·색인에 포함되지 않는다. 동일 마운트이므로 commit 은 복사가 아닌
`os.replace`(원자적 rename)로 완료된다. 워커 8개가 동일 디스크를 참조하므로 세션 상태도
디스크(meta.json)에 저장한다. 청크마다 다른 워커가 수신해도 무방하다.

S3 모드 참고: 현재 파일 라우터는 파일시스템 직결이고 `storage/backend.py` 의 S3 는
설정 검증 용도로만 사용된다. S3 멀티파트 매핑은 라우터가 S3 를 사용하게 되는 시점에 함께 구현한다.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

from app.files.retention import Stats, remove_within
from app.files.service import apply_mtime  # noqa: F401 — 라우터·테스트에서도 이 이름으로 사용

SESSIONS_DIRNAME = ".uploads"
SESSION_TTL = 24 * 3600                  # 마지막 활동 후 이 시간 경과 시 정리
CHUNK_SIZE = 8 * 1024 * 1024             # 클라이언트 권장 청크 크기
MAX_CHUNK_BYTES = 64 * 1024 * 1024       # 단일 PUT 허용 상한(임시 영역 보호)
MAX_CHUNKS = 999_999
META_NAME = "meta.json"
ASSEMBLED_NAME = "assembled"

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class SessionError(Exception):
    """잘못된 세션 ID·상태. 라우터가 4xx 로 변환한다."""


def sessions_root(storage_root: Path) -> Path:
    return Path(storage_root) / SESSIONS_DIRNAME


def new_session_id() -> str:
    return secrets.token_urlsafe(18)     # 24자, URL 안전


def session_dir(root: Path, session_id: str) -> Path:
    """세션 디렉터리. ID 형식을 우선 검증하여 `..`·구분자 유입을 차단한다."""
    if not _ID_RE.match(session_id or ""):
        raise SessionError("잘못된 세션 ID")
    d = root / session_id
    if not d.is_relative_to(root):          # pragma: no cover — 정규식에서 이미 차단
        raise SessionError("잘못된 세션 ID")
    return d


def create_session(root: Path, *, user_id: str, target_vpath: str, name: str,
                   total_size: int, mtime_ms: int | None) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    sid = new_session_id()
    d = session_dir(root, sid)
    d.mkdir(parents=False, exist_ok=False)
    now = time.time()
    meta = {
        "id": sid,
        "user_id": user_id,
        "target_vpath": target_vpath,     # 대상 디렉터리 가상경로(my/..., shared/...)
        "name": name,                     # 검증 완료된 파일명
        "total_size": int(total_size),
        "mtime_ms": int(mtime_ms) if mtime_ms is not None else None,
        "created_at": now,
        "expires_at": now + SESSION_TTL,
    }
    write_meta(d, meta)
    return meta


def write_meta(d: Path, meta: dict) -> None:
    tmp = d / (META_NAME + ".tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / META_NAME)


def read_meta(root: Path, session_id: str) -> tuple[Path, dict]:
    d = session_dir(root, session_id)
    p = d / META_NAME
    if not d.is_dir() or not p.is_file():
        raise SessionError("세션이 없거나 만료되었습니다")
    try:
        meta = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SessionError("세션 메타가 손상되었습니다")
    return d, meta


def chunk_path(d: Path, n: int) -> Path:
    if not (1 <= n <= MAX_CHUNKS):
        raise SessionError("청크 번호는 1 이상이어야 합니다")
    return d / f"{n:06d}"


def list_chunks(d: Path) -> list[tuple[int, int]]:
    """(번호, 크기) 오름차순. 기록 중인 `.part` 는 제외."""
    out = []
    for f in d.iterdir():
        if f.is_file() and f.name.isdigit() and len(f.name) == 6:
            out.append((int(f.name), f.stat().st_size))
    return sorted(out)


def received_bytes(d: Path) -> int:
    return sum(sz for _n, sz in list_chunks(d))


def assemble(d: Path, expected_total: int | None) -> Path:
    """청크를 번호순으로 연결하여 `assembled` 를 생성한다. 번호에 누락이 있으면 실패."""
    chunks = list_chunks(d)
    if not chunks:
        raise SessionError("받은 청크가 없습니다")
    numbers = [n for n, _ in chunks]
    if numbers != list(range(1, len(numbers) + 1)):
        missing = sorted(set(range(1, numbers[-1] + 1)) - set(numbers))
        raise SessionError(f"빠진 청크가 있습니다: {missing[:10]}")
    total = sum(sz for _, sz in chunks)
    if expected_total is not None and expected_total > 0 and total != expected_total:
        raise SessionError(f"크기 불일치: 받은 {total} ≠ 선언 {expected_total}")

    out = d / ASSEMBLED_NAME
    with open(out, "wb") as dst:
        for n, _ in chunks:
            with open(chunk_path(d, n), "rb") as src:
                while True:
                    buf = src.read(1024 * 1024)
                    if not buf:
                        break
                    dst.write(buf)
        dst.flush()
        try:
            os.fsync(dst.fileno())
        except OSError:
            pass
    return out


def discard(root: Path, session_id: str) -> bool:
    d = session_dir(root, session_id)
    if not d.is_dir():
        return False
    stats = Stats()
    remove_within(d, root, stats)
    return stats.removed > 0


def last_activity(d: Path) -> float:
    """세션 디렉터리 내 가장 최근 mtime(청크 도착 시마다 갱신된다)."""
    latest = 0.0
    try:
        latest = d.stat().st_mtime
        for f in d.iterdir():
            try:
                if not f.is_symlink():
                    latest = max(latest, f.stat().st_mtime)
            except OSError:
                pass
    except OSError:
        pass
    return latest


def expire_sessions(root: Path, max_age_s: int = SESSION_TTL, now: float | None = None) -> Stats:
    """마지막 활동 후 `max_age_s` 경과한 세션 디렉터리를 삭제한다. `.uploads` 하위만 대상으로 한다."""
    stats = Stats()
    if root.name != SESSIONS_DIRNAME or not root.is_dir() or root.is_symlink():
        return stats
    now = now if now is not None else time.time()
    for d in root.iterdir():
        stats.scanned += 1
        if d.is_symlink():
            # 임시 영역에 심볼릭 링크가 존재하면 링크만 삭제한다(추적하지 않음)
            remove_within(d, root, stats)
            continue
        if not d.is_dir() or not _ID_RE.match(d.name):
            continue
        if now - last_activity(d) > max_age_s:
            remove_within(d, root, stats)
    return stats


def expires_at_iso(meta: dict) -> str:
    return datetime.fromtimestamp(float(meta.get("expires_at", 0)), tz=timezone.utc).isoformat()
