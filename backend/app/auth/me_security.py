"""설정 › 연결된 앱 — 본인 OAuth 연결 앱 목록·연결 해제, 앱 비밀번호 발급·목록·삭제.

모든 엔드포인트는 get_current_user 로 호출자를 식별하며 **호출자 본인 소유 항목만** 처리한다(타 사용자의 id 는 404).

연결된 앱
  OAuth 동의(oauth_consents)와 유효한 리프레시 토큰(oauth_refresh_tokens)을 client_id 기준으로 병합하여
  "앱 하나 = 한 행"으로 표시한다. 연결 해제 시 동의를 철회하고 해당 앱의 리프레시 토큰 체인을 전부
  폐기한다 → 다음 갱신부터 거부(기발급 액세스 토큰은 만료(최대 1시간)까지 유효).
  /api/ai-connect/connections 는 MCP 커넥터 화면용(토큰 행 단위)이므로 변경하지 않는다.

앱 비밀번호
  app_passwords 테이블(평문 미저장, SHA-256). 메일(IMAP/SMTP — dovecot 이 호출하는 mail-auth)과
  DAV(Basic 인증)에서 계정 비밀번호 대신 수신한다. verify_app_password 가 해당 검증 지점이다.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import AppPassword, OAuthConsent, OAuthRefreshToken, User
from app.db.session import get_db

router = APIRouter(prefix="/api/auth/me", tags=["auth"])

APP_PASSWORD_SCOPES = ("mail", "dav")
MAX_APP_PASSWORDS = 20
_ALPHABET = "abcdefghijkmnopqrstuvwxyz"  # 소문자 한정(메일 앱 입력 편의), l 제외


# ── 앱 비밀번호 ─────────────────────────────────────────────


def _normalize(pw: str) -> str:
    return "".join(ch for ch in (pw or "").lower() if ch.isalnum())


def hash_app_password(pw: str) -> str:
    return hashlib.sha256(f"app-pw:{_normalize(pw)}".encode()).hexdigest()


def generate_app_password() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(16))
    return "-".join(raw[i:i + 4] for i in range(0, 16, 4))


def looks_like_app_password(pw: str) -> bool:
    n = _normalize(pw)
    return len(n) == 16 and n.isalpha()


async def verify_app_password(db: AsyncSession, user: User, password: str, scope: str) -> bool:
    """해당 사용자의 앱 비밀번호이며 scope 가 허용된 경우 True 반환(마지막 사용 시각 갱신)."""
    if not user or not password or not looks_like_app_password(password):
        return False
    row = (
        await db.execute(
            select(AppPassword).where(
                AppPassword.token_hash == hash_app_password(password),
                AppPassword.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if row is None or scope not in (row.scopes or "").split(","):
        return False
    row.last_used_at = datetime.now(timezone.utc)
    await db.commit()
    return True


def _pw_public(row: AppPassword) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "scopes": [s for s in (row.scopes or "").split(",") if s],
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
    }


class AppPasswordCreate(BaseModel):
    name: str
    scopes: list[str] = ["mail", "dav"]


@router.get("/app-passwords")
async def list_app_passwords(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(AppPassword).where(AppPassword.user_id == user.id).order_by(AppPassword.created_at.desc())
        )
    ).scalars().all()
    return {"app_passwords": [_pw_public(r) for r in rows]}


@router.post("/app-passwords", status_code=201)
async def create_app_password(
    body: AppPasswordCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력하십시오")
    if len(name) > 100:
        raise HTTPException(status_code=400, detail="이름은 100자 이하로 입력하십시오")
    scopes = [s for s in dict.fromkeys(body.scopes or []) if s in APP_PASSWORD_SCOPES]
    if not scopes:
        raise HTTPException(status_code=400, detail="사용할 곳(메일·캘린더/연락처)을 하나 이상 선택하십시오")
    count = len((await db.execute(select(AppPassword.id).where(AppPassword.user_id == user.id))).all())
    if count >= MAX_APP_PASSWORDS:
        raise HTTPException(status_code=400, detail=f"앱 비밀번호는 {MAX_APP_PASSWORDS}개까지 만들 수 있습니다")
    plain = generate_app_password()
    row = AppPassword(user_id=user.id, name=name, scopes=",".join(scopes), token_hash=hash_app_password(plain))
    db.add(row)
    await db.commit()
    await db.refresh(row)
    # 평문은 본 응답에서 1회만 반환
    return {**_pw_public(row), "password": plain}


@router.delete("/app-passwords/{pw_id}")
async def delete_app_password(pw_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(
            select(AppPassword).where(AppPassword.id == pw_id, AppPassword.user_id == user.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="앱 비밀번호를 찾을 수 없습니다")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ── 연결된 앱(OAuth) ────────────────────────────────────────


def _scope_labels(scopes: list[str]) -> list[str]:
    from app.auth.oauth_provider import SCOPE_DESCRIPTIONS

    return [SCOPE_DESCRIPTIONS.get(s, s) for s in scopes if s]


async def _client_name(db: AsyncSession, client_id: str) -> str:
    from app.auth.oauth_provider import _lookup_client

    try:
        cfg = await _lookup_client(db, client_id)
    except Exception:
        cfg = None
    return (cfg or {}).get("client_name") or client_id


def _aware(dt):
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


@router.get("/apps")
async def list_connected_apps(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """동의 또는 리프레시 토큰이 유효한 OAuth 앱 — client_id 당 한 행."""
    consents = (
        await db.execute(
            select(OAuthConsent).where(OAuthConsent.user_id == user.id, OAuthConsent.revoked_at.is_(None))
        )
    ).scalars().all()
    tokens = (
        await db.execute(select(OAuthRefreshToken).where(OAuthRefreshToken.user_id == user.id))
    ).scalars().all()

    apps: dict[str, dict] = {}

    def _slot(cid: str) -> dict:
        return apps.setdefault(cid, {"client_id": cid, "scopes": set(), "connected_at": None,
                                     "last_used_at": None, "live_tokens": 0, "consented": False})

    for c in consents:
        a = _slot(c.client_id)
        a["consented"] = True
        a["scopes"].update((c.scopes or "").split())
        g = _aware(c.granted_at)
        if g and (a["connected_at"] is None or g < a["connected_at"]):
            a["connected_at"] = g
    for t in tokens:
        live = t.revoked_at is None
        if not live and t.client_id not in apps:
            continue  # 연결 해제된 앱의 이전 토큰은 마지막 사용 시각 계산에만 사용
        a = _slot(t.client_id)
        issued = _aware(t.issued_at)
        if live:
            a["live_tokens"] += 1
            a["scopes"].update((t.scope or "").split())
            if issued and (a["connected_at"] is None or issued < a["connected_at"]):
                a["connected_at"] = issued
        # 리프레시 토큰은 사용 시마다 재발급(회전)되므로 마지막 발급 = 마지막 사용
        if issued and (a["last_used_at"] is None or issued > a["last_used_at"]):
            a["last_used_at"] = issued

    out = []
    for cid, a in apps.items():
        if not a["consented"] and not a["live_tokens"]:
            continue
        scopes = sorted(a["scopes"])
        out.append({
            "client_id": cid,
            "name": await _client_name(db, cid),
            "scopes": scopes,
            "scope_labels": _scope_labels(scopes),
            "connected_at": a["connected_at"],
            "last_used_at": a["last_used_at"],
        })
    out.sort(key=lambda x: x["last_used_at"] or x["connected_at"] or datetime.min.replace(tzinfo=timezone.utc),
             reverse=True)
    return {"apps": out}


@router.delete("/apps/{client_id}")
async def disconnect_app(client_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """동의 철회 및 해당 앱에 발급된 본인 리프레시 토큰 전부 폐기. 본인 연결이 없으면 404."""
    now = datetime.now(timezone.utc)
    consents = (
        await db.execute(
            select(OAuthConsent).where(
                OAuthConsent.user_id == user.id,
                OAuthConsent.client_id == client_id,
                OAuthConsent.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    tokens = (
        await db.execute(
            select(OAuthRefreshToken).where(
                OAuthRefreshToken.user_id == user.id,
                OAuthRefreshToken.client_id == client_id,
                OAuthRefreshToken.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    if not consents and not tokens:
        raise HTTPException(status_code=404, detail="연결된 앱을 찾을 수 없습니다")
    for c in consents:
        c.revoked_at = now
    for t in tokens:
        t.revoked_at = now
    await db.commit()
    return {"ok": True, "revoked_tokens": len(tokens)}
