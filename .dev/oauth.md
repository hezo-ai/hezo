# OAuth

Every third-party connection is an **MCP connector**. Token acquisition is chosen per provider by **what the provider's Authorization Server actually supports** — there are two OAuth strategies plus a non-OAuth fallback — but once a token exists, every connector finalizes through one shared path (store token → link + activate connector → provider side effects → egress substitution).

| Strategy | Mechanism | Selected when | Used by |
|---|---|---|---|
| **DCR auth-code + PKCE** | PRM discovery (RFC 9728) → Dynamic Client Registration (RFC 7591) → redirect popup → `/api/oauth/mcp-callback`. Zero config — the AS mints a client_id. | The MCP server's AS advertises a `registration_endpoint`. | DatoCMS, Linear, Notion, Vercel, Cloudflare, Sentry; any agent-registered MCP that supports DCR |
| **Device flow (RFC 8628)** | `connectors/:id/device/start` → user types the code at the provider → `connectors/:id/device/poll`. Needs a **pre-registered public client_id**; no redirect, no secret. | The capability registry declares a `deviceAuth` descriptor (provider can't do DCR). | **GitHub** (GitLab / Google / Microsoft fit the same shape) |
| **Paste / `request_credential`** | Raw API key pasted into the vault | Provider exposes no OAuth at all | capability `paste` fallback |

**Why GitHub uses the device flow.** GitHub's Authorization Server (`https://github.com/login/oauth`) advertises **no** `registration_endpoint`, so DCR is impossible — and a redirect/secret flow would need a per-host registered callback. The device flow needs only a public client_id and works on any self-hosted origin. GitHub is otherwise not special at the transport level; it just resolves its real identity and registers the project's SSH key as a post-connect side effect.

The selection is data-driven: device-flow providers carry a `deviceAuth` block in the capability registry (`packages/shared/src/types/connector-capabilities.ts`); the generic RFC 8628 service lives in `services/oauth/device-flow.ts`. `services/oauth/*` is provider-agnostic OAuth machinery; GitHub-specific REST helpers (identity fetch, SSH-key registration, scope status) live in `services/github.ts`.

GitHub connects to the official remote GitHub MCP server (`https://api.githubcopilot.com/mcp/`); the issued token serves both the MCP tool surface (issues, PRs, search) **and** the REST helpers (repo listing/creation, SSH-key registration). One connection, both purposes.

There is **no separate hosted callback service**. DCR connectors self-register per instance and callback at `<this-host>/api/oauth/mcp-callback`. Device-flow connectors use a pre-registered public OAuth App client_id (GitHub: instance env `GITHUB_OAUTH_CLIENT_ID`, with a committed public dev fallback).

**Agents** registering connectors via `register_connector` get the strategy chosen automatically: a raw `mcp_url` attempts DCR; a device-flow provider must be registered with `provider_id` set to its registry key (e.g. `github`), since device flow needs a pre-provisioned client_id.

## Storage

`oauth_connections` — **instance-global**: one row per (provider, provider_account_id), shared with every team's runs (connect GitHub/SaaS once, usable everywhere). The per-project commit-signing key stays on the project's backing team row (`team_ssh_keys`, keyed by `team_id` — one team backs one project).

| column | notes |
|---|---|
| id | UUID primary key |
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

## DCR connector flow (auth-code + PKCE + DCR)

MCP servers whose AS supports Dynamic Client Registration go through this path. (GitHub does **not** — see the device-flow section below.)

1. **Materialize the connector row.** For UI-initiated connects, `POST /api/teams/:teamId/connectors/ensure { provider_id }` idempotently creates (or returns) the `mcp_connections` row from the capability registry (`packages/shared/src/types/connector-capabilities.ts`). For agent-initiated connectors, `register_connector` writes the row. Either way the row carries the MCP server URL.
2. `POST /api/teams/:teamId/auth-start { connector_id }`. Backend:
   - Probes the MCP URL / discovers the Authorization Server via PRM (RFC 9728) + AS metadata (RFC 8414) through `discoverMcpAuthorization`, or reuses the cached `config.dcr`.
   - **Dynamic Client Registration** (RFC 7591) via `registerClient` if not already cached — self-registers as a public client with `redirect_uri = <this-host>/api/oauth/mcp-callback`.
   - **Scope selection**: if the connector's registry capability defines an explicit `scopes` list, that overrides the AS's advertised `scopes_supported`. GitHub's entry requests `repo workflow read:org write:ssh_signing_key write:public_key` — without the override, GitHub's AS advertises every OAuth scope and the consent screen is unreviewable.
   - PKCE-signs an HMAC state envelope (`signState` in `services/oauth/state.ts`) carrying `teamId`, the PKCE `code_verifier`, the provider config, and the `mcpConnectionId` link target. Returns `{ auth_url }`.
3. UI opens `auth_url` in a pop-up. User authorizes at the provider; provider redirects to `GET /api/oauth/mcp-callback?code=…&state=…` (public route — auth is the signed state).
4. Backend verifies state, exchanges the code at the AS token endpoint (`grant_type=authorization_code` + PKCE verifier + DCR-issued `client_id`, no `client_secret`), then runs the shared `finalizeConnectorConnection` (below).
5. Backend fires a `CredentialProvided` wakeup on the calling task's assignee (if any), then returns an HTML page that posts `hezo-oauth-success` / `hezo-oauth-error` to `window.opener` and closes itself. If there's no opener, redirects to `state.return_to`.

State is short-lived (15 minutes) and tamper-proof: any modification to the payload invalidates the HMAC. No `client_secret` anywhere — every DCR client is a public client.

The legacy `manual_config`-based `POST /api/teams/:teamId/oauth/auth-code/start` + `GET /api/oauth/callback` path stays for any external operator-supplied MCP that doesn't follow the PRM/DCR pattern (rare).

## Device-flow connector flow (RFC 8628)

For providers declaring a `deviceAuth` capability (GitHub today):

1. Materialize the connector row as above (`connectors/ensure` with `provider_id`).
2. `POST /api/teams/:teamId/connectors/:connectorId/device/start`. Backend resolves the capability's `deviceAuth` (client_id from `clientIdEnv` env var, falling back to the committed public dev id outside production; endpoint origins overridable via `baseUrlEnv` for tests / GitHub Enterprise), POSTs the device-code request with the capability's scope list, stashes the device code server-side keyed by an opaque `flow_id`, and returns `{ flow_id, user_code, verification_uri, interval }`.
3. The UI shows the user code and opens the verification URL; the user authorizes there.
4. The UI polls `POST .../device/poll { flow_id }` — `202 pending` until the user authorizes, then the token lands and the backend runs the shared `finalizeConnectorConnection`.

`auth-start` (the DCR route) refuses a `deviceAuth` connector with `USE_DEVICE_FLOW` so a misdirected call fails loudly rather than attempting impossible DCR.

## Shared finalize

`finalizeConnectorConnection` (in `routes/oauth.ts`) is the single post-token path for **both** strategies: resolve the provider identity, store the access (+refresh) token in `oauth_connections`, `markActive(connectorId, oauthConnectionId)`, run provider side effects, live-push to running containers, fire the `CredentialProvided` wakeup, and broadcast. Provider-specific behavior is a `ProviderConnectHooks` entry keyed by capability id; the generic case synthesizes an opaque account id and runs no side effects.

**GitHub's hook**: resolves the real identity via `GET /user` (so `provider = 'github'` and downstream `provider === 'github'` filters match), and registers the project's Ed25519 public key on the connecting user's account as **both** a signing key (`POST /user/ssh_signing_keys`) and an authentication key (`POST /user/keys`). Both registrations are idempotent — GitHub returns 422 "key is already in use" on repeat, treated as a no-op.

## Refresh

`refreshExpiringTokens` (in `services/oauth/token-resolver.ts`) is called by the egress proxy substitution path on every outbound request (across all instance-global connections). It selects connections whose `expires_at` is within 60s and whose `refresh_token_secret_id IS NOT NULL`, looks up the provider's registered `RefreshFn`, and refreshes. Concurrent refreshes for the same connection coalesce — at most one upstream round-trip at a time per connection.

To register a refresh function for a provider: `registerRefreshFn(provider, fn)` at startup.

## Egress integration

Once a connection exists, agents (or the host) refer to it via the placeholder `__HEZO_SECRET_<secret_name>__`. For SaaS MCPs with `oauth_connection_id` set, the MCP injector emits `Authorization: Bearer __HEZO_SECRET_OAUTH_<PROVIDER>_<HEX>__`, overriding any user-supplied Authorization header.

Repo clone/fetch/push does **not** use the OAuth token. The OAuth token is reserved for GitHub REST API calls (listing orgs/repos, creating repos via the picker, registering the auth/signing keys). The actual git transport is SSH (`git@github.com:owner/repo.git`), authenticated by the project's Ed25519 key via the `SshAgentServer`. Host-side git ops allocate an ephemeral agent socket through `withHostAgentSocket` in `services/ssh-agent/host.ts`; container-side ops use the per-run socat bridge already provisioned for commit signing. See `.dev/ssh-signing.md`.

Secret allowed_hosts gate substitution: a leak attempt to the wrong host (e.g. exfiltration via a placeholder in a header to a non-allowed origin) returns `secret_not_allowed_for_host` and is audited.

## Routes

| route | purpose |
|---|---|
| `POST /api/teams/:teamId/connectors/ensure` | idempotently materialize a connector row from the capability registry (UI "Connect" buttons) |
| `POST /api/teams/:teamId/auth-start` | begin auth-code+PKCE+DCR for a DCR-capable MCP connector; returns `{ auth_url }`. Refuses `deviceAuth` connectors with `USE_DEVICE_FLOW` |
| `GET  /api/oauth/mcp-callback` | public callback for the DCR flow; exchanges code, finalizes connection |
| `POST /api/teams/:teamId/connectors/:connectorId/device/start` | begin the RFC 8628 device flow; returns `{ flow_id, user_code, verification_uri, interval }` |
| `POST /api/teams/:teamId/connectors/:connectorId/device/poll` | poll the device flow; `202 pending` until authorized, then finalizes connection |
| `POST /api/teams/:teamId/oauth/auth-code/start` | legacy `manual_config` auth-code start (operator-supplied non-DCR MCPs) |
| `GET  /api/oauth/callback` | legacy public callback for the `manual_config` path |
| `GET  /api/teams/:teamId/oauth-connections` | list connections (no token values) |
| `DELETE /api/teams/:teamId/oauth-connections/:id` | revoke + cascade-null FKs |
| `GET  /api/teams/:teamId/oauth-connections/:id/orgs` | list GitHub orgs the connection can access |
| `GET  /api/teams/:teamId/oauth-connections/:id/repos?owner=&q=` | list GitHub repos the connection can access |
| `GET  /api/teams/:teamId/oauth-connections/:id/scope-status` | report whether the connection's granted scopes cover the minimum required for repo setup; drives the "Permissions needed — re-authorize" banner in the project settings UI |

## Config

GitHub uses a **pre-registered public OAuth App** (device flow needs a client_id; GitHub doesn't do DCR). The client_id is public and committed as a dev fallback; production overrides via `GITHUB_OAUTH_CLIENT_ID`. The OAuth App must have "Enable Device Flow" checked. The GitHub connector requests `repo`, `workflow`, `read:org`, `write:ssh_signing_key`, and `write:public_key` scopes (the `github` capability's `scopes` list). The last two register the project's Ed25519 key as a GitHub signing/authentication key; `repo` and `read:org` drive REST API calls (listing/creating repos and orgs).

DCR connectors (DatoCMS, Linear, …) need no config — each Hezo instance self-registers as a public client and caches the client_id in `mcp_connections.config.dcr`.

> **Note**: the GitHub MCP server gates some tools on a GitHub Copilot subscription. The OAuth flow and SSH-based git ops (which use the REST API, not the MCP) work without one; MCP *tool calls* return 402/403 if the account lacks Copilot.

| env var | default | purpose |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | committed public dev client_id | Device-flow OAuth App client_id; required in production |
| `GITHUB_OAUTH_BASE_URL` | `https://github.com` | Device-flow endpoint origin (device-code + token); overridden in tests by `github-sim`, or for GitHub Enterprise |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | REST base for account fetch + key registration; overridden in tests by `github-sim` |

## Tests

- `oauth-connection-store.test.ts` — CRUD, secret encryption, cascade-null, upsert
- `oauth-token-resolver.test.ts` — refresh on expiry, no-refresh without refresh_token, far-from-expiry skip, concurrent coalescing, swallow upstream errors
- `oauth-state.test.ts` — sign/verify round-trip, tampering rejection, expiry
- `oauth-github-provider.test.ts` — GitHub REST helpers: account fetch, signing-/auth-key registration, idempotent re-registration
- `oauth-device-flow.test.ts` — generic RFC 8628 service: `resolveDeviceAuth` (env override, dev fallback, base-url rewrite, missing client_id), start/poll response mapping
- `oauth-github-routes.test.ts` — full GitHub **device** flow end-to-end (ensure → auth-start refused with `USE_DEVICE_FLOW` → device/start → poll pending → approve → poll success creates `provider='github'` row + registers SSH keys), list, delete, cross-team isolation, against `github-sim`
- `connectors.test.ts` — DCR + auth-start + callback for a generic MCP connector against the fake MCP server
- `mcp-connections.test.ts` — `connectors/ensure` idempotency + unknown-provider rejection
- `oauth-generic-provider.test.ts` — metadata discovery, authorize URL building, code exchange, error handling
- `oauth-mcp-injection.test.ts` — `mcp_connections.oauth_connection_id` → injector emits placeholder Authorization header

## Trust boundaries

- No central Hezo Connect relay. DCR callbacks land on the individual Hezo instance's own URL — same host the user is already on for the UI. The device flow has no callback at all.
- DCR connectors use a per-instance, per-connector, public client (no Hezo-team-owned app). GitHub uses a single pre-registered **public** OAuth App client_id (device flow, no secret) — the only pre-provisioned client.
- DCR-issued tokens flow through the existing `oauth_connections` + `secrets` + egress-substitution pipeline; no new substrate.

**Failure modes**:
- AS doesn't support DCR (no `registration_endpoint`) and the provider has no `deviceAuth` capability → `OAUTH_DCR_UNSUPPORTED` with an actionable message (add a `deviceAuth` registry entry, or paste a token).
- Token exchange / device poll fails → connector marked `failed` with the error in `auth_error`; user can retry.
- GitHub identity fetch fails after the token lands → connector marked `failed`; the partial token is discarded.
- MCP server doesn't issue 401 with PRM → discovery falls back to the well-known PRM path; if that 404s too, discovery fails and the connector is not auth-able.
