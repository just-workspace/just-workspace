"""메일 제공자 프리셋 — 도메인으로 IMAP/SMTP 서버 + 인증 방식/안내 자동 결정.

가이드형 IMAP 온보딩에 사용: 사용자가 이메일만 입력 → detect()가 서버 설정과
제공자별 인증 안내(앱 비밀번호 링크 등)를 반환 → 프론트는 서버 설정을 자동 입력하고
안내만 표시한 뒤 비밀번호만 입력받는다.

auth:
  password      — 일반 계정 비밀번호로 IMAP 가능(보통 IMAP 사용 설정 필요)
  app_password  — 앱 전용 비밀번호 필요(대개 2FA 활성 상태). 일반 비밀번호는 거부됨
  oauth         — OAuth2 권장/필수(아직 미구현 → app_password 안내로 폴백)
"""

from __future__ import annotations

# 도메인(소문자) → 프리셋
_PRESETS: dict[str, dict] = {
    # ── Google ──
    "gmail.com": {
        "label": "Gmail", "auth": "app_password",
        "imap_host": "imap.gmail.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.gmail.com", "smtp_port": 587, "smtp_security": "starttls",
        "help_url": "https://myaccount.google.com/apppasswords",
        "guide": "2단계 인증을 활성화한 후 '앱 비밀번호'를 발급해 입력하십시오(일반 비밀번호는 거부됩니다).",
    },
    # ── Naver ──
    "naver.com": {
        "label": "네이버", "auth": "password",
        "imap_host": "imap.naver.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.naver.com", "smtp_port": 587, "smtp_security": "starttls",
        "help_url": "https://mail.naver.com/option/imap",
        "guide": "네이버 메일 > 환경설정 > IMAP/SMTP 에서 '사용함'으로 설정 후 비밀번호(또는 2단계 인증 시 애플리케이션 비밀번호)를 입력하십시오.",
    },
    # ── Kakao / Daum ──
    "daum.net": {
        "label": "다음", "auth": "password",
        "imap_host": "imap.daum.net", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.daum.net", "smtp_port": 465, "smtp_security": "ssl",
        "help_url": "https://mail.daum.net",
        "guide": "다음 메일 > 환경설정 > IMAP/POP3 에서 IMAP 사용을 활성화한 후 비밀번호를 입력하십시오.",
    },
    "hanmail.net": {"alias": "daum.net"},
    "kakao.com": {
        "label": "카카오", "auth": "password",
        "imap_host": "imap.kakao.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.kakao.com", "smtp_port": 465, "smtp_security": "ssl",
        "help_url": "https://mail.kakao.com",
        "guide": "카카오 메일 설정에서 IMAP 사용을 활성화한 후 비밀번호를 입력하십시오.",
    },
    "nate.com": {
        "label": "네이트", "auth": "password",
        "imap_host": "imap.nate.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.nate.com", "smtp_port": 465, "smtp_security": "ssl",
        "help_url": "https://mail.nate.com",
        "guide": "네이트 메일 환경설정에서 IMAP 사용을 활성화한 후 비밀번호를 입력하십시오.",
    },
    # ── Microsoft ──
    "outlook.com": {
        "label": "Outlook", "auth": "app_password",
        "imap_host": "outlook.office365.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp-mail.outlook.com", "smtp_port": 587, "smtp_security": "starttls",
        "help_url": "https://account.live.com/proofs/AppPassword",
        "guide": "기본 인증이 제한되어 앱 비밀번호(2단계 인증 필요)가 필요합니다. OAuth2 연동은 추후 지원 예정.",
    },
    "hotmail.com": {"alias": "outlook.com"},
    "live.com": {"alias": "outlook.com"},
    "msn.com": {"alias": "outlook.com"},
    # ── Yahoo ──
    "yahoo.com": {
        "label": "Yahoo", "auth": "app_password",
        "imap_host": "imap.mail.yahoo.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.mail.yahoo.com", "smtp_port": 587, "smtp_security": "starttls",
        "help_url": "https://login.yahoo.com/account/security/app-passwords",
        "guide": "앱 비밀번호를 발급해 입력하십시오.",
    },
    # ── Apple iCloud ──
    "icloud.com": {
        "label": "iCloud", "auth": "app_password",
        "imap_host": "imap.mail.me.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.mail.me.com", "smtp_port": 587, "smtp_security": "starttls",
        "help_url": "https://support.apple.com/ko-kr/102654",
        "guide": "Apple ID 에서 앱 전용 암호를 생성해 입력하십시오.",
    },
    "me.com": {"alias": "icloud.com"},
}


def _resolve_alias(p: dict) -> dict:
    if "alias" in p:
        return _PRESETS[p["alias"]]
    return p


def detect(email: str) -> dict:
    """이메일 → 프리셋. 알려진 도메인이면 정확한 프리셋, 아니면 추정값(guess=True)."""
    domain = (email.rsplit("@", 1)[-1] if "@" in email else "").strip().lower()
    p = _PRESETS.get(domain)
    if p:
        p = _resolve_alias(p)
        return {"domain": domain, "known": True, "guess": False, **p}
    # 미지원 도메인 → autodiscover 추정(imap./smtp.<도메인>)
    return {
        "domain": domain, "known": False, "guess": True,
        "label": domain or "사용자 지정", "auth": "password",
        "imap_host": f"imap.{domain}" if domain else "",
        "imap_port": 993, "imap_security": "ssl",
        "smtp_host": f"smtp.{domain}" if domain else "",
        "smtp_port": 587, "smtp_security": "starttls",
        "help_url": "",
        "guide": "알 수 없는 제공자입니다. 서버 정보를 직접 확인해 입력하십시오(추정값을 채워두었습니다).",
    }


def list_known() -> list[dict]:
    """대표 제공자 목록(피커용)."""
    out = []
    for dom, p in _PRESETS.items():
        if "alias" in p:
            continue
        out.append({"domain": dom, "label": p["label"], "auth": p["auth"]})
    return out
