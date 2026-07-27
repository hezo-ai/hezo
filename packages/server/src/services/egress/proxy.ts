import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
	type ClientRequest,
	createServer as createHttpServer,
	type Server as HttpServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import {
	createServer as createHttpsServer,
	Agent as HttpsAgent,
	type Server as HttpsServer,
	request as httpsRequest,
} from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import type { CA } from 'mockttp/dist/util/certificates';
import { getCA } from 'mockttp/dist/util/certificates';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { ref } from '../../lib/log-ref';
import { closeServerWithDeadline } from '../../lib/net';
import { logger } from '../../logger';
import {
	loadMcpHostRestrictions,
	type McpHostRestriction,
	mcpRestrictionKey,
} from '../connectors/connections';
import type { HezoCA } from './ca';
import { mcpMethodBlockedMessage, shouldBlockMcpRequest } from './mcp-method-guard';
import {
	EGRESS_HOST_PORT_RANGE_END,
	EGRESS_HOST_PORT_RANGE_START,
	PortAllocator,
} from './port-allocator';
import {
	loadAllSecrets,
	PLACEHOLDER_PROBE_REGEX,
	type ResolvedSecret,
	type SubstitutionFailure,
	substituteRequest,
} from './substitution';

const log = logger.child('egress-proxy');

/** When set, the proxy emits per-connection lifecycle traces (socket open/close/
 * error/timeout per leg, plus the host→dialed-port→owner of each CONNECT). Off by
 * default; the only reliable way to pin Bun's connection-accounting divergences,
 * which Node/vitest never reproduce. Enable in a real run with `HEZO_EGRESS_DEBUG=1`. */
const EGRESS_DEBUG = !!process.env.HEZO_EGRESS_DEBUG;

/** Connection-management headers scoped to a single transport hop, which a proxy
 * must not relay to the upstream (RFC 7230 §6.1). `proxy-*` are dropped
 * separately. Transfer-encoding / content-length are intentionally not here — the
 * runtime recomputes body framing for the re-issued request. */
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'upgrade']);

/** Hard cap on request bodies the proxy will buffer for placeholder
 * substitution. Body substitution exists for credential-in-body logins (small
 * JSON payloads); anything larger streams through byte-for-byte unchanged, so a
 * streaming/long-lived request body (SSE, Streamable-HTTP MCP) is never
 * buffered. Kept deliberately small so the supported shape is unambiguous. */
const MAX_BODY_SUBSTITUTION_BYTES = 8192;

/** Hard cap on request bodies the proxy will buffer to enforce a connector's MCP
 * method allowlist. Separate from — and much larger than — the substitution cap,
 * because an MCP `tools/call` legitimately carries a payload (a file to write, a
 * long issue body) far past the small credential-in-body logins substitution was
 * sized for. Applies only to a host whose connector is restricted; every other
 * host still streams unbuffered exactly as before. A restricted request larger
 * than this is rejected rather than forwarded uninspected — see `forward`. */
const MAX_MCP_INSPECTION_BYTES = 262144;

const PROXY_HOST = 'host.docker.internal';
const PROXY_BIND_HOST = '127.0.0.1';

/** Bytes of per-run proxy token. Mirrors the SSH-agent bridge's TCP token
 * (`ssh-agent/server.ts`) — 16 bytes of CSPRNG output, delivered to the run as
 * the password half of the proxy URL's basic-auth userinfo and compared
 * constant-time. The proxy authenticates the caller by nothing else: the run's
 * container reaches it over `host.docker.internal`/the bridge gateway, an
 * address any co-resident process shares, so without this token any such
 * process could drive secret substitution for any allowed host. */
const PROXY_TOKEN_BYTES = 16;
/** Basic-auth username half of the proxy URL. Value is irrelevant — only the
 * password (the token) is checked — but a stable, recognizable name keeps the
 * userinfo readable in a `HTTP(S)_PROXY` value. */
const PROXY_AUTH_USERNAME = 'run';
const PROXY_AUTH_REALM = 'hezo-egress';

/**
 * Thrown when the front proxy can't bind. Bubbled up to the agent runner so
 * the run aborts — never fall through to direct egress with real secrets.
 */
export class EgressProxyUnavailableError extends Error {
	constructor(reason: string) {
		super(`Egress proxy unavailable: ${reason}`);
		this.name = 'EgressProxyUnavailableError';
	}
}

export interface EgressProxyDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
	ca: HezoCA;
	portAllocator?: PortAllocator;
	/** Allocator for per-host MITM server loopback ports (range [30000,39999]).
	 * Separate from `portAllocator` (front-proxy range [20000,29999]) so per-host
	 * churn never contends with front-proxy binds. Injectable for tests. */
	hostPortAllocator?: PortAllocator;
	proxyHost?: string;
	/** Interface the per-run proxy binds to. Defaults to `127.0.0.1`
	 * (loopback-only — agent containers reach it via `host.docker.internal`,
	 * which on Docker Desktop tunnels to host loopback). Docker integration
	 * tests on a native-Linux daemon set this to `0.0.0.0` so the container can
	 * reach the proxy via the bridge gateway IP, which loopback would refuse. */
	proxyBindHost?: string;
	/** Mutable override for the bind host, read **per-run** at allocation time so
	 * the boot connectivity check can auto-rebind to the detected bridge gateway IP
	 * without a restart. Takes precedence over `proxyBindHost` when set. */
	bindHostRef?: { get(): string };
	/** Additional CA certs to trust when verifying upstream HTTPS servers.
	 * Tests use this to trust upstreams that present certs minted from the
	 * same CA the proxy uses. Production keeps this empty so the proxy
	 * relies on the runtime's system CA bundle. */
	extraUpstreamTrustedCAs?: string | string[];
	/** Require a per-run bearer token on every proxied request/CONNECT.
	 * Defaults to `true`. Set `false` (via `HEZO_EGRESS_PROXY_AUTH=0`) only to
	 * unblock a runtime whose HTTP client can't carry proxy credentials — the
	 * secret-substitution red line still holds either way, since an
	 * unauthenticated caller only ever ships unsubstituted placeholders. */
	authEnabled?: boolean;
}

