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
	describe('a credential git base64s into a Basic header', () => {
		// Measured, not assumed: `git ls-remote https://x-access-token:__HEZO_SECRET_X__@host/…`
		// puts the credential on the wire as
		// `Basic eC1hY2Nlc3MtdG9rZW46X19IRVpPX1NFQ1JFVF9YX18=`. A literal scan finds
		// nothing there, so before this every clone, fetch and push shipped the
		// unsubstituted placeholder as its password and GitHub refused it.
		const gh = () =>
			new Map([
				[
					'GH_TOKEN',
					makeSecret('GH_TOKEN', 'ghs_realtoken', ['github.com', 'codeload.github.com']),
				],
			]);
		const basic = (text: string) => `Basic ${Buffer.from(text, 'utf8').toString('base64')}`;
		const decode = (header: string) =>
			Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8');

		it('decodes, substitutes and re-encodes', () => {
			const result = substituteRequest(
				{
					...baseRequest,
					url: 'https://github.com/acme/widgets.git/info/refs',
					host: 'github.com',
					headers: { authorization: basic('x-access-token:__HEZO_SECRET_GH_TOKEN__') },
				},
				gh(),
			);
			expect(result.headersChanged).toBe(true);
			expect(decode(result.headers.authorization as string)).toBe('x-access-token:ghs_realtoken');
			expect(result.secretsUsed.has('GH_TOKEN')).toBe(true);
			expect(result.failure).toBeNull();
			// The real value never appears in the header verbatim - it is encoded.
			expect(result.headers.authorization).not.toContain('ghs_realtoken');
		});

		it('applies the same allowed_hosts gate as any other substitution', () => {
			// Nothing about being inside base64 relaxes the red line.
			const result = substituteRequest(
				{
					...baseRequest,
					url: 'https://evil.example.com/x',
					host: 'evil.example.com',
					headers: { authorization: basic('x-access-token:__HEZO_SECRET_GH_TOKEN__') },
				},
				gh(),
			);
			expect(result.failure).toEqual({
				kind: 'secret_not_allowed_for_host',
				name: 'GH_TOKEN',
				host: 'evil.example.com',
			});
			expect(decode(result.headers.authorization as string)).toContain('__HEZO_SECRET_GH_TOKEN__');
		});

		it('leaves a Basic credential carrying no placeholder byte-identical', () => {
			// Re-encoding one that never needed substituting would corrupt a
			// credential that was already correct.
			const header = basic('user:hunter2');
			const result = substituteRequest(
				{ ...baseRequest, host: 'github.com', headers: { authorization: header } },
				gh(),
			);
			expect(result.headers.authorization).toBe(header);
			expect(result.headersChanged).toBe(false);
		});

		it('leaves a Bearer token on the ordinary literal path', () => {
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'github.com',
					headers: { authorization: 'Bearer __HEZO_SECRET_GH_TOKEN__' },
				},
				gh(),
			);
			expect(result.headers.authorization).toBe('Bearer ghs_realtoken');
		});

		it('passes a malformed Basic value through rather than throwing', () => {
			const header = 'Basic not-valid-base64!!';
			const result = substituteRequest(
				{ ...baseRequest, host: 'github.com', headers: { authorization: header } },
				gh(),
			);
			expect(result.headers.authorization).toBe(header);
		});
	});

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
			expect(result.failure).toEqual({
				kind: 'secret_not_allowed_in_body',
				name: 'UMAMI_PW',
				deliveredElsewhere: false,
			});
			expect(result.body).toBe('{"password":"__HEZO_SECRET_UMAMI_PW__"}');
			expect(result.bodyChanged).toBe(false);
			expect(result.secretsUsed.size).toBe(0);
		});

		// The MCP shape: the connector's credential rides the Authorization header
		// the runtime configured, and the same placeholder turns up in the tool-call
		// arguments because the agent is writing that literal text somewhere. The
		// credential is already on the wire, so the body occurrence is content.
		it('reports a body placeholder as already delivered when the header carried it', () => {
			const secrets = new Map([
				['MCP_GITHUB', makeSecret('MCP_GITHUB', 'gho_real', ['api.githubcopilot.com'])],
			]);
			const result = substituteRequest(
				{
					...baseRequest,
					host: 'api.githubcopilot.com',
					url: 'https://api.githubcopilot.com/mcp/',
					headers: { authorization: 'Bearer __HEZO_SECRET_MCP_GITHUB__' },
					body: '{"method":"tools/call","params":{"arguments":{"body":"__HEZO_SECRET_MCP_GITHUB__"}}}',
				},
				secrets,
			);
			expect(result.failure).toEqual({
				kind: 'secret_not_allowed_in_body',
				name: 'MCP_GITHUB',
				deliveredElsewhere: true,
			});
			// The header pass still ran and still counted, so the discriminator is a
			// fact about this request rather than a guess about the payload.
			expect(result.headers.authorization).toBe('Bearer gho_real');
			expect([...result.secretsUsed]).toEqual(['MCP_GITHUB']);
			expect(result.bodyChanged).toBe(false);
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
