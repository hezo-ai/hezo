import { Agent as HttpsAgent } from 'node:https';
import type { PGlite } from '@electric-sql/pglite';
import type { IContext, IProxy } from 'http-mitm-proxy';
import { Proxy as MitmProxy } from 'http-mitm-proxy';
import type { MasterKeyManager } from '../../crypto/master-key';
import { ref } from '../../lib/log-ref';
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

const PROXY_HOST = 'host.docker.internal';

/**
 * Thrown when the underlying HTTPS proxy can't bind. Bubbled up to the
 * agent runner so the run aborts — never fall through to direct egress
 * with real secrets.
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
	/** Additional CA certs to trust when verifying upstream HTTPS servers.
	 * Tests use this to trust upstreams that present certs minted from the
	 * same CA the proxy uses. Production keeps this empty so the proxy
	 * relies on Node's system CA bundle. */
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

interface RunRecord {
	proxy: IProxy;
	port: number;
	scope: RunProxyScope;
}

export class EgressProxy {
	private readonly runs = new Map<string, RunRecord>();
	private readonly portAllocator: PortAllocator;
	private readonly proxyHost: string;

	constructor(private readonly deps: EgressProxyDeps) {
		this.portAllocator = deps.portAllocator ?? new PortAllocator();
		this.proxyHost = deps.proxyHost ?? PROXY_HOST;
	}

	get caCertPath(): string {
		return this.deps.ca.certPath;
	}