export interface RunProxyScope {
	teamId: string;
	agentId: string;
	projectId?: string | null;
	/** Human-friendly label (agentSlug/taskIdentifier) for run-scoped logs. */
	label?: string | null;
}

export interface AllocatedRunProxy {
	proxyHost: string;
	proxyPort: number;
	/** Per-run token, or `null` when auth is disabled. The caller embeds it as
	 * the password half of the proxy URL userinfo (`http://run:<token>@host:port`)
	 * so the run's HTTP client sends it as `Proxy-Authorization: Basic …`. */
	token: string | null;
}

/**
 * Build the `HTTP(S)_PROXY` URL a run's HTTP clients use. With a token, the
 * userinfo (`run:<token>@`) makes every mainstream client emit
 * `Proxy-Authorization: Basic base64(run:<token>)` on plain requests and
 * CONNECT alike; without one it degrades to a bare `http://host:port`.
 */
export function formatEgressProxyUrl(host: string, port: number, token: string | null): string {
	if (!token) return `http://${host}:${port}`;
	return `http://${PROXY_AUTH_USERNAME}:${token}@${host}:${port}`;
}

/** How many ports to try binding before giving up allocating a run's proxy. */
const EGRESS_BIND_ATTEMPTS = 5;

/** How many ports to try binding before giving up on a per-host MITM server. */
const HOST_BIND_ATTEMPTS = 5;

export class EgressProxy {
	private readonly runs = new Map<string, RunProxyInstance>();
	private readonly portAllocator: PortAllocator;
	private readonly hostPortAllocator: PortAllocator;
	private readonly proxyHost: string;
	private readonly proxyBindHost: string;
	private readonly authEnabled: boolean;
	private mintCa: Promise<CA> | null = null;

	constructor(private readonly deps: EgressProxyDeps) {
		this.portAllocator = deps.portAllocator ?? new PortAllocator();
		this.hostPortAllocator =
			deps.hostPortAllocator ??
			new PortAllocator(EGRESS_HOST_PORT_RANGE_START, EGRESS_HOST_PORT_RANGE_END);
		this.proxyHost = deps.proxyHost ?? PROXY_HOST;
		this.proxyBindHost = deps.proxyBindHost ?? PROXY_BIND_HOST;
		this.authEnabled = deps.authEnabled ?? true;
	}

	get caCertPath(): string {
		return this.deps.ca.certPath;
	}

	/** The certificate authority that mints per-host leaf certs, derived once
	 * from the persistent Hezo CA and reused across every run. */
	private getMintCa(): Promise<CA> {
		if (!this.mintCa) {
			this.mintCa = getCA({ cert: this.deps.ca.cert, key: this.deps.ca.key });
		}
		return this.mintCa;
	}

	async allocateRunProxy(runId: string, scope: RunProxyScope): Promise<AllocatedRunProxy> {
		if (this.runs.has(runId)) {
			throw new Error(`Egress proxy already allocated for run ${runId}`);
		}

		// Allocate-and-bind with a few attempts. A candidate can pass the
		// allocator's free-probe yet lose the race to bind — another run, a
		// parallel test process, or an external listener grabs it in the window
		// between probe and listen. Keep each failed port reserved so the next
		// attempt lands on a different one, then release the losers once we've
		// bound (or all of them if every attempt fails).
		const tokenBytes = this.authEnabled ? randomBytes(PROXY_TOKEN_BYTES) : null;
		// Resolve the run's restricted connectors once, before binding. A failure
		// here propagates rather than starting a run whose method restrictions
		// can't be enforced — the query hits the same DB the proxy needs for
		// secrets anyway, so a failure is not something to paper over.
		const mcpRestrictions = await loadMcpHostRestrictions(this.deps.db, scope.projectId);
		if (mcpRestrictions.size > 0) {
			log.debug('egress proxy enforcing mcp method allowlists', {
				run: ref(scope.label, runId),
				hosts: [...mcpRestrictions.keys()],
			});
		}
		const reserved: number[] = [];
		let lastReason = 'no bindable port in egress range';
		try {
			for (let attempt = 0; attempt < EGRESS_BIND_ATTEMPTS; attempt++) {
				const port = await this.portAllocator.allocate(scope.agentId);
				reserved.push(port);

				const instance = new RunProxyInstance({
					runId,
					scope,
					port,
					bindHost: this.deps.bindHostRef?.get() ?? this.proxyBindHost,
					token: tokenBytes,
					db: this.deps.db,
					masterKeyManager: this.deps.masterKeyManager,
					getMintCa: () => this.getMintCa(),
					upstreamTrustedCAs: this.deps.extraUpstreamTrustedCAs,
					hostPortAllocator: this.hostPortAllocator,
					mcpRestrictions,
				});

				try {
					await instance.listen();
				} catch (e) {
					lastReason = (e as Error).message;
					log.warn('egress proxy bind lost a race; retrying on another port', {
						run: ref(scope.label, runId),
						port,
						reason: lastReason,
					});
					continue;
				}

				this.runs.set(runId, instance);
				for (const p of reserved) {
					if (p !== port) this.portAllocator.release(p);
				}
				log.debug('egress proxy allocated', { run: ref(scope.label, runId), port });
				return {
					proxyHost: this.proxyHost,
					proxyPort: port,
					token: tokenBytes ? tokenBytes.toString('hex') : null,
				};
			}
		} catch (e) {
			lastReason = (e as Error).message;
		}

		for (const p of reserved) this.portAllocator.release(p);
		log.warn('egress proxy unavailable for run', {
			run: ref(scope.label, runId),
			reason: lastReason,
		});
		throw new EgressProxyUnavailableError(lastReason);
	}

