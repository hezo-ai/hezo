# Remaining work — agent-driven credentials + backend-mediated egress

Companion to `/Users/ram/.claude/plans/we-want-to-get-frolicking-muffin.md`. Phases 1 and 2 have shipped (commit `9fa5be6`). What's below is everything still to do, in execution order.

---

## P2-followup — macOS Docker Desktop SSH socket relay (blocker)

**Status:** ✅ Shipped 2026-05-03.

**Status (historical):** required before P3, because dev happens on macOS and Docker Desktop's gRPC-FUSE bridge does **not** forward `AF_UNIX` bind mounts. Symptom: container sees `/run/hezo/<runId>.sock` as an empty directory and `ssh-add -L` returns exit 2 ("could not connect to authentication agent"). Linux production is unaffected; this is purely a Docker Desktop on macOS limitation.

### Design

Always use a TCP relay path so the same wire-up runs on macOS dev and Linux prod with no branching. The cost is one `socat` process per container.

1. **`SshAgentServer` gains a per-run TCP listener** on loopback (`127.0.0.1`), port 0 (auto-allocate). The listener serves the same agent protocol as the Unix socket. Auth is by per-run UUID token included as the first 16 bytes of every connection (rejected with `SSH_AGENT_FAILURE` if it doesn't match).
2. **`agent-runner` allocates both** at run start:
   - Host TCP port (returned by SshAgentServer).
   - Per-run token (16 random bytes).
3. **At container exec time**, before launching the agent CLI, the runner uses `docker exec` to spawn a background `socat` that bridges the in-container Unix socket to host TCP:
   ```sh
   socat UNIX-LISTEN:/run/hezo/<runId>.sock,fork,reuseaddr,user=node \
         EXEC:'sh -c "printf \"%s\" $TOKEN; exec socat - TCP:host.docker.internal:$PORT"',pty,setsid
   ```
   (or simpler: a tiny shim binary baked into the agent base image that does framed prepend of the token then forwards bytes both ways).
4. **`SSH_AUTH_SOCK=/run/hezo/<runId>.sock`** as today; the agent CLI sees a normal Unix socket and is unaware of the bridge.
5. **Agent base image** (`docker/Dockerfile.agent-base`) installs `socat` (~150KB on Alpine, ~300KB on Debian-slim).

### Files to create / modify

- `packages/server/src/services/ssh-agent/server.ts` — add `tcpHostPort` allocation, per-run token, token-prefix auth in `handleConnection`.
- `packages/server/src/services/ssh-agent/relay.ts` — generate the in-container socat command line.
- `packages/server/src/services/agent-runner.ts` — after `markHeartbeatRunRunning`, run `docker.execCreate` for the socat sidecar before spawning the agent CLI; record its exec ID for cleanup.
- `docker/Dockerfile.agent-base` — `RUN apk add --no-cache socat` (or apt equivalent).
- `packages/server/src/test/__tests__/ssh-agent-docker.test.ts` — drop the darwin skip, the relay is the path under test now.

### Tests

- Unit: `relay.ts` produces the right command line for various token/port inputs.
- Integration (docker, runs on macOS too now): full `ssh-add -L` + `ssh-keygen -Y sign` flow through the TCP relay; assert no private key file in container; assert socat process exits when the run socket is released.
- Negative test: connection to TCP listener with wrong token gets `SSH_AGENT_FAILURE` and is closed.

### Effort estimate

~1 day. Single biggest risk: socat command-line subtlety and process-lifecycle on macOS Docker Desktop (zombie socat after container teardown). Mitigation: have the runner kill the socat exec ID explicitly in `cleanupRunArtifacts`.

---

## P3 — HTTPS MITM egress proxy

Replace direct env-var injection of credentials with placeholder + proxy substitution. This is the second of the two novel components and the largest single phase.

### Goal

When the agent's process — or any process inside the container, including SDK clients, CLIs, MCP servers — makes an outbound HTTPS request, the proxy:
1. Intercepts the connection (HTTP `CONNECT`).
2. Decrypts the TLS using a CA cert that the container trusts.
3. Inspects headers, URL, and request body for `__HEZO_SECRET_<NAME>__` placeholders.
4. Substitutes real values from the `secrets` table (decrypted server-side, scoped to the run's auth context).
5. Re-encrypts, forwards to upstream.
6. Audit-logs the substitution (host, method, count, secret names — never values).
7. Streams the response back to the agent.

### Library and process model

- **Library:** `mockttp` (`^3.x`). Actively maintained, TypeScript-native, supports HTTP/1.1 + HTTP/2 + WebSocket via mockttp's `passThrough({ beforeRequest })` rule. Falls back to hand-rolled Bun TLS only if a Bun compatibility issue surfaces.
- **Process model:** same Bun process, separate listener per run on loopback, port 0. Pre-v1; no need for a worker thread yet.

### Files to create

- `packages/server/src/services/egress/ca.ts` — `loadOrCreateCA(dataDir)` generates+persists a per-instance CA at `${dataDir}/ca/hezo-egress-ca.{pem,key}`, mode 0600, validity 10 years, RSA 2048 (best client compatibility). Computes the OpenSSL hashed-dir symlink (`<hash>.0`).
- `packages/server/src/services/egress/proxy.ts` — `EgressProxy` class wrapping mockttp:
  - `allocateRunProxy(runId, { companyId, agentId, projectId })` starts a per-run mockttp on loopback port 0; returns `{ proxyHost: 'host.docker.internal', proxyPort }`.
  - `releaseRunProxy(runId)` shuts down the mockttp instance.
  - Each instance uses `passThrough({ beforeRequest: (req) => substituteRequest(req, ctx) })`.
- `packages/server/src/services/egress/substitution.ts` — placeholder regex, header / URL / body scanning, allowlist matching, `Content-Length` recompute.
  - Always scan headers (all values) and URL.
  - Scan body only when content-type matches `^(application/(json|x-www-form-urlencoded|x-ndjson)|text/)` and body ≤ 1 MB.
  - Unresolved placeholder → 400 `{ error: 'unknown_secret', name }` (fail-closed).
  - Host not in secret's `allowed_hosts` → 403 `{ error: 'secret_not_allowed_for_host' }`.
  - Body > 1 MB or non-text content-type with placeholder pattern → forward unchanged, log `egress.body_unscanned_with_placeholder_pattern` for the operator.
- `packages/server/src/services/egress/audit.ts` — emits `audit_log` rows tagged `entity_type='egress_request'`, fields: `runId, agentId, host, method, urlPath, statusCode, substitutionsCount, secretNamesUsed[]`. Never the values.
- `packages/server/src/services/egress/port-allocator.ts` — small allocator over `[20000, 29999]` to keep ports stable across runs of the same agent for debugging.
- `packages/server/src/services/egress/index.ts` — public surface.

### Tests (no Docker)

- `__tests__/substitution.test.ts` — exhaustive: matches, near-misses, multiple matches in one value, allowlist hit/miss, body size threshold, unresolved name, content-type filtering.
- `__tests__/ca.test.ts` — generates valid X.509, leaf chains to root, hashed-dir symlink correct, idempotent across restarts.
- `__tests__/proxy.test.ts` — spin up upstream `http.createServer`, route HTTPS through proxy with the CA in the test client's trust store, verify upstream sees substituted value, verify audit log entry. Cover allowlist denial (403), unknown-secret (400), allow_all_hosts override.
- `__tests__/integration.test.ts` — `curl --cacert <ca> --proxy http://localhost:<port> -H "Authorization: Bearer __HEZO_SECRET_FOO__" https://localhost:<upstream>/echo` → upstream sees the resolved value, audit row written.

### Tests (Full Docker integration — required)

Spin up a real test Docker container with the proxy env vars set, the CA installed via `update-ca-certificates`, and placeholder env vars. From inside the container, exercise substitution across:

- **Headers:** `curl -H "Authorization: Bearer __HEZO_SECRET_FOO__" https://upstream/...`
- **URL / query string:** `curl https://upstream/api?token=__HEZO_SECRET_FOO__`
- **JSON body:** `curl -X POST -d '{"key":"__HEZO_SECRET_FOO__"}' -H 'content-type: application/json' https://upstream/api`
- **Form body:** `curl -X POST --data-urlencode 'key=__HEZO_SECRET_FOO__' https://upstream/api`
- **Multiple languages:** same substitution test driven from Python (`requests`), Node (`fetch`/`undici`), and `git` clone over HTTPS (`http.<url>.extraheader`).
- **Allowlist denial:** placeholder for a secret with `allowed_hosts=['github.com']` against `attacker.example` returns 403.
- **Unresolved placeholder:** placeholder for an unknown name returns 400 with `unknown_secret`.
- **Streaming response:** proxy doesn't buffer or corrupt streamed responses (e.g. SSE).
- **CA trust paths:** assert Python `requests` (`certifi`/`REQUESTS_CA_BUNDLE`), Python `httpx` (`SSL_CERT_FILE`), Node `fetch` (`NODE_EXTRA_CA_CERTS`), Go default cert pool, and curl all accept the proxy's certs.

Each test asserts the upstream test server saw the resolved value (never the placeholder), and audit log rows are written with the secret name (never the value).

### Wire-up

- `packages/server/src/startup.ts` — instantiate `loadOrCreateCA(config.dataDir)` and `EgressProxy(deps)` once at boot, pass into `JobManager` deps and Hono context.
- `packages/server/src/lib/types.ts` — add `egressProxy: EgressProxy | null` to `Env.Variables`.
- `packages/server/src/services/agent-runner.ts:319-335` (`buildRunContext`) — env additions per-run:
  ```
  HTTP_PROXY  / http_proxy   = http://host.docker.internal:<runProxyPort>
  HTTPS_PROXY / https_proxy  = http://host.docker.internal:<runProxyPort>
  NO_PROXY    / no_proxy     = host.docker.internal,localhost,127.0.0.1
  NODE_EXTRA_CA_CERTS        = /run/hezo/ca.pem
  SSL_CERT_FILE              = /run/hezo/ca.pem
  REQUESTS_CA_BUNDLE         = /run/hezo/ca.pem
  CURL_CA_BUNDLE             = /run/hezo/ca.pem
  GIT_SSL_CAINFO             = /run/hezo/ca.pem
  AWS_CA_BUNDLE              = /run/hezo/ca.pem
  PIP_CERT                   = /run/hezo/ca.pem
  NPM_CONFIG_CAFILE          = /run/hezo/ca.pem
  ```
  Plus the CA file at `${dataDir}/projects/<…>/run/ca.pem` (shared across runs in the project; the runs/ dir is bind-mounted to `/run/hezo/`).
- `packages/server/src/services/agent-runner.ts:125-136` (`buildProviderEnv`) — emit placeholders. AI provider keys become `ANTHROPIC_API_KEY=__HEZO_SECRET_ANTHROPIC_API_KEY__` etc. Real value lives in the `secrets` table with `allowed_hosts=['api.anthropic.com']`.
- `packages/server/src/services/containers.ts` — at container provision (after the container is healthy, before any agent run), copy the CA into the container's system trust store and run `update-ca-certificates`:
  ```
  docker exec <container> sh -c 'cp /run/hezo/ca.pem /usr/local/share/ca-certificates/hezo-egress.crt && update-ca-certificates'
  ```
  Idempotent. Covers Python `ssl.create_default_context()` (which on Linux loads from `/etc/ssl/certs/`), Go's default cert pool, Ruby Net::HTTP, PHP cURL, etc. Belt-and-suspenders alongside the env vars.
- `packages/shared/src/types/common.ts` — add `AuditEntityType.EgressRequest = 'egress_request'`.

### Edge cases

- **HMAC-signed bodies (e.g. AWS SigV4):** substitution after signing is impossible. Document; recommend the local-MCP-with-proxy pattern (the MCP server itself does the signing using the substituted secret in env).
- **Placeholder in upstream response:** leave it. We don't redact responses; the agent should never have written the placeholder somewhere it'd round-trip.
- **HTTP/2, WebSocket, SSE:** mockttp handles HTTP/2 natively. WebSocket frames are not scanned (only the upgrade headers); document. SSE is response-streamed, never buffered.
- **Cert minting cost:** ~50ms per host on first request (mockttp uses node-forge). Mitigation: warm the cache at startup for `api.github.com`, `api.anthropic.com`, `api.openai.com`, `*.googleapis.com`.
- **Bypass for Hezo backend:** `NO_PROXY=host.docker.internal` excludes Hezo's MCP and Agent API endpoints. Verified for Node `undici`, Python `requests`, curl, git, Go.
- **Master key locked at substitution time:** return 503 `{ error: 'secrets_unavailable' }` (matches the `LOCKED` pattern in `routes/secrets.ts`).

### Effort estimate

~5 days. The substitution logic is small but the integration test surface is large (every language SDK, every body format, every status code path). Most likely surprise: a Bun-vs-Node compat issue in mockttp; fallback is `http-mitm-proxy` or hand-rolled `Bun.serve({ tls })`.

---

## P4 — MCP connection persistence

Make MCP servers a first-class, persistent concept so the agent can declare what it needs at runtime, and so installs survive container rebuilds.

### Schema

```sql
CREATE TABLE mcp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = company-wide
  name TEXT NOT NULL,                          -- e.g. "stripe", "filesystem"
  kind TEXT NOT NULL CHECK (kind IN ('saas', 'local')),
  config JSONB NOT NULL,                       -- saas: {url, headers}; local: {command, args, env}
  install_status TEXT NOT NULL DEFAULT 'pending'
                 CHECK (install_status IN ('pending', 'installed', 'failed')),
  install_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, project_id, name)
);
```

`config.env` and `config.headers` values may contain `__HEZO_SECRET_*__` placeholders — substituted by P3's egress proxy at request time.

### Persistence model (the container-rebuild problem)

- **SaaS MCPs** need no install; they're injected into the agent's MCP descriptor list with the URL and substituted-credential headers.
- **Local MCPs** install under `${workspace}/.hezo/mcp/<name>/`. The workspace is host-bind-mounted, so the install survives container rebuild.
- Each `kind='local'` row is installed via `npm install --prefix /workspace/.hezo/mcp/<name>` (or `uv tool install --target` for Python MCPs). Entry point comes from `package.json#bin` → resolved to `/workspace/.hezo/mcp/<name>/node_modules/.bin/<cmd>` (or `dist/main.js`).
- A new `services/mcp-installer.ts` runs on container provision and on `mcp_connections` insert/update: walks rows for the project, idempotently installs anything missing or version-mismatched, marks `install_status` and `install_error`.

### Files to add

- `packages/server/src/mcp/tools/manage-mcp-connections.ts` — `add_mcp_connection`, `list_mcp_connections`, `remove_mcp_connection`, `test_mcp_connection`. Agent uses these to declare what MCPs it wants.
- `packages/server/src/services/mcp-installer.ts` — invoked on container provision and on `mcp_connections` insert. Uses `docker exec` with `npm install` / `uv tool install` inside the container.
- `packages/web/src/routes/companies/$company/mcp-connections.tsx` — UI for board users to view/edit MCP connections (kind, command, args, env, allowed hosts).

### Files to modify

- `packages/server/src/services/mcp-injectors/index.ts` and per-runtime adapters (`claude-code.ts`, `codex.ts`, `gemini.ts`) — read `mcp_connections` rows for the agent's `(company_id, project_id)` and merge into the MCP descriptor list alongside the built-in `hezo` MCP.
- `packages/server/src/services/containers.ts` — on provision, run `mcp-installer.installAll(projectId)` after the container is healthy.

### Tests

- Unit: installer is idempotent across runs; failed install marks status correctly; install command escapes args safely.
- Integration: add a `mcp_connections` row → next agent run sees the MCP in its descriptor list → can call its tools (with mock MCP server).
- e2e: agent declares a SaaS MCP via `add_mcp_connection`, calls a tool on it through the egress proxy with substituted credentials.

### Edge cases

- **Concurrent installs of the same MCP:** lock per `(project_id, name)` via a row-level advisory lock during install; second caller waits and re-checks status.
- **Install fails (network, missing package):** marks `install_status='failed'`, surfaces error to the agent on next descriptor build, suggests retry or different package name.
- **Stdio MCP that prints to stderr during startup:** capture and surface on first failure; don't fill the run log on subsequent successful starts.

### Effort estimate

~3 days.

---

## P5 — Delete `packages/connect` and the OAuth code paths

With the replacement in place across P1–P4, remove the old surface.

### Delete

- `packages/connect/` — entire package.
- `packages/server/src/routes/oauth-callback.ts`.
- `packages/server/src/routes/connections.ts` (CRUD now lives in `routes/secrets.ts` + the credential-request fulfillment from P1).
- `packages/web/src/hooks/use-connections.ts`.
- `packages/server/src/test/__tests__/oauth-callback.test.ts`, `connections.test.ts`.
- `packages/server/src/test/helpers/github-sim.ts` if no remaining tests use it.
- `connectUrl` / `connectPublicKey` from `startup.ts:107-111`, `cli.ts:24`, app context, every route handler that reads `c.get('connectUrl')`.
- `DEFAULT_CONNECT_URL` from `packages/shared/src/constants.ts`.
- Connect entries from `scripts/dev.ts` and `playwright.config.ts`.

### Schema cleanup (modify `001_initial_schema.sql` in place — pre-v1)

- Drop `connected_platforms` table.
- Drop `slack_connections` table (replaced by an `mcp_connections` row of `kind='saas'` with credentials in `secrets`).
- Drop `ai_provider_configs` table (replaced by `secrets` rows with naming convention `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` etc., plus `allowed_hosts` for the proxy). Provider resolution becomes a query on `secrets` filtered by name pattern.
- Drop `oauth_request` from `approvals.type` enum.
- Drop `github_key_id` column from `company_ssh_keys`.
- Drop the `OAuthRequestReason` enum from `packages/shared/src/types/common.ts`.

### Files to modify

- `packages/server/src/services/ai-provider-keys.ts` — read provider creds from `secrets` instead of `ai_provider_configs`. Returns the placeholder, not the real value. Real value is resolved by P3's proxy on outbound requests.
- `packages/server/src/services/agent-runner.ts:517` — `getProviderCredentialAndModel` calls into the new secrets-backed lookup.
- `packages/server/src/services/token-store.ts` — remove `storeOAuthToken` / `getOAuthToken` / `getConnection` (none used after `oauth-callback.ts` is gone).
- `packages/server/src/services/ssh-keys.ts` — remove `updateGitHubKeyId` (no more API auto-registration).
- `packages/server/src/services/github.ts` — drop `addGitHubSSHKey` and `removeGitHubSSHKey` (those required an OAuth token).

### Tests

- Existing tests that reference `connected_platforms`, `slack_connections`, `ai_provider_configs`, or `connectUrl` need to be updated or deleted.
- Existing AI-provider tests need to be re-pointed at the secrets-backed lookup.

### Effort estimate

~2 days. Mostly mechanical; risk is incomplete grep for `connectUrl` / connect-specific helpers leaving dead references.

---

## P6 — Polish + docs

### Operator UI

- Audit log UI: new tab on company settings showing egress events (host, secret name used, request count, timestamp, status code) — operator visibility on what the agents are calling.
- Credentials list view: `/companies/:slug/credentials` listing every secret with name, kind, scope (company/project), `allowed_hosts`, who created it, when it was last used (from the audit log). Revoke button.
- MCP connections list view: `/companies/:slug/mcp-connections` from P4, with install status indicator.

### Documentation in `.dev/`

- `.dev/credentials.md` — explain the credential model: how the agent asks (`request_credential` MCP tool), how the human provides (paste form), where secrets live (`secrets` table, AES-256-GCM, per-company), lifecycle (request → fulfill → grant → use → optionally revoke).
- `.dev/egress.md` — proxy CA generation, distribution to container trust store, placeholder format, allowlist semantics, audit log fields, edge cases (HMAC-signed bodies, body size cap, streaming responses).
- `.dev/mcp.md` — MCP connection model: SaaS vs local, install path under `/workspace/.hezo/mcp/`, idempotent re-install on container start, where credentials are referenced.
- `.dev/ssh-signing.md` — SSH agent server design, per-run socket vs TCP relay (macOS), how `SSH_AUTH_SOCK` is wired, GitHub deploy-key bootstrap flow.
- Update `AGENTS.md` "Security" section to reflect the new model.
- Update `.dev/spec.md` "Credentials & Connections" section.
- Add an `.dev/implementation-phases.md` entry for the whole rollout (P1–P5) per the AGENTS.md convention.

### Defense-in-depth (optional, time-permitting)

- **Container egress firewall rules**: iptables OUTPUT chain in the agent base image restricting egress to `host.docker.internal` (Hezo proxy + agent API + MCP) and `github.com:22` (SSH for git). Anything else is silently dropped. Backstop for the placeholder model in case an SDK leaks a literal placeholder to the wrong host.
- **Per-run gitconfig with pinned known_hosts**: generate `${dataDir}/projects/<…>/run/<runId>.gitconfig` with `commit.gpgsign=true`, `gpg.format=ssh`, `gpg.ssh.allowedSignersFile=<per-run>`, `core.sshCommand` pointing at `/run/hezo/known_hosts` (asset shipped in the repo with current GitHub host keys). Mount via `GIT_CONFIG_GLOBAL=/run/hezo/<runId>.gitconfig`. Catches GitHub MITM via host-key swap.
- **CA distribution to host browser** for debugging: doc note explaining how to trust the Hezo CA on the developer's host so devtools can inspect the agent's outbound calls.

### Effort estimate

~2 days for ops UIs + docs, +1 day if shipping the firewall/known_hosts hardening.

---

## End-to-end verification (after P5)

On a fresh dev environment, run the full happy-path flow:

1. `bun run dev` — server, web (no connect process).
2. Create a company, project, agent. Create an issue and assign the agent.
3. Agent runs and calls `setup_github_repo("git@github.com:owner/repo.git")` — generates Ed25519, surfaces public key in a credential_request comment.
4. User adds the public key as a deploy key on GitHub, marks the comment confirmed.
5. Agent retries; `git clone` succeeds via the SSH signing server. Verify in logs: socket sign request, GitHub host pinned.
6. Agent calls `request_credential('ANTHROPIC_API_KEY', kind='api_key', allowed_hosts=['api.anthropic.com'])`. User pastes key.
7. Agent's next Anthropic call has `Authorization: Bearer __HEZO_SECRET_ANTHROPIC_API_KEY__` in env; the proxy substitutes; api.anthropic.com sees the real key. Audit log shows one substitution row.
8. Agent calls `add_mcp_connection({name:'filesystem', kind:'local', command:'npx', args:['-y','@modelcontextprotocol/server-filesystem','/workspace']})`. Installer runs in the container; subsequent runs see the MCP in their descriptor list.
9. Restart the project container. Re-run the agent. MCP servers still work (under `/workspace/.hezo/mcp/`, bind-mounted).
10. Confirm `packages/connect/` is gone and `bun run build` + `bun run test` pass.

Test commands:

- `bun run test --skip-e2e` — unit/integration suites pass on macOS dev (TCP relay) and Linux CI (direct AF_UNIX).
- `bun run test --e2e --pattern credential-request`
- `bun run test --e2e --pattern egress`
- `bun run test --e2e --pattern ssh-signing`
- `bun run test --e2e --pattern mcp-connection`

---

## Summary of effort

| Phase | Effort | Status |
|-------|--------|--------|
| P1 | shipped | ✅ commit `9fa5be6` |
| P2 | shipped | ✅ commit `9fa5be6` |
| P2-followup (macOS SSH relay) | 1 day | ✅ shipped 2026-05-04 |
| P3 (HTTPS MITM proxy) | 5 days | not started |
| P4 (MCP connections) | 3 days | not started |
| P5 (delete connect) | 2 days | not started |
| P6 (polish + docs) | 2–3 days | not started |
| **Total remaining** | **~12–13 days** | |
