import { AiAuthMethod, AiProvider, AiProviderStatus } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	casMarkAiProviderInvalid,
	storeAiProviderKey,
	updateAiProviderCredential,
} from '../src/services/ai-provider-keys';
import { condemnRejectedProviderCredential } from '../src/services/provider-credential-health';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

/**
 * What happens to a stored credential after the provider refuses it.
 *
 * The two things worth proving are both about NOT acting: a probe that cannot
 * show the credential is dead leaves it alone, and a condemnation aimed at a
 * credential the operator has since replaced hits nothing. Either failure takes
 * a working credential out of service instance-wide, which is worse than the
 * stale badge this whole path exists to fix.
 */

let db: Db;
let masterKeyManager: MasterKeyManager;
const originalFetch = globalThis.fetch;

const TOKEN = 'sk-ant-oat01-the-one-the-run-used';

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

beforeEach(async () => {
	await db.query('DELETE FROM ai_provider_configs');
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	await safeClose(db);
});

async function storeSubscription(value = TOKEN): Promise<string> {
	return storeAiProviderKey(
		db,
		masterKeyManager,
		AiProvider.Anthropic,
		value,
		AiAuthMethod.Subscription,
		`sub-${Math.random().toString(36).slice(2, 10)}`,
	);
}

async function statusOf(configId: string): Promise<string> {
	const row = await db.query<{ status: string }>(
		'SELECT status FROM ai_provider_configs WHERE id = $1',
		[configId],
	);
	return row.rows[0].status;
}

function respondWith(status: number): void {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue({ ok: status >= 200 && status < 300, status }) as unknown as typeof fetch;
}

describe('casMarkAiProviderInvalid', () => {
	it('marks the config invalid when it still holds the condemned credential', async () => {
		const configId = await storeSubscription();

		const wrote = await casMarkAiProviderInvalid(db, masterKeyManager, configId, TOKEN);

		expect(wrote).toBe(true);
		expect(await statusOf(configId)).toBe(AiProviderStatus.Invalid);
	});

	it('leaves a replaced credential alone', async () => {
		const configId = await storeSubscription();
		// The operator pasted a fresh token while the run that is about to condemn
		// the old one was still in flight.
		await updateAiProviderCredential(db, masterKeyManager, configId, 'sk-ant-oat01-freshly-pasted');

		const wrote = await casMarkAiProviderInvalid(db, masterKeyManager, configId, TOKEN);

		expect(wrote).toBe(false);
		expect(await statusOf(configId)).toBe(AiProviderStatus.Verified);
	});

	it('does not rewrite a row that is already invalid', async () => {
		const configId = await storeSubscription();
		expect(await casMarkAiProviderInvalid(db, masterKeyManager, configId, TOKEN)).toBe(true);

		// A burst of runs all failing on one dead token must not each spend a write:
		// the embedded database does not vacuum, so a no-op update is leaked storage.
		expect(await casMarkAiProviderInvalid(db, masterKeyManager, configId, TOKEN)).toBe(false);
	});

	it('reports no write for a config that is gone', async () => {
		const wrote = await casMarkAiProviderInvalid(
			db,
			masterKeyManager,
			'00000000-0000-0000-0000-000000000000',
			TOKEN,
		);
		expect(wrote).toBe(false);
	});
});

describe('condemnRejectedProviderCredential', () => {
	const credential = {
		value: TOKEN,
		authMethod: AiAuthMethod.Subscription,
		baseUrl: null,
	};

	it('condemns a credential the provider rejects', async () => {
		const configId = await storeSubscription();
		respondWith(401);

		const outcome = await condemnRejectedProviderCredential(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			{ configId, ...credential },
		);

		expect(outcome).toBe('condemned');
		expect(await statusOf(configId)).toBe(AiProviderStatus.Invalid);
	});

	it('sends the subscription token as a bearer, never as an api key', async () => {
		const configId = await storeSubscription();
		const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 });
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		await condemnRejectedProviderCredential(db, masterKeyManager, AiProvider.Anthropic, {
			configId,
			...credential,
		});

		// On `x-api-key` an OAuth token is refused whatever its state, so probing
		// that way would condemn every subscription credential it was pointed at.
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers['x-api-key']).toBeUndefined();
	});

	it.each([
		['a server error', 500],
		['a rate limit', 429],
		['an accepted request', 200],
	])('leaves the credential alone on %s', async (_label, status) => {
		const configId = await storeSubscription();
		respondWith(status);

		const outcome = await condemnRejectedProviderCredential(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			{ configId, ...credential },
		);

		expect(outcome).toBe('not_proven');
		expect(await statusOf(configId)).toBe(AiProviderStatus.Verified);
	});

	it('leaves the credential alone when the provider cannot be reached', async () => {
		const configId = await storeSubscription();
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

		const outcome = await condemnRejectedProviderCredential(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			{ configId, ...credential },
		);

		// A network blip is not a verdict on the credential. Condemning here would
		// take every team's runs down for the duration of an outage.
		expect(outcome).toBe('not_proven');
		expect(await statusOf(configId)).toBe(AiProviderStatus.Verified);
	});

	it('does not condemn a credential replaced while the run was in flight', async () => {
		const configId = await storeSubscription();
		await updateAiProviderCredential(db, masterKeyManager, configId, 'sk-ant-oat01-freshly-pasted');
		respondWith(401);

		const outcome = await condemnRejectedProviderCredential(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			{ configId, ...credential },
		);

		expect(outcome).toBe('superseded');
		expect(await statusOf(configId)).toBe(AiProviderStatus.Verified);
	});

	it('reports not_proven for a provider whose subscription cannot be probed', async () => {
		// Codex's subscription credential is a JSON auth file, not a bearer, so its
		// table entry carries no `subscriptionHeaders` and there is nothing to ask.
		// An absent row must read as "cannot prove it", never as a rejection.
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'{"tokens":{"refresh_token":"r"}}',
			AiAuthMethod.Subscription,
			'codex-sub',
		);
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const outcome = await condemnRejectedProviderCredential(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			{
				configId,
				value: '{"tokens":{"refresh_token":"r"}}',
				authMethod: AiAuthMethod.Subscription,
				baseUrl: null,
			},
		);

		expect(outcome).toBe('not_proven');
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await statusOf(configId)).toBe(AiProviderStatus.Verified);
	});
});
