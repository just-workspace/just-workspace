"""Session-authenticated management API backing the profile "AI 연동" page.

Two things the user manages here for the MCP connector:

  * **Personal Access Tokens (PATs)** — ``wsmcp_`` bearer credentials that are a
    non-interactive fallback to the OAuth flow. Created here (plaintext shown
    once), listed (metadata only), and revoked. Clamped to ``mcp:read``.
  * **OAuth connections** — each live refresh token in ``oauth_refresh_tokens``
    is one connected client/session (claude.ai, Claude Desktop, …). Listed and
    revoked (whole rotation chain) here.

Every endpoint is bound to the caller via :func:`get_current_user` and only ever
touches that caller's own tokens/connections — never another user's.

Router prefix ``/api/ai-connect`` is deliberately OUTSIDE ``/api/mcp`` so it can
never be shadowed by the MCP Streamable-HTTP ``Mount("/api/mcp", …)`` (which
catches every ``/api/mcp/*`` path). See ``app.mcp.http_server``.
"""

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.auth.deps import get_current_user
from app.mcp import access as _access
from app.auth.oauth_provider import _get_clients
from app.auth.oauth_store import _revoke_chain
from app.db.models import McpPersonalToken, OAuthDynamicClient, OAuthRefreshToken, User
from app.db.session import get_db
from app.config import get_settings
from app.mcp import pat_store, revocation
from app.mcp import writes as _writes
from app.mcp.http_server import READ_ENDPOINT, WRITE_ENDPOINT

router = APIRouter(prefix="/api/ai-connect", tags=["ai-connect"])
settings = get_settings()


# ── Connector info (URL for the "AI 연동" page) ───────────────


@router.get("/info")
async def connector_info(user: User = Depends(get_current_user), db=Depends(get_db)):
    """Static info the profile page needs to render setup instructions.

    ``connector_url`` is the read MCP resource on the dedicated subdomain
    (mcp_public_url) — the exact URL the user pastes into claude.ai. Must match
    the endpoint's registered resource character-for-character."""
    return {
        "connector_url": READ_ENDPOINT.resource,
        "scope": READ_ENDPOINT.required_scope,
        # 설정 › AI 연동(MCP) 화면 — 읽기 전용·쓰기 포함 주소 두 개 + 관리자 쓰기 허용 여부
        "read_url": READ_ENDPOINT.resource,
        "write_url": WRITE_ENDPOINT.resource,
        "write_enabled": await _access.write_enabled(db),
        "token_prefix": pat_store.PAT_PREFIX,
        "token_expiry_days": list(TOKEN_EXPIRY_DAYS),
    }


# ── PAT (Personal Access Token) ──────────────────────────────


# 무기한 토큰은 생성 불가 — 30일·90일·1년 중 선택
TOKEN_EXPIRY_DAYS = (30, 90, 365)
DEFAULT_TOKEN_DAYS = 90


class CreateTokenRequest(BaseModel):
    name: str
    scope: str | None = None  # space-separated; clamped to mcp:read
    expires_days: int = DEFAULT_TOKEN_DAYS


def _pat_public(row: McpPersonalToken) -> dict:
    """PAT metadata safe to return — never the hash or plaintext."""
    return {
        "id": row.id,
        "name": row.name,
        "scopes": json.loads(row.scopes or "[]"),
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
        "expires_at": row.expires_at,
        "revoked": row.revoked_at is not None,
        "hint": row.token_hint,                       # 끝 4자 — "wsmcp_…7c2e"
        "can_write": "mcp:write" in json.loads(row.scopes or "[]"),
    }


@router.post("/tokens")
async def create_token(
    body: CreateTokenRequest,
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Create a PAT (scope clamped to mcp:read). Returns the plaintext token ONCE."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력하십시오")
    if body.expires_days not in TOKEN_EXPIRY_DAYS:
        raise HTTPException(status_code=400, detail="만료는 30일·90일·1년 중에서 선택하십시오(무기한 토큰은 만들 수 없습니다)")
    requested = (body.scope or "").split() or None
    token, row = await pat_store.create_personal_token(
        db, user_id=user.id, name=name[:255],
        scopes=pat_store.clamp_scopes(requested, allow_write=await _access.write_enabled(db)),
        expires_at=datetime.now(timezone.utc) + timedelta(days=body.expires_days),
    )
    await db.commit()
    return {"token": token, **_pat_public(row)}  # plaintext shown exactly once


