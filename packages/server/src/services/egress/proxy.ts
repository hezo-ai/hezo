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
import type { PGlite } from '@electric-sql/pglite';
import type { CA } from 'mockttp/dist/util/certificates';
import { getCA } from 'mockttp/dist/util/certificates';
import type { MasterKeyManager } from '../../crypto/master-key';
import { ref } from '../../lib/log-ref';
import { closeServerWithDeadline } from '../../lib/net';
import { logger } from '../../logger';
import { type EgressAuditEvent, recordEgressEvent } from './audit';
import type { HezoCA } from './ca';
import { PortAllocator } from './port-allocator';
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

const PROXY_HOST = 'host.docker.internal';
const PROXY_BIND_HOST = '127.0.0.1';

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
	db: PGlite;
	masterKeyManager: MasterKeyManager;
	ca: HezoCA;
	portAllocator?: PortAllocator;
	proxyHost?: string;
	/** Interface the per-run proxy binds to. Defaults to `127.0.0.1`
	 * (loopback-only — agent containers reach it via `host.docker.internal`,
	 * which on Docker Desktop tunnels to host loopback). Docker integration
	 * tests on a native-Linux daemon set this to `0.0.0.0` so the container can
	 * reach the proxy via the bridge gateway IP, which loopback would refuse. */
	proxyBindHost?: string;
	/** Additional CA certs to trust when verifying upstream HTTPS servers.
	 * Tests use this to trust upstreams that present certs minted from the
	 * same CA the proxy uses. Production keeps this empty so the proxy
	 * relies on the runtime's system CA bundle. */
	extraUpstreamTrustedCAs?: string | string[];
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
}

/** How many ports to try binding before giving up allocating a run's proxy. */
const EGRESS_BIND_ATTEMPTS = 5;

export class EgressProxy {
	private readonly runs = new Map<string, RunProxyInstance>();
	private readonly portAllocator: PortAllocator;
	private readonly proxyHost: string;
	private readonly proxyBindHost: string;
	private mintCa: Promise<CA> | null = null;