	async releaseRunProxy(runId: string): Promise<void> {
		const instance = this.runs.get(runId);
		if (!instance) return;
		await instance.close();
		this.portAllocator.release(instance.port);
		this.runs.delete(runId);
		log.debug('egress proxy released', { run: ref(instance.scope.label, runId) });
	}

	async releaseAll(): Promise<void> {
		for (const runId of [...this.runs.keys()]) {
			await this.releaseRunProxy(runId);
		}
	}
}

interface RunProxyConfig {
	runId: string;
	scope: RunProxyScope;
	port: number;
	bindHost: string;
	/** Per-run auth token; `null` disables caller authentication. */
	token: Buffer | null;
	db: Db;
	masterKeyManager: MasterKeyManager;
	getMintCa: () => Promise<CA>;
	upstreamTrustedCAs?: string | string[];
	hostPortAllocator: PortAllocator;
	/** Host → method allowlist for this run's *restricted* connectors only.
	 * Empty for the overwhelmingly common unrestricted run, which then takes no
	 * inspection path at all. Resolved once at allocation: the allowlist is an
	 * operator setting, not something that should change under a live run. */
	mcpRestrictions: Map<string, McpHostRestriction>;
}

/** A per-host internal TLS-terminating server. The agent's CONNECT socket is
 * bridged into it over loopback; it presents that host's minted leaf cert and
 * hands the decrypted request to the forwarder. */
interface HostServer {
	server: HttpsServer;
	port: number;
}

/**
 * One run's egress proxy. A single front HTTP server accepts the agent's
 * traffic: plain proxied requests fire `request`; HTTPS `CONNECT` tunnels fire
 * `connect`. Each CONNECT is bridged over loopback into a per-host TLS server
 * that presents that host's minted leaf cert, so the agent's TLS terminates
 * here, the request is scanned for secret placeholders, and a fresh upstream
 * request carries the substituted values on to the real server.
 *
 * Per-host servers are keyed by hostname and looked up live: an entry is reused
 * only while its server still owns its recorded port, otherwise it is rebuilt.
 * The hostname never routes through a cached bare port that could die or be
 * recycled to another host, which is the failure mode that an ephemeral-port
 * MITM cache suffers under run churn.
 */
class RunProxyInstance {
	private front: HttpServer | null = null;
	private readonly hostServers = new Map<string, HostServer>();
	private readonly pendingHostServers = new Map<string, Promise<HostServer>>();
	private closed = false;
	/** Every socket this run has accepted or bridged (front CONNECT sockets,
	 * per-host loopback sockets, and the loopback client legs), tracked so close
	 * can sever them directly. Bun's `closeAllConnections()` does not reach
	 * hijacked CONNECT sockets or an in-flight streamed response, so a long-lived
	 * stream (e.g. an MCP server→client SSE channel) would otherwise park
	 * `server.close()` until the deadline on every teardown. */
	private readonly liveSockets = new Set<Socket>();
	/** Every in-flight upstream request. Destroying the client/bridge sockets
	 * breaks the pipe but leaves the proxy→upstream socket open, so a streamed
	 * upstream connection (the SSE channel to api.githubcopilot.com) leaks unless
	 * the request itself is aborted on teardown. */
	private readonly liveUpstreams = new Set<ClientRequest>();
	/** This run's own agent for proxy→upstream HTTPS, with keep-alive OFF and owned
	 * per run rather than shared with the process-global agent. Keep-alive off means
	 * an upstream socket is never parked idle in a pool — it closes when its
	 * response ends — so only genuinely in-flight requests (aborted via
	 * `liveUpstreams`) hold a socket at teardown. Idle pooled sockets can't be
	 * reliably closed under Bun (a pooled socket's handle no longer maps to the live
	 * connection), so not pooling them is what keeps them from outliving the run and
	 * accumulating against a remote MCP host. */
	private readonly upstreamAgent: HttpsAgent;

	constructor(private readonly cfg: RunProxyConfig) {
		this.upstreamAgent = new HttpsAgent({
			keepAlive: false,
			...(cfg.upstreamTrustedCAs ? { ca: cfg.upstreamTrustedCAs } : {}),
		});
	}

	/** Debug-gated lifecycle logging. Enable with `HEZO_EGRESS_DEBUG=1` to trace
	 * which connection leg dies and when. */
	private dbg(msg: string, meta: Record<string, unknown> = {}): void {
		if (!EGRESS_DEBUG) return;
		log.info(`[egress-dbg] ${msg}`, {
			run: ref(this.cfg.scope.label, this.cfg.runId),
			...meta,
		});
	}

	/** Register a socket for forced teardown; auto-untracks when it closes. The
	 * optional `leg` names which hop it is (agent CONNECT, per-host accept, loopback
	 * bridge, upstream) so debug traces can attribute a death to the right side. */
	private trackSocket(sock: Socket, leg = 'socket'): void {
		if (this.closed || sock.destroyed) {
			sock.destroy();
			return;
		}
		this.liveSockets.add(sock);
		sock.once('close', () => this.liveSockets.delete(sock));
		if (EGRESS_DEBUG) {
			const at = Date.now();
			// An upstream socket is still connecting when its request first emits it,
			// so its ports aren't populated yet; defer the open log to `connect` so it
			// reports the real local/remote ports instead of a placeholder.
			const logOpen = () =>
				this.dbg('socket open', { leg, local: sock.localPort, remote: sock.remotePort });
			if (sock.connecting) sock.once('connect', logOpen);
			else logOpen();
			sock.on('timeout', () => this.dbg('socket timeout event', { leg, ageMs: Date.now() - at }));
			sock.once('error', (e: Error) =>
				this.dbg('socket error', { leg, ageMs: Date.now() - at, error: e.message }),
			);
			sock.once('close', (hadError: boolean) =>
				this.dbg('socket close', { leg, ageMs: Date.now() - at, hadError }),
			);
		}
	}

