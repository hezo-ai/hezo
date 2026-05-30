# OAuth

Every third-party connection — GitHub included — is an **MCP connector** authorized via **authorization-code + PKCE** with Dynamic Client Registration (RFC 7591) against the provider's own Authorization Server. There is one code path; GitHub is not special-cased at the transport level, only at the post-OAuth side-effect level (SSH-key registration).

- **GitHub** — connects to the official remote GitHub MCP server (`https://api.githubcopilot.com/mcp/`). The issued token is a standard GitHub OAuth token, so it serves both the MCP tool surface (issues, PRs, search) **and** the REST helpers (repo listing/creation, SSH-key registration). One connection, both purposes.
- **Other MCP servers** that publish OAuth metadata per the MCP authorization spec (DatoCMS, Linear, Notion, etc.) — same flow, no GitHub-specific side effects.

There is **no separate hosted callback service** and **no Hezo-team-owned OAuth app**. Each Hezo instance self-registers as a public OAuth client via DCR and handles its own callback at `<this-host>/api/oauth/mcp-callback`.

## Storage

`oauth_connections` — one row per (team, provider, provider_account_id):

| column | notes |
|---|---|
| id | UUID primary key |
| team_id | FK teams; cascade delete |
| provider | e.g. `github`, `datocms`, `linear`, `generic` |
| provider_account_id | stable upstream id (GH user id, DatoCMS workspace id, …) |
| provider_account_label | display string |
| access_token_secret_id | FK secrets; the secret holds the encrypted access token |
| refresh_token_secret_id | FK secrets, nullable |
| scopes | text[] |
| expires_at | nullable; refresh fires when within 60s of expiry if a refresh token exists |
| metadata | jsonb (avatar_url, login, email, token_url, authorize_url, …) |

Tokens themselves never have their own column — they ride the existing `secrets` table:

- name pattern: `OAUTH_<PROVIDER>_<8 hex prefix of connection id>` (and `_REFRESH` suffix for refresh tokens)
- `category = 'api_token'`
- `allowed_hosts` set automatically from the provider:
  - registry-backed connectors (e.g. github) → the capability's `allowedHosts` (github → `['api.githubcopilot.com', 'api.github.com', 'github.com']`)
  - other → host of the resource URL + token URL
- `allow_all_hosts = false` always

That means OAuth tokens flow through the same egress placeholder mechanism as raw `request_credential` secrets. Agents emit `Authorization: Bearer __HEZO_SECRET_OAUTH_GITHUB_AB12CD34__`; the egress proxy substitutes at request time and audits the substitution by name.

`mcp_connections.oauth_connection_id` and `repos.oauth_connection_id` are nullable FKs to `oauth_connections`. Deleting an OAuth connection cascades to nullify those FKs and removes the access/refresh secrets.

## Unified connector flow (auth-code + PKCE + DCR)

All connectors — GitHub and other MCP servers alike — go through this path.

1. **Materialize the connector row.** For UI-initiated connects, `POST /api/teams/:teamId/connectors/ensure { provider_id }` idempotently creates (or returns) the `mcp_connections` row from the capability registry (`packages/shared/src/types/connector-capabilities.ts`). For agent-initiated connectors, `register_connector` writes the row. Either way the row carries the MCP server URL.
2. `POST /api/teams/:teamId/auth-start { connector_id }`. Backend:
   - Probes the MCP URL / discovers the Authorization Server via PRM (RFC 9728) + AS metadata (RFC 8414) through `discoverMcpAuthorization`, or reuses the cached `config.dcr`.
   - **Dynamic Client Registration** (RFC 7591) via `registerClient` if not already cached — self-registers as a public client with `redirect_uri = <this-host>/api/oauth/mcp-callback`.
   - **Scope selection**: if the connector's registry capability defines an explicit `scopes` list, that overrides the AS's advertised `scopes_supported`. GitHub's entry requests `repo workflow read:org write:ssh_signing_key write:public_key` — without the override, GitHub's AS advertises every OAuth scope and the consent screen is unreviewable.
   - PKCE-signs an HMAC state envelope (`signState` in `services/oauth/state.ts`) carrying `teamId`, the PKCE `code_verifier`, the provider config, and the `mcpConnectionId` link target. Returns `{ auth_url }`.
