"""시작 체크리스트 — 항목별 완료 여부를 서버가 계산한다.

프런트의 완료 표시를 저장하지 않고 서버가 실제 데이터로 판정한다(프로필 사진 존재 여부,
채널 메시지 작성 여부 등). 따라서 기기를 변경하거나 다른 경로로 수행해도 결과가 일치한다. 닫기(dismiss)만 사용자 설정
(user_prefs 의 서버 관리 키 dashboard.checklist_dismissed_at)에 저장한다.

판정 기준
- profile_photo     : users.avatar_url 존재
- first_message     : DM 이 아닌 채널에 본인 작성 메시지 존재
- invite_colleague  : 본인이 회의에 타 사용자를 초대했거나, 본인이 생성한 채널에 타 사용자가 있거나, (관리자) 초대 링크를 생성함
- upload_file       : 본인 파일 색인(file_index scope=본인 id)에 파일 1개 이상 존재
- install_app       : 데스크톱/모바일 앱 기기 등록(user_devices, 미해지) 존재
- enable_push       : 웹 푸시 구독 존재
- enable_2fa        : 2단계 인증 활성화
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import (
    Channel, ChannelMember, FileIndex, MeetingDB, MeetingInvitee, Message, PushSubscription, User,
    UserDevice, UserInvite,
)
from app.db.session import get_db
from app.modules.registry import is_module_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

DISMISS_KEY = "dashboard.checklist_dismissed_at"

# link 는 프런트의 실제 경로(과거의 /settings/profile·/settings/devices 는 존재하지 않는 화면). 앱 설치는 다운로드 안내(/api/apps).
ITEMS = [
    ("profile_photo", "프로필 사진 올리기", "/settings/account"),
    ("first_message", "채널에 첫 메시지 보내기", "/chat"),
    ("invite_colleague", "동료 초대하기", "/meetings"),
    ("upload_file", "첫 파일 올리기", "/files"),
    ("install_app", "앱 설치하기", "/api/apps"),
    ("enable_push", "알림 켜기", "/settings/notifications"),
    ("enable_2fa", "2단계 인증 켜기", "/settings/security"),
]


async def _exists(db: AsyncSession, stmt) -> bool:
    try:
        return (await db.execute(stmt.limit(1))).first() is not None
    except Exception as e:   # 해당 모듈 테이블이 없는 설치 등 — 미완료로 간주
        logger.debug("체크리스트 판정 실패: %s", e)
        await db.rollback()
        return False


def visible_items(user: User) -> list[tuple[str, str, str]]:
    """본 설치·해당 사용자에게 표시할 항목 — 비활성화되었거나 미설치된 구역의 모듈에 의존하는 항목은 제외한다."""
    chat, meetings = is_module_enabled("chat"), is_module_enabled("meetings")
    out: list[tuple[str, str, str]] = []
    for item_id, label, link in ITEMS:
        if item_id == "first_message" and not chat:
            continue
        if item_id == "upload_file" and not is_module_enabled("files"):
            continue
        if item_id == "invite_colleague":
            # 회의 초대 · 채널 초대 · (관리자) 계정 초대 중 하나 — 셋 모두 불가하면 항목 제외
            if meetings:
                pass
            elif chat:
                link = "/chat"
            elif getattr(user, "is_admin", False):
                link = "/admin/users"
            else:
                continue
        out.append((item_id, label, link))
    return out


async def compute(db: AsyncSession, user: User) -> dict[str, bool]:
    """항목별 완료 여부. 비활성화되었거나 미설치된 구역의 테이블은 조회하지 않는다(해당 항목은 결과에 미포함)."""
    uid = str(user.id)
    chat, meetings = is_module_enabled("chat"), is_module_enabled("meetings")
    done: dict[str, bool] = {}
    done["profile_photo"] = bool(user.avatar_url)
    if chat:
        done["first_message"] = await _exists(db, select(Message.id).join(Channel, Channel.id == Message.channel_id).where(
            Message.sender_id == uid, Channel.type != "dm"))
    invited = False
    if meetings:
        invited = await _exists(db, select(MeetingInvitee.id).join(MeetingDB, MeetingDB.id == MeetingInvitee.meeting_id)
                                .where(MeetingDB.host_user_id == uid, MeetingInvitee.user_id.is_distinct_from(uid)))
    if not invited and chat:
        invited = await _exists(db, select(ChannelMember.channel_id)
                                .join(Channel, Channel.id == ChannelMember.channel_id)
                                .where(Channel.created_by == uid, Channel.type != "dm", ChannelMember.user_id != uid))
    if not invited:
        invited = await _exists(db, select(UserInvite.id).where(UserInvite.invited_by == uid))
    done["invite_colleague"] = invited
    if is_module_enabled("files"):
        done["upload_file"] = await _exists(db, select(FileIndex.id).where(FileIndex.scope == uid, FileIndex.is_dir == False))  # noqa: E712
    done["install_app"] = await _exists(db, select(UserDevice.id).where(UserDevice.user_id == uid, UserDevice.revoked_at.is_(None)))
    done["enable_push"] = await _exists(db, select(PushSubscription.id).where(PushSubscription.user_id == uid))
    done["enable_2fa"] = bool(user.totp_secret)
    return done


async def _dismissed_at(db: AsyncSession, uid: str) -> str | None:
    from app.me.prefs import get_prefs
    try:
        return (await get_prefs(db, uid)).get(DISMISS_KEY)
    except Exception:
        await db.rollback()
        return None


@router.get("/checklist")
async def get_checklist(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """시작 체크리스트 — 항목별 done 은 서버 판정. 전부 완료했거나 닫은 경우의 숨김 처리는 프런트 담당."""
    done = await compute(db, user)
    items = [{"id": i, "label": label, "link": link, "done": done.get(i, False)} for i, label, link in visible_items(user)]
    n = sum(1 for x in items if x["done"])
    dismissed_at = await _dismissed_at(db, str(user.id))
    return {
        "items": items,
        "done_count": n,
        "total": len(items),
        "completed": n == len(items),
        "dismissed": bool(dismissed_at),
        "dismissed_at": dismissed_at,
    }


class DismissRequest(BaseModel):
    undo: bool = False   # true 이면 재표시


@router.post("/checklist/dismiss")
async def dismiss_checklist(
    body: DismissRequest | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """체크리스트 닫기(기기 간 공유). {"undo": true} 이면 재표시."""
    from app.me.prefs import set_server_pref

    value = None if (body and body.undo) else datetime.now(timezone.utc).isoformat()
    await set_server_pref(db, str(user.id), DISMISS_KEY, value)
    return {"dismissed": value is not None, "dismissed_at": value}
