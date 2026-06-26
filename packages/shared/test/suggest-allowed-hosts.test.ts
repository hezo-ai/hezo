import { describe, expect, it } from 'vitest';
import { suggestAllowedHosts } from '../src/credentials/suggest-allowed-hosts.js';

describe('suggestAllowedHosts', () => {
	it('extracts the host from a URL named in the instructions', () => {
		const hosts = suggestAllowedHosts({
			name: 'UMAMI_INSTANCE_URL',
			instructions: 'Use the self-hosted instance at https://umami.hezo.ai or similar.',
		});
		expect(hosts).toContain('umami.hezo.ai');
	});

	it('strips the path, query, and port from an instruction URL', () => {
		const hosts = suggestAllowedHosts({
			name: 'API_BASE',
			instructions: 'Base URL: https://app.acme.io:8443/v2/path?token=x#frag',
		});
		expect(hosts).toContain('app.acme.io');
		expect(hosts).not.toContain('app.acme.io:8443');
	});

	it('maps a well-known service from the credential name', () => {
		expect(suggestAllowedHosts({ name: 'NETLIFY_AUTH_TOKEN' })).toEqual(['api.netlify.com']);
		expect(suggestAllowedHosts({ name: 'STRIPE_SECRET_KEY' })).toEqual(['api.stripe.com']);
	});

	it('maps a well-known service mentioned only in the instructions', () => {
		const hosts = suggestAllowedHosts({
			name: 'DEPLOY_TOKEN',
			instructions: 'Create a personal token from the Vercel dashboard.',
		});
		expect(hosts).toContain('api.vercel.com');
	});

	it('falls back to the connector registry for its service ids', () => {
		const hosts = suggestAllowedHosts({ name: 'LINEAR_API_KEY' });
		expect(hosts).toContain('api.linear.app');
	});

	it('puts URL-derived hosts before known-service hosts and de-dupes', () => {
		const hosts = suggestAllowedHosts({
			name: 'NETLIFY_TOKEN',
			instructions: 'See https://app.netlify.com/account and https://app.netlify.com/teams',
		});
		expect(hosts[0]).toBe('app.netlify.com'); // URL host first
		expect(hosts).toContain('api.netlify.com'); // known-service host after
		// de-duped: app.netlify.com appears once despite two URLs
		expect(hosts.filter((h) => h === 'app.netlify.com')).toHaveLength(1);
	});

	it('drops generic placeholder and loopback hosts', () => {
		const hosts = suggestAllowedHosts({
			name: 'SOME_KEY',
			instructions: 'e.g. https://example.com or http://localhost:3000 or http://127.0.0.1:8080',
		});
		expect(hosts).toEqual([]);
	});

	it('lowercases hosts', () => {
		const hosts = suggestAllowedHosts({
			name: 'X',
			instructions: 'Endpoint: https://API.Example.IO/health',
		});
		expect(hosts).toContain('api.example.io');
	});

	it('returns an empty array when nothing matches', () => {
		expect(suggestAllowedHosts({ name: 'GENERIC_SECRET', instructions: 'paste it here' })).toEqual(
			[],
		);
	});

	it('handles missing name and instructions', () => {
		expect(suggestAllowedHosts({})).toEqual([]);
	});

	it('caps the number of suggestions', () => {
		const instructions = Array.from({ length: 12 }, (_, i) => `https://h${i}.example.io/x`).join(
			' ',
		);
		expect(suggestAllowedHosts({ name: 'X', instructions }).length).toBeLessThanOrEqual(6);
	});
});
