"""내 로그인 기기 — 본인 세션 목록·단일 세션 종료·나머지 전체 종료.

세션 저장 구조(app/auth/sessions.py)를 그대로 사용한다: 로그인마다 sid 하나, Redis `sess:{sid}` 에
IP·호스트명·UA·생성 시각·마지막 활동, `usess:{user_id}` 에 해당 사용자의 sid 집합. get_current_user 가
요청마다 sid 유효 여부를 확인하므로 레코드를 삭제하면 해당 기기는 다음 요청에서 401 을 수신한다.

sid 원문은 쿠키 내 서명값의 일부이므로 화면에 노출하지 않으며, 목록·삭제는 sid 해시의 앞 16자(id)로 수행한다.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request

from app.auth import sessions as sess_mod
from app.auth.deps import get_current_user, unsign_value
from app.db.models import User

router = APIRouter(prefix="/api/auth/me", tags=["auth"])


def public_id(sid: str) -> str:
    return hashlib.sha256(f"sess:{sid}".encode()).hexdigest()[:16]


def current_sid(request: Request, ws_session: str | None) -> str | None:
    """본 요청을 송신한 세션의 sid (쿠키 또는 Bearer 서명값). OAuth 토큰 요청이면 None."""
    token = ws_session
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:].strip()
    data = unsign_value(token) if token else None
    return data.get("sid") if isinstance(data, dict) else None


_BROWSERS = [
    ("Edge", r"Edg(?:e|A|iOS)?/([\d.]+)"),
    ("Whale", r"Whale/([\d.]+)"),
    ("Samsung Internet", r"SamsungBrowser/([\d.]+)"),
    ("Opera", r"OPR/([\d.]+)"),
    ("Firefox", r"(?:Firefox|FxiOS)/([\d.]+)"),
    ("Chrome", r"(?:Chrome|CriOS)/([\d.]+)"),
    ("Safari", r"Version/([\d.]+).*Safari/"),
]


def parse_ua(ua: str) -> dict:
    """User-Agent → {browser, browser_version, os, device_type, app}. 정확한 판별이 아닌 사용자가 식별 가능한 수준을 목표로 한다."""
    ua = ua or ""
    app = None
    if "Electron/" in ua or "JustWorkspace" in ua:
        app = "desktop"
    browser, version = None, None
    for name, pat in _BROWSERS:
        m = re.search(pat, ua)
        if m:
            browser, version = name, m.group(1).split(".")[0]
            break
    if re.search(r"iPad", ua):
        os_, dtype = "iPadOS", "tablet"
    elif re.search(r"iPhone|iPod", ua):
        os_, dtype = "iOS", "mobile"
    elif "Android" in ua:
        os_, dtype = "Android", "mobile" if "Mobile" in ua else "tablet"
    elif "Windows" in ua:
        os_, dtype = "Windows", "desktop"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        os_, dtype = "macOS", "desktop"
    elif "CrOS" in ua:
        os_, dtype = "ChromeOS", "desktop"
    elif "Linux" in ua:
        os_, dtype = "Linux", "desktop"
    else:
        os_, dtype = None, "unknown"
    return {"browser": browser, "browser_version": version, "os": os_, "device_type": dtype, "app": app}


def _iso(ts) -> str | None:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    except Exception:
        return None


def session_view(rec: dict, cur: str | None) -> dict:
    ua = parse_ua(rec.get("ua", ""))
    label = " · ".join(x for x in (ua["browser"], ua["os"]) if x) or "알 수 없는 기기"
    if ua["app"] == "desktop":
        label = f"데스크톱 앱 · {ua['os']}" if ua["os"] else "데스크톱 앱"
    return {
        "id": public_id(rec["sid"]),
        "current": rec["sid"] == cur,
        "device": label,
        **ua,
        "ip": rec.get("ip") or "",
        "hostname": rec.get("hostname") or "",
        "user_agent": rec.get("ua") or "",
        "created_at": _iso(rec.get("created")),
        "last_seen_at": _iso(rec.get("last_seen")),
    }


async def _my_sessions(user_id: str) -> list[dict]:
    try:
        return await sess_mod.list_user_sessions(user_id)
    except Exception:
        raise HTTPException(status_code=503, detail="세션 저장소에 연결할 수 없습니다")


@router.get("/sessions")
async def my_sessions(
    request: Request,
    ws_session: str | None = Cookie(None),
    user: User = Depends(get_current_user),
):
    """본인 로그인 기기 목록 — 마지막 활동 최근순, 현재 사용 중인 기기는 current=true."""
    cur = current_sid(request, ws_session)
    rows = [session_view(r, cur) for r in await _my_sessions(str(user.id))]
    rows.sort(key=lambda r: (not r["current"], -(datetime.fromisoformat(r["last_seen_at"]).timestamp()
                                                  if r["last_seen_at"] else 0)))
    return {"sessions": rows}


@router.delete("/sessions/{session_id}")
async def revoke_my_session(
    session_id: str,
    request: Request,
    ws_session: str | None = Cookie(None),
    user: User = Depends(get_current_user),
):
    """본인 세션 하나 종료(해당 기기 로그아웃). 타 사용자의 세션 id 는 미존재로 처리한다(404)."""
    cur = current_sid(request, ws_session)
    for rec in await _my_sessions(str(user.id)):
        if public_id(rec["sid"]) == session_id:
            ok = await sess_mod.revoke_session(rec["sid"])
            if not ok:
                raise HTTPException(status_code=503, detail="세션을 끊지 못했습니다")
            return {"ok": True, "was_current": rec["sid"] == cur}
    raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(
    request: Request,
    ws_session: str | None = Cookie(None),
    user: User = Depends(get_current_user),
):
    """현재 기기를 제외한 본인의 다른 로그인 전부 종료."""
    cur = current_sid(request, ws_session)
    n = 0
    for rec in await _my_sessions(str(user.id)):
        if rec["sid"] != cur and await sess_mod.revoke_session(rec["sid"]):
            n += 1
    return {"ok": True, "revoked": n, "kept_current": cur is not None}
