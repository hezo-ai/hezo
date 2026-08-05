import { describe, expect, it } from 'vitest';
import {
	isBlockedEgressAddress,
	isBlockedEgressHost,
	isSelfEndpoint,
} from '../src/services/egress/net-guard';

/**
 * The egress proxy runs in the *host's* network namespace and dials whatever an
 * authenticated caller names, so without this guard an agent holding the run's
 * proxy token could `CONNECT 127.0.0.1:5432` and reach Hezo's own database, its
 * API, or any host-bound daemon. `NO_PROXY` is a client-side hint the agent
 * controls, not an enforcement point.
 */
describe('isBlockedEgressAddress', () => {
	it('blocks loopback, unspecified, private, link-local and CGNAT IPv4', () => {
		for (const addr of [
			'127.0.0.1',
			'127.1.2.3',
			'0.0.0.0',
			'10.0.0.5',
			'172.16.0.1',
			'172.31.255.254',
			'192.168.1.1',
			'169.254.169.254', // cloud instance metadata
			'100.64.0.1',
		]) {
			expect(isBlockedEgressAddress(addr), addr).toBe(true);
		}
	});

	it('allows ordinary public IPv4, including near-miss neighbours of private ranges', () => {
		for (const addr of [
			'1.1.1.1',
			'8.8.8.8',
			'172.15.0.1', // just below the 172.16/12 block
			'172.32.0.1', // just above it
			'192.169.1.1',
			'100.128.0.1', // just above the CGNAT block
			'11.0.0.1',
		]) {
			expect(isBlockedEgressAddress(addr), addr).toBe(false);
		}
	});

	it('blocks IPv6 loopback, unspecified, link-local and unique-local', () => {
		for (const addr of ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1']) {
			expect(isBlockedEgressAddress(addr), addr).toBe(true);
		}
	});

	it('blocks IPv4-mapped IPv6 forms rather than waving them through', () => {
		// The bypass this exists to prevent: ::ffff:127.0.0.1 is loopback wearing
		// an IPv6 costume, and a naive family check would let it past.
		expect(isBlockedEgressAddress('::ffff:127.0.0.1')).toBe(true);
		expect(isBlockedEgressAddress('::ffff:10.0.0.1')).toBe(true);
		expect(isBlockedEgressAddress('::ffff:8.8.8.8')).toBe(false);
	});

	it('allows ordinary public IPv6', () => {
		expect(isBlockedEgressAddress('2606:4700:4700::1111')).toBe(false);
	});

	it('treats a non-address as not-an-address rather than guessing', () => {
		// A hostname is undecidable here; it is caught on the upstream leg by the
		// guarded DNS lookup, which sees what it actually resolves to.
		expect(isBlockedEgressAddress('api.stripe.com')).toBe(false);
		expect(isBlockedEgressAddress('')).toBe(false);
	});
});

describe('isBlockedEgressHost', () => {
	it('blocks IP-literal CONNECT targets in blocked ranges', () => {
		expect(isBlockedEgressHost('127.0.0.1')).toBe(true);
		expect(isBlockedEgressHost('192.168.0.10')).toBe(true);
		expect(isBlockedEgressHost('[::1]')).toBe(true);
	});

	it('blocks the loopback hostnames', () => {
		expect(isBlockedEgressHost('localhost')).toBe(true);
		expect(isBlockedEgressHost('LOCALHOST')).toBe(true);
		expect(isBlockedEgressHost('localhost.')).toBe(true);
		expect(isBlockedEgressHost('foo.localhost')).toBe(true);
	});

	it('lets a normal hostname through to the resolution-time check', () => {
		expect(isBlockedEgressHost('api.stripe.com')).toBe(false);
		expect(isBlockedEgressHost('mcp.example.com')).toBe(false);
		// Not a loopback name despite the substring — suffix matching must be on a
		// label boundary, or `notlocalhost.com` would be wrongly refused.
		expect(isBlockedEgressHost('notlocalhost.com')).toBe(false);
	});
});

describe('isSelfEndpoint', () => {
	const self = { host: 'host.docker.internal', port: 3100 };

	it('matches Hezo own endpoint on its exact host and port', () => {
		expect(isSelfEndpoint('host.docker.internal', 3100, self)).toBe(true);
		expect(isSelfEndpoint('HOST.DOCKER.INTERNAL', 3100, self)).toBe(true);
		expect(isSelfEndpoint('host.docker.internal.', 3100, self)).toBe(true);
	});

	it('does not match the same host on another port', () => {
		// The port is what keeps this from becoming a general host pass: naming the
		// same host at 5432 must still be refused.
		expect(isSelfEndpoint('host.docker.internal', 5432, self)).toBe(false);
		expect(isSelfEndpoint('host.docker.internal', 3101, self)).toBe(false);
	});

	it('does not match another host on the same port', () => {
		expect(isSelfEndpoint('127.0.0.1', 3100, self)).toBe(false);
		expect(isSelfEndpoint('evil.example.com', 3100, self)).toBe(false);
	});

	it('matches nothing when no self endpoint is configured', () => {
		expect(isSelfEndpoint('host.docker.internal', 3100, null)).toBe(false);
	});
});