	/** Register an upstream request for forced abort; auto-untracks on settle.
	 * Also tracks the underlying socket: under Bun `ClientRequest.destroy()` does
	 * not reliably tear down the proxy→upstream socket of a streamed response, so
	 * the socket itself must be severed to release the upstream connection. */
	private trackUpstream(reqOut: ClientRequest): void {
		if (this.closed) {
			reqOut.destroy();
			return;
		}
		this.liveUpstreams.add(reqOut);
		const cleanup = () => this.liveUpstreams.delete(reqOut);
		reqOut.once('close', cleanup);
		reqOut.once('error', cleanup);
		reqOut.on('socket', (sock) => this.trackSocket(sock, 'upstream'));
	}

	get port(): number {
		return this.cfg.port;
	}

	get scope(): RunProxyScope {
		return this.cfg.scope;
	}

	/**
	 * Constant-time check of the caller's `Proxy-Authorization: Basic …` against
	 * this run's token. Returns `true` when auth is disabled (`token === null`).
	 * The username half is ignored — only the password (the hex token) is
	 * compared, and the comparison is length-safe (a wrong-length candidate is
	 * still run through `timingSafeEqual` on equal-length buffers so it can't
	 * short-circuit and leak length via timing).
	 */
	private isAuthorized(header: string | undefined): boolean {
		const expected = this.cfg.token;
		if (expected === null) return true;
		if (!header) return false;
		const match = /^Basic\s+(.+)$/i.exec(header.trim());
		if (!match) return false;
		let decoded: string;
		try {
			decoded = Buffer.from(match[1], 'base64').toString('utf8');
		} catch {
			return false;
		}
		const sep = decoded.indexOf(':');
		if (sep === -1) return false;
		const candidate = Buffer.from(decoded.slice(sep + 1), 'hex');
		// Compare equal-length buffers regardless of candidate length: a
		// length-mismatched candidate is compared against itself so the call
		// takes constant time relative to the expected token, then rejected.
		if (candidate.length !== expected.length) {
			timingSafeEqual(expected, expected);
			return false;
		}
		return timingSafeEqual(candidate, expected);
	}

