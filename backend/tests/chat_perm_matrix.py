"""채팅 권한 동작 매트릭스 — 스냅샷 테스트(test_chat_perm_snapshot)와 권한 엔진 그림자/강제 비교
(test_chat_perm_engine)가 공용으로 사용한다. pytest 가 직접 수집하지 않는 보조 모듈.

세계(world) 하나를 SQLite 파일로 1회 생성하고, 경우마다 해당 파일을 복사하여 새 DB 로 연다
(채널 삭제처럼 상태를 변경하는 동작이 다음 경우에 영향을 주지 않도록).

행위자(actor):
  own  — 일반 채널 owner(채널을 만든 사람)            · DM 에서는 member
  adm  — 일반 채널 admin                              · DM 비멤버
  mem  — 일반 채널 member                             · DM 에서는 member
  out  — 어느 채널에도 멤버가 아님
  gad  — 전역 관리자(is_admin), 멤버 아님
  gam  — 전역 관리자(is_admin), 일반 채널 member       · DM 비멤버
채널: pub(공개) · prv(비공개) · arc(보관된 공개) · voi(공개 음성) · dm(own↔mem)
메시지: 채널마다 행위자 전원이 작성한 글 m_<actor>_<ch> 가 하나씩 존재한다(현재는 비멤버도 본인 글 수정·삭제가
가능하다 — 탈퇴한 채널의 본인 글 — 해당 동작까지 고정한다). m_mem_<ch> 가 기본 대상 글(스레드 루트).
"""

from __future__ import annotations

import os
import shutil
import tempfile
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

import app.main  # noqa: F401 — 모든 모델을 메타데이터에 등록
from app.db.models import Base, Channel, ChannelMember, Message, User

ACTORS = ("own", "adm", "mem", "out", "gad", "gam")
CHANNELS = ("pub", "prv", "arc", "voi", "dm")
GLOBAL_ADMINS = {"gad", "gam"}

# 채널별 멤버와 채널 역할
MEMBERSHIP: dict[str, dict[str, str]] = {
    ch: {"own": "owner", "adm": "admin", "mem": "member", "gam": "member"}
    for ch in ("pub", "prv", "arc", "voi")
}
MEMBERSHIP["dm"] = {"own": "member", "mem": "member"}


def role_class(ch: str, actor: str) -> str:
    """owner|admin|member|none — 기대값 표의 열."""
    return MEMBERSHIP[ch].get(actor, "none")


def user_ns(actor: str) -> SimpleNamespace:
    return SimpleNamespace(id=actor, username=actor, display_name=actor.upper(),
                           is_admin=actor in GLOBAL_ADMINS, avatar_url=None)


def _build_template(path: str) -> None:
    eng = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        for a in ACTORS + ("new",):
            s.add(User(id=a, username=a, email=f"{a}@x", password_hash="x", display_name=a.upper(),
                       is_admin=a in GLOBAL_ADMINS, is_active=True))
        s.flush()
        for ch in CHANNELS:
            s.add(Channel(
                id=ch, name=f"{ch}-room", type={"prv": "private", "dm": "dm"}.get(ch, "public"),
                created_by="own", is_archived=(ch == "arc"), is_voice=True if ch == "voi" else None,
            ))
        s.flush()
        for ch, members in MEMBERSHIP.items():
            for uid, role in members.items():
                s.add(ChannelMember(channel_id=ch, user_id=uid, role=role))
        s.flush()
        for ch in CHANNELS:
            for a in ACTORS:
                s.add(Message(id=f"m_{a}_{ch}", channel_id=ch, sender_id=a, content=f"hello from {a}",
                              message_type="text"))
                s.flush()
        s.commit()
    eng.dispose()


_TEMPLATE: str | None = None


def template_path() -> str:
    global _TEMPLATE
    if _TEMPLATE is None:
        d = tempfile.mkdtemp(prefix="jw-perm-tpl-")
        _TEMPLATE = os.path.join(d, "world.db")
        _build_template(_TEMPLATE)
    return _TEMPLATE


async def open_world(tmp_dir: str):
    """템플릿을 복사한 새 DB 의 (engine, session)."""
    path = os.path.join(tmp_dir, f"w{os.urandom(4).hex()}.db")
    shutil.copyfile(template_path(), path)
    eng = create_async_engine(f"sqlite+aiosqlite:///{path}")
    sess = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)()
    return eng, sess


