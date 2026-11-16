"""파일 활동 기록·최근 열람·소유자 조회 보조.

기록 실패는 본 동작(업로드·이동…)을 차단하지 않는다 — 별도 세션으로 기록하고 예외는 무시한다.

내려받기(/download)는 기록하지 않는다: 데스크톱 동기화 클라이언트가 파일마다 호출하므로
기록하면 활동·최근 목록이 동기화 트래픽으로 채워진다. "열람"은 미리보기·공유 링크·
`POST /api/files/recent`(프런트가 파일을 열 때 호출)로 기록한다.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.db.models import FileActivity, FileRecent, FileStar, User

logger = logging.getLogger(__name__)

WRITE_ACTIONS = ("upload", "edit", "create", "copy", "version_restore")


def canonical_key(vp: str, user: User) -> str | None:
    """사용자 가상경로 → 소유자 기준 정규 키. 알 수 없는 루트이면 None."""
    vp = (vp or "").strip("/")
    if vp == "my":
        return f"users/{user.id}"
    if vp.startswith("my/"):
        return f"users/{user.id}/{vp[3:]}"
    if vp == "shared" or vp.startswith("shared/"):
        return vp
    if vp.startswith("users/") and getattr(user, "is_admin", False):
        return vp
    return None


def owner_key(owner_id: str, owner_vpath: str) -> str | None:
    """공유(FileShare) 의 소유자 경로(my/..) → 정규 키."""
    vp = (owner_vpath or "").strip("/")
    if vp == "my":
        return f"users/{owner_id}"
    if vp.startswith("my/"):
        return f"users/{owner_id}/{vp[3:]}"
    return None


def owner_id_from_key(key: str) -> str | None:
    parts = key.split("/")
    if len(parts) >= 2 and parts[0] == "users":
        return parts[1]
    return None


async def _session():
    from app.db.session import async_session
    return async_session()


async def record(path_key: str | None, user_id: str | None, action: str,
                 detail: dict | None = None, actor_name: str | None = None, db=None) -> None:
    if not path_key:
        return
    row = FileActivity(
        path_key=path_key[:1024], user_id=user_id, action=action,
        actor_name=actor_name, detail=json.dumps(detail, ensure_ascii=False) if detail else None,
    )
    try:
        if db is not None:
            db.add(row)
            await db.commit()
            return
        async with await _session() as s:
            s.add(row)
            await s.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("파일 활동 기록 실패(%s %s): %s", action, path_key, e)


async def touch_recent(user_id: str, path: str, name: str, db=None) -> None:
    now = datetime.now(timezone.utc)
    path = path.strip("/")[:1024]

    async def _do(s):
        res = await s.execute(
            update(FileRecent).where(FileRecent.user_id == user_id, FileRecent.path == path)
            .values(accessed_at=now, name=name[:512])
        )
        if not res.rowcount:
            s.add(FileRecent(user_id=user_id, path=path, name=name[:512], accessed_at=now))
        await s.commit()

    try:
        if db is not None:
            await _do(db)
            return
        async with await _session() as s:
            await _do(s)
    except Exception as e:  # noqa: BLE001
        logger.debug("최근 열람 기록 실패(%s): %s", path, e)


async def move_prefix(user: User, old_vp: str, new_vp: str,
                      old_key: str | None = None, new_key: str | None = None) -> None:
    """이름 변경·이동 후 활동·즐겨찾기·최근 기록의 경로를 갱신한다(실패 시 무시).

    old_key/new_key 가 주어지면 활동 기록은 해당 정규 키로 이전한다(공유받은 경로 — 소유자 기준 키).
    """
    old_vp, new_vp = old_vp.strip("/"), new_vp.strip("/")
    ok = old_key or canonical_key(old_vp, user)
    nk = new_key or canonical_key(new_vp, user)
    try:
        async with await _session() as s:
            if ok and nk and ok != nk:
                rows = (await s.execute(
                    select(FileActivity).where(
                        (FileActivity.path_key == ok) | FileActivity.path_key.like(ok + "/%")
                    )
                )).scalars().all()
                for r in rows:
                    r.path_key = nk + r.path_key[len(ok):]
            for model in (FileStar, FileRecent):
                rows = (await s.execute(
                    select(model).where(
                        model.user_id == user.id,
                        (model.path == old_vp) | model.path.like(old_vp + "/%"),
                    )
                )).scalars().all()
                for r in rows:
                    r.path = new_vp + r.path[len(old_vp):]
            await s.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("경로 이동 기록 갱신 실패(%s → %s): %s", old_vp, new_vp, e)


async def first_creators(db, keys: list[str]) -> dict[str, str]:
    """정규 키별 최초 생성(업로드) 사용자 id."""
    if not keys:
        return {}
    res = await db.execute(
        select(FileActivity.path_key, FileActivity.user_id)
        .where(FileActivity.path_key.in_(keys), FileActivity.action.in_(("upload", "create", "mkdir", "copy")))
        .order_by(FileActivity.created_at)
    )
    out: dict[str, str] = {}
    for k, uid in res.all():
        if k not in out and uid:
            out[k] = uid
    return out


async def user_names(db, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i and not i.startswith("guest-")}
    if not ids:
        return {}
    res = await db.execute(select(User.id, User.display_name, User.username).where(User.id.in_(list(ids))))
    return {i: (d or u or "?") for i, d, u in res.all()}


async def version_authors(db, path_key: str, version_ms: list[int]) -> tuple[dict[int, dict], dict | None]:
    """각 버전(스냅샷 시각) 내용의 작성자 = 해당 시각 직전의 마지막 쓰기 기록.

    반환: ({version_ms: {"id","name"}}, 현재본 작성자)
    """
    res = await db.execute(
        select(FileActivity.user_id, FileActivity.actor_name, FileActivity.created_at)
        .where(FileActivity.path_key == path_key, FileActivity.action.in_(WRITE_ACTIONS))
        .order_by(FileActivity.created_at)
    )
    writes = []
    for uid, actor, at in res.all():
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        writes.append((int(at.timestamp() * 1000), uid, actor))
    names = await user_names(db, {w[1] for w in writes if w[1]})

    def _who(uid, actor):
        if not uid and not actor:
            return None
        return {"id": uid, "name": names.get(uid) or actor or uid}

    out: dict[int, dict] = {}
    for v in version_ms:
        prev = [w for w in writes if w[0] <= v]
        if prev:
            w = prev[-1]
            who = _who(w[1], w[2])
            if who:
                out[v] = who
    current = _who(writes[-1][1], writes[-1][2]) if writes else None
    return out, current
