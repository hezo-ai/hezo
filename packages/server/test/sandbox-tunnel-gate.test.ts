import { describe, expect, it } from 'vitest';
import { tunnelEnabled } from '../src/services/agent-runner';
import {
	dockerRunEndpoints,
	TUNNEL_PORTS,
	tunnelRunEndpoints,
} from '../src/services/sandbox/endpoints';

/**
 * The gate exists because the tunnel replaces a path that works today, and the
 * Docker end of it - the hijacked exec socket - has no automated exercise,
 * since a test environment has no daemon. Off by default keeps the shipped
 * behaviour byte-identical until it has earned real exposure.
 */
describe('tunnelEnabled', () => {
	it('is off unless explicitly turned on', () => {
		for (const env of [{}, { HEZO_TUNNEL: '' }, { HEZO_TUNNEL: '0' }, { HEZO_TUNNEL: 'true' }]) {
			expect(tunnelEnabled(env as NodeJS.ProcessEnv)).toBe(false);
		}
	});

	it('is on for exactly "1"', () => {
		expect(tunnelEnabled({ HEZO_TUNNEL: '1' } as NodeJS.ProcessEnv)).toBe(true);
	});
});

describe('run endpoints', () => {
	it('names the host directly on the Docker path', () => {
		const endpoints = dockerRunEndpoints(3100);
		expect(endpoints.hezoBaseUrl).toBe('http://host.docker.internal:3100');
		expect(endpoints.proxyHost).toBe('host.docker.internal');
		expect(endpoints.sshHost).toBe('host.docker.internal');
	});

	it('names no host at all on the tunnel path', () => {
		// This is the property that makes a container off this machine work: it
		// dials its own loopback, where the tunnel client is listening, and the
		// host is never addressed.
		const endpoints = tunnelRunEndpoints();
		expect(endpoints.proxyHost).toBe('127.0.0.1');
		expect(endpoints.sshHost).toBe('127.0.0.1');
		expect(endpoints.hezoBaseUrl).toBe(`http://127.0.0.1:${TUNNEL_PORTS.mcp}`);
		expect(JSON.stringify(endpoints)).not.toContain('docker');
	});

	it('gives each target key its own port, so the client can tell them apart', () => {
		const ports = Object.values(TUNNEL_PORTS);
		expect(new Set(ports).size).toBe(ports.length);
	});
});
