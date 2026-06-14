# Egress proxy

A per-run HTTPS MITM proxy that intercepts every outbound request from an agent's container, decrypts the TLS, substitutes `__HEZO_SECRET_<NAME>__` placeholders in headers and the URL with the real secret values, re-encrypts, and forwards to the upstream. This is the choke point that lets agents reference secrets without ever holding them.

## Per-instance CA

On first boot Hezo generates an RSA-2048 CA at `<dataDir>/ca/`:

```
<dataDir>/ca/
├── certs/ca.pem            # CA certificate (mode 0644 — public)
└── keys/
    ├── ca.private.key      # CA private key (mode 0600 — host owner only)
    └── ca.public.key       # CA public key derived from cert
```

The same CA both signs per-host leaf certs in the proxy and bind-mounts into the container's trust store.

The cert is world-readable so the unprivileged in-container `node` user can verify TLS handshakes against it. The private key stays host-owner-only.

## Proxy lifecycle

The proxy is implemented in-house (`packages/server/src/services/egress/proxy.ts`) — no third-party MITM library. One instance per run, listening on `127.0.0.1` in the `[20000, 29999]` port range. The `PortAllocator` reuses the previous port for the same agent ID where possible (debugging-friendly) and probes for binding availability before claiming.

`EgressProxy.allocateRunProxy(runId, scope)` returns `{ proxyHost: 'host.docker.internal', proxyPort }`. `releaseRunProxy(runId)` shuts the instance down at run cleanup, closing the front server and every per-host server.

If the proxy fails to bind, the run aborts with `EgressProxyUnavailableError`. **There is no fall-through path.** A run that can't bring its proxy up is a run that would otherwise have to either (a) ship real secrets in the container env, or (b) drop the secrets and break — both worse than failing fast.

## TLS termination architecture

Each run's proxy is a single front `http.Server` on the allocated port. Plain proxied requests fire its `request` event (`isSSL=false`); HTTPS `CONNECT` tunnels fire its `connect` event.

For a CONNECT, the proxy looks up (or builds) a **per-host `https.Server`** keyed by the CONNECT hostname, minting that host's leaf cert from the CA via mockttp's `getCA`/`generateCertificate`. The agent's raw CONNECT socket is bridged into that per-host server over a loopback `net.connect`; TLS terminates there, the decrypted request runs through substitution, and a fresh upstream request carries the substituted values on.

Per-host servers are keyed **by hostname → live server object**, not by a cached bare port. Before reuse the proxy checks the server still owns its recorded port (`server.listening && server.address().port === recordedPort`); a server that has died or lost its port is rebuilt on the next tunnel. This makes the historical failure mode — a hostname routed to an ephemeral port that has since died (ECONNREFUSED) or been recycled to another host's server (cross-host wrong-SAN cert) — structurally impossible: the hostname never routes through a port that isn't currently owned by that host's live server. Concurrent first-touches for the same host share one in-flight build so a run never spins up duplicate servers.

## Container wiring

At project provision the CA cert is bind-mounted into the container at `/usr/local/share/ca-certificates/hezo-egress.crt` and `update-ca-certificates` runs once so the system trust bundle (`/etc/ssl/certs/ca-certificates.crt`) includes it. That covers Python `ssl.create_default_context()`, Go's default cert pool, Ruby Net::HTTP, PHP cURL, etc.

Per-run, the agent runner sets these container env vars:

```
HTTP_PROXY  / http_proxy   = http://host.docker.internal:<runProxyPort>
HTTPS_PROXY / https_proxy  = http://host.docker.internal:<runProxyPort>
NO_PROXY    / no_proxy     = host.docker.internal,localhost,127.0.0.1,<provider-api-hosts>
NODE_EXTRA_CA_CERTS        = /usr/local/share/ca-certificates/hezo-egress.crt
CURL_CA_BUNDLE             = /usr/local/share/ca-certificates/hezo-egress.crt
GIT_SSL_CAINFO             = /usr/local/share/ca-certificates/hezo-egress.crt
```

`NO_PROXY` carves out Hezo (`host.docker.internal` covers `:3100/agent-api` and `/mcp`) and the configured LLM provider API host (e.g. `api.deepseek.com`). Provider credentials are injected via env, not egress placeholders, and MITM breaks some Anthropic-compatible APIs — so LLM traffic goes direct. Do **not** set `SSL_CERT_FILE` to the egress CA alone; that replaces the system trust store. Provision runs `update-ca-certificates` so the system bundle already includes the Hezo CA for git/curl through the proxy.

## Substitution

The canonical placeholder grammar `__HEZO_SECRET_<NAME>__` (where `<NAME>` matches `[A-Z][A-Z0-9_]{0,63}`) is defined once in `lib/credential-placeholder.ts` and shared by the proxy, `request_credential`, and the admin secrets route — a name the proxy will substitute is exactly a name those paths permit to be created, so a stored secret is never un-referenceable and a placeholder never matches a name no path could have created. The match runs against:

- The full request URL (path + query string)
- Every header value (single-string and array-valued)

Bodies are forwarded byte-for-byte. **Body substitution is intentionally not implemented.** API providers expect credentials in headers (`Authorization`, `x-api-key`) or query strings, not in JSON. Adding body substitution would force `Transfer-Encoding: chunked` upstream, which breaks strict servers. Agents that need a secret in a JSON payload should run a local MCP server that reads the secret from its own env.

