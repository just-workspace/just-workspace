"""외부 메일 앱 자동 설정 — 주소·비밀번호만 입력하면 서버 설정이 자동 입력되도록 한다.

- Thunderbird·삼성 메일 등: autoconfig(`/.well-known/autoconfig/mail/config-v1.1.xml`, `/mail/config-v1.1.xml`)
- 아웃룩(클래식): POX autodiscover(`/autodiscover/autodiscover.xml`, POST) — DNS `_autodiscover._tcp` SRV 가 이 경로를 지정한다
- 애플(아이폰·맥): 구성 프로필(.mobileconfig) 다운로드 — 로그인한 본인 주소로만 생성한다(비밀번호는 포함하지 않으며,
  설치 시 기기가 입력을 요구한다)
- 웹 화면 안내용 JSON(`/api/mail/client-setup`)

내장 메일서버(builtin) 기준. 호스트는 mail.<domain>, IMAP 993(SSL), 발신 465(SSL)·587(STARTTLS),
아이디는 메일 주소 전체, 비밀번호는 워크스페이스 비밀번호(2단계 인증 사용자는 앱 비밀번호).
"""
from __future__ import annotations

import re
import uuid
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db

root_router = APIRouter(tags=["mail-client-setup"])
router = APIRouter(prefix="/api/mail", tags=["mail"])

IMAP_PORT = 993
SMTP_SSL_PORT = 465
SMTP_STARTTLS_PORT = 587
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$")


def _domain() -> str:
    return get_settings().domain


def _host() -> str:
    return f"mail.{_domain()}"


async def _enabled(db: AsyncSession) -> bool:
    from app.mail.router import _builtin_enabled
    return await _builtin_enabled(db)


def _own_address(email: str | None) -> str | None:
    """본 서비스 도메인 주소만 허용한다(타 도메인 설정은 제공하지 않는다)."""
    e = (email or "").strip()
    if not _EMAIL_RE.match(e) or e.rsplit("@", 1)[1].lower() != _domain().lower():
        return None
    return e


def settings_for(email: str) -> dict:
    return {
        "email": email,
        "username": email,
        "imap": {"host": _host(), "port": IMAP_PORT, "security": "ssl"},
        "smtp": {"host": _host(), "port": SMTP_SSL_PORT, "security": "ssl",
                 "alt_port": SMTP_STARTTLS_PORT, "alt_security": "starttls"},
    }


# ─── Thunderbird autoconfig (삼성 메일 등도 동일 형식을 조회한다) ───

def _autoconfig_xml() -> str:
    d, h = escape(_domain()), escape(_host())
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="{d}">
    <domain>{d}</domain>
    <displayName>{d} 메일</displayName>
    <displayShortName>{d}</displayShortName>
    <incomingServer type="imap">
      <hostname>{h}</hostname>
      <port>{IMAP_PORT}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>{h}</hostname>
      <port>{SMTP_SSL_PORT}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>{h}</hostname>
      <port>{SMTP_STARTTLS_PORT}</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
"""


@root_router.get("/.well-known/autoconfig/mail/config-v1.1.xml", include_in_schema=False)
@root_router.get("/mail/config-v1.1.xml", include_in_schema=False)
async def autoconfig(db: AsyncSession = Depends(get_db)):
    if not await _enabled(db):
        raise HTTPException(status_code=404)
    return Response(_autoconfig_xml(), media_type="application/xml; charset=utf-8",
                    headers={"Cache-Control": "public, max-age=3600"})


# ─── Outlook POX autodiscover ───

_AD_RESP_NS = "http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a"


def _autodiscover_xml(email: str) -> str:
    h, e = escape(_host()), escape(email)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="{_AD_RESP_NS}">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>{h}</Server>
        <Port>{IMAP_PORT}</Port>
        <LoginName>{e}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>{h}</Server>
        <Port>{SMTP_SSL_PORT}</Port>
        <LoginName>{e}</LoginName>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
        <UsePOPAuth>on</UsePOPAuth>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
"""