@router.get("/tokens")
async def list_tokens(
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """List the caller's PATs (no secret/hash)."""
    rows = (
        await db.execute(
            select(McpPersonalToken)
            .where(McpPersonalToken.user_id == user.id)
            .order_by(McpPersonalToken.created_at.desc())
        )
    ).scalars().all()
    return {"tokens": [_pat_public(r) for r in rows]}


@router.delete("/tokens/{token_id}")
async def revoke_token(
    token_id: str,
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Revoke one of the caller's PATs (404 if not theirs)."""
    row = (
        await db.execute(
            select(McpPersonalToken).where(
                McpPersonalToken.id == token_id,
                McpPersonalToken.user_id == user.id,  # caller-scoped
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="토큰을 찾을 수 없습니다")
    if row.revoked_at is None:
        row.revoked_at = datetime.now(timezone.utc)
        await db.commit()
    await revocation.mark(user.id, f"pat:{row.id}")   # 이미 열려 있는 연결(구 SSE)도 종료한다
    rejected = await _writes.reject_for_client(db, user, f"pat:{row.id}")
    return {"ok": True, "rejected": rejected}


# ── OAuth connections (live refresh tokens = connected clients) ──


async def _client_name(db, client_id: str) -> str:
    """Human label for a client_id: dynamic (DCR) client_name, else the static id."""
    if client_id.startswith("dcr_"):
        row = (
            await db.execute(
                select(OAuthDynamicClient).where(
                    OAuthDynamicClient.client_id == client_id
                )
            )
        ).scalar_one_or_none()
        if row is not None and row.client_name:
            return row.client_name
        return client_id
    # Static client: use a configured name if present, else the id itself.
    cfg = _get_clients().get(client_id) or {}
    return cfg.get("name") or client_id


@router.get("/connections")
async def list_connections(
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """The caller's active OAuth connections — one row per live refresh token."""
    rows = (
        await db.execute(
            select(OAuthRefreshToken)
            .where(
                OAuthRefreshToken.user_id == user.id,
                OAuthRefreshToken.revoked_at.is_(None),
            )
            .order_by(OAuthRefreshToken.issued_at.desc())
        )
    ).scalars().all()
    out = []
    for r in rows:
        out.append({
            "id": r.id,
            "client_id": r.client_id,
            "client_name": await _client_name(db, r.client_id),
            "scope": r.scope,
            "issued_at": r.issued_at,
            "expires_at": r.expires_at,
        })
    return {"connections": out}


@router.delete("/connections/{connection_id}")
async def revoke_connection(
    connection_id: str,
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    """Revoke a connection (refresh token + its whole rotation chain), caller-scoped."""
    row = (
        await db.execute(
            select(OAuthRefreshToken).where(
                OAuthRefreshToken.id == connection_id,
                OAuthRefreshToken.user_id == user.id,  # caller-scoped
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="연결을 찾을 수 없습니다")
    await _revoke_chain(db, row)  # revokes this token + all rotation successors/predecessors
    await db.commit()
    # 리프레시 토큰만 폐기하면 이미 발급된 액세스 토큰(1시간)은 계속 유효하다 — 해제 시각을 기록해 거부한다
    await revocation.mark(user.id, row.client_id)
    return {"ok": True}


# ── 연결된 앱 — MCP 커넥터에 연결된 앱 단위 목록 ─────────
# OAuth: MCP 리소스(읽기·쓰기 주소)에 발급된 유효한 리프레시 토큰을 client_id 로 묶는다.
# 개인 토큰: 1회 이상 사용된(last_used_at) 유효한 토큰 하나 = 앱 하나.
# 행 키(key)는 OAuth 이면 client_id, 개인 토큰이면 "pat:<id>" — 쓰기 요청의 client_id 와 동일한 값이다.

def _aware(dt):
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _is_mcp_resource(resource: str | None) -> bool:
    if not resource:
        return False
    return resource in {READ_ENDPOINT.resource, WRITE_ENDPOINT.resource} or resource.rstrip("/").endswith("/api/mcp")


@router.get("/apps")
async def list_apps(user: User = Depends(get_current_user), db=Depends(get_db)):
    """{apps:[{key, kind: oauth|personal_token, name, token_name, can_write, connected_at, last_used_at, pending}]}"""
    now = datetime.now(timezone.utc)
    apps: dict[str, dict] = {}
    tokens = (await db.execute(
        select(OAuthRefreshToken).where(OAuthRefreshToken.user_id == user.id)
    )).scalars().all()
    for t in tokens:
        if not _is_mcp_resource(t.resource):
            continue
        a = apps.setdefault(t.client_id, {"key": t.client_id, "kind": "oauth", "token_name": None, "scopes": set(),
                                          "connected_at": None, "last_used_at": None, "live": 0})
        issued = _aware(t.issued_at)
        if t.revoked_at is None and (_aware(t.expires_at) or now) >= now:
            a["live"] += 1
            a["scopes"].update((t.scope or "").split())
        if issued and (a["connected_at"] is None or issued < a["connected_at"]):
            a["connected_at"] = issued
        # 리프레시 토큰은 사용 시마다 회전하므로 마지막 발급 = 마지막 사용
        if issued and (a["last_used_at"] is None or issued > a["last_used_at"]):
            a["last_used_at"] = issued
    out = []
    for cid, a in apps.items():
        if not a["live"]:
            continue
        out.append({"key": cid, "kind": "oauth", "name": await _client_name(db, cid), "token_name": None,
                    "can_write": "mcp:write" in a["scopes"], "connected_at": a["connected_at"],
                    "last_used_at": a["last_used_at"]})
    pats = (await db.execute(select(McpPersonalToken).where(
        McpPersonalToken.user_id == user.id, McpPersonalToken.revoked_at.is_(None),
        McpPersonalToken.last_used_at.is_not(None),
    ))).scalars().all()
    for r in pats:
        if r.expires_at is not None and _aware(r.expires_at) < now:
            continue
        out.append({"key": f"pat:{r.id}", "kind": "personal_token", "name": r.name, "token_name": r.name,
                    "can_write": "mcp:write" in json.loads(r.scopes or "[]"), "connected_at": r.created_at,
                    "last_used_at": r.last_used_at})
    for a in out:
        a["pending"] = len(await _writes.pending_for_client(db, user.id, a["key"]))
    out.sort(key=lambda x: _aware(x["last_used_at"]) or _aware(x["connected_at"]) or now, reverse=True)
    return {"apps": out}


@router.delete("/apps/{key:path}")
async def disconnect_app(key: str, user: User = Depends(get_current_user), db=Depends(get_db)):
    """앱 연결 해제 — OAuth 이면 이 앱의 MCP 리프레시 토큰 사슬 전체, 개인 토큰이면 해당 토큰을 폐기한다.
    해당 연결의 대기 쓰기 요청은 '연결 해제됨' 사유로 거부한다. {ok, rejected}"""
    if key.startswith("pat:"):
        row = (await db.execute(select(McpPersonalToken).where(
            McpPersonalToken.id == key[4:], McpPersonalToken.user_id == user.id,
        ))).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="연결을 찾을 수 없습니다")
        if row.revoked_at is None:
            row.revoked_at = datetime.now(timezone.utc)
            await db.commit()
    else:
        rows = (await db.execute(select(OAuthRefreshToken).where(
            OAuthRefreshToken.user_id == user.id, OAuthRefreshToken.client_id == key,
            OAuthRefreshToken.revoked_at.is_(None),
        ))).scalars().all()
        rows = [r for r in rows if _is_mcp_resource(r.resource)]
        if not rows:
            raise HTTPException(status_code=404, detail="연결을 찾을 수 없습니다")
        for r in rows:
            await _revoke_chain(db, r)
        await db.commit()
    # 이미 발급된 액세스 토큰·열려 있는 연결도 이 시점부터 거부한다(app.mcp.revocation)
    await revocation.mark(user.id, key)
    rejected = await _writes.reject_for_client(db, user, key)
    return {"ok": True, "rejected": rejected}
