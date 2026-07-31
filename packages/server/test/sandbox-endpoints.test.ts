import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DOCKER_CONTAINER_HOST_ALIAS,
	DOCKER_HOST_GATEWAY_ENTRY,
	tunnelRunEndpoints,
} from '../src/services/sandbox/endpoints';

const PORTS = { proxy: 47080, mcp: 47081, ssh: 47082 };

describe('tunnelRunEndpoints', () => {
	it('builds the origin a container actually reaches Hezo on', () => {
		const e = tunnelRunEndpoints(PORTS);
		// Must be an absolute http origin with no trailing slash: callers append
		// '/mcp' and already-rooted signed asset paths straight onto it.
		expect(e.hezoBaseUrl).toBe('http://127.0.0.1:47081');
		expect(`${e.hezoBaseUrl}/mcp`).toBe('http://127.0.0.1:47081/mcp');
		expect(`${e.hezoBaseUrl}/assets/x?sig=y`).toBe('http://127.0.0.1:47081/assets/x?sig=y');
	});

	it('gives the proxy and ssh legs a bare host and its own port', () => {
		const e = tunnelRunEndpoints(PORTS);
		// These are handed to a TCP dialer and to the socat bridge argv, which
		// take host and port separately - a scheme here would be dialled verbatim.
		expect(e.proxyHost).toBe('127.0.0.1');
		expect(e.sshHost).toBe('127.0.0.1');
		expect(e.proxyHost).not.toContain('://');
		expect(e.sshHost).not.toContain('://');
		expect(e.proxyPort).toBe(PORTS.proxy);
		expect(e.sshPort).toBe(PORTS.ssh);
	});

	it('never names the host, on any leg', () => {
		// The whole reason there is one answer rather than two: naming the host
		// works only while the container is on this machine, so a leg that did it
		// would be a leg only a local daemon could serve.
		expect(JSON.stringify(tunnelRunEndpoints(PORTS))).not.toContain(DOCKER_CONTAINER_HOST_ALIAS);
	});

	it('keeps the local-model-provider alias and its ExtraHosts entry in lockstep', () => {
		// The alias carries no Hezo leg any more - it survives only so an operator
		// can point a local model provider at their own machine, and it resolves
		// only because containers are created with this ExtraHosts entry.
		expect(DOCKER_HOST_GATEWAY_ENTRY).toBe(`${DOCKER_CONTAINER_HOST_ALIAS}:host-gateway`);
	});
});

/** Source lines with `//` and `*` comment lines stripped, so prose does not trip the scan. */
function codeLines(source: string): string[] {
	return source
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith('.ts')) out.push(full);
	}
	return out;
}

describe('container host address has one home', () => {
	it('is not spelled literally anywhere else in server source', () => {
		const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
		const seam = join(srcRoot, 'services', 'sandbox', 'endpoints.ts');

		const offenders: string[] = [];
		for (const file of walk(srcRoot)) {
			if (file === seam) continue;
			for (const line of codeLines(readFileSync(file, 'utf-8'))) {
				if (line.includes('host.docker.internal')) {
					offenders.push(`${file.slice(srcRoot.length + 1)}: ${line}`);
				}
			}
		}

		// A container reaches Hezo over three legs - MCP plus signed asset URLs,
		// the egress proxy, and the ssh-agent bridge - and they all broke together
		// when the address changed, which is exactly what a non-local container
		// does. They all go through the tunnel now; the alias that remains is for
		// operator-configured local model providers, and it lives in the seam.
		expect(offenders).toEqual([]);
	});
});
