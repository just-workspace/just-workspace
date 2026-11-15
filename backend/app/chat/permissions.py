"""채팅 역할·권한 엔진 — 권한 비트 상수표와 계산 함수, 라우터가 부르는 검사 하나(`allowed`).

설계 문서: docs/chat-permissions.md.

■ 계산 순서(effective_permissions) — 디스코드 순서를 그대로 쓰고, 지금 동작을 지키는 두 단계를 더했다
  워크스페이스 범위(channel 없음 — 역할·카테고리 관리 같은 것)
    1. 전역 관리자(users.is_admin) → 전부
    2. @everyone ∪ 내 역할들(OR). ADMINISTRATOR 가 있으면 → 전부
  채널 범위
    0. DM → 멤버면 DM_PERMISSIONS(+채널 역할 암묵 권한), 아니면 0. 역할·덮어쓰기는 DM 에 안 먹는다.
    1. 기본 = @everyone ∪ 내 역할들(OR). ADMINISTRATOR 가 있으면 → 전부(짧은 길)
    2. [호환] 멤버십 문: 채널 멤버가 아니면 VIEW_CHANNEL 을 뺀다(지금은 공개 채널도 멤버만 본다)
    3. 카테고리 덮어쓰기(채널이 카테고리에 있으면): @everyone → 역할 합(deny 후 allow) → 사용자
    4. 채널 덮어쓰기: @everyone → 역할 합(deny 후 allow) → 사용자
    5. [호환] 채널 역할(channel_members.role) 암묵 권한: owner/admin → MANAGE_CHANNELS·KICK_MEMBERS
    6. 의존 정리: VIEW_CHANNEL 없으면 0 · SEND_MESSAGES 없으면 첨부·임베드·@everyone·투표도 0 ·
       CONNECT 없으면 음성 권한 전부 0
  짧은 길(short-circuit): ADMINISTRATOR 비트(역할로 받음) = 전부. 채널 owner 는 비트가 아니라
  "채널 삭제" 같은 owner 전용 동작에서 따로 본다(ACTIONS 의 owner_only). 전역 관리자는 워크스페이스
  범위에서만 짧은 길이다 — 채널 안(특히 남의 DM·비공개 채널)에서는 지금처럼 특권이 없다.

■ 모드(설정 CHAT_PERMISSIONS_ENGINE): legacy | shadow(기본) | enforce
  shadow 는 예전 검사로 막고 새 엔진을 옆에서 돌려 다르면 `chat_perm_shadow_mismatch` 구조화 로그
  (사용자·채널 id 는 해시, 본문 없음) + Redis 일별 카운터. 엔진이 실패해도 요청은 예전 검사로 끝난다.

비트 번호는 디스코드와 맞출 필요가 없다(외부 호환 없음). 새 비트는 끝에 붙이고 번호를 재사용하지 않는다.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import (
    Channel, ChannelMember, ChatPermissionOverwrite, ChatRole, ChatMemberRole, Message,
)

logger = logging.getLogger("app.chat.permissions")

# ─── 권한 비트(상수표 — 이 한 곳에서만 정의) ───

VIEW_CHANNEL = 1 << 0
SEND_MESSAGES = 1 << 1
SEND_IN_THREADS = 1 << 2
CREATE_THREADS = 1 << 3
READ_HISTORY = 1 << 4
EMBED_LINKS = 1 << 5
ATTACH_FILES = 1 << 6
ADD_REACTIONS = 1 << 7
USE_EXTERNAL_EMOJI = 1 << 8      # 예약(커스텀 이모지)
MENTION_EVERYONE = 1 << 9        # @everyone·@here·@채널 + 멘션 불가 역할도 부르기
MANAGE_MESSAGES = 1 << 10        # 남의 글 삭제·미리보기 지우기
PIN_MESSAGES = 1 << 11
MANAGE_THREADS = 1 << 12
MANAGE_CHANNELS = 1 << 13        # 채널 수정·탭·카테고리 만들기/정렬
MANAGE_ROLES = 1 << 14           # 역할 CRUD·부여, 덮어쓰기 편집
MANAGE_EXPRESSIONS = 1 << 15     # 이모지·스티커
MANAGE_WEBHOOKS = 1 << 16
CREATE_INVITE = 1 << 17          # 채널에 사람 추가
KICK_MEMBERS = 1 << 18           # 채널에서 내보내기
MODERATE_MEMBERS = 1 << 19       # 타임아웃
VIEW_AUDIT_LOG = 1 << 20
BYPASS_SLOWMODE = 1 << 21
SEND_POLLS = 1 << 22
USE_COMMANDS = 1 << 23
CONNECT = 1 << 24                # 음성 채널 접속
SPEAK = 1 << 25
STREAM = 1 << 26                 # 화면·카메라·소리 공유
USE_VAD = 1 << 27                # 끄면 PTT 강제
PRIORITY_SPEAKER = 1 << 28
MUTE_MEMBERS = 1 << 29
DEAFEN_MEMBERS = 1 << 30
MOVE_MEMBERS = 1 << 31
USE_SOUNDBOARD = 1 << 32
REQUEST_TO_SPEAK = 1 << 33
ADMINISTRATOR = 1 << 40          # 전부(덮어쓰기 무시)

_NAMES = (
    "VIEW_CHANNEL", "SEND_MESSAGES", "SEND_IN_THREADS", "CREATE_THREADS", "READ_HISTORY", "EMBED_LINKS",
    "ATTACH_FILES", "ADD_REACTIONS", "USE_EXTERNAL_EMOJI", "MENTION_EVERYONE", "MANAGE_MESSAGES", "PIN_MESSAGES",
    "MANAGE_THREADS", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_EXPRESSIONS", "MANAGE_WEBHOOKS", "CREATE_INVITE",
    "KICK_MEMBERS", "MODERATE_MEMBERS", "VIEW_AUDIT_LOG", "BYPASS_SLOWMODE", "SEND_POLLS", "USE_COMMANDS",
    "CONNECT", "SPEAK", "STREAM", "USE_VAD", "PRIORITY_SPEAKER", "MUTE_MEMBERS", "DEAFEN_MEMBERS", "MOVE_MEMBERS",
    "USE_SOUNDBOARD", "REQUEST_TO_SPEAK", "ADMINISTRATOR",
)
PERMISSIONS: dict[str, int] = {n: globals()[n] for n in _NAMES}
ALL_PERMISSIONS = 0
for _v in PERMISSIONS.values():
    ALL_PERMISSIONS |= _v

# 위험 권한 — UI 가 경고를 띄우는 묶음(관리 화면)
DANGEROUS = (ADMINISTRATOR | MANAGE_ROLES | MANAGE_CHANNELS | MANAGE_MESSAGES | KICK_MEMBERS
             | MODERATE_MEMBERS | MANAGE_WEBHOOKS | MENTION_EVERYONE)

# UI 묶음(권한 행렬의 섹션)
GROUPS: dict[str, list[str]] = {
    "general": ["VIEW_CHANNEL", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_EXPRESSIONS", "MANAGE_WEBHOOKS",
                "VIEW_AUDIT_LOG", "ADMINISTRATOR"],
    "members": ["CREATE_INVITE", "KICK_MEMBERS", "MODERATE_MEMBERS"],
    "text": ["SEND_MESSAGES", "SEND_IN_THREADS", "CREATE_THREADS", "READ_HISTORY", "EMBED_LINKS",
             "ATTACH_FILES", "ADD_REACTIONS", "USE_EXTERNAL_EMOJI", "MENTION_EVERYONE", "MANAGE_MESSAGES",
             "PIN_MESSAGES", "MANAGE_THREADS", "BYPASS_SLOWMODE", "SEND_POLLS", "USE_COMMANDS"],
    "voice": ["CONNECT", "SPEAK", "STREAM", "USE_VAD", "PRIORITY_SPEAKER", "MUTE_MEMBERS", "DEAFEN_MEMBERS",
              "MOVE_MEMBERS", "USE_SOUNDBOARD", "REQUEST_TO_SPEAK"],
}

# @everyone 기본값 = 지금 채널 멤버가 할 수 있는 것 전부(배포 직후 체감 변화 0).
# 지금 멤버 누구나: 보기·쓰기·답글·첨부·리액션·고정·초대·@everyone·음성 접속/말하기/소리 공유.
DEFAULT_EVERYONE = (
    VIEW_CHANNEL | SEND_MESSAGES | SEND_IN_THREADS | CREATE_THREADS | READ_HISTORY | EMBED_LINKS
    | ATTACH_FILES | ADD_REACTIONS | USE_EXTERNAL_EMOJI | MENTION_EVERYONE | PIN_MESSAGES | CREATE_INVITE
    | SEND_POLLS | USE_COMMANDS | CONNECT | SPEAK | STREAM | USE_VAD | USE_SOUNDBOARD | REQUEST_TO_SPEAK
)
# DM 은 역할과 무관하게 고정(디스코드도 서버 역할이 DM 에 안 먹는다)
DM_PERMISSIONS = DEFAULT_EVERYONE
# 채널 역할(channel_members.role) 암묵 권한 — 지금 owner/admin 이 하는 것: 채널 수정·탭·내보내기.
# owner 만 하는 채널 삭제는 비트가 아니라 ACTIONS 의 owner_only 로 본다.
# 원래 설계는 owner 에 MANAGE_MESSAGES 를 암묵 부여하자고 하지만 그건 지금 동작이 아니다(owner 도 남의 글을
# 못 지운다) → enforce 전환 뒤 별도 결정으로 여기에 한 줄 더하면 된다.
CHANNEL_ROLE_IMPLICIT: dict[str, int] = {
    "owner": MANAGE_CHANNELS | KICK_MEMBERS,
    "admin": MANAGE_CHANNELS | KICK_MEMBERS,
    "member": 0,
}
_SEND_DEPENDENT = ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE | SEND_POLLS
_VOICE_DEPENDENT = (SPEAK | STREAM | USE_VAD | PRIORITY_SPEAKER | MUTE_MEMBERS | DEAFEN_MEMBERS | MOVE_MEMBERS
                    | USE_SOUNDBOARD | REQUEST_TO_SPEAK)

# 역할 색 = 우리 토큰 팔레트의 키(hex 금지, 대비 4.5:1 은 토큰이 보장). 팔레트가 늘면 여기에 더한다.
ROLE_COLOR_TOKENS = (
    "primary", "accent", "success", "warning", "danger", "destructive", "muted-foreground", "foreground",
)

MODES = ("legacy", "shadow", "enforce")


def engine_mode() -> str:
    m = (get_settings().chat_permissions_engine or "shadow").strip().lower()
    return m if m in MODES else "shadow"


def names_of(bits: int) -> list[str]:
    return [n for n, v in PERMISSIONS.items() if bits & v]


def bits_of(value: Any) -> int:
    """정수 또는 이름 목록 → 비트. 모르는 이름은 ValueError."""
    if value is None:
        return 0
    if isinstance(value, int):
        if value < 0 or value & ~ALL_PERMISSIONS:
            raise ValueError("모르는 권한 비트")
        return value
    out = 0
    for n in value:
        key = str(n).strip().upper()
        if key not in PERMISSIONS:
            raise ValueError(f"모르는 권한: {n}")
        out |= PERMISSIONS[key]
    return out


# ─── 계산(순수 함수) ───

@dataclass
class PermContext:
    """effective_permissions 의 입력 — load_context 가 DB 에서 한 번에 채운다."""
    user_id: str
    is_global_admin: bool = False
    channel: Any = None                      # Channel 또는 None(워크스페이스 범위)
    member_role: str | None = None           # channel_members.role(None = 멤버 아님)
    everyone_permissions: int = DEFAULT_EVERYONE
    everyone_role_id: str | None = None
    role_ids: set[str] = field(default_factory=set)       # 내 역할(관리되는 역할 포함, @everyone 제외)
    role_permissions: int = 0                              # 내 역할들 OR
    category_overwrites: list = field(default_factory=list)  # (subject_kind, subject_id, allow, deny)
    channel_overwrites: list = field(default_factory=list)
    # 관리자 정책 토글(app/chat/policy.py) — 기본 False = 지금 동작
    admin_channel_privileges: bool = False   # 전역 관리자 → 채널 안에서도 전부(DM·비공개 포함)
    owner_manage_messages: bool = False      # 채널 owner → MANAGE_MESSAGES


def _apply_layer(p: int, ows: list, ctx: PermContext) -> int:
    everyone_id = ctx.everyone_role_id
    # @everyone
    for kind, sid, allow, deny in ows:
        if kind == "role" and (sid == everyone_id or sid == "everyone"):
            p = (p & ~deny) | allow
    # 역할 합 — deny 를 다 빼고 allow 를 다 더한다(같은 비트면 allow 가 이긴다)
    r_allow = r_deny = 0
    for kind, sid, allow, deny in ows:
        if kind == "role" and sid in ctx.role_ids:
            r_allow |= allow
            r_deny |= deny
    p = (p & ~r_deny) | r_allow
    # 사용자
    for kind, sid, allow, deny in ows:
        if kind == "user" and sid == ctx.user_id:
            p = (p & ~deny) | allow
    return p


def compute_permissions(ctx: PermContext) -> int:
    ch = ctx.channel
    base = ctx.everyone_permissions | ctx.role_permissions
    if ch is None:
        if ctx.is_global_admin or base & ADMINISTRATOR:
            return ALL_PERMISSIONS
        return base
    if ctx.is_global_admin and ctx.admin_channel_privileges:
        return ALL_PERMISSIONS
    implicit = CHANNEL_ROLE_IMPLICIT.get(ctx.member_role or "", 0) if ctx.member_role else 0
    if ctx.owner_manage_messages and ctx.member_role == "owner":
        implicit |= MANAGE_MESSAGES
    if ch.type == "dm":
        return (DM_PERMISSIONS | implicit) if ctx.member_role else 0
    if base & ADMINISTRATOR:
        return ALL_PERMISSIONS
    p = base
    if ctx.member_role is None:
        p &= ~VIEW_CHANNEL
    p = _apply_layer(p, ctx.category_overwrites, ctx)
    p = _apply_layer(p, ctx.channel_overwrites, ctx)
    p |= implicit
    if not p & VIEW_CHANNEL:
        return 0
    if not p & SEND_MESSAGES:
        p &= ~_SEND_DEPENDENT
    if not p & CONNECT:
        p &= ~_VOICE_DEPENDENT
    return p


# ─── DB 에서 문맥 읽기 ───

async def user_role_rows(db: AsyncSession, user_id: str) -> list[ChatRole]:
    """내 역할(직접 부여 + 그룹으로 관리되는 역할). @everyone 은 빠진다. 높은 순."""
    from app.groups.models import GroupMember
    direct = select(ChatMemberRole.role_id).where(ChatMemberRole.user_id == user_id)
    groups = select(GroupMember.group_id).where(GroupMember.user_id == user_id)
    rows = (await db.execute(
        select(ChatRole).where(
            ChatRole.is_default == False,  # noqa: E712
            or_(
                and_(ChatRole.group_id.is_(None), ChatRole.id.in_(direct)),
                and_(ChatRole.group_id.is_not(None), ChatRole.group_id.in_(groups)),
            ),
        ).order_by(ChatRole.position.desc())
    )).scalars().all()
    return list(rows)


async def everyone_role(db: AsyncSession) -> ChatRole | None:
    return (await db.execute(
        select(ChatRole).where(ChatRole.is_default == True).limit(1)  # noqa: E712
    )).scalar_one_or_none()


async def load_context(
    db: AsyncSession, user, channel: Channel | None = None, *, member_role: Any = ...,
) -> PermContext:
    uid = str(user.id)
    ctx = PermContext(user_id=uid, is_global_admin=bool(getattr(user, "is_admin", False)), channel=channel)
    from app.chat.policy import get_policy
    pol = await get_policy(db)
    ctx.admin_channel_privileges = pol["admin_channel_privileges"]
    ctx.owner_manage_messages = pol["owner_manage_messages"]
    ev = await everyone_role(db)
    if ev is not None:
        ctx.everyone_permissions = int(ev.permissions or 0)
        ctx.everyone_role_id = ev.id
    roles = await user_role_rows(db, uid)
    ctx.role_ids = {r.id for r in roles}
    for r in roles:
        ctx.role_permissions |= int(r.permissions or 0)
    if channel is not None:
        if member_role is ...:
            member_role = (await db.execute(
                select(ChannelMember.role).where(
                    ChannelMember.channel_id == channel.id, ChannelMember.user_id == uid,
                )
            )).scalar_one_or_none()
        ctx.member_role = member_role
        if channel.type != "dm":
            conds = [and_(ChatPermissionOverwrite.target_kind == "channel",
                          ChatPermissionOverwrite.target_id == channel.id)]
            cat = getattr(channel, "category_id", None)
            if cat:
                conds.append(and_(ChatPermissionOverwrite.target_kind == "category",
                                  ChatPermissionOverwrite.target_id == cat))
            for ow in (await db.execute(select(ChatPermissionOverwrite).where(or_(*conds)))).scalars():
                item = (ow.subject_kind, ow.subject_id, int(ow.allow or 0), int(ow.deny or 0))
                (ctx.channel_overwrites if ow.target_kind == "channel" else ctx.category_overwrites).append(item)
    return ctx


async def effective_permissions(db: AsyncSession, user, channel_or_id: Channel | str | None = None) -> int:
    ch = channel_or_id
    if isinstance(ch, str):
        ch = await db.get(Channel, ch)
        if ch is None:
            return 0
    return compute_permissions(await load_context(db, user, ch))


# ─── 동작별 검사(예전 규칙 ↔ 새 규칙) ───
# legacy(f): 지금 라우터에 있던 조건 그대로. new: 필요한 비트(전부 있어야 함) + 예외 조건.

@dataclass(frozen=True)
class Action:
    legacy: str                 # member | sender | manager | owner | manager_or_creator | always
    need: int = 0               # 새 엔진: 모두 필요한 비트
    sender_ok: bool = False     # 새 엔진: 본인 글이면 비트 없이 됨
    sender_only: bool = False   # 새 엔진: 본인 글만(수정 — 디스코드도 남의 글은 아무도 못 고친다)
    owner_only: bool = False    # 새 엔진: 채널 owner 또는 ADMINISTRATOR
    creator_ok: bool = False    # 새 엔진: 채널을 만든 사람이면 VIEW 만으로 됨(탭)


ACTIONS: dict[str, Action] = {
    "channel.view": Action("member", VIEW_CHANNEL),
    "message.read": Action("member", VIEW_CHANNEL | READ_HISTORY),
    "message.send": Action("member", VIEW_CHANNEL | SEND_MESSAGES),
    "message.reply": Action("member", VIEW_CHANNEL | SEND_IN_THREADS),
    "file.upload": Action("member", VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES),
    "file.download": Action("member", VIEW_CHANNEL | READ_HISTORY),
    "message.pin": Action("member", VIEW_CHANNEL | PIN_MESSAGES),
    "reaction.add": Action("member", VIEW_CHANNEL | ADD_REACTIONS),
    "channel.participate": Action("member", VIEW_CHANNEL),   # 팔로우·저장·안읽음·알림설정·임시글·스레드 읽음
    "message.edit": Action("sender", sender_only=True),
    "message.delete": Action("sender", VIEW_CHANNEL | MANAGE_MESSAGES, sender_ok=True),
    "preview.dismiss": Action("sender", VIEW_CHANNEL | MANAGE_MESSAGES, sender_ok=True),
    "channel.manage": Action("manager", VIEW_CHANNEL | MANAGE_CHANNELS),
    "channel.delete": Action("owner", owner_only=True),
    "member.invite": Action("member", VIEW_CHANNEL | CREATE_INVITE),
    "member.kick": Action("manager", VIEW_CHANNEL | KICK_MEMBERS),
    "tabs.manage": Action("manager_or_creator", VIEW_CHANNEL | MANAGE_CHANNELS, creator_ok=True),
    "voice.connect": Action("member", VIEW_CHANNEL | CONNECT),
    "mention.everyone": Action("always", MENTION_EVERYONE),
}


def _legacy_decision(a: Action, *, member_role, is_sender: bool, is_creator: bool,
                     policy: dict | None = None, is_admin: bool = False) -> bool:
    # 관리자 정책 토글(app/chat/policy.py) — 예전 규칙에도 같이 얹어 그림자 비교가 어긋나지 않게
    if policy:
        if policy.get("admin_channel_privileges") and is_admin and not a.sender_only:
            return True
        if (policy.get("owner_manage_messages") and a.legacy == "sender" and a.need & MANAGE_MESSAGES
                and member_role == "owner"):
            return True
    match a.legacy:
        case "member":
            return member_role is not None
        case "sender":
            return is_sender
        case "manager":
            return member_role in ("owner", "admin")
        case "owner":
            return member_role == "owner"
        case "manager_or_creator":
            return member_role in ("owner", "admin") or is_creator
        case "always":
            return True
    raise ValueError(a.legacy)


def _new_decision(a: Action, perms: int, *, member_role, is_sender: bool, is_creator: bool) -> bool:
    if a.sender_only:
        return is_sender
    if a.sender_ok and is_sender:
        return True
    if a.owner_only:
        return member_role == "owner" or bool(perms & ADMINISTRATOR)
    if a.creator_ok and is_creator and perms & VIEW_CHANNEL:
        return True
    return (perms & a.need) == a.need


# ─── 그림자 비교 기록 ───

SHADOW_STATS: dict[str, int] = {"checks": 0, "mismatch": 0, "error": 0}   # 프로세스 안(테스트·디버그용)
REDIS_KEY = "chat:perm:shadow:{}"   # 일별 hash: mismatch·error·<action>:<legacy>><engine>
REDIS_TTL = 40 * 86400


def _pseudo(value: str | None) -> str | None:
    if not value:
        return None
    key = (get_settings().secret_key or "").encode()
    return hashlib.sha256(key + b":" + str(value).encode()).hexdigest()[:12]


async def _record_redis(fields: dict[str, int]) -> None:
    try:
        from app.chat.redis_client import get_redis
        r = await get_redis()
        key = REDIS_KEY.format(datetime.now(timezone.utc).strftime("%Y%m%d"))
        pipe = r.pipeline()
        for f, n in fields.items():
            pipe.hincrby(key, f, n)
        pipe.expire(key, REDIS_TTL)
        await pipe.execute()
    except Exception:
        pass   # 카운터는 보조 — 로그가 원본


async def _report_mismatch(action: str, legacy: bool, new: bool, ctx: PermContext) -> None:
    SHADOW_STATS["mismatch"] += 1
    ch = ctx.channel
    logger.warning(json.dumps({
        "event": "chat_perm_shadow_mismatch",
        "action": action,
        "legacy": legacy,
        "engine": new,
        "channel_type": getattr(ch, "type", None),
        "is_voice": bool(getattr(ch, "is_voice", False)) if ch is not None else None,
        "channel_role": ctx.member_role,
        "roles": len(ctx.role_ids),
        "overwrites": len(ctx.channel_overwrites) + len(ctx.category_overwrites),
        "everyone_default": ctx.everyone_permissions == DEFAULT_EVERYONE,
        "user": _pseudo(ctx.user_id),
        "channel": _pseudo(getattr(ch, "id", None)),
    }, ensure_ascii=False))
    await _record_redis({"mismatch": 1, f"{action}:{int(legacy)}>{int(new)}": 1})


async def _report_error(action: str, exc: Exception) -> None:
    SHADOW_STATS["error"] += 1
    logger.warning(json.dumps({
        "event": "chat_perm_engine_error", "action": action, "mode": engine_mode(),
        "error": type(exc).__name__,
    }))
    await _record_redis({"error": 1})


async def shadow_stats(days: int = 7) -> dict:
    """최근 days 일 Redis 카운터 + 이 워커의 프로세스 카운터."""
    out: dict[str, Any] = {"mode": engine_mode(), "process": dict(SHADOW_STATS), "days": {}}
    try:
        from datetime import timedelta
        from app.chat.redis_client import get_redis
        r = await get_redis()
        now = datetime.now(timezone.utc)
        for i in range(max(1, min(days, 40))):
            d = (now - timedelta(days=i)).strftime("%Y%m%d")
            h = await r.hgetall(REDIS_KEY.format(d))
            if h:
                out["days"][d] = {k: int(v) for k, v in h.items()}
    except Exception:
        out["redis"] = "unavailable"
    return out


# ─── 라우터가 부르는 검사 ───

async def guarded(db: AsyncSession, fn):
    """PG 에서는 SAVEPOINT 안에서 돌린다 — 엔진 쿼리가 실패해도 요청 트랜잭션이 abort 되지 않게
    (PG 는 문장 하나가 실패하면 그 트랜잭션의 다음 문장이 전부 실패한다). SQLite 는 그대로."""
    try:
        is_pg = db.bind.dialect.name == "postgresql"
    except Exception:
        is_pg = False
    if not is_pg:
        return await fn()
    async with db.begin_nested():
        return await fn()


async def allowed(
    db: AsyncSession,
    user,
    action: str,
    channel: Channel | str | None,
    *,
    message: Message | None = None,
    member_role: Any = ...,
) -> bool:
    """이 사용자가 이 채널에서 action 을 해도 되나. 모드에 따라 예전/새 판정을 돌려준다.

    channel 은 Channel 또는 id(없는 채널이면 멤버 아님으로 본다 — 예전 is_channel_member 와 같다).
    message 를 주면 "본인 글" 여부를 그 글로 판단한다. 예전 검사와 같은 쿼리 순서를 지키려고
    멤버 역할은 한 번만 읽는다(member_role 을 이미 알면 넘겨 준다).
    """
    a = ACTIONS[action]
    mode = engine_mode()
    uid = str(user.id)
    is_sender = bool(message is not None and message.sender_id == uid)

    ch_obj: Channel | None = channel if isinstance(channel, Channel) else None
    ch_id = channel.id if isinstance(channel, Channel) else channel
    from app.chat.policy import get_policy
    pol = await get_policy(db)
    is_admin = bool(getattr(user, "is_admin", False))
    if a.legacy in ("sender", "always") and mode == "legacy" and not pol["owner_manage_messages"]:
        return _legacy_decision(a, member_role=None, is_sender=is_sender, is_creator=False,
                                policy=pol, is_admin=is_admin)

    if member_role is ... and ch_id is not None:
        member_role = (await db.execute(
            select(ChannelMember.role).where(ChannelMember.channel_id == ch_id, ChannelMember.user_id == uid)
        )).scalar_one_or_none()
    elif member_role is ...:
        member_role = None

    async def _creator() -> bool:
        nonlocal ch_obj
        if ch_obj is None and ch_id is not None:
            ch_obj = await db.get(Channel, ch_id)
        return bool(ch_obj is not None and ch_obj.created_by == uid)

    is_creator = await _creator() if a.legacy == "manager_or_creator" else False
    legacy = _legacy_decision(a, member_role=member_role, is_sender=is_sender, is_creator=is_creator,
                              policy=pol, is_admin=is_admin)
    if mode == "legacy":
        return legacy

    async def _compute() -> tuple[bool, PermContext]:
        nonlocal ch_obj
        if ch_obj is None and ch_id is not None:
            ch_obj = await db.get(Channel, ch_id)
        if ch_obj is None:
            return (False if ch_id is not None else legacy), PermContext(user_id=uid, member_role=member_role)
        c = await load_context(db, user, ch_obj, member_role=member_role)
        bits = compute_permissions(c)
        creator = ch_obj.created_by == uid
        return _new_decision(a, bits, member_role=member_role, is_sender=is_sender, is_creator=creator), c

    try:
        new, ctx = await guarded(db, _compute)
    except Exception as e:   # 엔진이 깨져도 요청은 예전 판정으로(그림자) / 막음(강제)
        await _report_error(action, e)
        return legacy if mode == "shadow" else False

    SHADOW_STATS["checks"] += 1
    if new != legacy:
        if mode == "shadow":
            await _report_mismatch(action, legacy, new, ctx)
        else:
            SHADOW_STATS["mismatch"] += 1
    return legacy if mode == "shadow" else new


async def workspace_permissions(db: AsyncSession, user) -> int:
    """워크스페이스 범위(역할·카테고리 관리) — 새 기능이라 모드와 무관하게 엔진으로 본다."""
    return compute_permissions(await load_context(db, user, None))


def system_user(user_id: str) -> SimpleNamespace:
    """WS·알림처럼 User 객체가 없는 곳에서 allowed() 에 넘길 최소 사용자."""
    return SimpleNamespace(id=user_id, is_admin=False)
