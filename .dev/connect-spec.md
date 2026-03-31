# Hezo Connect — OAuth Gateway Specification

> Hezo Connect is a standalone backend service that handles OAuth flows on behalf of
> local Hezo instances. It exists so that users don't need to register OAuth apps with
> every provider themselves.
>
> Two deployment modes: **self-hosted** (open source, free, you register your own OAuth
> apps) or **centrally hosted** (connect.hezo.ai, managed by the Hezo project, with
> billing and usage limits).

---

## 1. Overview

Hezo Connect is a **transient OAuth relay**. It holds registered OAuth applications for
supported platforms (GitHub, Gmail, Stripe, etc.), handles the OAuth authorization dance,
and delivers the resulting tokens to the requesting Hezo instance. It does NOT store
tokens long-term — after delivery, tokens are purged from memory.

The local Hezo app handles everything after the initial OAuth flow: token storage
(encrypted), token refresh, connection health monitoring, and revocation.

### Why a separate service?

OAuth providers require a registered application with a fixed callback URL. Without
Hezo Connect, every Hezo user would need to:
1. Register an OAuth app with each provider (GitHub, Google, Stripe, etc.)
2. Configure client IDs, secrets, and callback URLs
3. Manage OAuth app lifecycle (rotating secrets, updating scopes, etc.)

Hezo Connect does this once, centrally, for all users.

---

## 2. Architecture

```
┌─────────────────┐         ┌─────────────────────┐        ┌──────────────┐
│   Hezo App      │         │   Hezo Connect       │        │   Provider   │
│   (local)       │         │   (self-hosted or    │        │   (GitHub,   │
│                 │         │    connect.hezo.ai)  │        │    Google,   │
│                 │  1. redirect                   │        │    etc.)     │
│                 ├────────►│                      │        │              │
│                 │         │  2. redirect to       │        │              │
│                 │         │     provider consent  ├───────►│              │
│                 │         │                      │        │              │
│                 │         │  3. callback with     │◄───────┤              │
│                 │         │     auth code         │        │              │
│                 │         │                      │        └──────────────┘
│                 │         │  4. exchange code     │
│                 │         │     for tokens        │
│  5. receive     │◄────────┤                      │
│     tokens via  │ redirect│  6. purge tokens     │
│     browser     │         │     from memory       │
│     redirect    │         └─────────────────────┘
│                 │
│  7. encrypt +   │
│     store       │
└─────────────────┘
```

### Components

**Hezo Connect (this service)**
- Holds registered OAuth apps for each supported platform
- Handles the full OAuth dance (redirect → consent → callback → token exchange)
- Delivers tokens to the Hezo instance via browser redirect to the callback URL
- Purges tokens from memory after redirect
- Tracks usage for billing (centrally hosted mode)
- Validates Hezo instance identity via API keys (centrally hosted mode)

**Hezo App (local, covered in main spec)**
- Initiates OAuth flows by redirecting to Hezo Connect
- Receives tokens via callback endpoint
- Encrypts and stores tokens in the local secrets vault
- Handles token refresh locally (no Hezo Connect round-trip needed)
- Manages connection lifecycle: connect, disconnect, health check

---

## 3. OAuth Flow (detailed)

```
1.  Board member clicks "Connect GitHub" in Hezo UI
2.  Hezo app redirects browser to:
      http://localhost:4100/auth/github/start
        ?callback=http://localhost:3100/oauth/callback
        &state={signed_payload}
        &api_key={connect_api_key}          # centrally hosted only
3.  Hezo Connect validates the request:
      - Verify API key (centrally hosted) or skip (self-hosted)
      - Verify state signature (HMAC-SHA256)
4.  Hezo Connect redirects browser to GitHub OAuth consent screen:
      https://github.com/login/oauth/authorize
        ?client_id={hezo_connect_github_app_id}
        &redirect_uri=http://localhost:4100/auth/github/callback
        &scope=repo,read:org
        &state={signed_payload}
5.  User authorizes on GitHub
6.  GitHub redirects to:
      http://localhost:4100/auth/github/callback?code={auth_code}&state={signed_payload}
7.  Hezo Connect exchanges the auth code for tokens:
      POST https://github.com/login/oauth/access_token
        client_id, client_secret, code, redirect_uri
      → { access_token, token_type, scope }
8.  Hezo Connect fetches user info:
      GET https://api.github.com/user (with access token)
      → { login, avatar_url, email }
9.  Hezo Connect redirects browser to the Hezo app callback with tokens:
      http://localhost:3100/oauth/callback
        ?platform=github
        &access_token={access_token}
        &scopes={scope}
        &metadata={base64url({"username":"...","avatar_url":"..."})}
        &state={signed_payload}
10. Hezo Connect purges tokens from memory
11. Hezo app receives tokens via the browser redirect:
      - Verifies state signature
      - Encrypts access token with master key (AES-256-GCM)
      - Stores as secret (GITHUB_ACCESS_TOKEN)
      - Creates connected_platforms record
12. Browser redirects to Hezo UI showing "GitHub connected"
```