def silence_side_effects(monkeypatch, tmp_dir: str) -> None:
    """Redis·WS·푸시·LiveKit·스토리지를 차단한다(권한 판정만 검증)."""
    import app.realtime.events as ev
    from app.chat import notify, voice
    from app.chat import router as chat_router
    from app.notifications import service as nsvc

    async def _none(*_a, **_k):
        return None

    async def _empty_set(*_a, **_k):
        return set()

    async def _false(*_a, **_k):
        return False

    for mod in (ev, notify, chat_router):
        for name in ("emit_to_user", "emit_to_channel", "emit_to_users"):
            if hasattr(mod, name):
                monkeypatch.setattr(mod, name, _none)
    monkeypatch.setattr(ev, "connected_users", _empty_set)
    monkeypatch.setattr(notify, "connected_users", _empty_set)
    monkeypatch.setattr(ev, "is_connected", _false)
    monkeypatch.setattr(notify, "_push", _none)
    monkeypatch.setattr(nsvc, "_push", lambda *_a, **_k: _none())
    monkeypatch.setattr(chat_router.manager, "notify_channels_changed", _none)
    monkeypatch.setattr(voice, "close_channel", _none)
    monkeypatch.setattr(chat_router, "get_settings", lambda: SimpleNamespace(storage_root=tmp_dir))


# ─── 동작 ───
# 각 동작: async (db, user, ch, actor) -> 결과. 성공이면 200, HTTPException 이면 해당 코드.

def _other(actor: str) -> str:
    """'타인의 글' 대상 — 기본은 mem 의 글, 행위자가 mem 이면 own 의 글."""
    return "own" if actor == "mem" else "mem"


async def _act(name: str, db, user, ch: str, actor: str):
    from fastapi import UploadFile
    import io
    from app.chat import router as r
    from app.chat import tabs, voice
    from app.chat.schemas import (
        ChannelPrefsUpdate, ChannelUpdate, DraftUpsert, MarkUnreadRequest, MemberAdd, MessageCreate,
        MessageUpdate, ReactionToggle,
    )

    root = f"m_mem_{ch}"
    own_msg = f"m_{actor}_{ch}"
    other_msg = f"m_{_other(actor)}_{ch}"
    q = dict(before=None, after=None, before_seq=None, after_seq=None, limit=50)

    match name:
        case "channel.get":
            return await r.get_channel(ch, user=user, db=db)
        case "members.list":
            return await r.list_members(ch, user=user, db=db)
        case "messages.list":
            return await r.list_messages(ch, **q, user=user, db=db)
        case "message.send":
            return await r.send_message(ch, MessageCreate(content="hi there"), user=user, db=db)
        case "message.reply":
            return await r.send_message(ch, MessageCreate(content="reply", parent_id=root), user=user, db=db)
        case "file.upload":
            up = UploadFile(file=io.BytesIO(b"abc"), filename="a.txt")
            return await r.upload_chat_file(ch, up, parent_id=None, also_to_channel=False, user=user, db=db)
        case "file.download":
            return await r.download_chat_file(ch, "missing.txt", user=user, db=db)
        case "pins.list":
            return await r.list_pins(ch, limit=100, user=user, db=db)
        case "message.pin":
            return await r.pin_message(root, user=user, db=db)
        case "message.unpin":
            return await r.unpin_message(root, user=user, db=db)
        case "reaction.toggle":
            return await r.toggle_reaction(root, ReactionToggle(emoji="👍"), user=user, db=db)
        case "message.edit_own":
            return await r.edit_message(own_msg, MessageUpdate(content="edited"), user=user, db=db)
        case "message.edit_other":
            return await r.edit_message(other_msg, MessageUpdate(content="edited"), user=user, db=db)
        case "message.delete_own":
            return await r.delete_message(own_msg, user=user, db=db)
        case "message.delete_other":
            return await r.delete_message(other_msg, user=user, db=db)
        case "preview.dismiss_own":
            return await r.dismiss_link_preview(own_msg, user=user, db=db)
        case "preview.dismiss_other":
            return await r.dismiss_link_preview(other_msg, user=user, db=db)
        case "channel.update":
            return await r.update_channel(ch, ChannelUpdate(description="d"), user=user, db=db)
        case "channel.delete":
            return await r.delete_channel(ch, user=user, db=db)
        case "member.add":
            return await r.add_members(ch, MemberAdd(user_ids=["new"]), user=user, db=db)
        case "member.kick":
            return await r.remove_member(ch, _other(actor), user=user, db=db)
        case "member.leave":
            return await r.remove_member(ch, actor, user=user, db=db)
        case "thread.get":
            return await r.get_thread(root, limit=100, user=user, db=db)
        case "thread.follow":
            return await r.follow_thread(root, user=user, db=db)
        case "thread.read":
            return await r.mark_thread_read(root, None, user=user, db=db)
        case "message.save":
            return await r.save_message(root, user=user, db=db)
        case "channel.mark_unread":
            return await r.mark_channel_unread(ch, MarkUnreadRequest(message_id=root), user=user, db=db)
        case "prefs.get":
            return await r.get_channel_prefs(ch, user=user, db=db)
        case "prefs.update":
            return await r.update_channel_prefs(ch, ChannelPrefsUpdate(muted=True), user=user, db=db)
        case "draft.upsert":
            return await r.upsert_draft(DraftUpsert(channel_id=ch, content="draft"), user=user, db=db)
        case "tabs.update":
            return await tabs.update_channel_tabs(ch, tabs.TabsUpdate(wiki_page_id=None), user=user, db=db)
        case "voice.join":
            return await voice._require_voice_channel(db, ch, user)
    raise AssertionError(f"unknown action {name}")


