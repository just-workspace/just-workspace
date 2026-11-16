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

    `user_id` 는 편집자(OnlyOffice 협업 표시·잠금용), `owner_id` 는 경로 해석의 기준이 되는
    파일 소유자이다. 일반적으로 동일하나, 공유 링크로 진입한 게스트는 계정이 없으므로 링크 생성자가
    owner 가 된다.

    `scope` 는 편집 세션·잠금을 구분하는 키(없으면 owner_id). 팀 공유 폴더(shared/..) 문서는 누가 열든
    동일 값("shared")이어야 한 세션에서 공동 편집한다 — app/wopi/router.py session_scope 참고.
    `link_id` 는 공유 링크로 진입한 게스트 토큰에만 포함한다 — 저장 시 해당 링크의 유효 여부를 재검증한다.
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