**Note:** GitHub OAuth Apps issue non-expiring access tokens (no refresh token).
Token delivery uses a browser redirect rather than a server-to-server POST,
which avoids Hezo Connect needing to make outbound HTTP calls to the local
Hezo instance.

### State parameter

The `state` parameter is a signed JSON payload containing:
```json
{
  "callback_url": "http://localhost:3100/oauth/callback",
  "platform": "github",
  "nonce": "random-uuid",
  "timestamp": "2026-03-30T12:00:00Z"
}
```

Signed with HMAC-SHA256 using a shared secret between Hezo app and Hezo Connect.
This prevents CSRF and ensures the callback goes to the right Hezo instance.

### OAuth link validity

OAuth authorization links are valid for **24 hours**. This accommodates async workflows
where an agent requests access to a resource, the request appears in the board inbox,
and the board member may not see it immediately. After 24 hours the link expires and
must be re-generated.

---

## 4. Supported Platforms

| Platform | OAuth Type | Scopes | What Agents Use It For |
|----------|-----------|--------|----------------------|
| GitHub | OAuth 2.0 | `repo`, `workflow`, `read:org` | Repo access, PRs, Actions, issues |
| Gmail | OAuth 2.0 (Google) | `gmail.send`, `gmail.readonly` | Send/receive email, search |
| GitLab | OAuth 2.0 | `api`, `read_repository` | Repo access, CI/CD pipelines |
| Stripe | OAuth 2.0 (Connect) | `read_write` | Payments, subscriptions, invoices |
| PostHog | OAuth 2.0 | `read` | Analytics queries, feature flags |
| Railway | OAuth 2.0 | `project:read`, `project:write` | Deploy, environment management |
| Vercel | OAuth 2.0 | `read`, `write` | Deployments, domains, env vars |
| DigitalOcean | OAuth 2.0 | `read`, `write` | Droplets, databases, apps |
| X (Twitter) | OAuth 2.0 | `tweet.read`, `tweet.write`, `users.read` | Post tweets, read timeline |

Adding a new platform requires:
1. Register an OAuth app with the provider
2. Add platform config to Hezo Connect (client ID, secret, scopes, URLs)
3. Add platform type to the Hezo app's `platform_type` enum
4. Optionally: build an MCP adapter for the platform's API

---

## 5. Two Deployment Modes

### 5a. Self-Hosted (open source)

For users who want zero dependency on the centrally hosted instance.

**Setup:**
1. Deploy the Hezo Connect server (Docker image or binary)
2. Register OAuth apps with each provider you need (GitHub, Google, etc.)
3. Configure each app's client ID, client secret, and callback URL pointing to your instance
4. Set environment variables for each provider
5. Point your Hezo app to your instance: `hezo --connect-url https://my-connect.example.com`

**No billing, no API keys, no usage limits.** Self-hosted mode trusts all incoming
requests. There's no account system — any Hezo instance that knows the URL can use it.

**Config:**
```env
HEZO_CONNECT_MODE=self_hosted
HEZO_CONNECT_PORT=4000

# Per-platform OAuth app credentials
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
# ... etc for each platform
```

### 5b. Centrally Hosted (connect.hezo.ai)

The Hezo project runs a canonical instance at **connect.hezo.ai**. This is the default
for most users — no setup required.

**What's different from self-hosted:**

| Feature | Self-Hosted | Centrally Hosted |
|---------|------------|-----------------|
| OAuth apps | You register your own | Pre-registered by Hezo project |
| API keys | Not required | Required (per Hezo instance) |
| Cost | Free | Free (pricing later) |
| Usage tracking | None | Per-key request counts |
| Rate limiting | None | Basic abuse prevention |
| Account system | None | GitHub OAuth accounts |
| Dashboard | None | Usage stats, key management |

**Account + API key flow:**

1. User creates an account at connect.hezo.ai
2. User generates an API key in the dashboard
3. User configures their Hezo app: `hezo --connect-api-key hc_abc123...`
4. All OAuth requests from this Hezo instance include the API key
5. Hezo Connect validates the key, tracks usage, enforces limits

**API key format:** `hc_` prefix (e.g. `hc_a3b8c9d4e5f6...`)

---

## 6. Billing (centrally hosted only)

**Free for now.** The centrally hosted instance is free with no usage limits during the
initial launch period. Pricing will be introduced later.

Usage is still tracked per API key (for future billing and to detect abuse), but no
limits are enforced and no payment is required.

---

## 7. API Reference

### Public endpoints (no auth)

```
GET  /health                                    Health check + version
GET  /platforms                                 List supported platforms + required scopes
```

### OAuth flow endpoints

```
GET  /auth/:platform/start                     Initiate OAuth flow
     ?callback={url}&state={signed}&api_key={key}
GET  /auth/:platform/callback                  Provider redirects here after consent
     ?code={auth_code}&state={signed}
```

### Account endpoints (centrally hosted only)

```
GET  /accounts/auth/github                      Initiate GitHub OAuth login
GET  /accounts/auth/callback                    OAuth callback — creates/updates account, sets session
POST /accounts/logout                           End session
GET  /accounts/me                               Current account info
```