async def seed_defaults(db) -> None:
    """운영 init_db(_run_chat_roles_migration)와 동일한 상태 — @everyone 행 + 기본 카테고리 3개에 채널 배치."""
    from sqlalchemy import select
    from app.chat.roles import get_or_create_everyone
    from app.db.models import ChatCategory
    await get_or_create_everyone(db)
    cats = {}
    for pos, name in enumerate(("채널", "음성", "보관")):
        c = ChatCategory(name=name, position=pos)
        db.add(c)
        await db.flush()
        cats[name] = c.id
    for ch in (await db.execute(select(Channel))).scalars():
        if ch.type != "dm":
            ch.category_id = cats["보관"] if ch.is_archived else cats["음성"] if ch.is_voice else cats["채널"]
    await db.commit()


async def run_case(name: str, ch: str, actor: str, tmp_dir: str, *, seeded: bool = False) -> int:
    eng, db = await open_world(tmp_dir)
    if seeded:
        await seed_defaults(db)
    try:
        await _act(name, db, user_ns(actor), ch, actor)
        return 200
    except HTTPException as e:
        return e.status_code
    finally:
        await db.close()
        await eng.dispose()


# ─── 현재 동작 — 수기 작성 표 ───
# 열: owner·admin·member·none(비멤버). 값: 200 = 허용, 그 외 = HTTP 코드.
# 전역 관리자(is_admin)는 채팅 내에서 특권이 없다 — gad 는 none, gam 은 member 열을 따른다.
OK4 = {"owner": 200, "admin": 200, "member": 200, "none": 403}     # 멤버이면 허용
ALL = {"owner": 200, "admin": 200, "member": 200, "none": 200}     # 멤버십 검사 없음(본인 글)
NONE = {"owner": 403, "admin": 403, "member": 403, "none": 403}    # 전원 불가
MGR = {"owner": 200, "admin": 200, "member": 403, "none": 403}     # 채널 owner/admin

EXPECTED: dict[str, dict[str, int]] = {
    "channel.get": OK4,
    "members.list": OK4,
    "messages.list": OK4,
    "message.send": OK4,
    "message.reply": OK4,
    "file.upload": OK4,
    "file.download": {"owner": 404, "admin": 404, "member": 404, "none": 403},
    "pins.list": OK4,
    "message.pin": OK4,          # 멤버 전원 고정 가능
    "message.unpin": OK4,
    "reaction.toggle": OK4,
    "message.edit_own": ALL,     # 탈퇴한 채널의 본인 글도 수정 가능
    "message.edit_other": NONE,  # owner·admin 도 타인의 글은 수정 불가
    "message.delete_own": ALL,
    "message.delete_other": NONE,  # owner·admin 도 타인의 글은 삭제 불가
    "preview.dismiss_own": ALL,
    "preview.dismiss_other": NONE,
    "channel.update": MGR,
    "channel.delete": {"owner": 200, "admin": 403, "member": 403, "none": 403},
    "member.add": OK4,           # 멤버 전원 초대 가능
    "member.kick": MGR,
    "member.leave": {"owner": 200, "admin": 200, "member": 200, "none": 404},
    "thread.get": OK4,
    "thread.follow": OK4,
    "thread.read": OK4,
    "message.save": OK4,
    "channel.mark_unread": OK4,
    "prefs.get": OK4,
    "prefs.update": OK4,
    "draft.upsert": OK4,
    "tabs.update": MGR,          # + 채널 생성자(own = owner 이므로 MGR 과 동일)
    "voice.join": OK4,
}

# 채널 종류별 재정의
OVERRIDES: dict[tuple[str, str], dict[str, int]] = {
    # DM 에는 탭 추가 불가(멤버 400, 비멤버는 멤버 검사에서 403)
    ("tabs.update", "dm"): {"owner": 400, "admin": 400, "member": 400, "none": 403},
}
# 음성 채널이 아닌 채널에서 음성 접속 — 멤버 400(비멤버는 403 이 우선)
for _ch in ("pub", "prv", "arc", "dm"):
    OVERRIDES[("voice.join", _ch)] = {"owner": 400, "admin": 400, "member": 400, "none": 403}


def expected(name: str, ch: str, actor: str) -> int:
    table = OVERRIDES.get((name, ch), EXPECTED[name])
    return table[role_class(ch, actor)]


def all_cases() -> list[tuple[str, str, str]]:
    return [(n, ch, a) for n in EXPECTED for ch in CHANNELS for a in ACTORS]
