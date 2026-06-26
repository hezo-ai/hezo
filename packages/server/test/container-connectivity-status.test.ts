import { describe, expect, it, vi } from 'vitest';
import {
	type ConnectivityStatus,
	ContainerConnectivityStatus,
	EffectiveBindHost,
	type ProbeResult,
	shouldAbortForConnectivity,
} from '../src/services/container-connectivity-status';

describe('EffectiveBindHost', () => {
	it('returns its initial value and reflects updates', () => {
		const ref = new EffectiveBindHost('127.0.0.1');
		expect(ref.get()).toBe('127.0.0.1');
		ref.set('172.17.0.1');
		expect(ref.get()).toBe('172.17.0.1');
	});
});

describe('shouldAbortForConnectivity', () => {
	it('aborts only when the egress proxy is unreachable from containers', () => {
		const abort: ConnectivityStatus[] = ['bind-loopback', 'bind-firewalled', 'mcp-unreachable'];
		const proceed: ConnectivityStatus[] = ['ok', 'skipped', 'unknown'];
		for (const s of abort) expect(shouldAbortForConnectivity(s)).toBe(true);
		for (const s of proceed) expect(shouldAbortForConnectivity(s)).toBe(false);
	});
});

describe('ContainerConnectivityStatus', () => {
	it('starts unknown with the seeded bind host and never-checked', () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		expect(status.get()).toEqual({ status: 'unknown', bindHost: '127.0.0.1', checkedAt: null });
	});

	it('records the outcome, bind host, and timestamp on set', () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		status.set('ok', '172.17.0.1', 1000);
		expect(status.get()).toEqual({ status: 'ok', bindHost: '172.17.0.1', checkedAt: 1000 });
	});

	it('ensureFresh probes when unknown and caches the result', async () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		const probe = vi
			.fn<() => Promise<ProbeResult>>()
			.mockResolvedValue({ status: 'ok', bindHost: '172.17.0.1' });
		const result = await status.ensureFresh(probe, 60_000);
		expect(result).toBe('ok');
		expect(probe).toHaveBeenCalledTimes(1);
		expect(status.get().bindHost).toBe('172.17.0.1');
	});

	it('ensureFresh returns the cached status without re-probing while fresh', async () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		status.set('ok', '172.17.0.1', 1000);
		const probe = vi.fn<() => Promise<ProbeResult>>();
		const result = await status.ensureFresh(probe, 60_000, 1500);
		expect(result).toBe('ok');
		expect(probe).not.toHaveBeenCalled();
	});

	it('ensureFresh re-probes once the cached status is stale', async () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		status.set('ok', '172.17.0.1', 1000);
		const probe = vi
			.fn<() => Promise<ProbeResult>>()
			.mockResolvedValue({ status: 'bind-firewalled', bindHost: '172.17.0.1' });
		const result = await status.ensureFresh(probe, 60_000, 1_000_000);
		expect(result).toBe('bind-firewalled');
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('ensureFresh is single-flight: concurrent callers share one probe', async () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		let resolve: (r: ProbeResult) => void = () => {};
		const probe = vi.fn<() => Promise<ProbeResult>>().mockImplementation(
			() =>
				new Promise<ProbeResult>((r) => {
					resolve = r;
				}),
		);
		const calls = Array.from({ length: 5 }, () => status.ensureFresh(probe, 60_000));
		resolve({ status: 'ok', bindHost: '172.17.0.1' });
		const results = await Promise.all(calls);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
	});

	it('ensureFresh re-probes again after the in-flight one settles', async () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		const probe = vi
			.fn<() => Promise<ProbeResult>>()
			.mockResolvedValue({ status: 'ok', bindHost: '172.17.0.1' });
		// maxAgeMs 0 → never fresh, so each call probes (but not concurrently here).
		await status.ensureFresh(probe, 0);
		await status.ensureFresh(probe, 0);
		expect(probe).toHaveBeenCalledTimes(2);
	});
});
