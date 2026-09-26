import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { DEFAULT_MODEL_BACKFILL_META_KEY } from '../src/db/migrations/code/082_allowance_pacing';
import { storeAiProviderKey } from '../src/services/ai-provider-keys';
import {
	CREDENTIAL_MODEL_UNLISTED_COMMENT_KIND,
	checkCredentialModelsForRelease,
	DEFAULT_MODEL_BACKFILL_COMMENT_KIND,
	postDefaultModelBackfillNotice,
} from '../src/services/credential-model-notices';
import { HEZO_VERSION } from '../src/version';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	await safeClose(db);
});

async function notices(kind: string) {
	const r = await db.query<{ content: Record<string, unknown>; assignee_id: string | null }>(
		`SELECT tc.content, t.assignee_id FROM task_comments tc JOIN tasks t ON t.id = tc.task_id
		  WHERE tc.content->>'kind' = $1`,
		[kind],
	);
	return r.rows;
}

describe('postDefaultModelBackfillNotice', () => {
	it('posts the models the upgrade set, once, on an unassigned HQ task', async () => {
		await db.query('INSERT INTO system_meta (key, value) VALUES ($1, $2)', [
			DEFAULT_MODEL_BACKFILL_META_KEY,
			JSON.stringify([
				{ label: 'OpenAI', provider: 'openai', model: 'gpt-5.6-sol' },
				{ label: 'Local', provider: 'ollama', model: null },
			]),
		]);

		await postDefaultModelBackfillNotice(db, undefined);
		// A second boot finds no record and posts nothing.
		await postDefaultModelBackfillNotice(db, undefined);

		const rows = await notices(DEFAULT_MODEL_BACKFILL_COMMENT_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].assignee_id).toBeNull();
		expect(rows[0].content.text).toContain('OpenAI (openai): gpt-5.6-sol');
		expect(rows[0].content.text).toContain('Local (ollama): needs a model chosen');
	});
});

describe('checkCredentialModelsForRelease', () => {
	beforeEach(async () => {
		await db.query('DELETE FROM ai_provider_configs');
		await db.query(`DELETE FROM system_meta WHERE key = 'credential_model_check_release'`);
		await db.query(`DELETE FROM task_comments WHERE content->>'kind' = $1`, [
			CREDENTIAL_MODEL_UNLISTED_COMMENT_KIND,
		]);
	});

	const listing = (ids: string[]) =>
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ data: ids.map((id) => ({ id })) }),
		}) as unknown as typeof fetch;

	const verified = async (label: string, model: string) => {
		const id = await storeAiProviderKey(
			db,
			masterKeyManager,
			'anthropic',
			'sk-ant-check',
			'api_key',
			label,
			{},
			null,
			model,
		);
		await db.query(`UPDATE ai_provider_configs SET status = 'verified' WHERE id = $1`, [id]);
	};

	it('tells the admin about a model its provider no longer offers, once per release', async () => {
		await verified('Kept', 'claude-opus-5');
		await verified('Retired', 'claude-opus-4-1');
		globalThis.fetch = listing(['claude-opus-5', 'claude-opus-5-5']);

		await checkCredentialModelsForRelease({ db, masterKeyManager });
		await checkCredentialModelsForRelease({ db, masterKeyManager });

		const rows = await notices(CREDENTIAL_MODEL_UNLISTED_COMMENT_KIND);
		expect(rows).toHaveLength(1);
		expect(rows[0].content.text).toContain('Retired (anthropic): claude-opus-4-1');
		expect(rows[0].content.text).not.toContain('Kept');
		const done = await db.query<{ value: string }>(
			`SELECT value FROM system_meta WHERE key = 'credential_model_check_release'`,
		);
		expect(done.rows[0]?.value).toBe(HEZO_VERSION);
	});

	it('posts nothing and checks again next start when a list cannot be read', async () => {
		await verified('Unreachable', 'claude-opus-4-1');
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

		await checkCredentialModelsForRelease({ db, masterKeyManager });

		expect(await notices(CREDENTIAL_MODEL_UNLISTED_COMMENT_KIND)).toHaveLength(0);
		const done = await db.query(
			`SELECT 1 FROM system_meta WHERE key = 'credential_model_check_release'`,
		);
		expect(done.rows).toHaveLength(0);
	});
});