### API key management (centrally hosted only)

```
GET  /keys                                      List API keys for account
POST /keys                                      Generate new API key
     → { key: "hc_abc123...", prefix: "hc_abc1" }
DELETE /keys/:keyId                             Revoke key
GET  /keys/:keyId/usage                         Usage stats for key
```

### Admin endpoints (centrally hosted only)

```
GET  /admin/stats                               Global usage statistics
GET  /admin/accounts                            List accounts
GET  /admin/keys                                List all API keys
POST /admin/accounts/:id/suspend                Suspend account
```

---

## 8. Tech Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Runtime | Node.js / TypeScript | Same ecosystem as Hezo |
| Framework | Express or Hono | Lightweight HTTP server |
| Database | PostgreSQL | Accounts, keys, usage, billing (centrally hosted) |
| Database (self-hosted) | SQLite or none | Minimal state needed |
| Auth | Better Auth | Accounts for centrally hosted dashboard |
| Payments | Stripe (future) | Not needed for launch — free tier only |
| Deployment | Docker | Single container |
| Hosting | Railway or Fly.io | For connect.hezo.ai |

### Self-hosted has minimal dependencies

In self-hosted mode, Hezo Connect is nearly stateless. It needs:
- OAuth app credentials (env vars)
- A signing key for state parameters (env var)
- No database, no accounts, no billing

---

## 9. Database Schema (centrally hosted only)

```sql
-- Accounts
CREATE TABLE accounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys
CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    prefix      TEXT NOT NULL,
    key_hash    TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    last_used_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usage tracking
CREATE TABLE usage_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    event_type  TEXT NOT NULL,  -- 'oauth_start', 'oauth_complete', 'oauth_error'
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_key_month ON usage_events(api_key_id, created_at);

-- Monthly usage rollups (materialized for fast billing queries)
CREATE TABLE usage_monthly (
    api_key_id  UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    month       DATE NOT NULL,
    flow_count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, month)
);
```

---

## 10. Security

### Token handling
- Tokens exist in Hezo Connect memory only during the exchange (seconds)
- After redirecting the browser to the Hezo app callback, tokens are immediately purged
- No token logging, no token persistence, no token caching
- All communication over HTTPS in production (HTTP allowed for localhost in dev)

### State parameter security
- HMAC-SHA256 signed with shared secret
- Contains nonce (prevents replay) and timestamp (prevents stale use)
- Verified on callback before proceeding

### Callback URL validation
- Callback URL must use HTTPS in production (HTTP allowed for localhost)
- Optional: Hezo Connect can verify the callback URL is reachable before starting the flow

### API key security (centrally hosted)
- Keys are hashed (SHA-256) before storage — raw key shown once
- Keys can be revoked instantly
- Rate limiting per key (burst: 10/sec, sustained: per plan limits)

### Self-hosted security
- No API keys — trust is implicit (you control the server)
- OAuth app secrets stored as environment variables
- Signing key for state parameters must be configured

---

## 11. Error Handling

| Error | HTTP Code | Response |
|-------|-----------|----------|
| Invalid platform | 400 | `{ "error": "unsupported_platform", "message": "..." }` |
| Invalid/expired state | 400 | `{ "error": "invalid_state", "message": "..." }` |
| Provider denied consent | 400 | `{ "error": "access_denied", "message": "User denied authorization" }` |
| Token exchange failed | 502 | `{ "error": "token_exchange_failed", "message": "..." }` |
| Invalid API key | 401 | `{ "error": "invalid_api_key" }` |
| Abuse limit exceeded | 429 | `{ "error": "rate_limited", "message": "Too many requests" }` |
| Rate limited | 429 | `{ "error": "rate_limited", "retry_after": 60 }` |

On error, the browser is redirected back to the Hezo app with an error parameter:
```
http://localhost:3100/oauth/callback?error=access_denied&platform=github
```

---

## 12. Self-Hosted vs Centrally Hosted — Config Comparison

### Self-hosted `.env`
```env
HEZO_CONNECT_MODE=self_hosted
HEZO_CONNECT_PORT=4000
STATE_SIGNING_KEY=random-256-bit-key

GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=secret123
GMAIL_CLIENT_ID=123-abc.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-secret
# ... per platform
```

### Centrally hosted `.env`
```env
HEZO_CONNECT_MODE=centrally_hosted
HEZO_CONNECT_PORT=4000
STATE_SIGNING_KEY=random-256-bit-key
DATABASE_URL=postgres://...
BETTER_AUTH_SECRET=session-signing-key
# STRIPE_SECRET_KEY=sk_live_...       # Future: when pricing is added
# STRIPE_WEBHOOK_SECRET=whsec_...     # Future: when pricing is added

GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=secret123
# ... per platform (same as self-hosted)
```

### Hezo app config
```
# Use centrally hosted (default)
hezo --connect-url https://connect.hezo.ai --connect-api-key hc_abc123

# Use self-hosted
hezo --connect-url https://my-connect.example.com

# Local development (default: Hezo Connect at http://localhost:4100)
hezo
```