	listen(): Promise<void> {
		const front = createHttpServer();
		this.front = front;
		// Track every accepted socket (plain-request and CONNECT alike) so close
		// can sever it — a hijacked CONNECT socket leaves the server's own
		// connection list under Bun.
		front.on('connection', (socket) => this.trackSocket(socket as Socket, 'agent-front'));
		front.on('request', (req, res) => {
			// Authenticate the agent↔proxy hop here — this fires only for plain
			// proxied requests. For CONNECT/HTTPS the auth check is in onConnect;
			// the decrypted inner request (forwarded with isSSL=true) carries no
			// Proxy-Authorization and must not be re-checked.
			if (!this.isAuthorized(req.headers['proxy-authorization'])) {
				respondProxyAuthRequired(res);
				return;
			}
			this.forward(false, null, req, res).catch((e: Error) => this.onHandlerError(res, e));
		});
		front.on('connect', (req, socket, head) => this.onConnect(req, socket as Socket, head));
		// A client that drops mid-handshake should not surface as an unhandled error.
		front.on('clientError', (_err, socket) => socket.destroy());

		return new Promise<void>((resolve, reject) => {
			const onListenError = (err: Error) => reject(err);
			front.once('error', onListenError);
			front.listen(this.cfg.port, this.cfg.bindHost, () => {
				front.removeListener('error', onListenError);
				front.on('error', (err) => {
					log.warn('egress front server error', {
						run: ref(this.cfg.scope.label, this.cfg.runId),
						error: err.message,
					});
				});
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		// Sever every tracked connection first. Without this, a long-lived stream
		// (an MCP server→client SSE channel) parks each server.close() until the
		// 5s deadline and leaks the upstream connection — observed in production
		// as repeated "server close timed out" warnings on api.githubcopilot.com.
		for (const sock of this.liveSockets) sock.destroy();
		this.liveSockets.clear();
		for (const up of this.liveUpstreams) up.destroy();
		this.liveUpstreams.clear();
		// Tear down the run's upstream agent so nothing it holds outlives the run.
		this.upstreamAgent.destroy();

		const closables: Array<Promise<void>> = [];
		for (const [host, { server, port }] of this.hostServers.entries()) {
			this.cfg.hostPortAllocator.release(port);
			closables.push(closeServer(server, `${this.cfg.scope.label}/${host}`));
		}
		this.hostServers.clear();
		this.pendingHostServers.clear();
		if (this.front) {
			closables.push(closeServer(this.front, `${this.cfg.scope.label}/front`));
			this.front = null;
		}
		await Promise.all(closables);
	}

	private onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
		const target = req.url ?? '';
		const sep = target.lastIndexOf(':');
		const host = (sep === -1 ? target : target.slice(0, sep)).toLowerCase();

		client.on('error', () => client.destroy());

		// Authenticate the tunnel before establishing it. HTTPS clients send
		// Proxy-Authorization on the CONNECT (never inside the TLS tunnel), so
		// this is the only place to enforce it for HTTPS egress.
		if (!this.isAuthorized(req.headers['proxy-authorization'])) {
			client.write(
				`HTTP/1.1 407 Proxy Authentication Required\r\n` +
					`Proxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\n` +
					`Content-Length: 0\r\n\r\n`,
			);
			client.destroy();
			return;
		}

		client.pause();

		this.bridgeConnect(host, client, head).catch((e: Error) => {
			log.warn('egress CONNECT setup failed', {
				run: ref(this.cfg.scope.label, this.cfg.runId),
				host,
				error: e.message,
			});
			client.destroy();
		});
	}

	/** Bridge a CONNECT tunnel into the host's per-host TLS server. The dial
	 * re-checks liveness synchronously and rebuilds a dead server, then connects
	 * with no further `await` — so a server that died after lookup is never dialed.
	 * The dialed port is the one this host's server was explicitly bound to (never
	 * read back from `address()`), so the tunnel always reaches that host's leaf
	 * cert. */
	private async bridgeConnect(host: string, client: Socket, head: Buffer): Promise<void> {
		let rec = await this.ensureHostServer(host);
		if (!this.closed && !rec.server.listening) {
			rec = await this.buildHostServer(host);
		}
		if (this.closed) {
			client.destroy();
			return;
		}
		if (EGRESS_DEBUG) {
			// The cross-host cert leak (a host served another host's leaf cert) shows
			// up here: the port about to be dialed must be owned by THIS host's server
			// and no other. Log the owner(s) so a mis-route is caught red-handed.
			const owners = [...this.hostServers.entries()]
				.filter(([, r]) => r.port === rec.port)
				.map(([h]) => h);
			this.dbg('connect dial', { host, dialPort: rec.port, owners });
		}
		const up = netConnect({ host: '127.0.0.1', port: rec.port }, () => {
			this.trackSocket(up, `bridge:${host}`);
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head?.length) up.write(head);
			client.pipe(up);
			up.pipe(client);
			client.resume();
		});
		up.on('error', () => client.destroy());
		up.on('close', () => client.destroy());
		client.on('close', () => up.destroy());
	}

	/** Return a live per-host TLS server, rebuilding it if the cached one has
	 * stopped listening. Concurrent first-touches for the same host share one
	 * in-flight build so the run never spins up duplicate servers. */
	private ensureHostServer(host: string): Promise<HostServer> {
		const existing = this.hostServers.get(host);
		// Liveness is `server.listening` alone. Each per-host server owns an
		// explicitly allocated port, so a live entry can never be a zombie pointing
		// at another host's port (the `address()`-lies failure mode that needed the
		// old uniqueness check). A closed server is rebuilt onto a fresh port.
		if (existing?.server.listening) {
			return Promise.resolve(existing);
		}

		const pending = this.pendingHostServers.get(host);
		if (pending) return pending;

		const build = this.buildHostServer(host);
		this.pendingHostServers.set(host, build);
		build.finally(() => {
			if (this.pendingHostServers.get(host) === build) this.pendingHostServers.delete(host);
		});
		return build;
	}

	private async buildHostServer(host: string): Promise<HostServer> {
		const stale = this.hostServers.get(host);
		if (stale) {
			this.hostServers.delete(host);
			this.cfg.hostPortAllocator.release(stale.port);
			void closeServer(stale.server, `${this.cfg.scope.label}/${host}`);
		}

		const ca = await this.cfg.getMintCa();
		const leaf = await ca.generateCertificate(host);

		// Bind to an EXPLICITLY allocated loopback port and treat that port as
		// authoritative. `server.listen(0)` + `server.address().port` is unreliable
		// under Bun — it has reported the same port for every per-host server,
		// collapsing all hosts onto one and serving the wrong leaf cert
		// (ERR_TLS_CERT_ALTNAME_INVALID). The port must be one we chose, never read
		// back from `address()`. Allocate-and-bind with retry since a probed-free
		// port can still lose the bind race (mirrors the front-server allocation).
		const reserved: number[] = [];
		let lastReason = 'no bindable loopback port for per-host server';
		try {
			for (let attempt = 0; attempt < HOST_BIND_ATTEMPTS; attempt++) {
				// No agentId: per-host ports need no per-agent stickiness, and passing
				// it would pollute the front proxy's lastForAgent map.
				const port = await this.cfg.hostPortAllocator.allocate();
				reserved.push(port);

				const server = createHttpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
					this.forward(true, host, req, res).catch((e: Error) => this.onHandlerError(res, e));
				});
				server.on('connection', (socket) => this.trackSocket(socket as Socket, `perhost:${host}`));
				server.on('clientError', (_err, socket) => socket.destroy());

				try {
					await new Promise<void>((resolve, reject) => {
						const onErr = (err: Error) => reject(err);
						server.once('error', onErr);
						server.listen(port, '127.0.0.1', () => {
							server.removeListener('error', onErr);
							resolve();
						});
					});
				} catch (e) {
					// Lost the bind race; keep this port reserved so the next attempt
					// lands elsewhere, and try another port.
					lastReason = (e as Error).message;
					server.close();
					continue;
				}

				// Bound — attach the long-lived error logger now (a pre-bind error
				// rejects the listen promise above instead of being logged here).
				server.on('error', (err) => {
					log.warn('egress per-host server error', {
						run: ref(this.cfg.scope.label, this.cfg.runId),
						host,
						error: err.message,
					});
				});

				if (this.closed) {
					for (const p of reserved) this.cfg.hostPortAllocator.release(p);
					await closeServer(server, `${this.cfg.scope.label}/${host}`);
					throw new Error('proxy closed');
				}

				const rec: HostServer = { server, port };
				this.hostServers.set(host, rec);
				for (const p of reserved) {
					if (p !== port) this.cfg.hostPortAllocator.release(p);
				}
				return rec;
			}
		} catch (e) {
			lastReason = (e as Error).message;
		}
		for (const p of reserved) this.cfg.hostPortAllocator.release(p);
		throw new Error(`egress per-host server bind failed for ${host}: ${lastReason}`);
	}