3. UI opens `auth_url` in a pop-up. User authorizes at the provider; provider redirects to `GET /api/oauth/mcp-callback?code=…&state=…` (public route — auth is the signed state).
4. Backend verifies state, exchanges the code at the AS token endpoint (`grant_type=authorization_code` + PKCE verifier + DCR-issued `client_id`, no `client_secret`), creates an `oauth_connections` row, and calls `markActive(connectorId, oauthConnectionId)`.
5. **GitHub carve-out**: when the connector resolves to the `github` capability, the callback additionally calls `GET /user` to populate the `oauth_connections` row with the GitHub identity (so `provider = 'github'` and downstream `provider === 'github'` filters match), and registers the team's Ed25519 public key on the connecting user's account as **both** a signing key (`POST /user/ssh_signing_keys`) and an authentication key (`POST /user/keys`). Both registrations are idempotent — GitHub returns 422 "key is already in use" on repeat calls, treated as a no-op. This is the only provider-specific branch in the callback.
6. Backend fires a `CredentialProvided` wakeup on the calling task's assignee (if any), then returns an HTML page that posts `hezo-oauth-success` / `hezo-oauth-error` to `window.opener` and closes itself. If there's no opener, redirects to `state.return_to`.

State is short-lived (15 minutes) and tamper-proof: any modification to the payload invalidates the HMAC. No `client_secret` anywhere — every client is a DCR-registered public client.

The legacy `manual_config`-based `POST /api/teams/:teamId/oauth/auth-code/start` + `GET /api/oauth/callback` path stays for any external operator-supplied MCP that doesn't follow the PRM/DCR pattern (rare); it does not gate the unified flow.

## Refresh

`refreshExpiringTokensForTeam` (in `services/oauth/token-resolver.ts`) is called by the egress proxy substitution path on every outbound request. It selects connections whose `expires_at` is within 60s and whose `refresh_token_secret_id IS NOT NULL`, looks up the provider's registered `RefreshFn`, and refreshes. Concurrent refreshes for the same connection coalesce — at most one upstream round-trip at a time per connection.

To register a refresh function for a provider: `registerRefreshFn(provider, fn)` at startup.

## Egress integration

Once a connection exists, agents (or the host) refer to it via the placeholder `__HEZO_SECRET_<secret_name>__`. For SaaS MCPs with `oauth_connection_id` set, the MCP injector emits `Authorization: Bearer __HEZO_SECRET_OAUTH_<PROVIDER>_<HEX>__`, overriding any user-supplied Authorization header.

Repo clone/fetch/push does **not** use the OAuth token. The OAuth token is reserved for GitHub REST API calls (listing orgs/repos, creating repos via the picker, registering the auth/signing keys). The actual git transport is SSH (`git@github.com:owner/repo.git`), authenticated by the team Ed25519 key via the `SshAgentServer`. Host-side git ops allocate an ephemeral agent socket through `withHostAgentSocket` in `services/ssh-agent/host.ts`; container-side ops use the per-run socat bridge already provisioned for commit signing. See `.dev/ssh-signing.md`.

Secret allowed_hosts gate substitution: a leak attempt to the wrong host (e.g. exfiltration via a placeholder in a header to a non-allowed origin) returns `secret_not_allowed_for_host` and is audited.

## Routes

