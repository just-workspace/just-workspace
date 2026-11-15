"""workspace_context — 오늘 날짜·시간대·사용자 정보.

모델은 오늘 날짜를 모른다. "이번 주 회의", "어제 받은 메일" 같은 요청을 풀려면 기준 시각과
시간대가 필요하다. 사용자가 누구인지(이름·소속 그룹·관리자 여부)도 함께 준다.
개인 데이터 도구가 아니다(app.mcp.access.NON_DATA_TOOLS) — 본인 신원 최소 정보만 돌려준다.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register

DEFAULT_TZ = "Asia/Seoul"
_WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        return ZoneInfo(DEFAULT_TZ)


async def workspace_context(user: User, **_: object) -> dict:
    tz = _zone(getattr(user, "timezone", None))
    now = datetime.now(tz)
    groups: list[str] = []
    try:
        from sqlalchemy import select

        from app.groups.models import Group, GroupMember

        async with async_session() as db:
            rows = (await db.execute(
                select(Group.name).join(GroupMember, GroupMember.group_id == Group.id)
                .where(GroupMember.user_id == user.id)
            )).scalars().all()
            groups = sorted(str(r) for r in rows if r)
    except Exception:  # noqa: BLE001 — 그룹을 못 읽어도 날짜는 준다
        groups = []
    iso = now.isocalendar()
    return {
        "now": now.isoformat(timespec="seconds"),
        "date": now.date().isoformat(),
        "weekday": _WEEKDAY_KO[now.weekday()],
        "iso_week": f"{iso.year}-W{iso.week:02d}",
        "timezone": str(tz.key),
        "utc_offset": now.strftime("%z"),
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": getattr(user, "display_name", None) or user.username,
            "email": getattr(user, "email", None),
            "groups": groups,
            "is_admin": bool(getattr(user, "is_admin", False)),
        },
    }


register(Tool(
    name="workspace_context",
    description=(
        "Get today's date, current time, weekday and time zone for the user, plus who the user "
        "is (name, email, groups, admin). Call this first whenever the request depends on "
        "dates (\"this week\", \"yesterday\", deadlines) or on who the user is."
    ),
    parameters={"type": "object", "properties": {}},
    handler=workspace_context,
))