	/** Scan the decrypted (or plain) request for secret placeholders, substitute
	 * them, and forward a fresh request to the real upstream. */
	private async forward(
		isSSL: boolean,
		connectHost: string | null,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		// Hold the body until we decide whether to forward — the secret lookup
		// awaits the DB and must not let request bytes drain to nowhere.
		req.pause();

		const { host, port, path } = resolveTarget(isSSL, connectHost, req);
		const method = req.method ?? 'GET';
		const headers: Record<string, string | string[] | undefined> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			// Strip hop-by-hop headers (RFC 7230 §6.1) and all proxy-* headers: they
			// describe the agent↔proxy hop, not the proxy↔upstream one, and a proxy
			// must not relay them. Relaying the client's `connection: keep-alive` in
			// particular tells the upstream to hold the socket open on the client's
			// behalf, against the proxy's own connection management.
			if (/^proxy-/i.test(name) || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
			headers[name] = value;
		}

		if (isSSL) {
			// Drop the client-forwarded Host header so the runtime regenerates it
			// from the connection target. Some runtimes verify the upstream cert
			// against the Host header verbatim — which carries the port for
			// non-default ports and so fails hostname validation against a cert
			// whose SAN is the bare host. With no Host header, verification uses
			// the connection host and the regenerated header still carries the
			// correct host:port to the upstream.
			delete headers.host;
			delete headers.Host;
		}

		const protocol = isSSL ? 'https' : 'http';
		const url = `${protocol}://${host}${path}`;
		const probeInUrlOrHeaders = PLACEHOLDER_PROBE_REGEX.test(path) || headersContainProbe(headers);

		// Decide from headers alone whether this request may carry a credential in
		// its body. Only small, fixed-length, uncompressed application/json
		// POST/PUT/PATCH bodies qualify; everything else (streaming, large,
		// non-JSON) is never buffered and streams through byte-for-byte as before.
		const bodyEligible = isBodySubstitutionEligible(method, headers);

		// A host backing a restricted connector must have its `tools/call` bodies
		// inspected, which needs a larger cap than substitution and must also cover
		// request shapes substitution skips (no Content-Length, oversized). Null for
		// every other host, which keeps the untouched path untouched.
		const restriction = this.cfg.mcpRestrictions.get(mcpRestrictionKey(host, port)) ?? null;
		const inspectForMcp = restriction !== null && mayCarryJsonRpc(method, headers);

		// Read the body ONCE, at whichever cap applies. Both gates want the same
		// bytes and the stream can only be consumed once, so the read is shared and
		// each gate decides separately what to do with the result.
		let bufferedBody: Buffer | null = null;
		if (bodyEligible || inspectForMcp) {
			const cap = inspectForMcp ? MAX_MCP_INSPECTION_BYTES : MAX_BODY_SUBSTITUTION_BYTES;
			const read = await readBodyCapped(req, cap);
			if (read.tooLarge) {
				// Over the inspection cap on a restricted host means the allowlist
				// cannot be checked. Fail closed: forwarding it uninspected would make
				// the restriction advisory.
				if (inspectForMcp) {
					respondEarly(
						res,
						403,
						'mcp_method_not_enabled',
						`Blocked by Hezo: this request to the "${restriction.connectorName}" MCP server ` +
							`exceeds the ${MAX_MCP_INSPECTION_BYTES}-byte limit for method-allowlist inspection, ` +
							`and that connector only exposes a subset of its server's methods.`,
					);
					return;
				}
				respondEarly(
					res,
					413,
					'body_too_large',
					`Request body exceeds the ${MAX_BODY_SUBSTITUTION_BYTES}-byte limit for body substitution.`,
				);
				return;
			}
			bufferedBody = read.buffer;
		}

		if (restriction && inspectForMcp && bufferedBody !== null) {
			const verdict = shouldBlockMcpRequest(bufferedBody.toString('utf8'), restriction.enabled);
			if (verdict.blocked) {
				log.info('egress proxy blocked a disabled mcp method', {
					run: ref(this.cfg.scope.label, this.cfg.runId),
					connector: restriction.connectorName,
					host,
					method: verdict.method,
					reason: verdict.reason,
				});
				respondEarly(
					res,
					403,
					'mcp_method_not_enabled',
					mcpMethodBlockedMessage(verdict, restriction.connectorName),
				);
				return;
			}
		}

		const probeInBody =
			bufferedBody !== null && PLACEHOLDER_PROBE_REGEX.test(bufferedBody.toString('utf8'));

		if (probeInUrlOrHeaders || probeInBody) {
			let secrets: Map<string, ResolvedSecret>;
			try {
				secrets = await loadAllSecrets({
					db: this.cfg.db,
					masterKeyManager: this.cfg.masterKeyManager,
				});
			} catch (e) {
				if ((e as Error).name === 'MasterKeyLocked') {
					respondEarly(res, 503, 'secrets_unavailable', 'Master key is locked.');
					req.resume();
					return;
				}
				throw e;
			}

			const result = substituteRequest(
				{
					url,
					headers,
					method,
					host,
					...(bufferedBody !== null ? { body: bufferedBody.toString('utf8') } : {}),
				},
				secrets,
			);
			if (result.failure) {
				const fail = describeFailure(result.failure);
				respondEarly(res, fail.statusCode, fail.code, fail.message);
				req.resume();
				return;
			}
			if (result.headersChanged) {
				for (const [name, value] of Object.entries(result.headers)) {
					headers[name] = value;
				}
			}
			let upstreamPath = path;
			if (result.urlChanged) {
				try {
					const u = new URL(result.url);
					upstreamPath = `${u.pathname}${u.search}`;
				} catch {
					// pre-validated regex match — defensive only
				}
			}
			if (bufferedBody !== null) {
				const outBody =
					result.bodyChanged && result.body !== null
						? Buffer.from(result.body, 'utf8')
						: bufferedBody;
				this.forwardBuffered(isSSL, host, port, method, upstreamPath, headers, outBody, res);
			} else {
				this.pipeUpstream(isSSL, host, port, method, upstreamPath, headers, req, res);
			}
			return;
		}

		// No placeholder anywhere. A buffered (eligible) body must be forwarded from
		// the buffer — its stream is already consumed; otherwise stream as usual.
		if (bufferedBody !== null) {
			this.forwardBuffered(isSSL, host, port, method, path, headers, bufferedBody, res);
		} else {
			this.pipeUpstream(isSSL, host, port, method, path, headers, req, res);
		}
	}

