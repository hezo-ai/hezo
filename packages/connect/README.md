# @hezo/connect

Hezo Connect — standalone OAuth gateway. Handles the OAuth authorization dance for GitHub and delivers tokens to the requesting Hezo instance via browser redirect. No database, no accounts — a transient relay.

## Setup

```bash
# From the monorepo root
bun install
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEZO_CONNECT_PORT` | No | `4100` | HTTP listen port |
| `GITHUB_CLIENT_ID` | Yes | — | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | Yes | — | GitHub OAuth app client secret |
| `STATE_SIGNING_KEY` | No | auto-generated | HMAC-SHA256 key for state parameter signing. Auto-generated on startup if not set (not persisted — set this env var for consistent signing across restarts). |

Create a `.env` file in `packages/connect/` to set these locally:

```bash
# packages/connect/.env
GITHUB_CLIENT_ID=your_id
GITHUB_CLIENT_SECRET=your_secret
# STATE_SIGNING_KEY=optional_hex_key
```

The server loads this file automatically on startup via `dotenv`.

### GitHub OAuth App Setup

1. Go to [GitHub Settings > Developer Settings > OAuth Apps > New](https://github.com/settings/applications/new)
2. **Application name**: `Hezo Connect Dev`
3. **Homepage URL**: `http://localhost:3100`
4. **Authorization callback URL**: `http://localhost:4100/auth/github/callback`
5. Copy Client ID and Client Secret into your `.env` file

## Dev Server

```bash
bun run dev
```

Starts on port 4100 with hot reload.

## OAuth Flow

```
1. Hezo app redirects browser to Connect:
   GET /auth/github/start?callback=http://localhost:3100/oauth/callback

2. Connect signs a state parameter (HMAC-SHA256) and stores a nonce (5-min TTL)

3. Connect redirects browser to GitHub consent screen

4. User authorizes on GitHub

5. GitHub redirects to Connect:
   GET /auth/github/callback?code=xxx&state=xxx

6. Connect verifies state signature and nonce, exchanges code for token,
   fetches user info, then redirects browser to the Hezo app callback:
   http://localhost:3100/oauth/callback?platform=github&access_token=xxx&scopes=xxx&metadata=xxx

7. Connect purges the token from memory immediately
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ "ok": true }` |
| GET | `/platforms` | Lists supported platforms and their scopes |
| GET | `/signing-key` | Returns the HMAC signing key (hex) for state verification |
| GET | `/auth/:platform/start` | Initiates OAuth flow. Requires `?callback=<url>` query param |
| GET | `/auth/:platform/callback` | Provider redirects here after consent |

## Security

- **State signing**: HMAC-SHA256 prevents CSRF and ensures callbacks reach the correct Hezo instance
- **Nonce store**: In-memory, 5-minute TTL, single-use — prevents replay attacks
- **Token handling**: Tokens exist in memory only during the exchange (seconds), purged immediately after redirect
- **Timing-safe comparison**: State signature verification uses constant-time comparison

## Testing

```bash
bun test
```

44 tests covering configuration loading (defaults, validation, .env file support), state signing, endpoint responses, and the full OAuth flow with mocked GitHub API (dependency-injected fetch).

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start with hot reload |
| `bun run build` | Compile TypeScript |
| `bun run test` | Run Vitest tests |
| `bun run typecheck` | Type-check without emitting |
