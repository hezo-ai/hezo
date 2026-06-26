import type { ConnectivityOutcome } from './container-connectivity-preflight';

/**
 * Mutable holder for the interface the egress proxy and SSH bridge bind to. Both
 * services read it **per-run** at bind time (`EgressProxy.allocateRunProxy`,
 * `SshAgentServer.allocateRunSocket`), so updating it — e.g. auto-rebinding from
 * loopback to the detected docker bridge gateway IP when a container can't reach
 * loopback — takes effect on the next run with no listener restart.
 */
export class EffectiveBindHost {
	private host: string;
	constructor(initial: string) {
		this.host = initial;
	}
	get(): string {
		return this.host;
	}
	set(host: string): void {
		this.host = host;
	}
}

/** How long a captured connectivity outcome is trusted before a run re-probes.
 * Long enough that steady-state runs hit the cache, short enough that a firewall
 * fix (or regression) is picked up within minutes without a server restart. */
export const CONNECTIVITY_STALE_MS = 5 * 60_000;

export type ConnectivityStatus = ConnectivityOutcome | 'skipped' | 'unknown';

/**
 * The outcomes that mean the egress proxy is unreachable from agent containers.
 * An egress-requiring run must abort on these rather than silently fall through to
 * direct egress (which defeats secret substitution, allowed_hosts, and audit).
 * `ok`, `skipped`, and `unknown` are fail-open: the run proceeds.
 */
export function shouldAbortForConnectivity(
	status: ConnectivityStatus,
): status is 'bind-loopback' | 'bind-firewalled' | 'mcp-unreachable' {
	return status === 'bind-loopback' || status === 'bind-firewalled' || status === 'mcp-unreachable';
}

export interface ConnectivitySnapshot {
	status: ConnectivityStatus;
	/** The bind host the status was probed against (used for guidance messages). */
	bindHost: string;
	/** Epoch ms of the last update, or null if never probed. */
	checkedAt: number | null;
}

/** What a re-probe resolves to: the fresh outcome plus the host it tested. */
export interface ProbeResult {
	status: ConnectivityStatus;
	bindHost: string;
}

/**
 * Shared, in-memory record of the latest container→host connectivity outcome,
 * written by the boot preflight and read at run time to gate egress-requiring
 * work. Constructed once and injected (DI), not a module global.
 */
export class ContainerConnectivityStatus {
	private status: ConnectivityStatus = 'unknown';
	private checkedAt: number | null = null;
	private inFlight: Promise<ConnectivityStatus> | null = null;

	/** `initialBindHost` seeds the guidance host before the first probe lands. */
	constructor(private bindHost: string = '') {}

	get(): ConnectivitySnapshot {
		return { status: this.status, bindHost: this.bindHost, checkedAt: this.checkedAt };
	}

	set(status: ConnectivityStatus, bindHost: string, now: number = Date.now()): void {
		this.status = status;
		this.bindHost = bindHost;
		this.checkedAt = now;
	}

	/**
	 * Return the current status if it is fresh (set within `maxAgeMs` and not
	 * `'unknown'`); otherwise run `probe` to refresh it. **Single-flight**:
	 * concurrent callers share one probe so a burst of dispatched runs boots at
	 * most one throwaway probe container. `probe` must not reject — it should
	 * resolve to a status (the preflight returns `'skipped'` on its own failure),
	 * so a transient probe error fails open rather than aborting a run.
	 */
	async ensureFresh(
		probe: () => Promise<ProbeResult>,
		maxAgeMs: number,
		now: number = Date.now(),
	): Promise<ConnectivityStatus> {
		if (this.status !== 'unknown' && this.checkedAt !== null && now - this.checkedAt < maxAgeMs) {
			return this.status;
		}
		if (this.inFlight) return this.inFlight;
		this.inFlight = (async () => {
			try {
				const { status, bindHost } = await probe();
				this.set(status, bindHost);
				return status;
			} finally {
				this.inFlight = null;
			}
		})();
		return this.inFlight;
	}
}