	private pipeUpstream(
		isSSL: boolean,
		host: string,
		port: number,
		method: string,
		path: string,
		headers: Record<string, string | string[] | undefined>,
		req: IncomingMessage,
		res: ServerResponse,
	): void {
		const requestFn = isSSL ? httpsRequest : httpRequest;
		const upstream = requestFn(
			{
				host,
				port,
				method,
				path,
				headers,
				...(isSSL ? { servername: host, agent: this.upstreamAgent } : {}),
			},
			(upstreamRes) => {
				res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
				upstreamRes.pipe(res);
			},
		);
		this.trackUpstream(upstream);
		upstream.on('error', (err) => this.onForwardError(res, err, { host, port, method, path }));
		req.pipe(upstream);
	}

	/** Forward a request whose body the proxy buffered (and possibly substituted)
	 * rather than streamed. Mirrors `pipeUpstream`, but writes a fixed `Buffer`
	 * with a recomputed `Content-Length` instead of piping the live request —
	 * substitution changes the body length, so the original framing is stale. */
	private forwardBuffered(
		isSSL: boolean,
		host: string,
		port: number,
		method: string,
		path: string,
		headers: Record<string, string | string[] | undefined>,
		body: Buffer,
		res: ServerResponse,
	): void {
		const outHeaders: Record<string, string | string[] | undefined> = { ...headers };
		outHeaders['content-length'] = String(body.byteLength);
		// The body is now a fixed Buffer, so re-frame it as such. Substitution can
		// change its length, and the MCP-inspection path also buffers requests that
		// arrived chunked with no Content-Length at all — either way the original
		// framing is stale, and leaving a transfer-encoding alongside an explicit
		// Content-Length would make it ambiguous upstream.
		delete outHeaders['transfer-encoding'];
		const requestFn = isSSL ? httpsRequest : httpRequest;
		const upstream = requestFn(
			{
				host,
				port,
				method,
				path,
				headers: outHeaders,
				...(isSSL ? { servername: host, agent: this.upstreamAgent } : {}),
			},
			(upstreamRes) => {
				res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
				upstreamRes.pipe(res);
			},
		);
		this.trackUpstream(upstream);
		upstream.on('error', (err) => this.onForwardError(res, err, { host, port, method, path }));
		upstream.end(body);
	}

	/** A connection to the real upstream failed (refused, DNS, timeout, TLS).
	 * Logs the target and the error's system-level fields so the cause is
	 * diagnosable — `code` distinguishes ECONNREFUSED (upstream refused) from
	 * ENOTFOUND (DNS) from ETIMEDOUT — then returns a 502 to the agent. */
	private onForwardError(res: ServerResponse, err: Error, target?: UpstreamTarget): void {
		log.warn('egress upstream request failed', this.failureMeta(err, target));
		this.finishError(res, err);
	}

	/** An error thrown by the request handler itself (secret lookup, substitution,
	 * target resolution) before any upstream connection — distinct from an
	 * upstream connectivity failure so the two are not conflated in the logs. */
	private onHandlerError(res: ServerResponse, err: Error): void {
		log.warn('egress request handler failed', this.failureMeta(err));
		this.finishError(res, err);
	}

	/** Structured failure context: the run, the upstream target (when known), and
	 * the Node `SystemError` fields present on connection errors. Fields absent
	 * under the runtime (Bun does not always populate `code`/`syscall`) are
	 * omitted rather than logged as `undefined`. */
	private failureMeta(err: Error, target?: UpstreamTarget): Record<string, unknown> {
		const sysErr = err as NodeJS.ErrnoException;
		const meta: Record<string, unknown> = {
			run: ref(this.cfg.scope.label, this.cfg.runId),
			error: err.message,
		};
		if (target) {
			meta.host = target.host;
			meta.port = target.port;
			meta.method = target.method;
			meta.path = target.path;
		}
		if (sysErr.code) meta.code = sysErr.code;
		if (sysErr.syscall) meta.syscall = sysErr.syscall;
		if (sysErr.errno !== undefined) meta.errno = sysErr.errno;
		return meta;
	}

	private finishError(res: ServerResponse, err: Error): void {
		if (!res.headersSent) {
			respondEarly(res, 502, 'upstream_error', err.message);
		} else {
			res.end();
		}
	}
}

interface TargetAddress {
	host: string;
	port: number;
	path: string;
}

/** The upstream a forwarded request was aimed at, attached to failure logs so a
 * connection error names the host it could not reach. */
interface UpstreamTarget {
	host: string;
	port: number;
	method: string;
	path: string;
}

/** Resolve the upstream host, port, and request path. For TLS the host is the
 * CONNECT target the per-host server was minted for; the port rides on the Host
 * header for non-default ports. For plain HTTP the absolute-form request line
 * carries all three. */
function resolveTarget(
	isSSL: boolean,
	connectHost: string | null,
	req: IncomingMessage,
): TargetAddress {
	if (isSSL) {
		const hostHeader = req.headers.host ?? '';
		const portFromHeader = Number(hostHeader.split(':')[1]);
		return {
			host: connectHost ?? hostHeader.split(':')[0] ?? '',
			port: Number.isFinite(portFromHeader) && portFromHeader > 0 ? portFromHeader : 443,
			path: req.url ?? '/',
		};
	}
	const rawUrl = req.url ?? '/';
	try {
		const u = new URL(
			rawUrl.startsWith('http') ? rawUrl : `http://${req.headers.host ?? ''}${rawUrl}`,
		);
		return {
			host: u.hostname.toLowerCase(),
			port: u.port ? Number(u.port) : 80,
			path: `${u.pathname}${u.search}`,
		};
	} catch {
		return { host: (req.headers.host ?? '').split(':')[0] ?? '', port: 80, path: rawUrl };
	}
}

