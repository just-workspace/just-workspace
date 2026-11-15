# AI Connector (claude.ai custom connector)

Just-Workspace exposes its MCP server as a remote endpoint that claude.ai can
register as a **custom connector**. Authentication reuses the built-in OAuth
provider (no separate auth stack).

**Two hosts:**
- **MCP resource server** — `https://mcp.example.com` (dedicated subdomain,
  reverse-proxied). Serves the MCP endpoint + its protected-resource metadata.
- **OAuth authorization server** — `https://workspace.example.com` (the workspace).
  Issues tokens (`/oauth/authorize`, `/oauth/token`) and serves the
  authorization-server metadata. The MCP resource points here for auth.

> **Scope of this document: READ-ONLY.** Only the read connector is enabled.
> The write side (`/api/mcp/write`, approval-gated) is **not built yet** and is
> intentionally deferred — see [Write is not enabled yet](#write-is-not-enabled-yet).

---

## Read connector setup

Register a **single** custom connector on claude.ai pointing at the read
resource on `mcp.example.com`.

1. **Client credentials** — two options.

   **(a) Dynamic Client Registration (default, RFC 7591).** The authorization
   server advertises `registration_endpoint` (`APP_URL/oauth/register`), so
   claude.ai registers itself: enter only the connector URL, leave Client
   ID/Secret empty, and log in. Dynamic clients are clamped to `mcp:read`,
   require exact-match `https` redirect URIs, store secrets hashed, and are
   capped globally by `OAUTH_DYNAMIC_CLIENTS_MAX` (default 500).

   **(b) Static client** — add a `claude-mcp` entry to `OAUTH_CLIENTS_JSON`
   (`.env`), e.g. when you want a fixed Client ID or `mcp:write` later. The
   Client ID is the map key (`claude-mcp`); the Client Secret is its `secret`
   value:

   ```json
   {
     "claude-mcp": {
       "secret": "<openssl rand -hex 24>",
       "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
       "scopes": ["mcp:read"]
     }
   }
   ```

   Keep `scopes` at `["mcp:read"]` for the read-only connector. `redirect_uris`
   is an exact whitelist — do not widen it to prefix/wildcard matching.

2. **claude.ai** → Settings → Connectors → Add custom connector:
   - **URL**: `https://mcp.example.com/api/mcp/read`
   - **Client ID / Secret**: empty for DCR, or `claude-mcp` + its `secret` for a static client

   The URL must match the connector's registered resource **character for
   character** (including no trailing slash).

Claude then runs the OAuth authorization-code + PKCE flow against
`workspace.example.com`, receives an access token whose `aud` is
`https://mcp.example.com/api/mcp/read` and whose `scope` contains `mcp:read`,
and calls `tools/list` / `tools/call` on `mcp.example.com`.

### Tools exposed on the read connector

Only tools classified `scope="mcp:read"` are visible and callable here (further
filtered by module on/off state and the user's RBAC grants). Current set
(`backend/app/mcp/tools/`):

- files: `files_list`, `files_read`, `files_recent`, `files_search`
- notes (plugin): `notes_list`, `notes_search`
- mail: `mail_search`, `mail_read` — output wrapped as untrusted external content
- chat / board: `chat_list_channels`, `chat_read_messages`, `board_list_posts`, `board_read_post`, `board_search`
- PIM: `calendar_list_calendars`, `calendar_list_events`, `contacts_search`, `tasks_list`
- `web_search` (SearXNG, `aitools` profile) — output wrapped as untrusted external content

`notes_create` is the only `mcp:write` tool and therefore **never appears on and
cannot be called via** the read connector.

### Personal Access Tokens

The profile page "AI 연동" (`/api/ai-connect/*`) lets a user create `wsmcp_…`
PATs as a non-interactive fallback to OAuth (shown once, clamped to `mcp:read`),
and list/revoke OAuth connections (each refresh-token chain = one connected
client such as claude.ai or Claude Desktop).

---

## Discovery flow

The connector discovers everything from the MCP URL:

| Step | Where | Path |
|---|---|---|
| 1. Protected-resource metadata | `mcp.example.com` | `GET /.well-known/oauth-protected-resource/api/mcp/read` |
| 2. Authorization-server metadata | `workspace.example.com` | `GET /.well-known/oauth-authorization-server` |
| 3. Authorize + token (PKCE) | `workspace.example.com` | `/oauth/authorize`, `/oauth/token` |
| 4. MCP calls | `mcp.example.com` | `POST /api/mcp/read` |

An unauthenticated call to `https://mcp.example.com/api/mcp/read` returns
**401** with a
`WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp/read"`
header. That pointer is what makes the connector start discovery — a missing
header is the most common cause of silent connection failures.

The protected-resource metadata reports:

```json
{
  "resource": "https://mcp.example.com/api/mcp/read",
  "authorization_servers": ["https://workspace.example.com"],
  "scopes_supported": ["mcp:read"],
  "bearer_methods_supported": ["header"]
}
```

`MCP_PUBLIC_URL` (`.env`, `https://mcp.example.com`) drives the resource/`aud`
and the metadata; `APP_URL` (`https://workspace.example.com`) stays the OAuth issuer.

---

## Trust boundary (prompt-injection defense)

`mail_search` and `web_search` return **unauthenticated external content**.
Their output is wrapped so the model treats it as data, never as instructions:

```json
{
  "untrusted": true,
  "source": "external_email",   // or "external_web" for web_search
  "data": { ... original tool result ... }
}
```

Do not add tools that perform side effects (send mail, delete files, change
permissions, make outbound HTTP requests) to the read endpoint.

---

## Reverse proxy (mcp.example.com)

The dedicated subdomain terminates TLS at the RP (리버스 프록시) and proxies
**only** the MCP paths to the workspace — nothing else of the workspace is
exposed on this host:

- `location /api/mcp/` → `http://<WORKSPACE_LAN_IP>:80` (ws-nginx → backend, Streamable HTTP; keep buffering off and long read timeouts — ws-nginx already does)
- `location /.well-known/oauth-protected-resource` → workspace
- everything else → `404`

ws-nginx matches `^~ /api/mcp` ahead of the generic `/api/` block (no rate-limit, no buffering, 24h timeouts).

Cert: Let's Encrypt on the RP (`/etc/letsencrypt/live/mcp.example.com/`),
auto-renewed via the RP's certbot deploy hook. DNS: `mcp.example.com` A →
public IP (same as the other subdomains). The connector's token exchange is done
by Anthropic's servers (external → public), so no internal hairpin is involved.

---

## Write is not enabled yet

A separate approval-gated write connector (`/api/mcp/write`, scope `mcp:write`,
resource `https://mcp.example.com/api/mcp/write`) is **planned but not
implemented**. Until it ships:

- No `mcp:write` tool (currently `notes_create`) is exposed or callable through
  **any** MCP endpoint — the base `/api/mcp` and `/api/mcp/read` endpoints both
  expose read-scoped tools only.
- Do **not** register a write connector on claude.ai; there is no
  `/api/mcp/write` endpoint to point it at.

When the write side is added it will require its own connector registration and
a human approval step before any write action executes.
