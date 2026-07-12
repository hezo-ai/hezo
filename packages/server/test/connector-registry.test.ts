import { describe, expect, it } from 'vitest';
import {
	buildConnectorRecipesSkill,
	CONNECTOR_RECIPES_SLUG,
	isConnectorRecipesSlug,
	resolveConnectorRegistry,
} from '../src/services/connector-registry';

describe('connector registry', () => {
	it('resolveConnectorRegistry validates the bundled JSON with zod', () => {
		// Throws on malformed data — reaching here means the real file passed the schema.
		const registry = resolveConnectorRegistry();
		expect(registry.patterns.length).toBeGreaterThanOrEqual(6);
		expect(registry.services.length).toBeGreaterThanOrEqual(15);
		expect(registry.oauthProviders.length).toBeGreaterThanOrEqual(1);
	});

	it('returns a cached, stable instance', () => {
		expect(resolveConnectorRegistry()).toBe(resolveConnectorRegistry());
	});

	it('includes the required Google/YouTube device-flow provider', () => {
		const google = resolveConnectorRegistry().oauthProviders.find((p) => p.id === 'google-youtube');
		expect(google).toBeDefined();
		expect(google?.device_code_url).toBe('https://oauth2.googleapis.com/device/code');
		expect(google?.token_url).toBe('https://oauth2.googleapis.com/token');
		expect(google?.scopes).toContain('https://www.googleapis.com/auth/youtube');
		expect(google?.client_type).toBe('TVs and Limited Input devices');
		expect(google?.allowed_hosts).toEqual(
			expect.arrayContaining(['*.googleapis.com', 'oauth2.googleapis.com']),
		);
	});

	it('includes a read-only YouTube recipe that uses a plain API key, not OAuth', () => {
		const yt = resolveConnectorRegistry().services.find((s) =>
			s.service.startsWith('YouTube Data API'),
		);
		expect(yt).toBeDefined();
		expect(yt?.transport).toBe('api');
		// A single api_key credential (no oauth_token) — this is the light path.
		expect(yt?.credentials).toHaveLength(1);
		expect(yt?.credentials[0]).toMatchObject({ name: 'YOUTUBE_API_KEY', kind: 'api_key' });
		expect(yt?.credentials[0].allowed_hosts).toContain('*.googleapis.com');
		// The notes steer read-only use to the query-param key and reserve OAuth for writes.
		expect(yt?.notes).toMatch(/api key/i);
		expect(yt?.notes).toMatch(/query/i);
		expect(yt?.notes).toMatch(/upload|user-scoped/i);
	});

	it('every service credential names a known kind and the transport is mcp|api', () => {
		const kinds = new Set([
			'api_key',
			'oauth_token',
			'github_pat',
			'webhook_secret',
			'ssh_private_key',
			'other',
		]);
		for (const s of resolveConnectorRegistry().services) {
			expect(['mcp', 'api']).toContain(s.transport);
			for (const cred of s.credentials) expect(kinds.has(cred.kind)).toBe(true);
		}
	});
});

describe('buildConnectorRecipesSkill', () => {
	const skill = buildConnectorRecipesSkill();

	it('produces the reserved slug/name/description', () => {
		expect(skill.slug).toBe(CONNECTOR_RECIPES_SLUG);
		expect(skill.name).toBe('Connector Recipes');
		expect(skill.description.length).toBeGreaterThan(0);
	});

	it('renders a non-empty body with patterns, services, and the Google provider block', () => {
		expect(skill.content.length).toBeGreaterThan(200);
		expect(skill.content).toContain('## Connection patterns');
		// A known pattern id from the registry.
		expect(skill.content).toContain('(mcp-hosted)');
		expect(skill.content).toContain('## Service recipes');
		// The Google/YouTube provider block renders with its device-flow URL.
		expect(skill.content).toContain('## OAuth providers');
		expect(skill.content).toContain('### google-youtube');
		expect(skill.content).toContain('https://oauth2.googleapis.com/device/code');
		// Positive framing: no blocklist copy.
		expect(skill.content.toLowerCase()).not.toContain("don't use");
	});
});

describe('isConnectorRecipesSlug', () => {
	it('matches the reserved slug and its case/spacing variants, rejects others', () => {
		expect(isConnectorRecipesSlug('connector-recipes')).toBe(true);
		expect(isConnectorRecipesSlug('Connector Recipes')).toBe(true);
		expect(isConnectorRecipesSlug('Connector-Recipes')).toBe(true);
		expect(isConnectorRecipesSlug('my-skill')).toBe(false);
		expect(isConnectorRecipesSlug('')).toBe(false);
		expect(isConnectorRecipesSlug(null)).toBe(false);
	});
});
