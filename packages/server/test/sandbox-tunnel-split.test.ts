import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { McpDescriptor } from '../src/services/mcp-injectors/types';
import {
	buildTunnelHostPolicy,
	hostNeedsProxy,
	type TunnelHostPolicy,
} from '../src/services/sandbox/tunnel/split-routing';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;

beforeAll(async () => {
	({ db } = await createTestApp());
});
afterAll(async () => {
	await safeClose(db);
});
beforeEach(async () => {
	await db.query('DELETE FROM secrets');
});

async function seedSecret(name: string, allowedHosts: string[], allowAll = false): Promise<void> {
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, allowed_hosts, allow_all_hosts)
		 VALUES ($1, 'enc', $2, $3)`,
		[name, allowedHosts, allowAll],
	);
}

const http = (url: string): McpDescriptor => ({ kind: 'http', name: 'c', url });

/**
 * The list decides which requests reach the MITM proxy and which go straight
 * out. Getting it *too narrow* is a security gap - a host that needed a policy
 * check would skip it - so these lean on the two sources being present, not on
 * the list being short.
 */
describe('buildTunnelHostPolicy', () => {
	it('collects every secret’s allowed hosts', async () => {
		await seedSecret('a', ['api.github.com']);
		await seedSecret('b', ['api.linear.app', 'api.github.com']);
		const policy = await buildTunnelHostPolicy(db, []);
		expect(policy.proxiedHosts).toEqual(['api.github.com', 'api.linear.app']);
		expect(policy.proxyEverything).toBe(false);
	});

	it('includes connector MCP hosts even when no secret names them', async () => {
		// The per-connector method allowlist is enforced at the proxy, so a
		// connector host routed directly would silently skip its policy check.
		const policy = await buildTunnelHostPolicy(db, [http('https://mcp.linear.app/sse')]);
		expect(policy.proxiedHosts).toContain('mcp.linear.app');
	});

	it('ignores stdio descriptors, which have no host to route', async () => {
		const policy = await buildTunnelHostPolicy(db, [
			{ kind: 'stdio', name: 'local', command: 'node', args: [] },
		]);
		expect(policy.proxiedHosts).toEqual([]);
	});

	it('normalizes case and whitespace so DNS-equal hosts dedupe', async () => {
		await seedSecret('a', ['API.GitHub.com', '  api.github.com  ']);
		expect((await buildTunnelHostPolicy(db, [])).proxiedHosts).toEqual(['api.github.com']);
	});

	it('drops empty host entries rather than emitting a match-nothing rule', async () => {
		await seedSecret('a', ['', '   ', 'api.github.com']);
		expect((await buildTunnelHostPolicy(db, [])).proxiedHosts).toEqual(['api.github.com']);
	});

	it('routes everything through the proxy when any secret allows all hosts', async () => {
		// Secrets are instance-global, so one such secret forces every run on the
		// instance to proxy everything. That is the argument for keeping
		// request_credential's explicit-hosts requirement, not for special-casing.
		await seedSecret('scoped', ['api.github.com']);
		await seedSecret('wide', [], true);
		const policy = await buildTunnelHostPolicy(db, [http('https://mcp.linear.app/sse')]);
		expect(policy.proxyEverything).toBe(true);
		expect(hostNeedsProxy(policy, 'registry.npmjs.org')).toBe(true);
	});

	it('proxies nothing when the vault is empty', async () => {
		const policy = await buildTunnelHostPolicy(db, []);
		expect(policy.proxiedHosts).toEqual([]);
		// A host in no secret's allowed_hosts would have been rejected by the
		// proxy anyway, so sending it direct changes nothing but the byte path.
		expect(hostNeedsProxy(policy, 'registry.npmjs.org')).toBe(false);
	});

	it('never contains a secret value', async () => {
		await seedSecret('token', ['api.github.com']);
		const policy = await buildTunnelHostPolicy(db, []);
		expect(JSON.stringify(policy)).not.toContain('enc');
	});
});

describe('hostNeedsProxy', () => {
	const policy = (hosts: string[]): TunnelHostPolicy => ({
		proxiedHosts: hosts,
		proxyEverything: false,
	});

	it('matches an exact host and nothing near it', () => {
		const p = policy(['api.github.com']);
		expect(hostNeedsProxy(p, 'api.github.com')).toBe(true);
		expect(hostNeedsProxy(p, 'evil-api.github.com')).toBe(false);
		expect(hostNeedsProxy(p, 'api.github.com.evil.test')).toBe(false);
		expect(hostNeedsProxy(p, 'github.com')).toBe(false);
	});

	it('matches a leading-dot entry on the domain and its subdomains', () => {
		const p = policy(['.github.com']);
		expect(hostNeedsProxy(p, 'github.com')).toBe(true);
		expect(hostNeedsProxy(p, 'api.github.com')).toBe(true);
		expect(hostNeedsProxy(p, 'notgithub.com')).toBe(false);
	});

	it('is case-insensitive, since DNS is', () => {
		expect(hostNeedsProxy(policy(['api.github.com']), 'API.GitHub.COM')).toBe(true);
	});
});
