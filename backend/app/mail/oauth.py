"""메일 OAuth2 (Gmail / Microsoft 365) — XOAUTH2 연결용 토큰 흐름.

- 관리자가 provider별 client_id/secret(+MS tenant)을 등록(SystemSetting).
- 사용자는 /api/mail/oauth/{provider}/authorize 로 동의 → callback 에서 토큰 교환 →
  MailAccount(auth_method=oauth) 생성. IMAP/SMTP는 XOAUTH2(access token)로 인증.
- access token 만료 시 refresh token 으로 자동 갱신(get_access_token).

⚠ 사용자가 Google Cloud / Azure 에서 OAuth 앱을 등록하고 redirect_uri 를 등록해야 함:
   {APP_URL}/api/mail/oauth/google/callback , {APP_URL}/api/mail/oauth/microsoft/callback
"""
from __future__ import annotations

import base64
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import MailAccount, SystemSetting, User
from app.db.session import get_db, async_session
from app.mail.crypto import decrypt_password, encrypt_password

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/mail/oauth", tags=["mail-oauth"])

PROVIDERS = {
    "google": {
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        # contacts.readonly 는 메일과 별개 스코프다. 새로 연동하는 계정은 바로
        # 연락처를 가져올 수 있고, 기존 연동 계정은 한 번 재연동해야 한다.
        "scope": ("https://mail.google.com/ openid email "
                  "https://www.googleapis.com/auth/contacts.readonly"),
        "imap": ("imap.gmail.com", 993, "ssl"),
        "smtp": ("smtp.gmail.com", 587, "starttls"),
        "extra": {"access_type": "offline", "prompt": "consent"},
    },
    "microsoft": {
        "scope": ("offline_access openid email "
                  "https://outlook.office365.com/IMAP.AccessAsUser.All "
                  "https://outlook.office365.com/SMTP.Send"),
        "imap": ("outlook.office365.com", 993, "ssl"),
        "smtp": ("smtp.office365.com", 587, "starttls"),
    },
}


# ─── 설정(SystemSetting) ───
async def _get(db, key: str, default: str = "") -> str:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    return s.value if s and s.value is not None else default


async def _set(db, key: str, value: str) -> None:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    if s:
        s.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


async def _provider_cfg(db, provider: str) -> dict:
    p = f"mail.oauth.{provider}."
    enc = await _get(db, p + "client_secret")
    secret = ""
    if enc:
        try:
            secret = decrypt_password(enc)
        except Exception:
            secret = ""
    return {
        "client_id": await _get(db, p + "client_id"),
        "client_secret": secret,
        "tenant": await _get(db, p + "tenant", "common"),
    }


def _ms_url(kind: str, tenant: str) -> str:
    return f"https://login.microsoftonline.com/{tenant or 'common'}/oauth2/v2.0/{kind}"


def _redirect_uri(provider: str) -> str:
    return f"{settings.app_url.rstrip('/')}/api/mail/oauth/{provider}/callback"


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.secret_key, salt="mail-oauth-state")


def _decode_jwt_email(id_token: str) -> str:
    """id_token(JWT) 페이로드에서 email/preferred_username 추출(검증 생략 — TLS로 직접 수신)."""
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("email") or data.get("preferred_username") or data.get("upn") or ""
    except Exception:
        return ""


# ─── 토큰 교환/갱신 ───
async def _token_request(provider: str, cfg: dict, data: dict) -> dict:
    url = PROVIDERS["google"]["token"] if provider == "google" else _ms_url("token", cfg["tenant"])
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    if r.status_code != 200:
        raise RuntimeError(f"token endpoint {r.status_code}: {r.text[:200]}")
    return r.json()


async def get_access_token(account: MailAccount) -> str:
    """유효한 access token 반환(만료 시 refresh + DB 갱신)."""
    now = datetime.now(timezone.utc)
    if (account.oauth_access_token and account.oauth_expires_at
            and account.oauth_expires_at > now + timedelta(seconds=120)):
        return account.oauth_access_token
    refresh = decrypt_password(account.oauth_refresh_token or "")
    if not refresh:
        raise RuntimeError("OAuth refresh token이 없습니다 — 계정을 다시 연결하세요")
    async with async_session() as db:
        cfg = await _provider_cfg(db, account.oauth_provider or "")
        if not cfg["client_id"]:
            raise RuntimeError("관리자가 OAuth 앱을 설정하지 않았습니다")
        tok = await _token_request(account.oauth_provider, cfg, {
            "client_id": cfg["client_id"], "client_secret": cfg["client_secret"],
            "grant_type": "refresh_token", "refresh_token": refresh,
        })
        acc = await db.get(MailAccount, account.id)
        if acc:
            acc.oauth_access_token = tok["access_token"]
            acc.oauth_expires_at = now + timedelta(seconds=int(tok.get("expires_in", 3600)))
            if tok.get("refresh_token"):
                acc.oauth_refresh_token = encrypt_password(tok["refresh_token"])
            await db.commit()
            account.oauth_access_token = acc.oauth_access_token
            account.oauth_expires_at = acc.oauth_expires_at
    return account.oauth_access_token


