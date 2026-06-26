import { Logger } from '@hiddentao/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildProbeScript,
	type ConnectivityProbeResult,
	checkContainerToHostConnectivity,
	classifyConnectivity,
	connectivitySeverity,
	formatContainerConnectivityMessage,
	isLoopbackHost,
	NETWORKING_DOCS_URL,
	parseProbeOutput,
	resolveAutoRebindTarget,
	SKIP_CONNECTIVITY_ENV,
} from '../src/services/container-connectivity-preflight';
import { createStubDocker } from './helpers/app';

const REACHABLE: ConnectivityProbeResult = { mcpReachable: true, bindReachable: true };
const MCP_DOWN: ConnectivityProbeResult = { mcpReachable: false, bindReachable: false };
const BIND_DOWN: ConnectivityProbeResult = { mcpReachable: true, bindReachable: false };

describe('isLoopbackHost', () => {
	it('recognises loopback addresses', () => {
		for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', ' 127.0.0.1 ']) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});
	it('treats all-interfaces / bridge IPs as non-loopback', () => {
		for (const h of ['0.0.0.0', '172.17.0.1', '10.0.0.5']) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});
});

describe('classifyConnectivity', () => {
	it('is ok only when both probes reach the host', () => {
		expect(classifyConnectivity(REACHABLE, '0.0.0.0')).toBe('ok');
	});
	it('reports mcp-unreachable whenever the MCP port is blocked (the firewall signal)', () => {
		expect(classifyConnectivity(MCP_DOWN, '0.0.0.0')).toBe('mcp-unreachable');
		// MCP gates: even if the bind probe somehow passed, a blocked MCP port wins.
		expect(classifyConnectivity({ mcpReachable: false, bindReachable: true }, '0.0.0.0')).toBe(
			'mcp-unreachable',
		);
	});
	it('blames the loopback bind when MCP works but the bind host is loopback', () => {
		expect(classifyConnectivity(BIND_DOWN, '127.0.0.1')).toBe('bind-loopback');
	});
	it('blames the firewall when the bind host is non-loopback but still unreachable', () => {
		expect(classifyConnectivity(BIND_DOWN, '0.0.0.0')).toBe('bind-firewalled');
	});
});

describe('connectivitySeverity', () => {
	it('is error only for the fully-broken mcp-unreachable case', () => {
		expect(connectivitySeverity('mcp-unreachable')).toBe('error');
	});
	it('is warn for the bind-host degradations (MCP works, agents still run)', () => {
		expect(connectivitySeverity('bind-loopback')).toBe('warn');
		expect(connectivitySeverity('bind-firewalled')).toBe('warn');
	});
});

describe('parseProbeOutput', () => {
	it('treats a real HTTP status as reachable and 000/DOWN/missing as not', () => {
		expect(parseProbeOutput('MCP:200 BIND:200')).toEqual({
			mcpReachable: true,
			bindReachable: true,
		});
		// 401/404 from the MCP endpoint still proves the path is open.
		expect(parseProbeOutput('MCP:401 BIND:000')).toEqual({
			mcpReachable: true,
			bindReachable: false,
		});
		expect(parseProbeOutput('MCP:000 BIND:200')).toEqual({
			mcpReachable: false,
			bindReachable: true,
		});
		expect(parseProbeOutput('MCP:DOWN BIND:DOWN')).toEqual({
			mcpReachable: false,
			bindReachable: false,
		});
		expect(parseProbeOutput('unexpected garbage')).toEqual({
			mcpReachable: false,
			bindReachable: false,
		});
	});

	it('extracts the bridge gateway IP and treats GW:- / missing as undefined', () => {
		expect(parseProbeOutput('MCP:200 BIND:200 GW:172.17.0.1').gatewayIp).toBe('172.17.0.1');
		expect(parseProbeOutput('MCP:200 BIND:000 GW:-').gatewayIp).toBeUndefined();
		expect(parseProbeOutput('MCP:200 BIND:200').gatewayIp).toBeUndefined();
	});
});

describe('buildProbeScript', () => {
	it('curls both host targets, resolves the gateway, and prints parseable markers', () => {
		const script = buildProbeScript(3100, 25000);
		expect(script).toContain('http://host.docker.internal:3100/mcp');
		expect(script).toContain('http://host.docker.internal:25000/');
		expect(script).toContain('getent hosts host.docker.internal');
		expect(script).toContain("printf 'MCP:%s BIND:%s GW:%s");
		// Round-trips through the parser when the markers are filled in.
		expect(parseProbeOutput('MCP:200 BIND:200')).toEqual(REACHABLE);
	});
});

describe('resolveAutoRebindTarget', () => {
	it('rebinds to the gateway IP only when a loopback bind is unreachable', () => {
		expect(
			resolveAutoRebindTarget({ outcome: 'bind-loopback', gatewayIp: '172.17.0.1' }, '127.0.0.1'),
		).toBe('172.17.0.1');
	});
	it('never overrides an explicit non-loopback bind host (operator intent wins)', () => {
		expect(
			resolveAutoRebindTarget({ outcome: 'bind-loopback', gatewayIp: '172.17.0.1' }, '0.0.0.0'),
		).toBeNull();
	});
	it('does not rebind without a resolved gateway IP', () => {
		expect(resolveAutoRebindTarget({ outcome: 'bind-loopback' }, '127.0.0.1')).toBeNull();
	});
	it('does not rebind on any other outcome', () => {
		for (const outcome of ['ok', 'bind-firewalled', 'mcp-unreachable', 'skipped'] as const) {
			expect(resolveAutoRebindTarget({ outcome, gatewayIp: '172.17.0.1' }, '127.0.0.1')).toBeNull();
		}
	});
});

describe('formatContainerConnectivityMessage', () => {
	const opts = { serverPort: 3100, containerBindHost: '127.0.0.1' };

	it('names the MCP port and the firewall rule when the bridge is blocked', () => {
		const msg = formatContainerConnectivityMessage('mcp-unreachable', opts);
		expect(msg).toContain('http://host.docker.internal:3100/mcp');
		expect(msg).toContain('ufw allow in on docker0 to any port 3100 proto tcp');
		expect(msg).toContain(NETWORKING_DOCS_URL);
	});

	it('points at --container-bind-host when the egress/SSH bind is loopback', () => {
		const msg = formatContainerConnectivityMessage('bind-loopback', opts);
		expect(msg).toContain('--container-bind-host 0.0.0.0');
		expect(msg).toContain('20000:29999');
		// Degradation framing, not the fatal "produce nothing" of mcp-unreachable.
		expect(msg).toContain('direct LLM providers');
		expect(msg).toContain('safe');
		expect(msg).not.toContain('produce nothing');
	});

	it('points at the firewall (egress range) when the bind host is already non-loopback', () => {
		const msg = formatContainerConnectivityMessage('bind-firewalled', {
			serverPort: 3100,
			containerBindHost: '0.0.0.0',
		});
		expect(msg).toContain('20000:29999');
		expect(msg).not.toContain('--container-bind-host');
		expect(msg).toContain('direct LLM providers');
		expect(msg).not.toContain('produce nothing');
	});

	it('frames mcp-unreachable as fatal and the bind cases as non-fatal degradations', () => {
		expect(formatContainerConnectivityMessage('mcp-unreachable', opts)).toContain(
			'hang with no tools',
		);
		for (const outcome of ['bind-loopback', 'bind-firewalled'] as const) {
			const msg = formatContainerConnectivityMessage(outcome, opts);
			expect(msg).toContain('degraded');
			expect(msg).toContain('agents run');
			expect(msg).not.toContain('produce nothing');
		}
	});

	it('honours a custom --port in the firewall rule', () => {
		const msg = formatContainerConnectivityMessage('mcp-unreachable', {
			serverPort: 8080,
			containerBindHost: '127.0.0.1',
		});
		expect(msg).toContain('to any port 8080 proto tcp');
	});

	it('never leaks the test-only / opt-out escape hatches', () => {
		for (const outcome of ['mcp-unreachable', 'bind-loopback', 'bind-firewalled'] as const) {
			const msg = formatContainerConnectivityMessage(outcome, opts);
			expect(msg).not.toContain('HEZO_SKIP_DOCKER');
			expect(msg).not.toContain(SKIP_CONNECTIVITY_ENV);
		}
	});
});

describe('checkContainerToHostConnectivity', () => {
	const docker = createStubDocker({ imageExists: async () => true });
	const base = {
		docker,
		serverPort: 3100,
		containerBindHost: '127.0.0.1',
		retryGapMs: 0,
		env: {} as NodeJS.ProcessEnv,
	};

	// The orchestrator logs its (multi-line) guidance on the non-ok path. Spy on the
	// logger so a green run stays quiet and so we can assert which level fired:
	// error for the fatal mcp-unreachable case, warn for the bind-host degradations.
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
		warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
		vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('skips (without probing) under HEZO_SKIP_DOCKER', async () => {
		const probe = vi.fn();
		const outcome = await checkContainerToHostConnectivity({
			...base,
			env: { HEZO_SKIP_DOCKER: '1' },
			probe,
		});
		expect(outcome.outcome).toBe('skipped');
		expect(probe).not.toHaveBeenCalled();
	});

	it('skips (without probing) under the documented opt-out', async () => {
		const probe = vi.fn();
		const outcome = await checkContainerToHostConnectivity({
			...base,
			env: { [SKIP_CONNECTIVITY_ENV]: '1' },
			probe,
		});
		expect(outcome.outcome).toBe('skipped');
		expect(probe).not.toHaveBeenCalled();
	});

	it('returns ok when a container can reach both targets', async () => {
		const outcome = await checkContainerToHostConnectivity({
			...base,
			probe: async () => REACHABLE,
		});
		expect(outcome.outcome).toBe('ok');
		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('surfaces the gateway IP the probe resolved', async () => {
		const outcome = await checkContainerToHostConnectivity({
			...base,
			probe: async () => ({ ...BIND_DOWN, gatewayIp: '172.17.0.1' }),
		});
		expect(outcome.outcome).toBe('bind-loopback');
		expect(outcome.gatewayIp).toBe('172.17.0.1');
	});

	it('logs mcp-unreachable at error (fatal — no tools load)', async () => {
		const outcome = await checkContainerToHostConnectivity({
			...base,
			probe: async () => MCP_DOWN,
		});
		expect(outcome.outcome).toBe('mcp-unreachable');
		expect(errorSpy).toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('logs a loopback bind at warn (degraded — MCP works, agents run)', async () => {
		const outcome = await checkContainerToHostConnectivity({
			...base,
			probe: async () => BIND_DOWN,
		});
		expect(outcome.outcome).toBe('bind-loopback');
		expect(warnSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('logs an unreachable non-loopback bind at warn (degraded)', async () => {
		const outcome = await checkContainerToHostConnectivity({
			...base,
			containerBindHost: '0.0.0.0',
			probe: async () => BIND_DOWN,
		});
		expect(outcome.outcome).toBe('bind-firewalled');
		expect(warnSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('retries a transient failure before settling on the result', async () => {
		const probe = vi
			.fn<() => Promise<ConnectivityProbeResult>>()
			.mockResolvedValueOnce(MCP_DOWN)
			.mockResolvedValueOnce(REACHABLE);
		const outcome = await checkContainerToHostConnectivity({ ...base, probe });
		expect(outcome.outcome).toBe('ok');
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it('stays non-fatal (skipped) when the probe machinery itself throws', async () => {
		const outcome = await checkContainerToHostConnectivity({
			...base,
			probe: async () => {
				throw new Error('docker boom');
			},
		});
		expect(outcome.outcome).toBe('skipped');
	});
});
