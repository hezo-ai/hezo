import { Agent as HttpsAgent } from 'node:https';
import type { PGlite } from '@electric-sql/pglite';
import type { IContext, IProxy } from 'http-mitm-proxy';
import { Proxy as MitmProxy } from 'http-mitm-proxy';
import type { MasterKeyManager } from '../../crypto/master-key';
import { logger } from '../../logger';
import { type EgressAuditEvent, recordEgressEvent } from './audit';
import type { HezoCA } from './ca';
import { PortAllocator } from './port-allocator';
import {
	loadSecretsForScope,
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
	companyId: string;
	agentId: string;
	projectId?: string | null;
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
		proxy.onError((_ctx, err, errorKind) => {
			if (!err) return;
			log.warn('mitm proxy error', { runId, kind: errorKind, error: err.message });
		});
		proxy.onRequest((ctx, callback) => {
			this.handleRequest(runId, scope, ctx)
				.then(() => callback())
				.catch((e: Error) => callback(e));
		});

		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				proxy.onError((_ctx, err, kind) => {
					if (kind === 'HTTPS_SERVER_ERROR' && !settled) {
						settled = true;
						reject(err ?? new Error('HTTPS_SERVER_ERROR'));
					}
				});
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
			log.warn('egress proxy unavailable for run', { runId, reason });
			throw new EgressProxyUnavailableError(reason);
		}

		this.runs.set(runId, { proxy, port, scope });
		log.debug('egress proxy allocated', { runId, port });

		return { proxyHost: this.proxyHost, proxyPort: port };
	}

	async releaseRunProxy(runId: string): Promise<void> {
		const record = this.runs.get(runId);
		if (!record) return;
		try {
			record.proxy.close();
		} catch (e) {
			log.warn('egress proxy close failed', { runId, error: (e as Error).message });
		}
		this.portAllocator.release(record.port);
		this.runs.delete(runId);
		log.debug('egress proxy released', { runId });
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

		const probeInUrlOrHeaders =
			PLACEHOLDER_PROBE_REGEX.test(urlPath) || headersContainProbe(headers);
		if (!probeInUrlOrHeaders) return;

		let secrets: Map<string, ResolvedSecret>;
		try {
			secrets = await loadSecretsForScope({
				db: this.deps.db,
				masterKeyManager: this.deps.masterKeyManager,
				companyId: scope.companyId,
				projectId: scope.projectId ?? null,
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
			companyId: scope.companyId,
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
