import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '080_provider_usage_hold.sql';

describe('080_provider_usage_hold migration', () => {
	let h: DataPreservationHarness;
	let configId: string;
	let wakeupId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0]?.id ?? '';
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0]?.id ?? '';

		const config = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs
			   (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('openai', 'subscription', 'OpenAI', 'ciphertext', true, 'verified', 'gpt-5-codex')
			 RETURNING id`,
		);
		configId = config.rows[0]?.id ?? '';

		// A wakeup handed back under the previous cooldown scheme, which keyed on the
		// skip reason and its timestamp alone.
		const wakeup = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests
			   (member_id, team_id, source, status, payload, last_skipped_reason, last_skipped_at)
			 VALUES ($1, $2, 'heartbeat', 'queued', $3::jsonb, 'provider_usage_limit', now())
			 RETURNING id`,
			[memberId, teamId, JSON.stringify({ task_id: '00000000-0000-0000-0000-000000000001' })],
		);
		wakeupId = wakeup.rows[0]?.id ?? '';

		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('adds the two nullable hold columns', async () => {
		const cols = await h.db.query<{ table_name: string; column_name: string; is_nullable: string }>(
			`SELECT table_name, column_name, is_nullable FROM information_schema.columns
			 WHERE (table_name = 'ai_provider_configs' AND column_name = 'usage_limited_until')
			    OR (table_name = 'agent_wakeup_requests' AND column_name = 'not_before')
			 ORDER BY table_name`,
		);
		expect(cols.rows).toEqual([
			{ table_name: 'agent_wakeup_requests', column_name: 'not_before', is_nullable: 'YES' },
			{ table_name: 'ai_provider_configs', column_name: 'usage_limited_until', is_nullable: 'YES' },
		]);
	});

	it('preserves the credential row and starts it with no hold', async () => {
		const row = await h.db.query<{
			label: string;
			status: string;
			is_default: boolean;
			default_model: string;
			encrypted_credential: string;
			usage_limited_until: Date | null;
		}>(
			`SELECT label, status, is_default, default_model, encrypted_credential, usage_limited_until
			 FROM ai_provider_configs WHERE id = $1`,
			[configId],
		);
		expect(row.rows[0]).toEqual({
			label: 'OpenAI',
			status: 'verified',
			is_default: true,
			default_model: 'gpt-5-codex',
			encrypted_credential: 'ciphertext',
			usage_limited_until: null,
		});
	});

	it('preserves a queued wakeup and leaves it claimable', async () => {
		const row = await h.db.query<{
			status: string;
			last_skipped_reason: string;
			payload: Record<string, unknown>;
			not_before: Date | null;
		}>(
			`SELECT status, last_skipped_reason, payload, not_before
			 FROM agent_wakeup_requests WHERE id = $1`,
			[wakeupId],
		);
		expect(row.rows[0]?.status).toBe('queued');
		expect(row.rows[0]?.last_skipped_reason).toBe('provider_usage_limit');
		expect(row.rows[0]?.payload).toEqual({ task_id: '00000000-0000-0000-0000-000000000001' });
		expect(row.rows[0]?.not_before).toBeNull();
	});

	it('stores a hold time on both tables', async () => {
		const until = '2026-09-20T10:50:00.000Z';
		await h.db.query(`UPDATE ai_provider_configs SET usage_limited_until = $1 WHERE id = $2`, [
			until,
			configId,
		]);
		await h.db.query(`UPDATE agent_wakeup_requests SET not_before = $1 WHERE id = $2`, [
			until,
			wakeupId,
		]);
		const read = await h.db.query<{ a: Date; b: Date }>(
			`SELECT c.usage_limited_until AS a, w.not_before AS b
			 FROM ai_provider_configs c, agent_wakeup_requests w
			 WHERE c.id = $1 AND w.id = $2`,
			[configId, wakeupId],
		);
		expect(new Date(read.rows[0]?.a ?? 0).toISOString()).toBe(until);
		expect(new Date(read.rows[0]?.b ?? 0).toISOString()).toBe(until);
	});
});
