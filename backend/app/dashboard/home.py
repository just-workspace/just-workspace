"""홈 대시보드 카드 조회 — 이어서 하기 · 팀 · 내 저장 공간.

- GET /api/dashboard/continue?tab=recent|favorites|shared : "이어서 하기" 한 목록(파일·문서·시트·위키·채널·게시글)
    recent    = 최근 연 파일(files_recent) + 내가 쓰거나 고친 위키 문서 + 안 읽은 채널
    favorites = 파일 즐겨찾기(file_stars) + 게시글 북마크(post_bookmarks)
                ※ 모듈별 즐겨찾기 현황(2026-10-18): 파일 별표·게시글 북마크만 개인 즐겨찾기가 있다.
                  위키 is_pinned 는 공간 고정(모두에게), 채팅 고정은 채널 고정, 연락처 즐겨찾기는 사람이라 넣지 않는다.
    shared    = 나에게 공유된 파일·폴더(files shared-with-me — 사람·채널 공유)
  행: {key, kind, name, to, reason, actor?, n?, at, path?, is_dir?}
    reason: opened · edited · edited_by_me · edited_by · shared_by · unread · starred · bookmarked
  권한: 기존 목록 API 를 그대로 불러 쓴다 — 지워졌거나 권한이 사라진 항목은 그 API 가 이미 뺀다.
- GET /api/dashboard/team?limit=6 : 최근 30일 자주 대화한 사람(DM ×3 + 내가 글 쓴 채널에서 그 사람 글 ×1) + 상태
- GET /api/dashboard/storage      : 내 저장 공간 — 사용량 · 할당(0 = 제한 없음) · 그중 공유한 파일 크기
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import (
    Board, Channel, ChannelMember, FileShare, Message, Post, PostBookmark, User, WikiPage, WikiPageVersion,
    WikiSpace, WikiSpaceMember,
)
from app.db.session import get_db
from app.modules.registry import is_module_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

TABS = ("recent", "favorites", "shared")


def _iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()


def _parent(path: str) -> str:
    i = path.rfind("/")
    return path[:i] if i > 0 else path


def _file_row(it: dict, reason: str, at: str | None, actor: str | None = None) -> dict:
    path = it.get("path") or ""
    is_dir = bool(it.get("is_dir"))
    return {
        "key": f"file:{path}", "kind": "file", "name": it.get("name") or path.rsplit("/", 1)[-1],
        "path": path, "is_dir": is_dir,
        "to": f"/files?path={path if is_dir else _parent(path)}",
        "reason": reason, "actor": actor, "at": at,
    }


async def _recent_files(db: AsyncSession, user: User, limit: int) -> list[dict]:
    if not is_module_enabled("files"):
        return []
    from app.files.router import list_recent

    try:
        items = (await list_recent(limit=limit, user=user, db=db))["items"]
    except Exception as e:
        logger.debug("최근 파일 실패: %s", e)
        return []
    out = []
    for it in items:
        acc, mod = it.get("accessed_at"), it.get("modified_at")
        # 연 뒤(또는 연 무렵)에 내용이 바뀌었으면 "편집", 아니면 "열어 봄"
        edited = bool(acc and mod and mod >= acc[:19])
        out.append(_file_row(it, "edited" if edited else "opened", mod if edited else acc))
    return out


async def _recent_wiki(db: AsyncSession, user_id: str, limit: int) -> list[dict]:
    """내가 쓰거나 고친 적 있는, 지금도 볼 수 있는 위키 문서 — 고친 시각 순. 마지막으로 고친 사람을 이유로."""
    if not is_module_enabled("wiki"):
        return []
    visible = (
        (WikiSpace.visibility == "public")
        | (WikiSpace.owner_id == user_id)
        | (WikiSpace.id.in_(select(WikiSpaceMember.space_id).where(WikiSpaceMember.user_id == user_id)))
    )
    touched = (WikiPage.author_id == user_id) | WikiPage.id.in_(
        select(WikiPageVersion.page_id).where(WikiPageVersion.author_id == user_id)
    )
    rows = (await db.execute(
        select(WikiPage.id, WikiPage.title, WikiPage.space_id, WikiPage.updated_at, WikiPage.author_id)
        .join(WikiSpace, WikiSpace.id == WikiPage.space_id)
        .where(visible, touched)
        .order_by(WikiPage.updated_at.desc())
        .limit(limit)
    )).all()
    if not rows:
        return []
    # 마지막으로 고친 사람 = 가장 큰 버전 번호의 작성자(버전이 없으면 문서 작성자)
    ids = [r.id for r in rows]
    last_ver = (
        select(WikiPageVersion.page_id, func.max(WikiPageVersion.version_number).label("vn"))
        .where(WikiPageVersion.page_id.in_(ids)).group_by(WikiPageVersion.page_id).subquery()
    )
    editors = {
        pid: aid for pid, aid in (await db.execute(
            select(WikiPageVersion.page_id, WikiPageVersion.author_id)
            .join(last_ver, and_(last_ver.c.page_id == WikiPageVersion.page_id, last_ver.c.vn == WikiPageVersion.version_number))
        )).all()
    }
    who_ids = {editors.get(r.id) or r.author_id for r in rows}
    names = {u.id: (u.display_name or u.username) for u in (await db.execute(select(User).where(User.id.in_(who_ids)))).scalars().all()}
    out = []
    for r in rows:
        editor = editors.get(r.id) or r.author_id
        mine = editor == user_id
        out.append({
            "key": f"wiki:{r.id}", "kind": "wiki", "name": r.title,
            "to": f"/wiki?space={r.space_id}&page={r.id}",
            "reason": "edited_by_me" if mine else "edited_by", "actor": None if mine else names.get(editor),
            "at": _iso(r.updated_at),
        })
    return out


async def _unread_channels(db: AsyncSession, user_id: str, limit: int) -> list[dict]:
    if not is_module_enabled("chat"):
        return []
    from app.chat.service import get_user_channels

    try:
        chans = await get_user_channels(db, user_id)
    except Exception as e:
        logger.debug("채널 목록 실패: %s", e)
        await db.rollback()
        return []
    rows = [c for c in chans if (c.get("unread_count") or 0) > 0 and not c.get("is_archived")]
    rows.sort(key=lambda c: _iso((c.get("last_message") or {}).get("created_at")) or "", reverse=True)
    out = []
    for c in rows[:limit]:
        lm = c.get("last_message") or {}
        out.append({
            "key": f"channel:{c['id']}", "kind": "dm" if c.get("type") == "dm" else "channel",
            "name": c.get("name") or "", "to": f"/chat?channel={c['id']}",
            "reason": "unread", "n": int(c.get("unread_count") or 0),
            "at": _iso(lm.get("created_at")) if isinstance(lm.get("created_at"), datetime) else lm.get("created_at"),
        })
    return out


async def _favorites(db: AsyncSession, user: User, limit: int) -> list[dict]:
    out: list[dict] = []
    if is_module_enabled("files"):
        from app.files.router import list_stars

        try:
            for it in (await list_stars(user=user, db=db))["items"]:
                if it.get("exists"):
                    out.append(_file_row(it, "starred", it.get("starred_at")))
        except Exception as e:
            logger.debug("파일 즐겨찾기 실패: %s", e)
    if is_module_enabled("board"):
        rows = (await db.execute(
            select(Post.id, Post.title, Post.board_id, Board.name, PostBookmark.created_at)
            .join(PostBookmark, PostBookmark.post_id == Post.id)
            .join(Board, Board.id == Post.board_id)
            .where(PostBookmark.user_id == user.id, Post.is_deleted == False)  # noqa: E712
            .order_by(PostBookmark.created_at.desc()).limit(limit)
        )).all()
        for pid, title, bid, bname, at in rows:
            out.append({
                "key": f"post:{pid}", "kind": "post", "name": title, "to": f"/board/{bid}/{pid}",
                "reason": "bookmarked", "actor": bname, "at": _iso(at),
            })
    return out


async def _shared(db: AsyncSession, user: User) -> list[dict]:
    if not is_module_enabled("files"):
        return []
    from app.files.router import shared_with_me

    try:
        items = (await shared_with_me(user=user, db=db))["items"]
    except Exception as e:
        logger.debug("공유받은 파일 실패: %s", e)
        return []
    out = []
    for it in items:
        sid = it["share_id"]
        is_dir = bool(it.get("is_dir"))
        out.append({
            "key": f"shared:{sid}", "kind": "file", "name": it.get("name") or "",
            "path": f"shared-with-me/{sid}", "is_dir": is_dir,
            "to": f"/files?path=shared-with-me/{sid}" if is_dir else "/files?view=shared-with-me",
            "reason": "shared_by", "actor": (it.get("owner") or {}).get("display_name"),
            "at": it.get("shared_at") or it.get("modified_at"),
        })
    return out


def _by_time(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda r: r.get("at") or "", reverse=True)


@router.get("/continue")
async def continue_items(
    tab: str = Query("recent"),
    limit: int = Query(8, ge=1, le=20),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이어서 하기 — 탭 하나의 목록(시각 최신순)."""
    if tab not in TABS:
        tab = "recent"
    uid = str(user.id)
    if tab == "recent":
        rows = await _recent_files(db, user, limit) + await _recent_wiki(db, uid, limit) + await _unread_channels(db, uid, 3)
    elif tab == "favorites":
        rows = await _favorites(db, user, limit)
    else:
        rows = await _shared(db, user)
    return {"tab": tab, "items": _by_time(rows)[:limit]}