	constructor(private readonly deps: EgressProxyDeps) {
		this.portAllocator = deps.portAllocator ?? new PortAllocator();
		this.proxyHost = deps.proxyHost ?? PROXY_HOST;
		this.proxyBindHost = deps.proxyBindHost ?? PROXY_BIND_HOST;
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
					bindHost: this.proxyBindHost,
					db: this.deps.db,
					masterKeyManager: this.deps.masterKeyManager,
					getMintCa: () => this.getMintCa(),
					upstreamTrustedCAs: this.deps.extraUpstreamTrustedCAs,
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
				return { proxyHost: this.proxyHost, proxyPort: port };
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
	db: PGlite;
	masterKeyManager: MasterKeyManager;
	getMintCa: () => Promise<CA>;
	upstreamTrustedCAs?: string | string[];
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
			this.dbg('socket open', { leg, local: sock.localPort, remote: sock.remotePort });
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

	listen(): Promise<void> {
		const front = createHttpServer();
		this.front = front;
		// Track every accepted socket (plain-request and CONNECT alike) so close
		// can sever it — a hijacked CONNECT socket leaves the server's own
		// connection list under Bun.
		front.on('connection', (socket) => this.trackSocket(socket as Socket, 'agent-front'));
		front.on('request', (req, res) => {
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
		for (const [host, { server }] of this.hostServers.entries()) {
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
	 * re-validates port ownership synchronously and rebuilds a stale server,
	 * then connects with no further `await` — only synchronous code separates the
	 * ownership check from the `netConnect`, so a concurrently-built server can
	 * never recycle the freed ephemeral port in between and route the tunnel to
	 * another host's leaf cert. */
	private async bridgeConnect(host: string, client: Socket, head: Buffer): Promise<void> {
		let rec = await this.ensureHostServer(host);
		while (!this.closed && !serverOwnsPort(rec)) {
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
	 * stopped owning its port. Concurrent first-touches for the same host share
	 * one in-flight build so the run never spins up duplicate servers. */
	private ensureHostServer(host: string): Promise<HostServer> {
		const existing = this.hostServers.get(host);
		// Reuse only a live entry that is the *sole* claimant of its port. Under Bun
		// a stale entry can keep reporting a port that another host's live server has
		// since taken over (`address()` lies), so `serverOwnsPort` alone can't tell a
		// real owner from a zombie pointing at someone else's port — dialing it would
		// serve the other host's leaf cert. Requiring unique ownership forces a
		// rebuild onto a fresh, exclusive port instead.
		if (existing && serverOwnsPort(existing) && this.portUniquelyOwnedBy(host, existing.port)) {
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
			void closeServer(stale.server, `${this.cfg.scope.label}/${host}`);
		}

		const ca = await this.cfg.getMintCa();
		const leaf = await ca.generateCertificate(host);
		const server = createHttpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
			this.forward(true, host, req, res).catch((e: Error) => this.onHandlerError(res, e));
		});
		server.on('connection', (socket) => this.trackSocket(socket as Socket, `perhost:${host}`));
		server.on('clientError', (_err, socket) => socket.destroy());
		server.on('error', (err) => {
			log.warn('egress per-host server error', {
				run: ref(this.cfg.scope.label, this.cfg.runId),
				host,
				error: err.message,
			});
		});

		await new Promise<void>((resolve, reject) => {
			const onErr = (err: Error) => reject(err);
			server.once('error', onErr);
			server.listen(0, '127.0.0.1', () => {
				server.removeListener('error', onErr);
				resolve();
			});
		});

		if (this.closed) {
			await closeServer(server, `${this.cfg.scope.label}/${host}`);
			throw new Error('proxy closed');
		}

		const port = (server.address() as { port: number }).port;
		// The OS just handed this port to the new server, so any other host entry
		// still claiming it lost it and is stale — drop those entries so no two
		// hosts ever map to one port (the cross-host wrong-cert invariant). The
		// orphaned server is already off the port; let it be GC'd rather than
		// risk closing a live server on a mis-reported port.
		for (const [h, r] of this.hostServers) {
			if (h !== host && r.port === port) this.hostServers.delete(h);
		}
		const rec: HostServer = { server, port };
		this.hostServers.set(host, rec);
		return rec;
	}

	/** Whether `host` is the only entry claiming `port`. A port belongs to exactly
	 * one per-host server; a second claimant is a stale entry that lost the port. */
	private portUniquelyOwnedBy(host: string, port: number): boolean {
		for (const [h, r] of this.hostServers) {
			if (h !== host && r.port === port) return false;
		}
		return true;
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

		if (probeInUrlOrHeaders) {
			let secrets: Map<string, ResolvedSecret>;
			try {
				secrets = await loadAllSecrets({
					db: this.cfg.db,
					masterKeyManager: this.cfg.masterKeyManager,
				});
			} catch (e) {
				if ((e as Error).name === 'MasterKeyLocked') {
					await this.audit(host, method, path, 503, 0, [], 'secrets_unavailable');
					respondEarly(res, 503, 'secrets_unavailable', 'Master key is locked.');
					req.resume();
					return;
				}
				throw e;
			}

			const result = substituteRequest({ url, headers, method, host }, secrets);
			if (result.failure) {
				const fail = describeFailure(result.failure);
				await this.audit(host, method, path, fail.statusCode, 0, [], fail.code);
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
			if (result.secretsUsed.size > 0) {
				await this.audit(host, method, path, null, result.secretsUsed.size, [
					...result.secretsUsed,
				]);
			}
			this.pipeUpstream(isSSL, host, port, method, upstreamPath, headers, req, res);
			return;
		}

		this.pipeUpstream(isSSL, host, port, method, path, headers, req, res);
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

	private async audit(
		host: string,
		method: string,
		urlPath: string,
		statusCode: number | null,
		substitutionsCount: number,
		secretNamesUsed: string[],
		error: string | null = null,
	): Promise<void> {
		const event: EgressAuditEvent = {
			teamId: this.cfg.scope.teamId,
			agentId: this.cfg.scope.agentId,
			runId: this.cfg.runId,
			host,
			method,
			urlPath,
			statusCode,
			substitutionsCount,
			secretNamesUsed,
			error,
		};
		await recordEgressEvent(this.cfg.db, event);
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

/** Whether the server still owns its recorded port. `address()` returns null
 * once a server closes and two sockets can never share one port, so this is the
 * authoritative liveness signal — a closed or recycled server fails it and is
 * rebuilt on the next request. */
function serverOwnsPort(rec: HostServer): boolean {
	if (!rec.server.listening) return false;
	const addr = rec.server.address();
	return typeof addr === 'object' && addr !== null && addr.port === rec.port;
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

function headersContainProbe(headers: Record<string, string | string[] | undefined>): boolean {
	for (const v of Object.values(headers)) {
		if (typeof v === 'string' && PLACEHOLDER_PROBE_REGEX.test(v)) return true;
		if (Array.isArray(v) && v.some((s) => PLACEHOLDER_PROBE_REGEX.test(s))) return true;
	}
	return false;
}
