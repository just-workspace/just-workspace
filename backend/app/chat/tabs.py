"""채널 탭 — 메시지 · 파일 · 위키 + 더보기(회의 · 작업 · 탭 관리).

- GET  /api/chat/channels/{id}/tabs      탭 머리 요약(파일 수 · 연결 폴더 · 위키 페이지 · 예정 회의 수 · 열린 작업 수)
- PUT  /api/chat/channels/{id}/tabs      탭 관리 — 폴더·위키 페이지 연결/해제(채널 소유자·관리자·생성자)
- GET  /api/chat/channels/{id}/files     파일 탭 — 채널에 업로드한 파일(메시지) + 연결된 폴더 파일, 최신순
- GET  /api/chat/channels/{id}/meetings  회의 — 이 채널에 연결된 예정·진행 중 회의
- GET  /api/chat/channels/{id}/tasks     작업 — 이 채널에 연결된 작업(최상위, filter=open|mine|done + 칩 수)

추가 사항:
- 탭 순서·비활성화(layout) — 메시지는 항상 첫 번째이므로 저장하지 않는다. 변경 시 채널 멤버 전원에게 적용.
- 위키 탭은 스페이스 단위(wiki_space) — 연결 페이지만 있던 채널은 해당 페이지의 스페이스로 간주한다.
- 회의는 지난 회의(past)도 반환한다.

폴더 연결 = 해당 폴더를 채널에 공유(file_shares.shared_with_channel_id)하는 것 — 멤버는 공유받음 경로로 접근한다.
연결로 생성된 공유는 origin='channel_folder' 로 표시하며, 연결을 해제하거나 다른 폴더로 변경하면 해당 공유만 회수한다.
연결과 무관하게 설정된 공유(공유 창에서 동일 채널·사용자에게 직접 설정한 것)는 유지한다 — 규칙은 _made_by_link.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.chat import permissions as chat_perms
from app.chat import service as chat_service
from app.db.models import Channel, FileShare, Message, MeetingDB, TaskDB, User
from app.db.session import get_db

router = APIRouter(prefix="/api/chat/channels", tags=["chat-tabs"])

_FILES_LIMIT = 200
LINK_ORIGIN = "channel_folder"
_ACTIVE_MEETINGS = ("scheduled", "live")
_PAST_LIMIT = 10
# 메시지 뒤에 오는 탭(기본 순서). 메시지는 고정이므로 포함하지 않음.
TAB_KEYS = ("files", "wiki", "meetings", "tasks")


def _layout(ch: Channel) -> list[dict]:
    """저장된 순서·비활성화 정보를 읽어 [{key, visible}] 를 반환한다 — 알 수 없는 키는 제거하고 누락된 키는 기본 순서로 뒤에 추가한다."""
    order: list[str] = []
    hidden: set[str] = set()
    if ch.tab_layout:
        try:
            raw = json.loads(ch.tab_layout)
            order = [k for k in raw.get("order", []) if k in TAB_KEYS]
            hidden = {k for k in raw.get("hidden", []) if k in TAB_KEYS}
        except (ValueError, AttributeError):
            order, hidden = [], set()
    seen: list[str] = []
    for k in order + list(TAB_KEYS):
        if k not in seen:
            seen.append(k)
    return [{"key": k, "visible": k not in hidden} for k in seen]


async def _wiki_space(db: AsyncSession, ch: Channel) -> dict | None:
    from app.db.models import WikiPage, WikiSpace
    sid = ch.linked_wiki_space_id
    if not sid and ch.linked_wiki_page_id:
        page = await db.get(WikiPage, ch.linked_wiki_page_id)
        sid = page.space_id if page is not None else None
    if not sid:
        return None
    space = await db.get(WikiSpace, sid)
    if space is None:
        return None
    pages = (await db.execute(
        select(func.count()).select_from(WikiPage).where(WikiPage.space_id == sid)
    )).scalar_one()
    return {"id": space.id, "name": space.name, "pages": int(pages)}


async def _member_channel(db: AsyncSession, channel_id: str, user: User) -> Channel:
    ch = await db.get(Channel, channel_id)
    if ch is None:
        raise HTTPException(status_code=404, detail="채널을 찾을 수 없습니다")
    if not await chat_perms.allowed(db, user, "channel.view", ch):
        raise HTTPException(status_code=403, detail="채널 멤버가 아닙니다")
    return ch


def _folder_real(owner_id: str, vpath: str) -> Path | None:
    from app.files import router as files_router
    try:
        return files_router._owner_real(owner_id, vpath)
    except HTTPException:
        return None


async def _channel_share(db: AsyncSession, ch: Channel) -> FileShare | None:
    if not ch.linked_folder_owner_id or not ch.linked_folder_path:
        return None
    return (await db.execute(
        select(FileShare).where(
            FileShare.owner_id == ch.linked_folder_owner_id,
            FileShare.file_path == ch.linked_folder_path,
            FileShare.shared_with_channel_id == ch.id,
        )
    )).scalars().first()


def _made_by_link(row: FileShare) -> bool:
    """이 채널 공유가 폴더 연결로 생성된 것인지 판정한다 — 연결은 origin='channel_folder' 로 표시된다.

    표시가 없는 공유는 사용자가 설정한 것으로 간주하여 유지한다(회수보다 유지가 안전).
    """
    return row.origin == LINK_ORIGIN


async def _revoke_link_share(db: AsyncSession, ch: Channel) -> bool:
    """현재 연결된 폴더의 채널 공유 중 연결로 생성된 것을 삭제한다(사용자가 설정한 공유는 유지). 삭제한 경우 True."""
    row = await _channel_share(db, ch)
    if row is None or not _made_by_link(row):
        return False
    await db.delete(row)
    return True


def _folder_label(vpath: str) -> list[str]:
    parts = [p for p in vpath.strip("/").split("/") if p]
    if parts and parts[0] == "my":
        parts = parts[1:]
    return parts


async def _folder_info(db: AsyncSession, ch: Channel, user: User) -> dict | None:
    if not ch.linked_folder_owner_id or not ch.linked_folder_path:
        return None
    owner = await db.get(User, ch.linked_folder_owner_id)
    share = await _channel_share(db, ch)
    mine = ch.linked_folder_owner_id == user.id
    real = _folder_real(ch.linked_folder_owner_id, ch.linked_folder_path)
    return {
        "owner_id": ch.linked_folder_owner_id,
        "owner_name": (owner.display_name or owner.username) if owner else "",
        "path": ch.linked_folder_path if mine else None,
        "segments": _folder_label(ch.linked_folder_path),
        "share_id": share.id if share else None,
        "mine": mine,
        # 소유자가 채널 공유를 해제했거나 폴더가 삭제된 경우 멤버는 접근 불가
        "accessible": bool(real and real.is_dir() and (mine or share)),
        "can_write": bool(mine or (share and share.can_write)),
    }


def _folder_files(ch: Channel, info: dict | None) -> list[dict]:
    if not info or not info["accessible"]:
        return []
    real = _folder_real(ch.linked_folder_owner_id, ch.linked_folder_path)
    if real is None:
        return []
    out = []
    try:
        entries = sorted(real.iterdir(), key=lambda p: p.name)
    except OSError:
        return []
    from app.files import service as fs
    for p in entries:
        # 숨김 판정은 파일 모듈 한 곳에서 수행("@회의록.txt" 는 표시하고 @Recycle 같은 NAS 이름만 숨김)
        if fs.is_hidden_name(p.name) or not p.is_file():
            continue
        st = p.stat()
        if info["mine"]:
            url = f"/api/files/download?path={ch.linked_folder_path.rstrip('/')}/{p.name}"
            path = f"{ch.linked_folder_path.rstrip('/')}/{p.name}"
        else:
            url = f"/api/files/shared-with-me/{info['share_id']}/download?path={p.name}"
            path = f"shared-with-me/{info['share_id']}/{p.name}"
        out.append({
            "name": p.name,
            "size": st.st_size,
            "source": "folder",
            "who": info["owner_name"],
            "at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            "message_id": None,
            "url": url,
            "path": path,
        })
        if len(out) >= _FILES_LIMIT:
            break
    return out


async def _message_files(db: AsyncSession, channel_id: str) -> list[dict]:
    rows = (await db.execute(
        select(Message, User.display_name, User.username)
        .outerjoin(User, Message.sender_id == User.id)
        .where(Message.channel_id == channel_id, Message.message_type == "file", Message.is_deleted.is_(False))
        .order_by(Message.created_at.desc())
        .limit(_FILES_LIMIT)
    )).all()
    out = []
    for m, display, username in rows:
        try:
            meta = json.loads(m.file_meta or "{}")
        except ValueError:
            meta = {}
        at = m.created_at
        if at is not None and at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        out.append({
            "name": meta.get("filename") or m.content,
            "size": meta.get("size") or 0,
            "source": "message",
            "who": display or username or "",
            "at": at.isoformat() if at else None,
            "message_id": m.id,
            "url": meta.get("url"),
            "path": None,
        })
    return out


@router.get("/{channel_id}/tabs")
async def channel_tabs(channel_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ch = await _member_channel(db, channel_id, user)
    folder = await _folder_info(db, ch, user)
    msg_count = (await db.execute(
        select(func.count()).select_from(Message).where(
            Message.channel_id == channel_id, Message.message_type == "file", Message.is_deleted.is_(False),
        )
    )).scalar_one()
    wiki = None
    if ch.linked_wiki_page_id:
        from app.db.models import WikiPage
        page = await db.get(WikiPage, ch.linked_wiki_page_id)
        if page is not None:
            wiki = {"id": page.id, "title": page.title, "space_id": page.space_id}
    meetings = (await db.execute(
        select(func.count()).select_from(MeetingDB).where(
            MeetingDB.chat_channel_id == channel_id, MeetingDB.status.in_(_ACTIVE_MEETINGS),
        )
    )).scalar_one()
    tasks = (await db.execute(
        select(func.count()).select_from(TaskDB).where(
            TaskDB.channel_id == channel_id, TaskDB.status != "done", TaskDB.parent_id.is_(None),
        )
    )).scalar_one()
    can_manage = ch.type != "dm" and await chat_perms.allowed(db, user, "tabs.manage", ch)
    return {
        "files_count": int(msg_count) + len(_folder_files(ch, folder)),
        "folder": folder,
        "wiki": wiki,
        "wiki_space": await _wiki_space(db, ch),
        "meetings_upcoming": int(meetings),
        "tasks_open": int(tasks),
        "layout": _layout(ch),
        "can_manage": can_manage,
    }


class TabsLayout(BaseModel):
    # 메시지 뒤 탭 순서(files·wiki·meetings·tasks 모두)와 비활성화한 탭
    order: list[str]
    hidden: list[str] = []


class TabsUpdate(BaseModel):
    # 전송된 필드만 변경. null = 연결 해제
    folder_path: str | None = None
    wiki_page_id: str | None = None
    wiki_space_id: str | None = None
    layout: TabsLayout | None = None


@router.put("/{channel_id}/tabs")
async def update_channel_tabs(
    channel_id: str, body: TabsUpdate,
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    ch = await _member_channel(db, channel_id, user)
    if ch.type == "dm":
        raise HTTPException(status_code=400, detail="1:1 대화에는 탭을 연결할 수 없습니다")
    if not await chat_perms.allowed(db, user, "tabs.manage", ch):
        raise HTTPException(status_code=403, detail="채널 관리자만 탭을 변경할 수 있습니다")
    fields = body.model_fields_set

    if "folder_path" in fields:
        vp = (body.folder_path or "").strip().strip("/")
        same = bool(vp) and ch.linked_folder_owner_id == user.id and ch.linked_folder_path == vp
        if not vp:
            # 연결 해제 — 연결로 생성된 채널 공유도 회수(사용자가 직접 설정한 공유는 유지)
            await _revoke_link_share(db, ch)
            ch.linked_folder_owner_id = None
            ch.linked_folder_path = None
        else:
            from app.files import service as fs
            if fs.owner_relpath_from_my(vp) is None:
                raise HTTPException(status_code=400, detail="내 파일(my/)의 폴더만 연결할 수 있습니다")
            real = _folder_real(user.id, vp)
            if real is None or not real.is_dir():
                raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다")
            exists = (await db.execute(
                select(FileShare).where(
                    FileShare.owner_id == user.id, FileShare.file_path == vp,
                    FileShare.shared_with_channel_id == ch.id,
                )
            )).scalars().first()
            if not same:
                # 다른 폴더로 변경 시 기존 폴더에 연결로 생성된 공유는 회수(동일 폴더 재연결은 유지)
                await _revoke_link_share(db, ch)
            if exists is None:
                db.add(FileShare(owner_id=user.id, file_path=vp, shared_with_channel_id=ch.id, can_write=False,
                                 role="view", origin=LINK_ORIGIN))
            # 기존 공유(사용자가 설정한 것)는 표시를 변경하지 않음 — 연결을 해제해도 유지됨
            ch.linked_folder_owner_id = user.id
            ch.linked_folder_path = vp

    if "wiki_page_id" in fields:
        pid = body.wiki_page_id or None
        if pid:
            from app.db.models import WikiPage
            from app.wiki import service as wiki_service
            page = await db.get(WikiPage, pid)
            if page is None:
                raise HTTPException(status_code=404, detail="위키 페이지를 찾을 수 없습니다")
            if not user.is_admin and not await wiki_service.get_user_role(db, page.space_id, str(user.id)):
                raise HTTPException(status_code=403, detail="볼 수 있는 위키 페이지만 연결할 수 있습니다")
        ch.linked_wiki_page_id = pid

    if "wiki_space_id" in fields:
        sid = body.wiki_space_id or None
        if sid:
            from app.db.models import WikiSpace
            from app.wiki import service as wiki_service
            if await db.get(WikiSpace, sid) is None:
                raise HTTPException(status_code=404, detail="위키 스페이스를 찾을 수 없습니다")
            if not user.is_admin and not await wiki_service.get_user_role(db, sid, str(user.id)):
                raise HTTPException(status_code=403, detail="볼 수 있는 스페이스만 연결할 수 있습니다")
        ch.linked_wiki_space_id = sid
        if sid is None:
            # 스페이스 연결 해제 시 기존 페이지 연결도 함께 해제(위키 탭 = 연결 없음)
            ch.linked_wiki_page_id = None

    if "layout" in fields and body.layout is not None:
        order = body.layout.order
        bad = [k for k in order + body.layout.hidden if k not in TAB_KEYS]
        if bad or len(set(order)) != len(order) or set(order) != set(TAB_KEYS):
            raise HTTPException(status_code=400, detail="탭 순서가 올바르지 않습니다")
        ch.tab_layout = json.dumps({"order": order, "hidden": sorted(set(body.layout.hidden))})

    await db.commit()
    return await channel_tabs(channel_id, user=user, db=db)


@router.get("/{channel_id}/files")
async def channel_files(channel_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ch = await _member_channel(db, channel_id, user)
    folder = await _folder_info(db, ch, user)
    items = (await _message_files(db, channel_id)) + _folder_files(ch, folder)
    items.sort(key=lambda x: x["at"] or "", reverse=True)
    return {"items": items[:_FILES_LIMIT], "folder": folder}


@router.get("/{channel_id}/meetings")
async def channel_meetings(channel_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _member_channel(db, channel_id, user)
    rows = (await db.execute(
        select(MeetingDB).where(MeetingDB.chat_channel_id == channel_id, MeetingDB.status.in_(_ACTIVE_MEETINGS))
        .order_by(MeetingDB.scheduled_at.is_(None), MeetingDB.scheduled_at, MeetingDB.created_at)
    )).scalars().all()

    def _iso(d):
        if d is None:
            return None
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()

    past = (await db.execute(
        select(MeetingDB).where(MeetingDB.chat_channel_id == channel_id, MeetingDB.status == "ended")
        .order_by(func.coalesce(MeetingDB.ended_at, MeetingDB.scheduled_at, MeetingDB.created_at).desc())
        .limit(_PAST_LIMIT)
    )).scalars().all()

    def _utc(d):
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

    def _one(r: MeetingDB) -> dict:
        actual = None
        if r.started_at and r.ended_at:
            actual = max(0, int((_utc(r.ended_at) - _utc(r.started_at)).total_seconds() // 60))
        return {
            "id": r.id,
            "title": r.title or r.room_name,
            "status": r.status,
            "scheduled_at": _iso(r.scheduled_at),
            "duration_minutes": r.duration_minutes,
            "started_at": _iso(r.started_at),
            "ended_at": _iso(r.ended_at),
            # 지난 회의의 실제 소요 시간(분) — 시작·종료 기록이 있는 경우에만
            "actual_minutes": actual,
            "host_name": r.host_display_name,
            "is_host": r.host_user_id == user.id,
            # 채널 멤버는 초대 링크로 입장
            "join_path": f"/meetings/join/{r.share_token}",
        }

    return {"items": [_one(r) for r in rows], "past": [_one(r) for r in past]}


@router.get("/{channel_id}/tasks")
async def channel_tasks(
    channel_id: str, filter: str = "open",
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """filter: open(열린 작업, 기본) · mine(나에게 배정된 열린 작업) · done(완료). counts = 칩 숫자."""
    await _member_channel(db, channel_id, user)
    if filter not in ("open", "mine", "done"):
        raise HTTPException(status_code=400, detail="filter 는 open·mine·done 중 하나입니다")
    top = (TaskDB.channel_id == channel_id, TaskDB.parent_id.is_(None))
    conds = {
        "open": (*top, TaskDB.status != "done"),
        "mine": (*top, TaskDB.status != "done", TaskDB.assignee_id == user.id),
        "done": (*top, TaskDB.status == "done"),
    }
    counts = {}
    for k, c in conds.items():
        counts[k] = int((await db.execute(select(func.count()).select_from(TaskDB).where(*c))).scalar_one())
    order = ((TaskDB.updated_at.desc(),) if filter == "done"
             else (TaskDB.due_date.is_(None), TaskDB.due_date, TaskDB.created_at.desc()))
    rows = (await db.execute(
        select(TaskDB).where(*conds[filter]).order_by(*order).limit(200)
    )).scalars().all()
    ids = {t.assignee_id for t in rows if t.assignee_id} | {t.user_id for t in rows}
    names = {}
    if ids:
        for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all():
            names[u.id] = u.display_name or u.username
    return {"items": [{
        "id": t.id,
        "title": t.title,
        "status": t.status,
        "priority": t.priority,
        "due_date": (t.due_date if (t.due_date is None or t.due_date.tzinfo) else t.due_date.replace(tzinfo=timezone.utc)).isoformat() if t.due_date else None,
        "assignee_name": names.get(t.assignee_id) if t.assignee_id else None,
        "assignee_id": t.assignee_id,
        "owner_name": names.get(t.user_id, ""),
        # 생성자·담당자만 작업 화면에서 열 수 있음(완료 체크도 동일)
        "can_open": user.id in (t.user_id, t.assignee_id),
    } for t in rows], "counts": counts}
