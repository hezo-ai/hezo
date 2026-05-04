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

The layout matches what `http-mitm-proxy`'s CA loader expects so the same CA both signs server certs in the proxy and bind-mounts into the container's trust store.

The cert is world-readable so the unprivileged in-container `node` user can verify TLS handshakes against it. The private key stays host-owner-only.

## Proxy lifecycle

One mockttp-equivalent (`http-mitm-proxy`) instance per run, listening on `127.0.0.1` in the `[20000, 29999]` port range. The `PortAllocator` reuses the previous port for the same agent ID where possible (debugging-friendly) and probes for binding availability before claiming.

`EgressProxy.allocateRunProxy(runId, scope)` returns `{ proxyHost: 'host.docker.internal', proxyPort }`. `releaseRunProxy(runId)` shuts the instance down at run cleanup.

If the proxy fails to bind, the run aborts with `EgressProxyUnavailableError`. **There is no fall-through path.** A run that can't bring its proxy up is a run that would otherwise have to either (a) ship real secrets in the container env, or (b) drop the secrets and break — both worse than failing fast.

## Container wiring

At project provision the CA cert is bind-mounted into the container at `/usr/local/share/ca-certificates/hezo-egress.crt` and `update-ca-certificates` runs once so the system trust bundle (`/etc/ssl/certs/ca-certificates.crt`) includes it. That covers Python `ssl.create_default_context()`, Go's default cert pool, Ruby Net::HTTP, PHP cURL, etc.

Per-run, the agent runner sets these container env vars:

```
HTTP_PROXY  / http_proxy   = http://host.docker.internal:<runProxyPort>
HTTPS_PROXY / https_proxy  = http://host.docker.internal:<runProxyPort>
NO_PROXY    / no_proxy     = host.docker.internal,localhost,127.0.0.1
NODE_EXTRA_CA_CERTS        = /usr/local/share/ca-certificates/hezo-egress.crt
SSL_CERT_FILE              = /usr/local/share/ca-certificates/hezo-egress.crt
REQUESTS_CA_BUNDLE         = /usr/local/share/ca-certificates/hezo-egress.crt
CURL_CA_BUNDLE             = /usr/local/share/ca-certificates/hezo-egress.crt
GIT_SSL_CAINFO             = /usr/local/share/ca-certificates/hezo-egress.crt
AWS_CA_BUNDLE              = /usr/local/share/ca-certificates/hezo-egress.crt
PIP_CERT                   = /usr/local/share/ca-certificates/hezo-egress.crt
NPM_CONFIG_CAFILE          = /usr/local/share/ca-certificates/hezo-egress.crt
```

`NO_PROXY` carves out the path back to Hezo (`host.docker.internal:3100/agent-api`, `host.docker.internal:3100/mcp`) so the agent's calls into the backend bypass the proxy entirely.

## Substitution

`PLACEHOLDER_REGEX = /__HEZO_SECRET_([A-Z0-9_]+)__/g` runs against:

- The full request URL (path + query string)
- Every header value (single-string and array-valued)

Bodies are forwarded byte-for-byte. **Body substitution is intentionally not implemented.** API providers expect credentials in headers (`Authorization`, `x-api-key`) or query strings, not in JSON. Adding body substitution would force `Transfer-Encoding: chunked` upstream, which breaks strict servers. Agents that need a secret in a JSON payload should run a local MCP server that reads the secret from its own env.

For each placeholder match the proxy:

1. Loads the secret named `<NAME>` from `secrets` scoped to `(company_id, optional project_id)`. Project-scoped rows win on name dedup.
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
- **WebSocket / HTTP/2**: the proxy passes WebSocket upgrades through but does not scan frames; only the upgrade headers go through substitution. HTTP/2 is forwarded transparently.
- **Streaming responses** (SSE etc.): the proxy does not buffer or modify response bodies.
- **Cert minting cost**: ~50 ms per host on first request because cert generation uses `node-forge`. Hot upstreams stay cached for the lifetime of the per-run proxy.
- **Bypass for Hezo backend**: `NO_PROXY=host.docker.internal,localhost,127.0.0.1` excludes the agent → backend path. Verified for Node `undici`, Python `requests`, curl, git, Go.

## Bun compatibility

The implementation uses `http-mitm-proxy` rather than `mockttp`. Mockttp's TLS server initialisation depends on Node's internal `connection`-listener layout and fails to start under Bun. `http-mitm-proxy` works on both runtimes and uses `node-forge` for cert generation — IP-as-CN certs include the right SAN entries automatically.

## Tests

`packages/server/src/test/__tests__/`:
- `egress-substitution.test.ts` — pure substitution logic
- `egress-port-allocator.test.ts` — port allocator behaviour
- `egress-ca.test.ts` — CA generation + idempotent reload
- `egress-proxy.test.ts` — in-process proxy with a Node HTTP upstream
- `egress-proxy-docker.test.ts` — real container exercising substitution through curl with the CA bind-mounted into the trust store
