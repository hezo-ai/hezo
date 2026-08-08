# Bun runtime issues we work around

Bun is the production runtime, and its networking stack diverges from Node in ways that do not surface as errors — a request body silently sent empty, a teardown that never settles, bytes duplicated on the wire. This is the register of those divergences: the ones already worked around (so nobody removes the workaround as dead weight), the ones we are exposed to with no defence, and the ones checked and found not to apply.

Every entry names an upstream issue and the code site. Rationale lives here; the trip-wires that bind someone who does not yet know they are in this territory are in `AGENTS.md` § *Bun runtime constraints*.

## Which Bun actually ships

| Where | Version | Set in |
|---|---|---|
| CI, and the `bun build --compile` binary users run | **1.3.11** | `BUN_VERSION` in `ci.yml`, `release.yml`, `release-publish.yml` |
| Workspace tooling | 1.3.9 | `packageManager` in the root `package.json` |
| Latest Bun release | 1.3.14 (2026-05-13) | upstream |

**The compiled binary embeds the runtime of the Bun that built it**, so the pinned CI version is the one in production, not whatever a developer has locally. A fix landing on Bun's `main` is not a fix we have; a fix in 1.3.12+ is not a fix we have either until `BUN_VERSION` moves. Bumping that pin is a change to the production runtime - re-read this file when you do it, and drop the entries the bump resolves.

## Worked around - the workaround is load-bearing

Each of these cost a debugging cycle. The code carries a comment saying what was measured; this table says which upstream defect it is measuring.

### The `lookup` option on `http(s).request` is not usable