	async allocateRunProxy(runId: string, scope: RunProxyScope): Promise<AllocatedRunProxy> {
		if (this.runs.has(runId)) {
			throw new Error(`Egress proxy already allocated for run ${runId}`);
		}
		const port = await this.portAllocator.allocate(scope.agentId);

		const proxy = new MitmProxy();
		const upstreamHttpsAgent = this.deps.extraUpstreamTrustedCAs
			? new HttpsAgent({ keepAlive: true, ca: this.deps.extraUpstreamTrustedCAs })
			: undefined;
		proxy.onError((ctx, err, errorKind) => {
			if (!err) return;
			log.warn('mitm proxy error', {
				run: ref(scope.label, runId),
				kind: errorKind,
				error: err.message,
				...describeErrorContext(proxy, ctx, err),
			});
		});
		proxy.onRequest((ctx, callback) => {
			this.handleRequest(runId, scope, ctx)
				.then(() => callback())
				.catch((e: Error) => callback(e));
		});

		// The library terminates TLS with a per-host internal server, each
		// presenting that host's leaf cert, but caches the host→port mapping and
		// never invalidates it — so a recycled ephemeral port can leave a hostname
		// pointing at another host's server (a wrong-SAN TLS failure). This runs
		// after the per-host server is (re)selected: it purges stale mappings so
		// the next tunnel rebuilds a correct server, then logs loud if any live
		// cross-host route survives.
		const loggedCollisions = new Set<string>();
		proxy.onConnect(((_req: unknown, _socket: unknown, _head: unknown, callback: () => void) => {
			setImmediate(() => detectCrossHostCertRoute(proxy, scope, runId, loggedCollisions));
			callback();
		}) as Parameters<IProxy['onConnect']>[0]);

		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				proxy.onError((_ctx, err, kind) => {
					if (kind === 'HTTPS_SERVER_ERROR' && !settled) {
						settled = true;
						reject(err ?? new Error('HTTPS_SERVER_ERROR'));
					}
				});
				// The library terminates TLS with a separate internal HTTPS
				// server per host, each presenting a statically-minted leaf cert.
				// (forceSNI — a single SNI-multiplexed server via addContext — is
				// unusable here: the runtime's https.Server has no addContext and
				// ignores SNICallback, so dynamic SNI never fires. The patched
				// loopback connect retries then fails fast instead of hanging when
				// a per-host server is mid-listen or closing under run churn.)
				proxy.listen(
					{
						port,
						host: '127.0.0.1',
						sslCaDir: this.deps.ca.rootDir,
						...(upstreamHttpsAgent ? { httpsAgent: upstreamHttpsAgent } : {}),
					},
					((err?: Error | null) => {
						if (err) {
							if (!settled) {
								settled = true;
								reject(err);
							}
							return;
						}
						if (!settled) {
							settled = true;
							resolve();
						}
					}) as () => void,
				);
			});
		} catch (e) {
			this.portAllocator.release(port);
			const reason = (e as Error).message;
			log.warn('egress proxy unavailable for run', { run: ref(scope.label, runId), reason });
			throw new EgressProxyUnavailableError(reason);
		}

		this.runs.set(runId, { proxy, port, scope });
		log.debug('egress proxy allocated', { run: ref(scope.label, runId), port });

		return { proxyHost: this.proxyHost, proxyPort: port };
	}

	async releaseRunProxy(runId: string): Promise<void> {
		const record = this.runs.get(runId);
		if (!record) return;
		try {
			record.proxy.close();
		} catch (e) {
			log.warn('egress proxy close failed', {
				run: ref(record.scope.label, runId),
				error: (e as Error).message,
			});
		}
		this.portAllocator.release(record.port);
		this.runs.delete(runId);
		log.debug('egress proxy released', { run: ref(record.scope.label, runId) });
	}

	async releaseAll(): Promise<void> {
		for (const runId of [...this.runs.keys()]) {
			await this.releaseRunProxy(runId);
		}
	}

	private async handleRequest(runId: string, scope: RunProxyScope, ctx: IContext): Promise<void> {
		const opts = ctx.proxyToServerRequestOptions;
		if (!opts) return;
		const host = (opts.host ?? '').toLowerCase();
		const method = opts.method ?? 'GET';
		const urlPath = opts.path ?? '/';
		const headers = opts.headers ?? {};
		const protocol = ctx.isSSL ? 'https' : 'http';
		const url = `${protocol}://${host}${urlPath}`;

		if (ctx.isSSL) {
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

		const probeInUrlOrHeaders =
			PLACEHOLDER_PROBE_REGEX.test(urlPath) || headersContainProbe(headers);
		if (!probeInUrlOrHeaders) return;

		let secrets: Map<string, ResolvedSecret>;
		try {
			secrets = await loadAllSecrets({
				db: this.deps.db,
				masterKeyManager: this.deps.masterKeyManager,
			});
		} catch (e) {
			if ((e as Error).name === 'MasterKeyLocked') {
				await this.audit(runId, scope, host, method, urlPath, 503, 0, [], 'secrets_unavailable');
				respondEarly(ctx, 503, 'secrets_unavailable', 'Master key is locked.');
				throw new Error('secrets_unavailable');
			}
			throw e;
		}

		const result = substituteRequest({ url, headers, method, host }, secrets);
		if (result.failure) {
			const fail = describeFailure(result.failure);
			await this.audit(runId, scope, host, method, urlPath, fail.statusCode, 0, [], fail.code);
			respondEarly(ctx, fail.statusCode, fail.code, fail.message);
			throw new Error(fail.code);
		}
		if (result.headersChanged) {
			for (const [name, value] of Object.entries(result.headers)) {
				headers[name] = Array.isArray(value) ? value.join(', ') : value;
			}
		}
		if (result.urlChanged) {
			try {
				const u = new URL(result.url);
				opts.path = `${u.pathname}${u.search}`;
			} catch {
				// pre-validated regex match — defensive only
			}
		}
		if (result.secretsUsed.size > 0) {
			await this.audit(
				runId,
				scope,
				host,
				method,
				urlPath,
				null,
				result.secretsUsed.size,
				[...result.secretsUsed],
				null,
			);
		}
	}

	private async audit(
		runId: string,
		scope: RunProxyScope,
		host: string,
		method: string,
		urlPath: string,
		statusCode: number | null,
		substitutionsCount: number,
		secretNamesUsed: string[],
		error: string | null,
	): Promise<void> {
		const event: EgressAuditEvent = {
			teamId: scope.teamId,
			agentId: scope.agentId,
			runId,
			host,
			method,
			urlPath,
			statusCode,
			substitutionsCount,
			secretNamesUsed,
			error,
		};
		await recordEgressEvent(this.deps.db, event);
	}
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

function respondEarly(ctx: IContext, statusCode: number, code: string, message: string): void {
	const body = JSON.stringify({ error: code, message });
	const res = ctx.proxyToClientResponse;
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(statusCode, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body).toString(),
	});
	res.end(body);
}