@root_router.post("/autodiscover/autodiscover.xml", include_in_schema=False)
@root_router.post("/Autodiscover/Autodiscover.xml", include_in_schema=False)
@root_router.get("/autodiscover/autodiscover.xml", include_in_schema=False)
@root_router.get("/Autodiscover/Autodiscover.xml", include_in_schema=False)
async def autodiscover(request: Request, db: AsyncSession = Depends(get_db)):
    if not await _enabled(db):
        raise HTTPException(status_code=404)
    body = (await request.body())[:8192].decode("utf-8", "replace")
    m = re.search(r"<EMailAddress>\s*([^<\s]+)\s*</EMailAddress>", body, re.I)
    email = _own_address(m.group(1) if m else request.query_params.get("email"))
    if not email:
        # 주소 미확인 또는 타 도메인. 아웃룩은 이를 "자동 설정 없음"으로 판정하고 수동 입력으로 전환한다
        raise HTTPException(status_code=404)
    return Response(_autodiscover_xml(email), media_type="application/xml; charset=utf-8")


# ─── 웹 안내 + 애플 구성 프로필 ───

@router.get("/client-setup")
async def client_setup(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    email = _own_address(user.email)
    if not await _enabled(db) or not email:
        raise HTTPException(status_code=404, detail="내장 메일 계정이 없습니다")
    return settings_for(email)


def _mobileconfig(email: str, display_name: str) -> str:
    d, h, e = escape(_domain()), escape(_host()), escape(email)
    name = escape(display_name or email)
    # 주소별 고정 UUID. 재다운로드 후 설치하면 새 계정이 아닌 기존 프로필을 덮어쓴다
    base = uuid.uuid5(uuid.NAMESPACE_URL, f"mailto:{email}")
    pid = uuid.uuid5(base, "payload")
    rev = ".".join(reversed(_domain().split(".")))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.mail.managed</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>{rev}.mail.{pid}</string>
      <key>PayloadUUID</key><string>{str(pid).upper()}</string>
      <key>PayloadDisplayName</key><string>{d} 메일</string>
      <key>EmailAccountDescription</key><string>{d} 메일</string>
      <key>EmailAccountName</key><string>{name}</string>
      <key>EmailAccountType</key><string>EmailTypeIMAP</string>
      <key>EmailAddress</key><string>{e}</string>
      <key>IncomingMailServerHostName</key><string>{h}</string>
      <key>IncomingMailServerPortNumber</key><integer>{IMAP_PORT}</integer>
      <key>IncomingMailServerUseSSL</key><true/>
      <key>IncomingMailServerUsername</key><string>{e}</string>
      <key>IncomingMailServerAuthentication</key><string>EmailAuthPassword</string>
      <key>OutgoingMailServerHostName</key><string>{h}</string>
      <key>OutgoingMailServerPortNumber</key><integer>{SMTP_SSL_PORT}</integer>
      <key>OutgoingMailServerUseSSL</key><true/>
      <key>OutgoingMailServerUsername</key><string>{e}</string>
      <key>OutgoingMailServerAuthentication</key><string>EmailAuthPassword</string>
      <key>OutgoingPasswordSameAsIncomingPassword</key><true/>
      <key>PreventMove</key><false/>
      <key>SMIMEEnabled</key><false/>
    </dict>
  </array>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>{rev}.mail.profile.{base}</string>
  <key>PayloadUUID</key><string>{str(base).upper()}</string>
  <key>PayloadDisplayName</key><string>{d} 메일 ({e})</string>
  <key>PayloadDescription</key><string>{e} 메일 계정을 이 기기 메일 앱에 추가합니다. 설치할 때 비밀번호를 묻습니다.</string>
  <key>PayloadOrganization</key><string>{d}</string>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
"""


@router.get("/client-setup/apple.mobileconfig")
async def apple_profile(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    email = _own_address(user.email)
    if not await _enabled(db) or not email:
        raise HTTPException(status_code=404, detail="내장 메일 계정이 없습니다")
    body = _mobileconfig(email, user.display_name or "")
    fname = f"{_domain()}-mail.mobileconfig"
    return Response(body, media_type="application/x-apple-aspen-config",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"',
                             "Cache-Control": "no-store"})
