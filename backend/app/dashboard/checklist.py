"""시작 체크리스트 — 항목별 완료 여부를 서버가 계산한다.

프런트가 "했다고 누른 것"을 저장하는 게 아니라, 서버가 실제 데이터로 판정한다(프로필 사진이 있나,
채널에 글을 썼나…). 그래서 기기를 바꿔도·다른 경로로 해도 맞게 나온다. 닫기(dismiss)만 사용자 설정
(user_prefs 의 서버 관리 키 dashboard.checklist_dismissed_at)에 저장한다.

판정 기준
- profile_photo     : users.avatar_url 이 있다
- first_message     : DM 이 아닌 채널에 내가 쓴 메시지가 있다
- invite_colleague  : 내가 회의에 누군가 초대했거나, 내가 만든 채널에 다른 사람이 있거나, (관리자) 초대 링크를 만들었다
- upload_file       : 내 파일 색인(file_index scope=내 id)에 파일이 하나라도 있다
- install_app       : 데스크톱/모바일 앱 기기 등록(user_devices, 해지 안 됨)이 있다
- enable_push       : 웹 푸시 구독이 있다
- enable_2fa        : 2단계 인증을 켰다
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

DISMISS_KEY = "dashboard.checklist_dismissed_at"

# link 는 프런트 실제 경로(예전 /settings/profile·/settings/devices 는 없는 화면이었다). 앱 설치는 내려받기 안내(/api/apps).
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
    except Exception as e:   # 그 모듈 테이블이 없는 설치 등 — 안 한 것으로 본다
        logger.debug("체크리스트 판정 실패: %s", e)
        await db.rollback()
        return False


async def compute(db: AsyncSession, user: User) -> dict[str, bool]:
    uid = str(user.id)
    done: dict[str, bool] = {}
    done["profile_photo"] = bool(user.avatar_url)
    done["first_message"] = await _exists(db, select(Message.id).join(Channel, Channel.id == Message.channel_id).where(
        Message.sender_id == uid, Channel.type != "dm"))
    invited = await _exists(db, select(MeetingInvitee.id).join(MeetingDB, MeetingDB.id == MeetingInvitee.meeting_id)
                            .where(MeetingDB.host_user_id == uid, MeetingInvitee.user_id.is_distinct_from(uid)))
    if not invited:
        invited = await _exists(db, select(ChannelMember.channel_id)
                                .join(Channel, Channel.id == ChannelMember.channel_id)
                                .where(Channel.created_by == uid, Channel.type != "dm", ChannelMember.user_id != uid))
    if not invited:
        invited = await _exists(db, select(UserInvite.id).where(UserInvite.invited_by == uid))
    done["invite_colleague"] = invited
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
    """시작 체크리스트 — 항목별 done 은 서버 판정. 다 했거나 닫았으면 프런트가 숨기면 된다."""
    done = await compute(db, user)
    items = [{"id": i, "label": label, "link": link, "done": done.get(i, False)} for i, label, link in ITEMS]
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
    undo: bool = False   # true 면 다시 보이기


@router.post("/checklist/dismiss")
async def dismiss_checklist(
    body: DismissRequest | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """체크리스트 닫기(기기 사이 공유). {"undo": true} 면 다시 보이기."""
    from app.me.prefs import set_server_pref

    value = None if (body and body.undo) else datetime.now(timezone.utc).isoformat()
    await set_server_pref(db, str(user.id), DISMISS_KEY, value)
    return {"dismissed": value is not None, "dismissed_at": value}
