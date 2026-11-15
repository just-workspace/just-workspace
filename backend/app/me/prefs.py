"""개인 설정 서버 저장 — GET/PATCH /api/me/prefs.

사용자당 JSON 한 행(user_prefs). 프런트가 새 설정을 만들 때마다 백엔드를 고치지 않아도 되게
키는 열어 두되, 아무거나 쌓이지 않게 규칙을 둔다.

- 키: 영소문자로 시작, 영소문자·숫자·`_`·`.`·`-` 만, 64자 이하.
- 허용: 아래 TOP_LEVEL_KEYS 이거나 ALLOWED_PREFIXES 로 시작하는 키.
- 값: JSON 으로 직렬화되는 값, 한 값 4KB 이하. 전체 32KB·키 200개 이하.
- PATCH 는 합치기(merge): 보낸 키만 바뀌고, 값이 null 이면 그 키를 지운다.
- 서버가 관리하는 키(SERVER_KEYS)는 PATCH 로 못 쓴다 — 전용 API(방해 금지 일정 등)가 검증해서 쓴다.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User, UserPref
from app.db.session import get_db

router = APIRouter(prefix="/api/me", tags=["me"])

KEY_RE = re.compile(r"^[a-z][a-z0-9_.\-]{0,63}$")
TOP_LEVEL_KEYS = {
    "density",              # comfortable | compact
    "theme",                # dark | light | system
    "language",             # ko | en ...
    "timezone",             # IANA, 예: Asia/Seoul — 방해 금지 일정 기본 시간대로도 쓴다
    "week_start",           # 0(일)~6 / "mon"
    "date_format",
    "time_format",
    "tabbar_pinned",        # 탭바 고정 탭 id 목록
    "mail_dark_view",       # 메일 본문 어둡게 보기
    "read_receipt_default", # 읽음 확인 기본값
    "sidebar_collapsed",
    "start_page",
}
ALLOWED_PREFIXES = (
    "ui.", "mail.", "chat.", "calendar.", "dashboard.", "tabbar.", "files.",
    "editor.", "tasks.", "meetings.", "board.", "wiki.", "notify.", "contacts.", "search.",
    "ai.",     # AI 설정(권한 모드는 SERVER_KEYS — /api/approvals/mode 가 검증해서 쓴다)
    "dash.",   # 대시보드 배치(dash.layout — app/dashboard/layout.py 가 모양을 검사)
)
# 전용 API 가 검증해서 쓰는 키 — PATCH 로는 못 바꾼다(읽기는 된다)
SERVER_KEYS = {"notify.dnd_schedule", "dashboard.checklist_dismissed_at", "ai.permission_mode", "ai.permission_rules"}
# 값 모양을 서버가 검사·정규화하는 키(서버가 읽어서 쓰는 설정)
KEYWORDS_KEY = "chat.keywords"   # 채팅 알림 키워드 — 메시지에 나오면 "나를 부른 것"(app/chat/keywords.py)
MAX_KEYWORDS = 20
MAX_KEYWORD_LEN = 40
MAX_VALUE_BYTES = 4096
MAX_TOTAL_BYTES = 32 * 1024
MAX_KEYS = 200


def key_allowed(key: str) -> bool:
    if not isinstance(key, str) or not KEY_RE.match(key):
        return False
    return key in TOP_LEVEL_KEYS or key.startswith(ALLOWED_PREFIXES)


def normalize_keywords(v) -> list[str]:
    """알림 키워드 목록 검사·정리 — 문자열 목록, 앞뒤 공백 제거, 대소문자 무시 중복 제거, 최대 20개·40자."""
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise HTTPException(status_code=400, detail="알림 키워드는 문자열 목록이어야 합니다")
    out: list[str] = []
    seen: set[str] = set()
    for x in v:
        w = " ".join(x.split())
        if not w:
            continue
        if len(w) > MAX_KEYWORD_LEN:
            raise HTTPException(status_code=400, detail=f"키워드는 {MAX_KEYWORD_LEN}자까지입니다")
        k = w.casefold()
        if k in seen:
            continue
        seen.add(k)
        out.append(w)
    if len(out) > MAX_KEYWORDS:
        raise HTTPException(status_code=400, detail=f"알림 키워드는 최대 {MAX_KEYWORDS}개입니다")
    return out


LAYOUT_KEY = "dash.layout"     # 대시보드 개인 배치(handover 17 편집 모드)


def normalize_dash_layout(v) -> dict:
    from app.dashboard.layout import normalize_layout
    try:
        return normalize_layout(v)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


_VALIDATORS = {KEYWORDS_KEY: normalize_keywords, LAYOUT_KEY: normalize_dash_layout}


def _load(row: UserPref | None) -> dict:
    if row is None or not row.data:
        return {}
    try:
        d = json.loads(row.data)
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


async def get_prefs(db: AsyncSession, user_id: str) -> dict:
    return _load(await db.get(UserPref, user_id))


async def set_server_pref(db: AsyncSession, user_id: str, key: str, value) -> dict:
    """서버 관리 키 쓰기(검증은 호출자가 끝낸 뒤). value=None 이면 지운다. 커밋까지 한다."""
    row = await db.get(UserPref, user_id)
    data = _load(row)
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value
    if row is None:
        row = UserPref(user_id=user_id, data=json.dumps(data, ensure_ascii=False))
        db.add(row)
    else:
        row.data = json.dumps(data, ensure_ascii=False)
        row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return data


def apply_patch(current: dict, patch: dict) -> dict:
    """검증하고 합친 결과를 돌려준다. 규칙 위반은 HTTPException(400/413)."""
    if not isinstance(patch, dict):
        raise HTTPException(status_code=400, detail="객체(JSON object)를 보내야 합니다")
    bad = [k for k in patch if not key_allowed(k)]
    if bad:
        raise HTTPException(status_code=400, detail=f"허용되지 않는 설정 키: {', '.join(sorted(bad)[:10])}")
    locked = [k for k in patch if k in SERVER_KEYS]
    if locked:
        raise HTTPException(status_code=400, detail=f"전용 API 로만 바꿀 수 있는 키: {', '.join(sorted(locked))}")
    out = dict(current)
    for k, v in patch.items():
        if v is None:
            out.pop(k, None)
            continue
        if k in _VALIDATORS:
            v = _VALIDATORS[k](v)
        try:
            size = len(json.dumps(v, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"JSON 으로 저장할 수 없는 값: {k}")
        if size > MAX_VALUE_BYTES:
            raise HTTPException(status_code=413, detail=f"값이 너무 큽니다(4KB 초과): {k}")
        out[k] = v
    if len(out) > MAX_KEYS:
        raise HTTPException(status_code=413, detail=f"설정 키가 너무 많습니다({MAX_KEYS}개 초과)")
    if len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > MAX_TOTAL_BYTES:
        raise HTTPException(status_code=413, detail="설정 전체가 너무 큽니다(32KB 초과)")
    return out


@router.get("/prefs")
async def read_prefs(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """내 개인 설정 전부. 저장한 적 없으면 빈 객체."""
    row = await db.get(UserPref, str(user.id))
    return {
        "prefs": _load(row),
        "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
    }


@router.patch("/prefs")
async def patch_prefs(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """보낸 키만 바꾼다(null 이면 삭제). 요청 몸통은 {"prefs": {...}} 또는 설정 객체 그대로."""
    patch = body.get("prefs") if isinstance(body.get("prefs"), dict) and len(body) == 1 else body
    row = await db.get(UserPref, str(user.id))
    merged = apply_patch(_load(row), patch)
    now = datetime.now(timezone.utc)
    if row is None:
        row = UserPref(user_id=str(user.id), data=json.dumps(merged, ensure_ascii=False), updated_at=now)
        db.add(row)
    else:
        row.data = json.dumps(merged, ensure_ascii=False)
        row.updated_at = now
    await db.commit()
    return {"prefs": merged, "updated_at": now.isoformat()}