function closeServer(server: HttpServer | HttpsServer, label: string): Promise<void> {
	return closeServerWithDeadline(server, `egress:${label}`);
}

interface FailureDescription {
	statusCode: number;
	code: string;
	message: string;
}

function describeFailure(failure: SubstitutionFailure): FailureDescription {
	switch (failure.kind) {
		case 'unknown_secret':
			return {
				statusCode: 400,
				code: 'unknown_secret',
				message: `No secret named ${failure.name} is available to this run.`,
			};
		case 'secret_not_allowed_for_host':
			return {
				statusCode: 403,
				code: 'secret_not_allowed_for_host',
				message: `Secret ${failure.name} is not permitted for host ${failure.host}.`,
			};
		case 'secret_not_allowed_in_body':
			return {
				statusCode: 403,
				code: 'secret_not_allowed_in_body',
				message: `Secret ${failure.name} is not permitted in request bodies. Enable body substitution for this credential to use it in a JSON payload.`,
			};
		case 'secrets_unavailable':
			return {
				statusCode: 503,
				code: 'secrets_unavailable',
				message: 'Secrets store is locked.',
			};
	}
}

function respondEarly(
	res: ServerResponse,
	statusCode: number,
	code: string,
	message: string,
): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	const body = JSON.stringify({ error: code, message });
	res.writeHead(statusCode, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body).toString(),
	});
	res.end(body);
}

/** 407 for a plain proxied request missing/failing per-run auth. */
function respondProxyAuthRequired(res: ServerResponse): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	const body = JSON.stringify({
		error: 'proxy_auth_required',
		message: 'Missing or invalid per-run egress proxy credentials.',
	});
	res.writeHead(407, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body).toString(),
		'proxy-authenticate': `Basic realm="${PROXY_AUTH_REALM}"`,
	});
	res.end(body);
}

function headersContainProbe(headers: Record<string, string | string[] | undefined>): boolean {
	for (const v of Object.values(headers)) {
		if (typeof v === 'string' && PLACEHOLDER_PROBE_REGEX.test(v)) return true;
		if (Array.isArray(v) && v.some((s) => PLACEHOLDER_PROBE_REGEX.test(s))) return true;
	}
	return false;
}

function headerValue(
	headers: Record<string, string | string[] | undefined>,
	name: string,
): string | null {
	const v = headers[name];
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return v[0] ?? null;
	return null;
}

/** Whether a request is eligible for body placeholder substitution, decided from
 * the request line + headers alone (before any body byte is read). Gates keep
 * buffering to small credential-in-body logins and never touch streaming bodies:
 * a POST/PUT/PATCH with an uncompressed `application/json` payload and a fixed
 * `Content-Length` within the cap. Everything else streams through unchanged. */
function isBodySubstitutionEligible(
	method: string,
	headers: Record<string, string | string[] | undefined>,
): boolean {
	const m = method.toUpperCase();
	if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return false;
	const contentType = headerValue(headers, 'content-type');
	if (!contentType || !/^\s*application\/json\b/i.test(contentType)) return false;
	// A compressed body can't be string-substituted safely — exclude it.
	if (headerValue(headers, 'content-encoding')) return false;
	// Require a fixed, in-range Content-Length: excludes chunked/streaming bodies
	// and bounds buffering before a single byte is read.
	const lenRaw = headerValue(headers, 'content-length');
	if (lenRaw === null) return false;
	const len = Number(lenRaw);
	if (!Number.isInteger(len) || len < 0 || len > MAX_BODY_SUBSTITUTION_BYTES) return false;
	return true;
}

/** Whether a request to a restricted MCP host could carry a JSON-RPC message,
 * and so must be inspected before it is forwarded.
 *
 * Deliberately wider than `isBodySubstitutionEligible`: that gate exists to keep
 * buffering rare, while this one exists to make sure nothing slips past. It
 * accepts a body with no `Content-Length` (a chunked `tools/call` is legal) and
 * imposes no size limit here — `readBodyCapped` enforces the inspection cap and
 * an over-cap request is rejected rather than waved through.
 *
 * Only bodied methods are inspected. A GET/DELETE carries no JSON-RPC message,
 * and on MCP's Streamable HTTP transport a GET is the SSE channel the server
 * pushes on — buffering that would hang the stream, and it can't invoke a tool
 * regardless. A compressed body is *not* excluded here: it can't be inspected,
 * so it must reach the guard and be blocked rather than skipped. */
function mayCarryJsonRpc(
	method: string,
	headers: Record<string, string | string[] | undefined>,
): boolean {
	const m = method.toUpperCase();
	if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return false;
	const contentType = headerValue(headers, 'content-type');
	// An MCP client posts JSON. Anything else on this transport isn't a tools/call
	// — and a body we can't read as JSON is caught by the guard's fail-closed
	// parse, not skipped here.
	if (contentType && !/^\s*application\/json\b/i.test(contentType)) return false;
	return true;
}

/** Read a paused request body into memory, aborting as soon as it exceeds `cap`
 * (a defence against a lying Content-Length). Resumes the stream itself; the
 * caller paused it. */
function readBodyCapped(
	req: IncomingMessage,
	cap: number,
): Promise<{ tooLarge: true } | { tooLarge: false; buffer: Buffer }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const cleanup = () => {
			req.off('data', onData);
			req.off('end', onEnd);
			req.off('error', onError);
		};
		const onData = (chunk: Buffer) => {
			if (settled) return;
			total += chunk.length;
			if (total > cap) {
				settled = true;
				cleanup();
				resolve({ tooLarge: true });
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ tooLarge: false, buffer: Buffer.concat(chunks) });
		};
		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		req.on('data', onData);
		req.on('end', onEnd);
		req.on('error', onError);
		req.resume();
	});
}