[#36978](https://github.com/oven-sh/bun/issues/36978), **fixed on Bun's `main` on 2026-08-05, in no release**. Through 1.3.14 the `node:http` client carried its own resolver plumbing, and a `lookup` callback using Node's documented scalar signature `cb(err, address, family)` throws `TypeError: results.sort is not a function` before the request is sent. Verified on both 1.3.11 and 1.3.14:

```js
// throws on Bun <= 1.3.14, works on Node
opts.lookup = (hostname, options, cb) => cb(null, '127.0.0.1', 4);
// works on both
opts.lookup = (hostname, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
```

The array form is required because `autoSelectFamily` defaults on, which calls `lookup` with `all: true` - **current Node fails the same way**, so a portable custom lookup always honours `options.all`.

`net-guard.ts` records a second symptom: a request carrying a **body** delivering none of it, so the upstream answers as though it received an empty one, with `GET` unaffected - a proxied `git` clone fetching its ref advertisement normally and then hanging on `POST /git-upload-pack`. **That one does not reproduce in a direct `http`/`https` POST on 1.3.11 or 1.3.14**, in either callback form, plain or chunked, dialing a name or a literal. So the trigger is narrower than the comment implies; treat the body-drop as unexplained rather than as a characterised defect.

Upstream has since rewritten the client to resolve through `node:net` / `_http_agent` like Node, which removes the plumbing both symptoms came from. **This is a broad change to how every `node:http` request connects** - when `BUN_VERSION` moves onto a release carrying it, re-test the proxy's upstream leg rather than assuming it is a strict improvement.

Keep resolve-then-dial regardless. `resolveGuardedAddress` (`services/egress/net-guard.ts`) resolves first and returns the literal the caller dials, and the reason to keep it after the upstream fix is the security property, not the bug: the address that was checked is the address connected to, with no window for a name to re-resolve to something private in between. The caller must pass the original hostname as `servername` and set `Host` from it, since the runtime derives `Host` from the address otherwise.

### `server.close()` never settles

[#28350](https://github.com/oven-sh/bun/pull/28350) (open), [#23648](https://github.com/oven-sh/bun/issues/23648) (open), part of [#28396](https://github.com/oven-sh/bun/issues/28396). On native close Bun pushes `null` to the readable but never destroys the socket, so `autoDestroy` never fires and the server's connection count never decrements. `closeAllConnections()` does not reach a hijacked CONNECT socket or an in-flight streamed response either.

`closeServerWithDeadline` (`lib/net.ts`) resolves on the listening handle releasing rather than on the drain callback, and the proxy severs its own tracked sockets first (`services/egress/proxy.ts`). Without both, every teardown carrying a long-lived stream parks for the full deadline.

**Forward risk.** [#31301](https://github.com/oven-sh/bun/issues/31301): under Bun, `closeAllConnections()` also tears down the *listening* socket, contrary to Node. That bug is currently what makes our teardown fast - the handle we poll drops immediately. If [#31302](https://github.com/oven-sh/bun/pull/31302) lands and restores Node's behaviour, teardowns start eating the whole deadline again, quietly: slower tests and slower run cleanup, no failure.

### `'upgrade'` is never emitted for a Docker exec hijack

The upgrade half of [#28396](https://github.com/oven-sh/bun/issues/28396); the underlying reports ([#14522](https://github.com/oven-sh/bun/issues/14522), [#15489](https://github.com/oven-sh/bun/issues/15489), [#16819](https://github.com/oven-sh/bun/issues/16819), [#10441](https://github.com/oven-sh/bun/issues/10441), [#18945](https://github.com/oven-sh/bun/issues/18945)) were **fixed on Bun's `main` on 2026-07-24 and are in no release**. Under 1.3.11 Bun emits `'response'` with status 101 and routes the framed exec bytes onto the response stream, where writing back to `res.socket` never reaches the exec's stdin - so the `'upgrade'`-based version rejected every attach with "attach failed (101)".

`hijackExec` (`services/docker.ts`) speaks the request over a raw `node:net` socket and owns it outright. That removes the divergence rather than branching on it, so it stays correct on both runtimes and is worth keeping even after the fix ships.

### `fetch` enforces a hardcoded idle timeout that per-request options cannot disable

Roughly five minutes, no way to opt out ([#5930](https://github.com/oven-sh/bun/issues/5930) is the closest upstream thread, closed as an enhancement request; the behaviour remains). An exec stream that stays quiet that long - an agent CLI deep in a tool call emitting nothing - is torn down mid-run with "The operation timed out." and the run fails.

`requestStream` (`services/docker.ts`) puts long-lived streaming requests on `node:http` over the same unix socket, which applies no idle timeout, and wraps the response back into a web `Response` so callers parse both transports identically.

### `ClientRequest` emits `'close'` prematurely

No upstream issue. Bun fires it while the response body is still streaming. Detaching an abort handler on that event leaves a stalled read with nothing to tear it down, so a hung exec ignores its timeout and blocks until the connection dies at OS level. `requestStream` detaches on the *response* stream's `'close'` instead.

### `SNICallback` and `ALPNCallback` never fire

[#17932](https://github.com/oven-sh/bun/issues/17932) and [#4053](https://github.com/oven-sh/bun/issues/4053), both open, the latter since 2023. One TLS server cannot serve per-host leaf certificates, so the egress proxy mints a **server per host** on its own loopback port from a 10k-port range, with bind retries (`services/egress/proxy.ts`). That machinery collapses to a single server the day SNI lands - which is the reason to leave it alone until then.

### `server.listen(0)` + `address().port` reports the same port for every server

No upstream issue. Observed collapsing every per-host TLS server onto one port, serving the wrong leaf cert (`ERR_TLS_CERT_ALTNAME_INVALID`). The proxy allocates an explicit port and treats it as authoritative, never reading one back from `address()`.

### Defaults that need overriding

- **`Bun.serve` idles connections out after 10s**, measured between writes. Handlers that legitimately work a while before their first byte get severed mid-request; the client sees a bare "Failed to fetch" while the server keeps working. Set to 120 in `index.ts`. **The cap is 255** ([#15589](https://github.com/oven-sh/bun/issues/15589)) - raising it past that throws at startup.
- **WebSocket send buffers grow without bound.** `backpressureLimit` plus `closeOnBackpressureLimit` in `index.ts` cut a socket loose rather than growing its queue forever; recovery is the existing reconnect-and-reseed path.

## Exposed, no workaround

Ranked by what a failure would cost us.

### Partial-`writev` corruption on `node:net` sockets

[#32087](https://github.com/oven-sh/bun/issues/32087), open; fix [#32088](https://github.com/oven-sh/bun/pull/32088) open. When a socket already holds natively-buffered data and a vectored write goes partial, Bun mis-accounts which bytes of the new chunk remain: it either re-buffers bytes already written (**duplicated on the wire**) or skips bytes never written (**silently lost**). No error either way. Reproduced on `main` - one measured run duplicated ~5.5 MB, another lost 64 KiB. Present from v1.2.14 through at least v1.3.6, spanning our pinned 1.3.11.

Both of our `node:net` write paths are in range: the egress proxy's CONNECT bridge legs and `hijackExec`'s writes to exec stdin. It would not present as a network error - it presents as a corrupt git object or a garbled agent tool call.

### Segfaults in long-running standalone binaries

[#31467](https://github.com/oven-sh/bun/issues/31467) (use-after-free in the socket dispatch loop during teardown; root-caused, fix [#31469](https://github.com/oven-sh/bun/pull/31469) **closed unmerged**), [#34476](https://github.com/oven-sh/bun/issues/34476) (GC marking, ~18h of traffic to trigger), [#32219](https://github.com/oven-sh/bun/issues/32219). All three are the exact shape we ship: a `bun build --compile` binary serving HTTP for hours or days. `supervisor.ts` respawning is the mitigation, and should be understood as one.

### DNS divergence

- **Error codes differ.** Bun surfaces c-ares status codes where Node surfaces getaddrinfo ones - `ESERVFAIL` for Node's `EAI_AGAIN` ([#31888](https://github.com/oven-sh/bun/issues/31888)), and `ETIMEOUT` (no trailing D) where a resolver does not answer ([#32164](https://github.com/oven-sh/bun/issues/32164)). Any code that branches on a DNS error code must accept both spellings; `db/postgres-connect-errors.ts` does.
- **Address family differs.** `dns.lookup` defaults to the c-ares backend on Linux and can return `::1` where Node returns `127.0.0.1` ([#29227](https://github.com/oven-sh/bun/issues/29227), fix [#29231](https://github.com/oven-sh/bun/pull/29231) closed unmerged), and `--dns-result-order=ipv4first` is ignored ([#28817](https://github.com/oven-sh/bun/issues/28817)). A dual-stack upstream may be dialed over v6 where Node would pick v4.

The egress guard is unaffected by the family question - it dials the literal it checked, and `isBlockedEgressAddress` covers v6 including IPv4-mapped forms. A guard rewritten to compare *names*, or to trust a single lookup and dial a name, would not be.

### Stream errors swallowed into truncated success

[#31964](https://github.com/oven-sh/bun/issues/31964), open. When a piped byte stream delivers an error, two consumers drop it: buffering a body resolves **successfully with whatever bytes arrived** instead of rejecting, and a streamed response ends cleanly with a truncated payload. A partial fix ([#31963](https://github.com/oven-sh/bun/pull/31963)) merged 2026-06-23 - after 1.3.14, so in no release.

Consequence: `response.text()` / `.json()` over a body that fails mid-transfer looks like a success. The updater is defended by design (it hashes as it streams and refuses to stage on a mismatch); a fetch whose result is used without a verification step is not. Fetches of remote catalogs and manifests should validate what they got rather than trusting a resolved promise.

### Memory growth under sustained load

[#20912](https://github.com/oven-sh/bun/issues/20912) (high `fetch` volume leaks), [#14065](https://github.com/oven-sh/bun/issues/14065), [#30415](https://github.com/oven-sh/bun/issues/30415) (RSS growing linearly under sustained SDK traffic). Worth knowing about on a small host, where the symptom is swap thrash and pool-acquire timeouts rather than an OOM.

### Watch, not yet actionable

- [#35283](https://github.com/oven-sh/bun/issues/35283) - `Bun.serve` may not drain or close a keep-alive connection when a handler responds before reading the whole request body, misframing the next request on that connection. The maintainer disputes the repro as client-side truncation. Relevant to routes that answer early (a `401` or a size rejection on an upload).
- [#26554](https://github.com/oven-sh/bun/issues/26554) - `Bun.serve`'s WebSocket `sendPings` carries its own timeout that cannot be separated from `idleTimeout`, so pings cannot be used purely as a keepalive. Only bites if we start relying on protocol-level pings.

## Checked and does not apply

Recorded so the next sweep does not re-investigate them.

- **Bun's `S3Client` issues, including [#32045](https://github.com/oven-sh/bun/issues/32045) (ignores `NO_PROXY`).** We ship our own client (`assets/s3-client.ts`) and never use Bun's.
- **[#36477](https://github.com/oven-sh/bun/issues/36477)** - erroring a streamed `Response` body still sends the terminal chunk, so clients read a truncated body as complete. No route constructs an error-able `ReadableStream`; the one streaming response wraps a `Readable`, which is not the affected path.
- **[#32483](https://github.com/oven-sh/bun/issues/32483)** (no inbound WebSocket backpressure) - bounded by our inbound payload cap, and inbound frames are only subscribe/unsubscribe control messages.
- **[#31760](https://github.com/oven-sh/bun/issues/31760)** (client `WebSocket.bufferedAmount` always 0) - only affects WebSocket *clients*, i.e. the chat gateways, and neither reads it.

## Keeping this current

Bun's networking labels (`web:fetch`, `bun:http`, `node:http`, `node:net`, `node:tls`, `node:https`, `bun:dns`, `web:websocket`, `web:stream`) stopped being applied around December 2025, so a label query returns only the old issues. Sweep by keyword over recently-created issues as well:

```sh
gh api -X GET search/issues \
  -f q='repo:oven-sh/bun is:issue is:open created:>2026-01-01 in:title socket' \
  -f sort=created -f order=desc --jq '.items[] | "\(.number)\t\(.created_at[0:10])\t\(.title)"'
```

Repeat for `fetch`, `tls`, `proxy`, `dns`, `stream`, `websocket`, `connection`, `http server`. Check the *fix PR's* merge state and the release it landed in, never the issue's closed state - several fixes here are merged to `main` or closed unmerged, and neither means we have them.

**Re-run the symptom against the pinned version before trusting an entry.** Download the pinned Bun into a scratch dir and run a minimal repro against it and against Node side by side. A symptom recorded in a code comment is evidence that something broke, not a characterisation of what - the `lookup` entry above is one that turned out narrower than it was written.