For each placeholder match the proxy:

1. Loads the secret named `<NAME>` from `secrets` scoped to `(team_id, optional project_id)`. Project-scoped rows win on name dedup.
2. Verifies the request's host is on the secret's `allowed_hosts` (or `allow_all_hosts=true`). Wildcard form `*.googleapis.com` matches any subdomain.
3. Replaces the placeholder with the decrypted value.

Failures:

- Placeholder names a secret that does not exist → 400 `{ "error": "unknown_secret", "name": "..." }`. Audited.
- Secret exists but host is not allow-listed → 403 `{ "error": "secret_not_allowed_for_host", "name": "...", "host": "..." }`. Audited.
- Master key locked → 503 `{ "error": "secrets_unavailable" }`. Audited.

## Audit log

`audit_log` rows tagged `entity_type='egress_request'` carry:

```json
{
  "run_id": "...",
  "host": "api.anthropic.com",
  "method": "POST",
  "url_path": "/v1/messages",
  "status_code": null | 400 | 403 | 503,
  "substitutions_count": 1,
  "secret_names_used": ["ANTHROPIC_API_KEY"],
  "error": null | "unknown_secret" | "secret_not_allowed_for_host" | "secrets_unavailable"
}
```

The audit row is only written when there was a substitution attempt — pure pass-through requests (no placeholder anywhere) leave no row. Successful substitutions and failed ones both audit. The secret value itself is never serialised.

## Edge cases

- **HMAC-signed bodies** (e.g. AWS SigV4): substitution after signing is impossible. Use the local-MCP-with-proxy pattern — the MCP server itself does the signing using the substituted secret in its env.
- **WebSocket / HTTP/2**: `Upgrade` requests are not proxied (no agent egress uses them today). An upgrade with no handler is closed cleanly rather than hung. Add an `upgrade`-event path if a real need appears.
- **Streaming responses** (SSE etc.): the proxy does not buffer or modify response bodies — the upstream response is piped straight back to the client. This is what carries a Streamable-HTTP MCP server's server→client channel (e.g. `api.githubcopilot.com/mcp/`). Because such a stream stays open for the whole run, the proxy **tracks every accepted/bridged socket and every in-flight upstream request** and severs them on `releaseRunProxy`. Without that, an open stream parks `server.close()` on the 5s deadline and **leaks the proxy→upstream socket** on every run — under Bun, `closeAllConnections()` reaches neither a hijacked CONNECT socket nor an in-flight streamed response, and aborting the `ClientRequest` alone does not drop its socket. Accumulated leaked sessions against a remote MCP host are a plausible cause of later "socket connection was closed unexpectedly" failures, so teardown must actually close them.
- **Cert minting cost**: a few ms per host on first request. Per-host servers stay live for the lifetime of the per-run proxy, so a hot upstream mints once.
- **Bypass for Hezo backend**: `NO_PROXY=host.docker.internal,localhost,127.0.0.1` excludes the agent → backend path. Verified for Node `undici`, Python `requests`, curl, git, Go.

## Bun compatibility

The proxy runs on Bun in dev/prod. Bun's TLS stack diverges from Node's in ways that dictate the per-host-server topology — these were re-confirmed empirically on **Bun 1.3.14**:

| Termination approach | Result under Bun |
|---|---|
| `new tls.TLSSocket(sock, { isServer: true })` in-process | **broken** — handshake never completes |
| One server + `SNICallback` / `addContext` to pick the cert per-connection | **ignored** — serves the base cert; `SNICallback` never fires (`addContext` is a no-op stub) |
| `https.Server.emit('connection', rawSocket)` (with or without `listen()`) | **broken** — handshake never completes |
| `tls.createServer` / `https.createServer` **listening**, reached by a real socket | **works** |

So TLS can only be terminated by a genuinely-listening server reached over a socket, and a single SNI-multiplexed server can't serve per-host certs — hence one listening `https.Server` per host, bridged from the CONNECT socket over loopback. Do not re-attempt the broken approaches above to "simplify"; they pass under Node/vitest and fail only on the production Bun runtime, so a Node-only test gives false confidence (this is why the egress proxy has a `bun test` tier).

Upstream cert verification under Bun checks the connection's Host header verbatim, which carries the port for non-default ports and fails against a bare-host SAN. The forwarder drops the client Host header on the TLS path so the runtime regenerates it from the connection target.

Cert generation uses mockttp's CA (`@peculiar/x509`), the same path the tests trust.

## Tests

`packages/server/test/`:
- `egress-substitution.test.ts` — pure substitution logic
- `egress-port-allocator.test.ts` — port allocator behaviour
- `egress-ca.test.ts` — CA generation + idempotent reload
- `egress-proxy.test.ts` — in-process proxy with a Node HTTP upstream
- `egress-proxy-docker.test.ts` — real container exercising substitution through curl with the CA bind-mounted into the trust store

`packages/server/test/bun/` (run under `bun test` on the production runtime — Node/vitest can't see the Bun TLS/connection divergences):
- `egress-proxy.bun.test.ts` — HTTPS MITM termination + per-host cert routing under Bun
- `egress-streaming.bun.test.ts` — long-lived SSE responses pipe through incrementally, and an open stream is severed (not leaked) on run teardown without parking the close deadline