function headersContainProbe(headers: Record<string, string>): boolean {
	for (const v of Object.values(headers)) {
		if (typeof v === 'string' && PLACEHOLDER_PROBE_REGEX.test(v)) return true;
	}
	return false;
}

/** Collapse the first DNS label to a wildcard so subdomains sharing one
 * wildcard-covered internal server (a legitimate single cert) don't read as a
 * collision. `api.githubcopilot.com` → `*.githubcopilot.com`. */
function wildcardForm(host: string): string {
	return host.replace(/^[^.]+\./, '*.');
}

interface SslServerEntry {
	port?: number;
	server?: { listening?: boolean };
}

/**
 * Reconcile the library's per-host server map, then assert the egress
 * invariant that no two unrelated upstream hosts share one internal MITM
 * server port.
 *
 * The library caches a bare port per hostname and never invalidates it: when a
 * per-host server is gone its ephemeral port can be recycled by the OS to a
 * different host's new server, leaving the original hostname pointing at a port
 * that now serves the wrong leaf cert (a wrong-SAN TLS failure). So first drop
 * any entry whose own backing server has stopped listening, plus wildcard-alias
 * entries no longer covered by a live server — the next tunnel for those hosts
 * then rebuilds a correct server.
 *
 * After reconciliation a live cross-wildcard collision should be impossible;
 * the remaining check is a tripwire that logs once per offending port.
 */
export function detectCrossHostCertRoute(
	proxy: IProxy,
	scope: RunProxyScope,
	runId: string,
	logged: Set<string>,
): void {
	const sslServers = (proxy as unknown as { sslServers?: Record<string, SslServerEntry> })
		.sslServers;
	if (!sslServers) return;

	const portHasLiveServer = new Map<number, boolean>();
	for (const entry of Object.values(sslServers)) {
		const port = entry?.port;
		if (typeof port !== 'number') continue;
		if (entry.server?.listening) portHasLiveServer.set(port, true);
	}
	for (const [host, entry] of Object.entries(sslServers)) {
		const port = entry?.port;
		if (typeof port !== 'number') continue;
		if (entry.server) {
			// A created per-host server: once its port stops listening it must
			// not keep serving this hostname — the port may be recycled.
			if (entry.server.listening === false) delete sslServers[host];
		} else if (!portHasLiveServer.get(port)) {
			// A wildcard-alias entry ({ port } only) with no live server on its
			// port is stale.
			delete sslServers[host];
		}
	}

	const hostsByPort = new Map<number, string[]>();
	for (const [host, entry] of Object.entries(sslServers)) {
		const port = entry?.port;
		if (typeof port !== 'number') continue;
		const hosts = hostsByPort.get(port);
		if (hosts) hosts.push(host);
		else hostsByPort.set(port, [host]);
	}
	for (const [port, hosts] of hostsByPort) {
		if (hosts.length < 2) continue;
		if (new Set(hosts.map(wildcardForm)).size < 2) continue;
		if (logged.has(`${port}`)) continue;
		logged.add(`${port}`);
		log.error('egress MITM server port serves unrelated hosts — cross-host cert risk', {
			run: ref(scope.label, runId),
			port,
			hosts: [...new Set(hosts)],
		});
	}
}

interface ErrorContext {
	method?: string;
	url?: string;
	hostname?: string;
	port?: number;
}

function describeErrorContext(proxy: IProxy, ctx: IContext | null, err: Error): ErrorContext {
	if (ctx?.proxyToServerRequestOptions) {
		const opts = ctx.proxyToServerRequestOptions;
		const host = (opts.host ?? '').toLowerCase();
		const method = opts.method ?? 'GET';
		const urlPath = opts.path ?? '/';
		const protocol = ctx.isSSL ? 'https' : 'http';
		return { method, url: `${protocol}://${host}${urlPath}` };
	}

	const errPort = (err as { port?: unknown }).port;
	const failedPort = typeof errPort === 'number' ? errPort : undefined;
	if (failedPort === undefined) return {};

	const sslServers = (proxy as unknown as { sslServers?: Record<string, { port: number }> })
		.sslServers;
	if (!sslServers) return { port: failedPort };

	for (const [hostname, entry] of Object.entries(sslServers)) {
		if (entry?.port === failedPort) {
			return { hostname, port: failedPort };
		}
	}
	return { port: failedPort };
}
