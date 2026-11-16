# AI connector (MCP)

Just Workspace exposes its workspace tools as a remote **MCP server** (Model
Context Protocol, Streamable HTTP). An external AI client that supports custom
connectors — claude.ai, Claude Desktop, Claude Code and similar — can register
it and then read (and, where permitted, write) workspace data on behalf of the
signed-in user. Authentication reuses the workspace's built-in OAuth provider;
there is no separate auth stack.

The connector is part of the **AI assistant zone** (`ai`). If that zone is not
installed, none of the endpoints below exist.

Addresses in this document are examples: the workspace is
`https://workspace.example.com`, the optional dedicated MCP host is
`https://mcp.example.com`.

## Two connector URLs

| Connector | URL | Token scope | What it exposes |
|---|---|---|---|
| **Read-only** | `<MCP base>/api/mcp/read` | `mcp:read` | Read tools only |
| **Read + write** | `<MCP base>/api/mcp/write` | `mcp:write` | Read tools and write tools. Risky writes wait for the user's approval |

`<MCP base>` is `MCP_PUBLIC_URL` if set, otherwise `APP_URL`.

The two are separate OAuth resources (the token `aud` must equal the URL
character for character). A token issued for the read connector can never call
a write tool, even if it carries the `mcp:write` scope. A user who wants writes
has to add the write URL as a second connector on purpose.

Users find both URLs, ready to copy, under **설정 › AI 연동(MCP)**.

There is also a bare `<MCP base>/api/mcp` endpoint (read tools only) kept for
clients that were registered with that URL. Use `/api/mcp/read` for new setups.

## Setting up a connector

