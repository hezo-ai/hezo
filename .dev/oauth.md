# OAuth

Hezo backend acts as a confidential OAuth client for both:

1. **GitHub** — repo clone/fetch/push and signing-key registration. Uses **device flow** (no redirect URI, no client_secret).
2. **MCP servers** that publish OAuth metadata per the MCP authorization spec (DatoCMS, Linear, Notion, etc.). Uses **authorization-code + PKCE** with a localhost callback.

There is **no separate hosted callback service**. The Hezo backend running locally (default `:3100`) handles every callback at `http://127.0.0.1:3100/api/oauth/callback`.

## Storage

`oauth_connections` — one row per (company, provider, provider_account_id):

| column | notes |
|---|---|
| id | UUID primary key |
| company_id | FK companies; cascade delete |
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
  - github → `['github.com', 'api.github.com']`
  - generic → host of the resource URL + token URL
- `allow_all_hosts = false` always

That means OAuth tokens flow through the same egress placeholder mechanism as raw `request_credential` secrets. Agents emit `Authorization: Bearer __HEZO_SECRET_OAUTH_GITHUB_AB12CD34__`; the egress proxy substitutes at request time and audits the substitution by name.

`mcp_connections.oauth_connection_id` and `repos.oauth_connection_id` are nullable FKs to `oauth_connections`. Deleting an OAuth connection cascades to nullify those FKs and removes the access/refresh secrets.

## GitHub flow (device)

1. `POST /api/companies/:companyId/oauth/github/device-start` — backend calls `POST https://github.com/login/device/code` with the configured `client_id` (`GITHUB_OAUTH_CLIENT_ID` env, falls back to a public Hezo client_id). Persists the device_code server-side keyed by a short `flow_id`. Returns `{ flow_id, user_code, verification_uri, interval, expires_in }`.
2. UI opens `verification_uri` in a new tab and shows `user_code` for the user to paste.
3. UI polls `POST /api/companies/:companyId/oauth/github/device-poll { flow_id }`. Backend calls `POST /login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. While the user hasn't approved yet, returns 202 + `{ status: 'pending', retry_after }`.
4. On success: backend calls `GET https://api.github.com/user` to get the GitHub login + user_id, creates an `oauth_connections` row, and (on first connect for that company) calls `POST /user/ssh_signing_keys` to register the company's Ed25519 public key as a signing key. The UI receives `{ status: 'success', connection: {...} }`.

No `client_secret`. No redirect URI registration with GitHub.

## Generic auth-code + PKCE flow (MCP, etc.)

1. `POST /api/companies/:companyId/oauth/auth-code/start { provider, server_url?, manual_config?, scopes?, return_to?, mcp_connection_id?, mcp_connection_name? }`.
   - `server_url`: backend fetches `<base>/.well-known/oauth-authorization-server` (RFC 8414) and falls back to `/.well-known/openid-configuration` to discover `authorization_endpoint` and `token_endpoint`.
   - `manual_config`: `{ authorize_url, token_url, client_id, client_secret?, scopes }` for non-spec-compliant providers. Required even with `server_url` until Dynamic Client Registration is implemented (we still need a `client_id` to register).
2. Backend signs an HMAC state envelope (`signState` in `services/oauth/state.ts`) using `MasterKeyManager.deriveKey('oauth_state')`. The envelope carries `companyId`, `provider`, the PKCE `code_verifier`, the discovered/manual provider config, and the optional `mcp_connection_id` link target. Returns `{ auth_url }` to open in a new browser tab.
3. User authorizes at the provider; provider redirects to `GET /api/oauth/callback?code=…&state=…` (public route — auth is the signed state).
4. Backend verifies state, calls the token endpoint with `grant_type=authorization_code` + the PKCE verifier, parses `access_token`/`refresh_token`/`expires_in`, creates an `oauth_connections` row.
5. If the state's payload includes `mcp_connection_id`, backend updates `mcp_connections.oauth_connection_id` to point at the new row.
6. Callback returns an HTML page that posts a message to `window.opener` (`hezo-oauth-success` or `hezo-oauth-error`) and closes itself. If there's no opener, redirects to `state.return_to`.

State is short-lived (15 minutes) and tamper-proof: any modification to the payload invalidates the HMAC.

## Refresh

`refreshExpiringTokensForCompany` (in `services/oauth/token-resolver.ts`) is called by the egress proxy substitution path on every outbound request. It selects connections whose `expires_at` is within 60s and whose `refresh_token_secret_id IS NOT NULL`, looks up the provider's registered `RefreshFn`, and refreshes. Concurrent refreshes for the same connection coalesce — at most one upstream round-trip at a time per connection.

To register a refresh function for a provider: `registerRefreshFn(provider, fn)` at startup.

## Egress integration

Once a connection exists, agents (or the host) refer to it via the placeholder `__HEZO_SECRET_<secret_name>__`. For SaaS MCPs with `oauth_connection_id` set, the MCP injector emits `Authorization: Bearer __HEZO_SECRET_OAUTH_<PROVIDER>_<HEX>__`, overriding any user-supplied Authorization header. For repo clone/fetch, `agent-runner` and `repo-sync` look up the access token and pass it via `GIT_HTTP_EXTRAHEADER` (host-side; not visible in `ps` output and never written to the agent container env).

Secret allowed_hosts gate substitution: a leak attempt to the wrong host (e.g. exfiltration via a placeholder in a header to a non-allowed origin) returns `secret_not_allowed_for_host` and is audited.

## Routes

| route | purpose |
|---|---|
| `POST /api/companies/:companyId/oauth/github/device-start` | begin GitHub device flow |
| `POST /api/companies/:companyId/oauth/github/device-poll` | poll the device flow until token is issued |
| `POST /api/companies/:companyId/oauth/auth-code/start` | begin auth-code+PKCE for a generic/MCP provider |
| `GET  /api/oauth/callback` | public callback for auth-code; redirects to `state.return_to` on success |
| `GET  /api/companies/:companyId/oauth-connections` | list connections (no token values) |
| `DELETE /api/companies/:companyId/oauth-connections/:id` | revoke + cascade-null FKs |
| `GET  /api/companies/:companyId/oauth-connections/:id/orgs` | list GitHub orgs the connection can access |
| `GET  /api/companies/:companyId/oauth-connections/:id/repos?owner=&q=` | list GitHub repos the connection can access |

## Config

| env var | default | purpose |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | a public Hezo OAuth App client_id | the GitHub OAuth App used for device flow |
| `GITHUB_OAUTH_BASE_URL` | `https://github.com` | overridden in tests by `github-sim` |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | same |

A self-host operator who wants to use their own GitHub App sets `GITHUB_OAUTH_CLIENT_ID` to their App's client_id. No secret needed for device flow on a public client.

## Tests

- `oauth-connection-store.test.ts` — CRUD, secret encryption, cascade-null, upsert
- `oauth-token-resolver.test.ts` — refresh on expiry, no-refresh without refresh_token, far-from-expiry skip, concurrent coalescing, swallow upstream errors
- `oauth-state.test.ts` — sign/verify round-trip, tampering rejection, expiry
- `oauth-github-provider.test.ts` — device start/poll, account fetch, signing-key registration
- `oauth-github-routes.test.ts` — full device flow end-to-end against `github-sim`, list, delete, cross-company isolation
- `oauth-generic-provider.test.ts` — metadata discovery, authorize URL building, code exchange, error handling
- `oauth-mcp-injection.test.ts` — `mcp_connections.oauth_connection_id` → injector emits placeholder Authorization header