| route | purpose |
|---|---|
| `POST /api/teams/:teamId/connectors/ensure` | idempotently materialize a connector row from the capability registry (UI "Connect" buttons) |
| `POST /api/teams/:teamId/auth-start` | begin auth-code+PKCE+DCR for an MCP connector; returns `{ auth_url }` |
| `GET  /api/oauth/mcp-callback` | public callback for the connector flow; exchanges code, marks connector active, fires wakeup |
| `POST /api/teams/:teamId/oauth/auth-code/start` | legacy `manual_config` auth-code start (operator-supplied non-DCR MCPs) |
| `GET  /api/oauth/callback` | legacy public callback for the `manual_config` path |
| `GET  /api/teams/:teamId/oauth-connections` | list connections (no token values) |
| `DELETE /api/teams/:teamId/oauth-connections/:id` | revoke + cascade-null FKs |
| `GET  /api/teams/:teamId/oauth-connections/:id/orgs` | list GitHub orgs the connection can access |
| `GET  /api/teams/:teamId/oauth-connections/:id/repos?owner=&q=` | list GitHub repos the connection can access |
| `GET  /api/teams/:teamId/oauth-connections/:id/scope-status` | report whether the connection's granted scopes cover the minimum required for repo setup; drives the "Permissions needed — re-authorize" banner in the project settings UI |

## Config

There is no operator-created GitHub OAuth App. Each Hezo instance self-registers as a public OAuth client against the GitHub MCP server's Authorization Server via DCR; the registered client_id caches in `mcp_connections.config.dcr`. The GitHub connector requests `repo`, `workflow`, `read:org`, `write:ssh_signing_key`, and `write:public_key` scopes (the `github` capability's `scopes` list). The last two register the team's Ed25519 key as a GitHub signing key and authentication key respectively; `repo` and `read:org` drive REST API calls (listing/creating repos and orgs).

> **Note**: the GitHub MCP server gates some tools on a GitHub Copilot subscription. The OAuth flow and SSH-based git ops (which use the REST API, not the MCP) work without one; MCP *tool calls* return 402/403 if the account lacks Copilot.

| env var | default | purpose |
|---|---|---|
| `GITHUB_API_BASE_URL` | `https://api.github.com` | REST base for account fetch + key registration; overridden in tests by `github-sim` |

## Tests

- `oauth-connection-store.test.ts` — CRUD, secret encryption, cascade-null, upsert
- `oauth-token-resolver.test.ts` — refresh on expiry, no-refresh without refresh_token, far-from-expiry skip, concurrent coalescing, swallow upstream errors
- `oauth-state.test.ts` — sign/verify round-trip, tampering rejection, expiry
- `oauth-github-provider.test.ts` — GitHub REST helpers: account fetch, signing-/auth-key registration, idempotent re-registration
- `oauth-github-routes.test.ts` — full GitHub auth-code flow end-to-end (ensure → auth-start with registry scopes → callback creates `provider='github'` row + registers SSH keys), list, delete, cross-team isolation, all against `github-sim` + a fake AS
- `connectors.test.ts` — DCR + auth-start + callback for a generic MCP connector against the fake MCP server
- `mcp-connections.test.ts` — `connectors/ensure` idempotency + unknown-provider rejection
- `oauth-generic-provider.test.ts` — metadata discovery, authorize URL building, code exchange, error handling
- `oauth-mcp-injection.test.ts` — `mcp_connections.oauth_connection_id` → injector emits placeholder Authorization header

## Trust boundaries

- No central Hezo Connect relay. Callbacks land on the individual Hezo instance's own URL — same host the user is already on for the UI.
- No Hezo-team-owned OAuth apps. DCR per-instance, per-connector, public-client — including GitHub.
- DCR-issued tokens flow through the existing `oauth_connections` + `secrets` + egress-substitution pipeline; no new substrate.

**Failure modes**:
- AS doesn't support DCR (no `registration_endpoint` in metadata) → 400, surfaced as `auth_error` on the connector.
- Token exchange fails (AS rejects PKCE / redirect_uri mismatch) → connector marked `failed` with the AS's error message in `auth_error`; user can click Retry.
- GitHub account fetch fails after token exchange → connector marked `failed`; the partial token is discarded.
- MCP server doesn't issue 401 with PRM → discovery falls back to the well-known PRM path; if that 404s too, discovery fails and the connector is not auth-able.
