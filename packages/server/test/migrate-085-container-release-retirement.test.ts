import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '085_container_release_retirement.sql';

/**
 * The migration adds the chat-release stamp a pool member carries and the index
 * the ledger's overlap guard reads. Neither may disturb what is already there:
 * a member's state and release clock decide which container is retired next,
 * and an uptime interval is a billed hour.
 */
describe('085_container_release_retirement migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;
	let releasedAt: Date;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			['team-release-retire'],
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, 'release-retire', 'RRT'],
		);
		projectId = project.rows[0].id;
		releasedAt = new Date(Date.now() - 30 * 60 * 1000);

		await h.db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, last_released_at)
			 VALUES ($1, 'ctr-idle', 'idle', $2), ($1, 'ctr-suspended', 'suspended', $2)`,
			[projectId, releasedAt],
		);
		await h.db.query(
			`INSERT INTO container_uptime_entries
			   (project_id, container_id, started_at, ended_at, end_reason, backend)
			 VALUES ($1, 'ctr-suspended', now() - interval '2 hours', now() - interval '1 hour', 'stopped', 'docker'),
			        ($1, 'ctr-idle', now() - interval '20 minutes', NULL, NULL, 'docker')`,
			[projectId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves every pool member, its state and its release clock', async () => {
		const rows = await h.db.query<{
			container_id: string;
			state: string;
			last_released_at: Date;
			chat_released_at: Date | null;
		}>(
			`SELECT container_id, state::text AS state, last_released_at, chat_released_at
			   FROM container_pool_members WHERE project_id = $1 ORDER BY container_id`,
			[projectId],
		);
		expect(rows.rows.map((r) => [r.container_id, r.state])).toEqual([
			['ctr-idle', 'idle'],
			['ctr-suspended', 'suspended'],
		]);
		for (const row of rows.rows) {
			expect(new Date(row.last_released_at).getTime()).toBeCloseTo(releasedAt.getTime(), -3);
			// No chat has released either member yet, so neither is held warm for one.
			expect(row.chat_released_at).toBeNull();
		}
	});

	it('preserves every uptime interval, open and closed', async () => {
		const rows = await h.db.query<{
			container_id: string;
			open: boolean;
			end_reason: string | null;
		}>(
			`SELECT container_id, ended_at IS NULL AS open, end_reason
			   FROM container_uptime_entries WHERE project_id = $1 ORDER BY container_id`,
			[projectId],
		);
		expect(rows.rows).toEqual([
			{ container_id: 'ctr-idle', open: true, end_reason: null },
			{ container_id: 'ctr-suspended', open: false, end_reason: 'stopped' },
		]);
	});

	it('records a chat release on a member', async () => {
		const updated = await h.db.query<{ chat_released_at: Date }>(
			`UPDATE container_pool_members SET chat_released_at = now()
			  WHERE container_id = 'ctr-idle' RETURNING chat_released_at`,
		);
		expect(updated.rows[0].chat_released_at).not.toBeNull();
	});

	it('indexes the chat-release lookup and the ledger overlap guard', async () => {
		const idx = await h.db.query<{ indexname: string; indexdef: string }>(
			`SELECT indexname, indexdef FROM pg_indexes
			  WHERE indexname IN ('idx_container_pool_members_chat_release',
			                      'idx_container_uptime_container_end')
			  ORDER BY indexname`,
		);
		expect(idx.rows.map((r) => r.indexname)).toEqual([
			'idx_container_pool_members_chat_release',
			'idx_container_uptime_container_end',
		]);
		expect(idx.rows[0].indexdef).toContain('chat_released_at');
		expect(idx.rows[1].indexdef).toContain('ended_at');
	});
});
