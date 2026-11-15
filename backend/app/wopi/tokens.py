"""WOPI access token management.

Tokens are used for server-to-server communication between
OnlyOffice and the backend WOPI endpoints.
"""

from itsdangerous import BadSignature, URLSafeTimedSerializer

from app.config import get_settings

settings = get_settings()
_signer = URLSafeTimedSerializer(settings.secret_key, salt="wopi-token")


def create_wopi_token(
    user_id: str,
    user_name: str,
    virtual_path: str,
    permissions: str = "edit",
    owner_id: str | None = None,
    scope: str | None = None,
    link_id: str | None = None,
) -> str:
    """Create a signed WOPI access token.

    `user_id` 는 편집하는 사람(OnlyOffice 협업 표시·잠금용), `owner_id` 는 경로를 풀 기준이 되는
    파일 소유자다. 보통 같지만, 공유 링크로 들어온 손님은 계정이 없으므로 링크를 만든 사람이
    owner 가 된다.

    `scope` 는 편집 세션·잠금을 묶는 키(없으면 owner_id). 팀 공유 폴더(shared/..) 문서는 누가 열든
    같은 값("shared")이라야 한 세션에서 같이 편집한다 — app/wopi/router.py session_scope 참고.
    `link_id` 는 공유 링크로 들어온 손님 토큰에만 — 저장할 때 그 링크가 아직 살아 있는지 다시 본다.
    """
    data = {
        "user_id": user_id,
        "user_name": user_name,
        "file_path": virtual_path,
        "permissions": permissions,
        "owner_id": owner_id or user_id,
    }
    if scope:
        data["scope"] = scope
    if link_id:
        data["link_id"] = link_id
    return _signer.dumps(data)


def validate_wopi_token(token: str) -> dict | None:
    """Validate and return token payload, or None if invalid/expired."""
    try:
        return _signer.loads(token, max_age=settings.wopi_token_ttl)
    except BadSignature:
        return None