# ─── 팀 ───

async def frequent_people(db: AsyncSession, user_id: str, limit: int = 6, days: int = 30) -> list[tuple[str, int]]:
    """최근 `days` 일 자주 대화한 사람 [(user_id, 점수)] — DM 메시지 ×3, 내가 글 쓴 채널의 그 사람 글 ×1."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
    score: dict[str, int] = {}
    # DM: 상대의 글과 내 글 모두 그 상대 점수로
    dm_ids = [r[0] for r in (await db.execute(
        select(Channel.id).where(Channel.type == "dm", Channel.id.in_(mine))
    )).all()]
    if dm_ids:
        partners = {
            ch: uid for ch, uid in (await db.execute(
                select(ChannelMember.channel_id, ChannelMember.user_id)
                .where(ChannelMember.channel_id.in_(dm_ids), ChannelMember.user_id != user_id)
            )).all()
        }
        counts = (await db.execute(
            select(Message.channel_id, func.count(Message.id))
            .where(Message.channel_id.in_(dm_ids), Message.created_at >= since, Message.is_deleted == False)  # noqa: E712
            .group_by(Message.channel_id)
        )).all()
        for ch, n in counts:
            p = partners.get(ch)
            if p:
                score[p] = score.get(p, 0) + 3 * int(n)
    # 내가 최근 글을 쓴 (DM 아닌) 채널에서 남이 쓴 글
    active = select(Message.channel_id).where(
        Message.sender_id == user_id, Message.created_at >= since, Message.channel_id.in_(mine),
    ).distinct()
    rows = (await db.execute(
        select(Message.sender_id, func.count(Message.id))
        .join(Channel, Channel.id == Message.channel_id)
        .where(
            Message.channel_id.in_(active), Channel.type != "dm", Message.created_at >= since,
            Message.is_deleted == False, Message.sender_id.is_not(None), Message.sender_id != user_id,  # noqa: E712
        )
        .group_by(Message.sender_id)
    )).all()
    for sid, n in rows:
        score[sid] = score.get(sid, 0) + int(n)
    return sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))[: max(limit * 2, limit)]


@router.get("/team")
async def team(
    limit: int = Query(6, ge=1, le=12),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """자주 대화한 사람(활성 계정만) + 지금 상태(채팅 프레즌스와 같은 값)."""
    if not is_module_enabled("chat"):
        return {"items": []}
    ranked = await frequent_people(db, str(user.id), limit)
    if not ranked:
        return {"items": []}
    users = {u.id: u for u in (await db.execute(
        select(User).where(User.id.in_([uid for uid, _ in ranked]), User.is_active == True)  # noqa: E712
    )).scalars().all()}
    try:
        from app.chat.presence import presence_snapshot

        statuses = (await presence_snapshot(db))["statuses"]
    except Exception as e:  # Redis 가 없으면 상태 없이(오프라인으로) 보인다
        logger.debug("프레즌스 실패: %s", e)
        statuses = {}
    out = []
    for uid, _n in ranked:
        u = users.get(uid)
        if not u:
            continue
        st = statuses.get(uid) or {}
        out.append({
            "id": u.id, "username": u.username, "display_name": u.display_name or u.username,
            "avatar_url": u.avatar_url, "state": st.get("state") or "offline",
            "emoji": st.get("emoji") or "", "text": st.get("text") or "",
        })
        if len(out) >= limit:
            break
    return {"items": out}


# ─── 내 저장 공간 ───

@router.get("/storage")
async def my_storage(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """{used, quota, shared, disk_total} — 바이트. quota 0 = 제한 없음. shared = 내가 사람·채널·링크로 공유한 항목 크기."""
    from app.files import quota as file_quota
    from app.files import service as fs
    from app.files.access import owner_real

    used = await file_quota.personal_usage(user.id)
    quota_gb = await file_quota.get_user_quota_gb(db)
    paths = {p for (p,) in (await db.execute(
        select(FileShare.file_path).where(FileShare.owner_id == user.id).limit(500)
    )).all()}
    # 겹치는 경로(폴더와 그 안 파일)는 바깥 것만 센다
    roots = sorted({p.strip("/") for p in paths if p})
    outer = [p for p in roots if not any(p != q and p.startswith(q + "/") for q in roots)]

    def _size() -> int:
        n = 0
        for p in outer:
            try:
                real = owner_real(user.id, p)
            except Exception:
                continue
            if real.is_dir():
                n += fs.get_dir_size(real)
            elif real.is_file():
                n += real.stat().st_size
        return n

    shared = await asyncio.to_thread(_size)
    disk_total = 0
    try:
        import shutil

        disk_total = (await asyncio.to_thread(shutil.disk_usage, fs.STORAGE_ROOT)).total
    except OSError:
        pass
    return {"used": used, "quota": quota_gb * file_quota.GB, "shared": min(shared, used), "disk_total": disk_total}


# ─── 둘러볼 채널(신규 사용자) ───

async def discover_channels(db: AsyncSession, user_id: str, limit: int = 3) -> list[dict]:
    """내가 아직 안 들어간 공개 채널(보관 제외) — 멤버 많은 순, 같으면 오늘 메시지 많은 순."""
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
    members = func.count(func.distinct(ChannelMember.user_id)).label("members")
    rows = (await db.execute(
        select(Channel.id, Channel.name, Channel.description, members)
        .join(ChannelMember, ChannelMember.channel_id == Channel.id)
        .where(Channel.type == "public", Channel.is_archived == False, Channel.id.not_in(mine))  # noqa: E712
        .group_by(Channel.id, Channel.name, Channel.description)
        .order_by(members.desc(), Channel.name)
        .limit(limit * 3)
    )).all()
    if not rows:
        return []
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    today = dict((await db.execute(
        select(Message.channel_id, func.count(Message.id))
        .where(Message.channel_id.in_([r.id for r in rows]), Message.created_at >= since, Message.is_deleted == False)  # noqa: E712
        .group_by(Message.channel_id)
    )).all())
    items = [{"id": r.id, "name": r.name, "description": r.description or "", "members": int(r.members),
              "messages_today": int(today.get(r.id, 0))} for r in rows]
    items.sort(key=lambda x: (-x["members"], -x["messages_today"], x["name"]))
    return items[:limit]


@router.get("/discover-channels")
async def get_discover_channels(
    limit: int = Query(3, ge=1, le=10),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not is_module_enabled("chat"):
        return {"items": []}
    return {"items": await discover_channels(db, str(user.id), limit)}


@router.post("/discover-channels/{channel_id}/join")
async def join_discover_channel(
    channel_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """둘러볼 채널 [참여] — 공개 채널(보관 안 됨)에만 나를 멤버로 넣는다. 비공개·DM 은 404(있는지도 알리지 않음)."""
    from fastapi import HTTPException

    if not is_module_enabled("chat"):
        raise HTTPException(status_code=404, detail="채널을 찾을 수 없습니다")
    ch = await db.get(Channel, channel_id)
    if ch is None or ch.type != "public" or ch.is_archived:
        raise HTTPException(status_code=404, detail="채널을 찾을 수 없습니다")
    from app.chat import service as chat_service

    added = await chat_service.add_members(db, channel_id, [str(user.id)])
    if added:
        try:
            from app.realtime.socket import manager

            await manager.notify_channels_changed([str(user.id)])
        except Exception as e:  # 실시간 알림 실패는 참여를 되돌리지 않는다
            logger.debug("채널 목록 갱신 알림 실패: %s", e)
    return {"ok": True, "channel_id": channel_id, "joined": bool(added)}