def xoauth2_string(email: str, access_token: str) -> str:
    """SASL XOAUTH2 base64 문자열."""
    raw = f"user={email}\x01auth=Bearer {access_token}\x01\x01"
    return base64.b64encode(raw.encode()).decode()


# ─── 엔드포인트: 상태/설정 ───
@router.get("/providers")
async def oauth_providers(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """프론트 — 설정된 provider(연결 버튼 노출용)."""
    out = {}
    for p in PROVIDERS:
        cfg = await _provider_cfg(db, p)
        out[p] = bool(cfg["client_id"] and cfg["client_secret"])
    return out


class OAuthConfig(BaseModel):
    provider: str
    client_id: str | None = None
    client_secret: str | None = None
    tenant: str | None = None


@router.get("/config")
async def oauth_get_config(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(403, "관리자만 가능합니다")
    out = {}
    for p in PROVIDERS:
        cfg = await _provider_cfg(db, p)
        out[p] = {"client_id": cfg["client_id"], "has_secret": bool(cfg["client_secret"]),
                  "tenant": cfg["tenant"], "redirect_uri": _redirect_uri(p)}
    return out


@router.put("/config")
async def oauth_put_config(body: OAuthConfig, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(403, "관리자만 가능합니다")
    if body.provider not in PROVIDERS:
        raise HTTPException(400, "지원하지 않는 provider")
    p = f"mail.oauth.{body.provider}."
    if body.client_id is not None:
        await _set(db, p + "client_id", body.client_id.strip())
    if body.client_secret:
        await _set(db, p + "client_secret", encrypt_password(body.client_secret))
    if body.tenant is not None:
        await _set(db, p + "tenant", body.tenant.strip() or "common")
    await db.commit()
    return {"ok": True}


# ─── 엔드포인트: OAuth 흐름 ───
@router.get("/{provider}/authorize")
async def oauth_authorize(provider: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if provider not in PROVIDERS:
        raise HTTPException(404, "지원하지 않는 provider")
    cfg = await _provider_cfg(db, provider)
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise HTTPException(400, "관리자가 OAuth 앱을 설정하지 않았습니다")
    state = _serializer().dumps({"uid": user.id, "p": provider, "n": secrets.token_hex(8)})
    params = {
        "client_id": cfg["client_id"], "redirect_uri": _redirect_uri(provider),
        "response_type": "code", "scope": PROVIDERS[provider]["scope"], "state": state,
    }
    params.update(PROVIDERS[provider].get("extra", {}))
    auth_url = (PROVIDERS["google"]["auth"] if provider == "google" else _ms_url("authorize", cfg["tenant"]))
    return RedirectResponse(url=f"{auth_url}?{urlencode(params)}", status_code=302)


@router.get("/{provider}/callback")
async def oauth_callback(provider: str, request: Request, db: AsyncSession = Depends(get_db)):
    if provider not in PROVIDERS:
        raise HTTPException(404, "지원하지 않는 provider")
    err = request.query_params.get("error")
    if err:
        return RedirectResponse(url=f"/mail/accounts?oauth_error={err}", status_code=302)
    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    try:
        st = _serializer().loads(state, max_age=600)
        uid = st["uid"]
        assert st["p"] == provider
    except (BadSignature, Exception):
        return RedirectResponse(url="/mail/accounts?oauth_error=state", status_code=302)

    cfg = await _provider_cfg(db, provider)
    try:
        tok = await _token_request(provider, cfg, {
            "client_id": cfg["client_id"], "client_secret": cfg["client_secret"],
            "grant_type": "authorization_code", "code": code, "redirect_uri": _redirect_uri(provider),
        })
    except Exception as e:
        logger.warning("[mail-oauth] token exchange failed: %s", e)
        return RedirectResponse(url="/mail/accounts?oauth_error=token", status_code=302)

    email = _decode_jwt_email(tok.get("id_token", ""))
    refresh = tok.get("refresh_token", "")
    if not email or not refresh:
        return RedirectResponse(url="/mail/accounts?oauth_error=incomplete", status_code=302)

    imap_h, imap_p, imap_s = PROVIDERS[provider]["imap"]
    smtp_h, smtp_p, smtp_s = PROVIDERS[provider]["smtp"]
    now = datetime.now(timezone.utc)

    existing = (await db.execute(select(MailAccount).where(
        MailAccount.user_id == uid, MailAccount.email == email))).scalar_one_or_none()
    acc = existing or MailAccount(user_id=uid, email=email, display_name=email)
    acc.imap_host, acc.imap_port, acc.imap_security = imap_h, imap_p, imap_s
    acc.smtp_host, acc.smtp_port, acc.smtp_security = smtp_h, smtp_p, smtp_s
    acc.username = email
    acc.password_encrypted = acc.password_encrypted or ""
    acc.auth_method = "oauth"
    acc.oauth_provider = provider
    acc.oauth_refresh_token = encrypt_password(refresh)
    acc.oauth_access_token = tok.get("access_token", "")
    acc.oauth_expires_at = now + timedelta(seconds=int(tok.get("expires_in", 3600)))
    if not existing:
        db.add(acc)
    await db.commit()
    return RedirectResponse(url="/mail/accounts?oauth=connected", status_code=302)
