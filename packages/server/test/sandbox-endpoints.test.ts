import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DOCKER_CONTAINER_HOST_ALIAS,
	DOCKER_HOST_GATEWAY_ENTRY,
	dockerRunEndpoints,
} from '../src/services/sandbox/endpoints';

describe('dockerRunEndpoints', () => {
	it('builds the origin a container actually reaches Hezo on', () => {
		const e = dockerRunEndpoints(3100);
		// Must be an absolute http origin with no trailing slash: callers append
		// '/mcp' and already-rooted signed asset paths straight onto it.
		expect(e.hezoBaseUrl).toBe('http://host.docker.internal:3100');
		expect(`${e.hezoBaseUrl}/mcp`).toBe('http://host.docker.internal:3100/mcp');
		expect(`${e.hezoBaseUrl}/assets/x?sig=y`).toBe(
			'http://host.docker.internal:3100/assets/x?sig=y',
		);
	});

	it('gives the proxy and ssh legs a bare host, not a URL', () => {
		const e = dockerRunEndpoints(3100);
		// These are handed to a TCP dialer and to the socat bridge argv, which
		// take host and port separately - a scheme here would be dialled verbatim.
		expect(e.proxyHost).toBe(DOCKER_CONTAINER_HOST_ALIAS);
		expect(e.sshHost).toBe(DOCKER_CONTAINER_HOST_ALIAS);
		expect(e.proxyHost).not.toContain('://');
		expect(e.sshHost).not.toContain('://');
	});

	it('keeps the alias and its ExtraHosts entry in lockstep', () => {
		// The alias only resolves because containers are created with this
		// ExtraHosts entry. Changing one without the other leaves every
		// container-to-host callback pointing at a name that does not resolve,
		// which is the failure this pairing exists to prevent.
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

		// A run reaches Hezo over four legs - MCP, signed asset URLs, the egress
		// proxy and the ssh-agent bridge - and they all break together when the
		// address changes, which is exactly what a non-local container does. The
		// point of the seam is that the address is stated once; a new literal
		// silently opts that call site out of ever being switchable.
		expect(offenders).toEqual([]);
	});
});
