# Credentials

How an agent obtains a secret it needs (an API key, an SSH deploy key, a database password) without that secret ever appearing in its prompt or its container env literally.

## Model

Every secret lives in the `secrets` table, encrypted with the master key (AES-256-GCM). Each row carries:

- `name` — uppercase token used by agents in placeholders, e.g. `STRIPE_API_KEY`
- `encrypted_value` — the actual secret, encrypted at rest
- `allowed_hosts` — the set of upstream hostnames the secret is permitted to reach (e.g. `['api.stripe.com']`); `*.example.com` works
- `allow_all_hosts` — escape hatch for the rare case where the secret should reach any host
- `category` — informational tag (`api_token`, `ssh_key`, `credential`, …)

Secrets are **instance-global**: a single set shared with every team's egress (still bounded per-secret by `allowed_hosts`). `name` is unique instance-wide. There is no team or project scope. The Admin (superuser) manages them via `GET /api/credentials` + `POST/PATCH/DELETE /api/secrets[/:id]`; agents obtain them through `request_credential` (below), which writes the same global rows.

An agent never sees the value. Wherever it would write the secret it instead writes the placeholder `__HEZO_SECRET_<NAME>__`. The egress proxy substitutes at request time — see `.dev/egress.md`.

## How agents acquire a credential

The agent calls the `request_credential` MCP tool with:

- `name` — the canonical name (`STRIPE_API_KEY`)
- `kind` — what the value looks like (`api_key`, `ssh_private_key`, `oauth_token`, `database_url`, `webhook_secret`, `other`)
- `allowed_hosts` — `['api.stripe.com']`
- `instructions` — markdown explaining where the human should fetch the value from
- `confirmation_text` — what the human will see on the action button

This posts a `credential_request` comment on the task. The task thread now shows a form with the agent's instructions and an input the human can paste into.

When the human submits the form the server:
1. Encrypts and writes the value to `secrets`.
2. Marks the comment as fulfilled.
3. Wakes the agent up with a `credential_provided` wakeup so it retries whatever needed the credential.

The agent's next env emits `STRIPE_API_KEY=__HEZO_SECRET_STRIPE_API_KEY__` (or whatever the agent already had in its env). The next outbound HTTPS request hits the egress proxy, which substitutes.

## Lifecycle

- **Request** — agent calls `request_credential`, posts the form.
- **Fulfill** — human pastes the value, server encrypts and stores a global secret.
- **Use** — proxy substitutes the placeholder when any run's request hits an allowlisted host. Substitution is gated by `allowed_hosts`, not by per-agent grants.
- **Revoke** — the Admin deletes the secret via `DELETE /api/secrets/:secretId`. Existing in-flight runs see `unknown_secret` (400) on the next outbound call.

## OAuth-issued credentials

GitHub access (clone/fetch/push) and SaaS-MCP authentication go through OAuth, not `request_credential`. The full design is in `.dev/oauth.md`. Mechanically, an OAuth connection persists its access token (and any refresh token) into the same `secrets` table — name pattern `OAUTH_<PROVIDER>_<8 hex>`, automatically `allowed_hosts`-locked to the provider's hosts. From the egress proxy's perspective, OAuth tokens are just secrets like any other; the placeholder substitution path is identical, the audit log records them by name, and revoking the OAuth connection deletes the underlying secret rows.

## MCP server connectors (third-party MCPs with OAuth)

When an agent needs a third-party MCP server (DatoCMS, Linear, Vercel, …), it calls `register_connector` with the MCP URL and optionally a `skill_doc_id` from `fetch_skill_file`. The tool:

1. Creates a row in `mcp_connections` (kind=`saas`, `created_by_task_id` set, `oauth_connection_id` NULL — i.e. **pending**).
2. Posts a `connect_required` comment on the agent's task with a **Connect** button.
3. Returns the placeholder + status; the agent ends its turn waiting on a `credential_provided` wakeup.

The human clicks Connect (in the task chat, or on the team Connectors page at `/teams/:teamId/connectors`). Hezo's backend runs the full OAuth dance in the user's actual browser:

- **PRM discovery** (RFC 9728) — probe the MCP URL, parse `WWW-Authenticate: Bearer resource_metadata="…"`, fetch the resource metadata document.
- **AS metadata** (RFC 8414) — fetch `/.well-known/oauth-authorization-server` for `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.
- **Dynamic Client Registration** (RFC 7591) — POST to `registration_endpoint` with `redirect_uris: ["https://<this-hezo-host>/api/oauth/mcp-callback"]`, `token_endpoint_auth_method: "none"` (public client + PKCE). The issued `client_id` is cached in `mcp_connections.config.dcr` so re-auth reuses the same registration.
- **PKCE authorize + token exchange** — same envelope helpers as the existing OAuth path (`services/oauth/state.ts`, `services/oauth/provider-generic.ts`).
- **Activation** — token stored as a secret, `mcp_connections.oauth_connection_id` set, `activated_at` stamped, `credential_provided` wakeup fired on the calling task's assignee.

Subsequent agent runs (any project in the team) get the MCP injected into their adapter's config via the existing `loadMcpConnectionDescriptors` path. The header carries the `__HEZO_SECRET_OAUTH_…__` placeholder; the egress proxy substitutes at request time.

**Why this needs no central relay**: DCR removes the "must pre-register a callback URL per OAuth app" constraint. Each Hezo instance acts as its own OAuth client; the callback URL is whatever host the user is already on for the UI (`localhost:3100`, `hezo.mycompany.com`, …). Browser-reachable by definition.

Pending and revoked connectors are excluded from the agent runtime by `loadMcpConnectionsForRun` so an agent never sees an MCP it can't authenticate against.

Agent skill files (`AGENTS.md`-style markdown a provider ships alongside its MCP server) are fetched via `fetch_skill_file`, stored as `documents` of `type='mcp_skill'`, and written into the adapter's skills directory at each run start (Claude Code: `~/.claude/skills/<slug>.md`).

The egress proxy's `loadAllSecrets` calls `refreshExpiringTokens` on every outbound request — tokens within 60s of expiry refresh through their provider's registered refresh function before the substitution fires.

## Why placeholders, not real values in env

A literal `STRIPE_API_KEY=sk_live_…` in the agent container is a leak vector — the agent could:

- Echo it into a comment for "debugging".
- Attach it to a tool call's metadata.
- Write it to a file the human downloads.
- Leak it to a third-party service via a typo'd URL.

The placeholder `__HEZO_SECRET_STRIPE_API_KEY__` carries no secret value. The agent can echo it freely; the proxy won't substitute except on hosts the secret is allowed for, and the audit log records every substitution.

The threat model assumes the agent itself may behave badly. The egress proxy is the choke point; the placeholder is the marker.

## Audit log

Every substitution attempt — successful, denied, blocked because the master key is locked — writes one row to `audit_log` with `entity_type='egress_request'`. The row records the run id, host, method, URL path, status code, count of substitutions, and the **names** of the secrets used. **Never the values.**

The audit row only fires when there is a placeholder to substitute. No-op requests (where neither URL nor headers contain the probe `__HEZO_SECRET_`) are not audited.