1. **Client credentials** — two options.

   **(a) Dynamic Client Registration (default, RFC 7591).** The authorization
   server advertises `registration_endpoint` (`APP_URL/oauth/register`), so the
   client registers itself: enter only the connector URL, leave Client
   ID/Secret empty, and sign in. Dynamic clients require exact-match `https`
   redirect URIs, have their secret stored hashed, and are capped globally by
   `OAUTH_DYNAMIC_CLIENTS_MAX` (default 500). Their scope is limited to
   `mcp:read`, plus `mcp:write` only while the administrator allows connector
   writes (see [Writes](#writes)).

   **(b) Static client** — add an entry to `OAUTH_CLIENTS_JSON` (`.env`) when
   a fixed Client ID is required. The Client ID is the map key; the Client Secret
   is its `secret` value:

   ```json
   {
     "claude-mcp": {
       "secret": "<openssl rand -hex 24>",
       "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
       "scopes": ["mcp:read"]
     }
   }
   ```

   `redirect_uris` is an exact whitelist — do not widen it to prefix/wildcard
   matching. Add `"mcp:write"` to `scopes` only if this client should be able
   to use the write connector.

2. **In the AI client** (claude.ai: Settings → Connectors → Add custom connector):
   - **URL**: `https://mcp.example.com/api/mcp/read` (or `…/api/mcp/write`)
   - **Client ID / Secret**: empty for DCR, or the static client's ID and `secret`

   The URL must match the resource **character for character** (no trailing slash).

The client then runs the OAuth authorization-code + PKCE flow against the
workspace. The user signs in to the workspace and sees a consent screen listing
the requested scopes. The client receives an access token whose `aud` is the
connector URL and calls `tools/list` / `tools/call`.

### Personal access tokens

For clients that cannot do OAuth (for example a config-file based setup),
**설정 › AI 연동(MCP)** lets a user create a `wsmcp_…` token. It is shown once,
stored hashed, expires after 30, 90 or 365 days, and is read-only unless the
user ticks "write" while the administrator allows connector writes. The same
page lists and revokes the user's OAuth connections (one per connected client).
API: `/api/ai-connect/*` (`backend/app/mcp/account_router.py`).

## What a connector can see

Every `tools/list` and `tools/call` is filtered for the user the token belongs to:

- **Zone and module** — a tool belongs to a module (`backend/app/mcp/access.py`,
  `TOOL_MODULE`). If the module's zone is not installed or the administrator
  switched the module off, its tools are hidden. A tool that is not in the map
  is hidden.
- **Group permissions** — if a module is granted only to certain groups
  (관리 › 그룹), only those users see its tools.
- **Scope** — the read connector lists read tools; the write connector lists both.
- **Data access** — a tool acts as the user. It returns only what that user
  could open in the web UI.

Tools live in `backend/app/mcp/tools/`. By module:

| Module | Read | Write (low risk) | Write (high risk — approval) |
|---|---|---|---|
| files | `files_list` `files_read` `files_stat` `files_search` `files_recent` `files_archive_list` `files_zip` `pdf_inspect` | `files_write_text` `files_create_folder` `files_copy` `files_move` `files_unzip` `files_convert` `pdf_*` (merge, split, rotate …) | `files_delete` `files_share_external` |
| mail | `mail_search` `mail_read` `mail_read_attachment` | `mail_save_draft` | `mail_send` |
| chat | `chat_list_channels` `chat_read_messages` | `chat_send_message` | — |
| board | `board_list_posts` `board_read_post` `board_search` | `board_create_post` `board_add_comment` | `board_delete_post` |
| wiki | `notes_list` `notes_read` `notes_search` | `notes_create` `notes_update` | `notes_delete` |
| calendar · contacts · tasks | `calendar_list_calendars` `calendar_list_events` `contacts_search` `tasks_list` | `calendar_create_event` `calendar_update_event` `tasks_create` `tasks_update` | `calendar_delete_event` `tasks_delete` |
| (no module) | `workspace_context` `web_search` `web_fetch` `approvals_status` | `docs_create` `docs_create_bundle` | — |

This table is a snapshot; the code is the reference. `web_search` uses the
SearXNG container that comes with the AI assistant zone. `code_run` (sandboxed
code execution) is not offered to connectors unless an administrator opts in.

## Writes

Write tools are never executed directly. Each call goes through
`backend/app/mcp/writes.py`:

| Risk | Examples | What happens when a connector calls it |
|---|---|---|
| **low** — creates or edits something that can be undone | save a draft, create an event, write a file | Runs immediately (the AI client has its own per-tool confirmation). Exception: if the same client read untrusted external content in the previous 15 minutes, the call is parked for approval instead |
| **high** — deletes, sends, or shares outside | send mail, delete a file, external share link | Always parked in the user's **승인 대기함** (approval inbox, `/approvals`) for up to 30 minutes. It runs only when the user approves it there |

- Low-risk writes report an undo action; the user can undo from the approval
  inbox for 10 minutes.
- Every write request, approval, rejection and undo is recorded
  (관리 › AI 운영 › 쓰기 현황 · 감사 로그).
- **Administrator switch**: 관리 › AI 운영 › 정책 › "AI 커넥터에 쓰기 허용"
  (on by default). When off, connectors and personal tokens are read-only: new
  dynamic clients and tokens cannot obtain `mcp:write`, and already-connected
  write connectors only read. The built-in AI assistant's own writes are
  governed separately.

## Discovery flow

The connector discovers everything from the MCP URL (shown for the read
connector; replace `read` with `write` for the other one):

| Step | Host | Path |
|---|---|---|
| 1. Protected-resource metadata | MCP base | `GET /.well-known/oauth-protected-resource/api/mcp/read` |
| 2. Authorization-server metadata | workspace | `GET /.well-known/oauth-authorization-server` |
| 3. Authorize + token (PKCE) | workspace | `/oauth/authorize`, `/oauth/token` |
| 4. MCP calls | MCP base | `POST /api/mcp/read` |

An unauthenticated call to the connector URL returns **401** with

```
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp/read", scope="mcp:read"
```

That pointer is what makes the client start discovery — if a proxy strips the
header, the connection fails without a useful error.

The protected-resource metadata reports:

```json
{
  "resource": "https://mcp.example.com/api/mcp/read",
  "authorization_servers": ["https://workspace.example.com"],
  "scopes_supported": ["mcp:read"],
  "bearer_methods_supported": ["header"]
}
```

`MCP_PUBLIC_URL` (`.env`) drives the resource/`aud` and this metadata; `APP_URL`
stays the OAuth issuer. Leave `MCP_PUBLIC_URL` empty to serve the connector on
the workspace's own address.

## Trust boundary (prompt-injection defense)

Tools that return text written by someone other than the user — inbound mail,
web pages, file contents, other people's chat messages, board posts, wiki
pages, calendar invitations — wrap their output so the model treats it as data,
never as instructions:

```json
{
  "untrusted": true,
  "source": "external_email",
  "data": { "...": "original tool result" }
}
```

`source` names where the content came from (`external_email`, `external_web`,
`file_content`, `chat_messages`, `board_posts`, `wiki_pages`, …). Reading such
content also starts the 15-minute window described under [Writes](#writes).

When adding a tool: mark it `untrusted_output=True` if its result can contain
third-party text, give every side-effecting tool `scope="mcp:write"` with the
right `risk`, and add it to `TOOL_MODULE`.

## Optional: a dedicated MCP host

The connector can be served on its own hostname so that only the MCP paths are
reachable there. Set `MCP_PUBLIC_URL=https://mcp.example.com` and, on the
reverse proxy in front of the workspace, create a server for that name that
forwards **only**:

- `location /api/mcp/` → the workspace's nginx (Streamable HTTP: buffering off, long read timeouts)
- `location /.well-known/oauth-protected-resource` → the workspace's nginx
- everything else → `404`

The workspace's own nginx (`nginx/nginx.conf`) already matches `^~ /api/mcp`
ahead of the generic `/api/` block, with buffering off and 24-hour timeouts.

The hostname needs a public DNS record and a TLS certificate. The AI vendor's
servers call the connector from the internet, so it must be reachable from
outside; restricting the source to the vendor's published address ranges on
the firewall is a reasonable hardening step.

## Internal key (headless agents)

`MCP_INTERNAL_TOOLS_ENABLED=true` together with a non-empty `MCP_API_KEY` makes
the endpoints accept that key as a bearer token, not bound to any user. It is
off by default and intended for a trusted internal automation only — it should
remain off unless required.
