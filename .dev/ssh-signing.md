# SSH signing

A per-run SSH agent server that holds the company's Ed25519 private key and answers SSH agent-protocol requests over both a Unix socket (host-side operations) and a loopback TCP listener (in-container access via a socat bridge). The key is used **only for git commit signing** — agents never see the private key, and GitHub repo access goes through OAuth (see `.dev/oauth.md`), not SSH deploy keys.

## Why two listeners

- **Host Unix socket** at `<runDir>/<runId>.sock` — host-side signing operations. Standard ssh-agent protocol, no auth (filesystem permissions are the gate).
- **Loopback TCP** on `127.0.0.1:<port>` — used by the in-container agent because Docker Desktop on macOS does not forward `AF_UNIX` bind mounts. Same protocol but every connection must prefix the agent-protocol bytes with a 16-byte per-run authentication token (timing-safe compared); a wrong token returns `SSH_AGENT_FAILURE` and the connection is closed.

The TCP listener is the same on macOS dev and Linux production — the per-run socat bridge always runs, no platform branching.

## Per-run socat bridge

The agent base image (`docker/Dockerfile.agent-base`) installs `socat` and ships two scripts:

`/usr/local/bin/hezo-ssh-bridge` — invoked once per accepted in-container connection. Reads the token from argv, writes it to the host TCP, then bidirectionally forwards bytes:

```sh
#!/bin/sh
TOKEN_HEX="$1" HOST="$2" PORT="$3"
ESCAPED=$(/usr/bin/printf '%s' "$TOKEN_HEX" | sed 's/../\\x&/g')
{ /usr/bin/printf '%b' "$ESCAPED"; cat; } | socat - "TCP:$HOST:$PORT"
```

(Coreutils `/usr/bin/printf` is called explicitly — dash's builtin doesn't support `\xHH`.)

`/usr/local/bin/hezo-run-with-bridge` — the wrapper the agent runner uses as `argv[0]`. It:

1. Spawns `socat UNIX-LISTEN:<socket>,fork,reuseaddr,unlink-early,mode=0600,user=node EXEC:hezo-ssh-bridge ...` in the background. Each new connection forks a child running the bridge.
2. Traps `EXIT INT TERM HUP` to kill the bridge socat when the wrapper exits.
3. Polls until the in-container Unix socket appears.
4. Execs the agent CLI with `< $HEZO_PROMPT_FILE`.

The agent CLI sees a normal Unix socket and is unaware of the relay.

## SshAgentServer

`packages/server/src/services/ssh-agent/server.ts`. `allocateRunSocket(runId, identity, socketHostPath)` returns `{ socketHostPath, tcpHostPort, tokenHex }`:

- Binds the Unix socket at `socketHostPath` (mode 0700 dir).
- Binds a TCP listener on `127.0.0.1:0` (auto-allocated).
- Generates a 16-byte token via `crypto.randomBytes`.
- Records all three in an internal registry keyed by `runId`.

`releaseRunSocket(runId)` closes both listeners, unlinks the Unix socket, and forgets the token.

The protocol implementation handles `MSG_REQUEST_IDENTITIES` (advertises the company's public key) and `MSG_SIGN_REQUEST` (signs the challenge with the matching private key, decrypted lazily from `secrets`). `MSG_FAILURE` is returned for any other message type.

## Agent runner integration

When `deps.sshAgentServer` is present the runner allocates a socket per run and passes the bridge args into `wrapExecCmd`:

```ts
[ '/usr/local/bin/hezo-run-with-bridge',
  '/run/hezo/<runId>.sock',  // in-container Unix socket path
  'node',                    // owner uid for the socket
  '<token-hex>',             // 32 lowercase hex chars
  'host.docker.internal:<tcpHostPort>',
  '--',
  ...agentCmd ]
```

`SSH_AUTH_SOCK=/run/hezo/<runId>.sock` is set in the container env. Tools that consult ssh-agent (`git commit -S`, `ssh-keygen -Y sign`, and `ssh`/`git@github.com:` clone/fetch/push) all go through the bridge → host TCP → SshAgentServer → key-blob match → signature. Same socket, same key, served for both signing and SSH authentication. Host-side git ops in `services/repo-sync.ts` / `services/agent-runner.ts` connect to the same `SshAgentServer` via its Unix socket directly (via `withHostAgentSocket` in `services/ssh-agent/host.ts`).

There is no in-container Unix-socket bind-mount from the host. The previous `<runDir>:/run/hezo:rw` bind-mount has been removed; the in-container socket lives purely in the container's overlay filesystem and is created fresh by socat at run start.

## Verified-on-GitHub bootstrap

The same Ed25519 key the agent runner uses for in-container signing is auto-registered on GitHub on every successful OAuth connect, as **both** a signing key (`POST /user/ssh_signing_keys` — drives `Verified` badges on commits) and an authentication key (`POST /user/keys` — so SSH `git@github.com:` clone/fetch/push works). Registration is idempotent: GitHub returns 422 "key is already in use" for repeat calls, treated as a no-op. One key per company; reused across every GitHub OAuth connection the company adds.

Repo *access* (clone, fetch, push) uses this same key over SSH (`git@github.com:owner/repo.git`). The OAuth token is reserved for REST API calls only (listing orgs/repos, creating repos via the picker).

## Tests

`packages/server/src/test/__tests__/`:
- `ssh-agent-protocol.test.ts` — wire format encoding/decoding.
- `ssh-agent-server.test.ts` — Unix and TCP listeners, identities, sign challenges, token-auth positive and negative.
- `ssh-agent-relay.test.ts` — relay command builder validation.
- `ssh-agent-docker.test.ts` — full Docker integration: `ssh-add -L`, no private key on disk inside the container, `ssh-keygen -Y sign` round-trip verified on the host. Same test runs on macOS dev (where the bridge is mandatory because Docker Desktop won't forward `AF_UNIX`) and Linux production (where the bridge is the same code path).
