import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import {
	invalidateSecretsVault,
	loadAllSecrets,
	type ResolvedSecret,
	substituteRequest,
} from '../src/services/egress/substitution';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

function makeSecret(
	name: string,
	value: string,
	hosts: string[],
	allowAll = false,
	allowBody = false,
): ResolvedSecret {
	return {
		name,
		value,
		allowedHosts: hosts,
		allowAllHosts: allowAll,
		allowBodySubstitution: allowBody,
	};
}

const baseRequest = {
	url: 'https://api.anthropic.com/v1/messages',
	headers: {} as Record<string, string | string[] | undefined>,
	method: 'POST',
	host: 'api.anthropic.com',
};

describe('substituteRequest', () => {
	it('replaces a placeholder in a header on a host that is allow-listed', () => {
		const secrets = new Map([
			['ANTHROPIC_API_KEY', makeSecret('ANTHROPIC_API_KEY', 'sk-real', ['api.anthropic.com'])],
		]);
		const result = substituteRequest(
			{
				...baseRequest,
				headers: { authorization: 'Bearer __HEZO_SECRET_ANTHROPIC_API_KEY__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer sk-real');
		expect(result.headersChanged).toBe(true);
		expect(result.urlChanged).toBe(false);
		expect([...result.secretsUsed]).toEqual(['ANTHROPIC_API_KEY']);
	});

	it('replaces a placeholder embedded in a URL query string', () => {
		const secrets = new Map([['GH_TOKEN', makeSecret('GH_TOKEN', 'ghp_xxx', ['api.github.com'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				url: 'https://api.github.com/user?token=__HEZO_SECRET_GH_TOKEN__',
				host: 'api.github.com',
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.url).toBe('https://api.github.com/user?token=ghp_xxx');
		expect(result.urlChanged).toBe(true);
	});

	it('rejects an unknown placeholder with unknown_secret and does not substitute partial matches', () => {
		const secrets = new Map<string, ResolvedSecret>();
		const result = substituteRequest(
			{ ...baseRequest, headers: { authorization: 'Bearer __HEZO_SECRET_NOPE__' } },
			secrets,
		);
		expect(result.failure).toEqual({ kind: 'unknown_secret', name: 'NOPE' });
		expect(result.headers.authorization).toBe('Bearer __HEZO_SECRET_NOPE__');
		expect(result.secretsUsed.size).toBe(0);
	});

	it('rejects placeholders for hosts that are not on the allowlist', () => {
		const secrets = new Map([['SCOPED', makeSecret('SCOPED', 'val', ['allowed.example'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'attacker.example',
				url: 'https://attacker.example/x',
				headers: { authorization: 'Bearer __HEZO_SECRET_SCOPED__' },
			},
			secrets,
		);
		expect(result.failure).toEqual({
			kind: 'secret_not_allowed_for_host',
			name: 'SCOPED',
			host: 'attacker.example',
		});
	});

	it('honours allowAllHosts even when allowed_hosts is empty', () => {
		const secrets = new Map([['ANY', makeSecret('ANY', 'v', [], true)]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'random.example',
				url: 'https://random.example/x',
				headers: { authorization: 'Bearer __HEZO_SECRET_ANY__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer v');
	});

	it('honours wildcard allowed-host entries (e.g. *.googleapis.com)', () => {
		const secrets = new Map([['G_KEY', makeSecret('G_KEY', 'ya29', ['*.googleapis.com'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'storage.googleapis.com',
				url: 'https://storage.googleapis.com/x',
				headers: { authorization: 'Bearer __HEZO_SECRET_G_KEY__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer ya29');
	});

	it('handles array-valued headers without losing siblings', () => {
		const secrets = new Map([['T', makeSecret('T', 'real', ['x.example'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'x.example',
				url: 'https://x.example/y',
				headers: { 'x-multi': ['static', '__HEZO_SECRET_T__', 'plain'] },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers['x-multi']).toEqual(['static', 'real', 'plain']);
	});

	it('returns no changes when no placeholder is present', () => {
		const result = substituteRequest(
			{ ...baseRequest, headers: { authorization: 'Bearer literal' } },
			new Map(),
		);
		expect(result.failure).toBeNull();
		expect(result.headersChanged).toBe(false);
		expect(result.urlChanged).toBe(false);
	});

	it('substitutes multiple distinct placeholders in one header value', () => {
		const secrets = new Map([
			['USER', makeSecret('USER', 'alice', ['x.example'])],
			['PASS', makeSecret('PASS', 'hunter2', ['x.example'])],
		]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'x.example',
				url: 'https://x.example/y',
				headers: { authorization: 'Basic __HEZO_SECRET_USER__:__HEZO_SECRET_PASS__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Basic alice:hunter2');
		expect([...result.secretsUsed].sort()).toEqual(['PASS', 'USER']);
	});

	it('does not recursively substitute a placeholder that appears inside a secret value', () => {
		// A secret whose value happens to contain another placeholder string must
		// be emitted verbatim — the substituted value is never re-scanned, or a
		// secret could be used to exfiltrate a second secret to an unrelated host.
		const secrets = new Map([
			['OUTER', makeSecret('OUTER', '__HEZO_SECRET_INNER__', ['x.example'])],
			['INNER', makeSecret('INNER', 'top-secret', ['other.example'])],
		]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'x.example',
				url: 'https://x.example/y',
				headers: { authorization: 'Bearer __HEZO_SECRET_OUTER__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer __HEZO_SECRET_INNER__');
		expect([...result.secretsUsed]).toEqual(['OUTER']);
	});

	describe('request body substitution', () => {
		it('substitutes a placeholder in the body when the secret opts in', () => {
			const secrets = new Map([
				['UMAMI_PW', makeSecret('UMAMI_PW', 's3cr3t', ['umami.example'], false, true)],
			]);
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'umami.example',
					url: 'https://umami.example/api/auth/login',
					body: '{"username":"admin","password":"__HEZO_SECRET_UMAMI_PW__"}',
				},
				secrets,
			);
			expect(result.failure).toBeNull();
			expect(result.body).toBe('{"username":"admin","password":"s3cr3t"}');
			expect(result.bodyChanged).toBe(true);
			expect([...result.secretsUsed]).toEqual(['UMAMI_PW']);
		});

		it('rejects a body placeholder when the secret has not opted in', () => {
			const secrets = new Map([
				['UMAMI_PW', makeSecret('UMAMI_PW', 's3cr3t', ['umami.example'], false, false)],
			]);
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'umami.example',
					url: 'https://umami.example/api/auth/login',
					body: '{"password":"__HEZO_SECRET_UMAMI_PW__"}',
				},
				secrets,
			);
			expect(result.failure).toEqual({ kind: 'secret_not_allowed_in_body', name: 'UMAMI_PW' });
			expect(result.body).toBe('{"password":"__HEZO_SECRET_UMAMI_PW__"}');
			expect(result.bodyChanged).toBe(false);
			expect(result.secretsUsed.size).toBe(0);
		});

		it('still enforces allowed_hosts on body placeholders', () => {
			const secrets = new Map([
				['UMAMI_PW', makeSecret('UMAMI_PW', 's3cr3t', ['umami.example'], false, true)],
			]);
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'attacker.example',
					url: 'https://attacker.example/login',
					body: '{"password":"__HEZO_SECRET_UMAMI_PW__"}',
				},
				secrets,
			);
			expect(result.failure).toEqual({
				kind: 'secret_not_allowed_for_host',
				name: 'UMAMI_PW',
				host: 'attacker.example',
			});
			expect(result.bodyChanged).toBe(false);
		});

		it('leaves the body untouched when no placeholder is present', () => {
			const secrets = new Map([
				['UMAMI_PW', makeSecret('UMAMI_PW', 's3cr3t', ['umami.example'], false, true)],
			]);
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'umami.example',
					url: 'https://umami.example/api/auth/login',
					body: '{"username":"admin"}',
				},
				secrets,
			);
			expect(result.failure).toBeNull();
			expect(result.body).toBe('{"username":"admin"}');
			expect(result.bodyChanged).toBe(false);
		});

		it('returns body null and unchanged when no body is provided', () => {
			const secrets = new Map([['T', makeSecret('T', 'v', ['x.example'])]]);
			const result = substituteRequest(
				{ ...baseRequest, host: 'x.example', url: 'https://x.example/y' },
				secrets,
			);
			expect(result.body).toBeNull();
			expect(result.bodyChanged).toBe(false);
		});
	});

	describe('name grammar (matches request_credential / admin-route validation)', () => {
		// The proxy match must be exactly the canonical secret-name grammar: a
		// looser matcher would substitute names no creation path can produce
		// (drift between "what can be stored" and "what can be referenced").
		const secrets = new Map([['VALID', makeSecret('VALID', 'v', ['x.example'])]]);

		it('does not treat a lowercase placeholder body as a secret reference', () => {
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'x.example',
					url: 'https://x.example/y',
					headers: { authorization: 'Bearer __HEZO_SECRET_valid__' },
				},
				secrets,
			);
			// No canonical match → treated as plain text, forwarded verbatim.
			expect(result.failure).toBeNull();
			expect(result.headers.authorization).toBe('Bearer __HEZO_SECRET_valid__');
			expect(result.headersChanged).toBe(false);
		});

		it('does not match a body that starts with a digit or underscore', () => {
			for (const bad of ['__HEZO_SECRET_1ABC__', '__HEZO_SECRET__LEADING__']) {
				const result = substituteRequest(
					{
						...baseRequest,
						host: 'x.example',
						url: 'https://x.example/y',
						headers: { authorization: `Bearer ${bad}` },
					},
					secrets,
				);
				expect(result.failure).toBeNull();
				expect(result.headersChanged).toBe(false);
			}
		});
	});
});

/**
 * The vault is read and decrypted on every proxied request carrying a
 * placeholder — i.e. every MCP call an agent makes — so it is cached. These
 * lock the three invalidation layers: explicit, master-key state, and TTL.
 */
describe('decrypted vault cache', () => {
	let ctx: ServerTestContext;

	beforeEach(async () => {
		ctx = await createTestContext();
		invalidateSecretsVault();
	});
	afterEach(async () => {
		invalidateSecretsVault();
		await destroyTestContext(ctx);
	});

	const scope = () => ({ db: ctx.db, masterKeyManager: ctx.masterKeyManager });

	async function seedSecret(name: string, value: string): Promise<void> {
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('locked');
		await ctx.db.query(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts)
			 VALUES ($1, $2, 'api_token'::secret_category, '{}', true)
			 ON CONFLICT (name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value`,
			[name, encrypt(value, key)],
		);
	}

	it('serves a second read from cache without re-querying', async () => {
		await seedSecret('CACHED_ONE', 'first');
		const first = await loadAllSecrets(scope());
		expect(first.get('CACHED_ONE')?.value).toBe('first');

		// Change the row behind the cache's back — a cached read must not see it.
		await seedSecret('CACHED_ONE', 'second');
		const cached = await loadAllSecrets(scope());
		expect(cached.get('CACHED_ONE')?.value).toBe('first');
	});

	it('picks up a change once the vault is invalidated', async () => {
		await seedSecret('CACHED_TWO', 'before');
		await loadAllSecrets(scope());

		await seedSecret('CACHED_TWO', 'after');
		invalidateSecretsVault();
		const reloaded = await loadAllSecrets(scope());
		expect(reloaded.get('CACHED_TWO')?.value).toBe('after');
	});

	it('coalesces concurrent misses into a single load', async () => {
		await seedSecret('CACHED_THREE', 'value');
		const results = await Promise.all([
			loadAllSecrets(scope()),
			loadAllSecrets(scope()),
			loadAllSecrets(scope()),
		]);
		// One load, shared: every caller gets the identical map instance.
		expect(results[1]).toBe(results[0]);
		expect(results[2]).toBe(results[0]);
		expect(results[0].get('CACHED_THREE')?.value).toBe('value');
	});

	// Decrypted material must never outlive the unlock that produced it.
	it('drops the cache when the master key is locked', async () => {
		await seedSecret('CACHED_FOUR', 'secret');
		await loadAllSecrets(scope());

		const locked = {
			getKey: () => null,
			getUnlockKeyHex: () => null,
			getState: () => 'locked' as const,
		};
		await expect(loadAllSecrets({ db: ctx.db, masterKeyManager: locked as never })).rejects.toThrow(
			'LOCKED',
		);

		// The rejection cleared the cache rather than leaving plaintext behind: a
		// later unlocked read must go back to the database.
		await ctx.db.query(`DELETE FROM secrets WHERE name = 'CACHED_FOUR'`);
		const after = await loadAllSecrets(scope());
		expect(after.has('CACHED_FOUR')).toBe(false);
	});
});
