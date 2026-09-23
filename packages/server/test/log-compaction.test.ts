import { RunLogPassKind, RunLogPassPhase, RunLogRewriteFailureReason } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { appendRunLogChunks, readRunLogText } from '../src/db/run-log-chunks';
import { waitForBackground } from '../src/lib/background';
import { deleteSystemMeta, getSystemMeta, setSystemMeta } from '../src/lib/system-meta';
import {
	compactRunLogsBatch,
	computeCompactedLog,
	getActiveCompaction,
	getCompactionEstimate,
	getDatabaseUsage,
	getLastCompaction,
	LOG_COMPACTION_ACTIVE_KEY,
	LOG_COMPACTION_LAST_KEY,
	runLogCompactionTick,
	startCompaction,
	startSpaceReclaim,
} from '../src/services/log-compaction';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

// A large, poorly-compressible log so its stored (pg_column_size) size clears
// the ~2KB TOAST threshold the compaction filter uses. A run of repeated 'x'
// would compress below it and never be selected.
function bigLog(): string {
	let s = '';
	let x = 987654321;
	while (s.length < 80 * 1024) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		s += `${x.toString(36)} agent streaming output line with some varied entropy\n`;
	}
	return `${s}\nSUMMARY: did the thing.\n[done] succeeded turns=5 duration=1000ms tokens=100/200`;
}

describe('computeCompactedLog', () => {
	it('leaves a short log unchanged', () => {
		const log = 'short run\n[done] succeeded';
		expect(computeCompactedLog(log, { preservedBytes: 1024 })).toBe(log);
	});

	it('trims a long log to its tail, keeping a compacted notice + the command', () => {
		const log = `${'noise line\n'.repeat(5000)}FINAL SUMMARY\n[done] succeeded`;
		const out = computeCompactedLog(log, {
			preservedBytes: 200,
			invocationCommand: 'claude -p --model opus',
		});
		expect(out.length).toBeLessThan(log.length);
		expect(out).toContain('THIS RUN LOG HAS BEEN COMPACTED');
		expect(out).toContain('$ claude -p --model opus');
		// The meaningful tail (summary + done line) survives.
		expect(out).toContain('FINAL SUMMARY');
		expect(out).toContain('[done] succeeded');
	});

	it('never grows a log even with a long command', () => {
		const log = `${'x'.repeat(300)}\n[done]`;
		const out = computeCompactedLog(log, {
			preservedBytes: 250,
			invocationCommand: 'a'.repeat(500),
		});
		expect(out.length).toBeLessThanOrEqual(log.length);
	});
});

describe('run-log compaction — service + routes', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let db: Db;
	let teamId: string;
	let memberId: string;
	const runIds: Record<string, string> = {};

	async function seedRun(
		key: string,
		opts: { ageDays: number; log: string; status?: string; command?: string; compacted?: boolean },
	): Promise<void> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, invocation_command, created_at, finished_at, log_compacted_at)
			 VALUES ($1, $2, $3::heartbeat_run_status, $4,
			         now() - ($5 || ' days')::interval, now() - ($5 || ' days')::interval,
			         CASE WHEN $6 THEN now() ELSE NULL END)
			 RETURNING id`,
			[
				teamId,
				memberId,
				opts.status ?? 'succeeded',
				opts.command ?? 'claude -p',
				String(opts.ageDays),
				opts.compacted ?? false,
			],
		);
		runIds[key] = r.rows[0].id;
		await appendRunLogChunks(db, r.rows[0].id, opts.log);
	}

	beforeAll(async () => {
		ctx = await createTestApp();
		db = ctx.db;
		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Compaction', 'compaction') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;

		await seedRun('oldBig', { ageDays: 60, log: bigLog() });
		await seedRun('oldSmall', { ageDays: 60, log: 'tiny old log\n[done] succeeded' });
		await seedRun('recentBig', { ageDays: 1, log: bigLog() });
		await seedRun('oldRunning', { ageDays: 60, log: bigLog(), status: 'running' });
		await seedRun('oldCompacted', { ageDays: 60, log: bigLog(), compacted: true });
	});

	afterAll(async () => {
		await safeClose(db);
	});

	/** A table's current file. A rewrite (`VACUUM FULL`) always gives it a new one. */
	async function fileNode(table: string): Promise<number> {
		const r = await db.query<{ n: number }>(
			'SELECT pg_relation_filenode($1::regclass)::bigint AS n',
			[table],
		);
		return Number(r.rows[0].n);
	}

	it('reports database usage without scanning/detoasting failing', async () => {
		const usage = await getDatabaseUsage(db, 'embedded');
		expect(usage.run_count).toBeGreaterThanOrEqual(5);
		expect(usage.run_log_bytes).toBeGreaterThan(0);
		expect(usage.database_bytes).toBeGreaterThan(0);
		expect((await getDatabaseUsage(db, 'external')).database_bytes).toBeNull();
	});

	it('estimates only old, large, terminal, uncompacted runs as compactable', async () => {
		const est = await getCompactionEstimate(db, 30);
		// Only oldBig qualifies (oldSmall is below TOAST size, recentBig is inside
		// the window, oldRunning is non-terminal, oldCompacted is already done).
		expect(est.runCount).toBe(1);
		expect(est.freeBytes).toBeGreaterThanOrEqual(0);
	});

	it('compacts the old large run and leaves the others intact', async () => {
		const beforeLen = (await readRunLogText(db, runIds.oldBig)).length;
		const { processed, bytesReclaimed } = await compactRunLogsBatch(db, { olderThanDays: 30 });
		expect(processed).toBe(1);
		expect(bytesReclaimed).toBeGreaterThan(0);

		const oldBig = await db.query<{ log_compacted_at: string | null }>(
			`SELECT log_compacted_at FROM heartbeat_runs WHERE id = $1`,
			[runIds.oldBig],
		);
		const compactedText = await readRunLogText(db, runIds.oldBig);
		expect(oldBig.rows[0].log_compacted_at).not.toBeNull();
		expect(compactedText).toContain('THIS RUN LOG HAS BEEN COMPACTED');
		expect(compactedText).toContain('$ claude -p');
		expect(compactedText.length).toBeLessThan(beforeLen);

		// The run's chunks were replaced by a single compacted chunk.
		const chunks = await db.query<{ seq: number }>(
			'SELECT seq FROM heartbeat_run_log_chunks WHERE run_id = $1',
			[runIds.oldBig],
		);
		expect(chunks.rows).toHaveLength(1);
		expect(chunks.rows[0].seq).toBe(0);

		// The recent run's log is untouched.
		const recent = await db.query<{ log_compacted_at: string | null }>(
			`SELECT log_compacted_at FROM heartbeat_runs WHERE id = $1`,
			[runIds.recentBig],
		);
		expect(recent.rows[0].log_compacted_at).toBeNull();

		// Idempotent: nothing left older than the window.
		const again = await compactRunLogsBatch(db, { olderThanDays: 30 });
		expect(again.processed).toBe(0);
	});

	it('an embedded compaction pass ends by rewriting both tables', async () => {
		await seedRun('oldBigEmbedded', { ageDays: 45, log: bigLog() });
		const files = [await fileNode('heartbeat_run_log_chunks'), await fileNode('heartbeat_runs')];
		await startCompaction(db, { olderThanDays: 30 });
		expect(await getActiveCompaction(db)).not.toBeNull();

		await runLogCompactionTick(db, { backend: 'embedded' });

		expect(await getActiveCompaction(db)).toBeNull();
		const last = await getLastCompaction(db, 'embedded');
		expect(last).toMatchObject({
			kind: RunLogPassKind.Compact,
			older_than_days: 30,
			processed: 1,
			rewrite_failure: null,
		});
		if (last?.kind !== RunLogPassKind.Compact) throw new Error('expected a compaction record');
		// Two separate numbers: the text trimmed, and the disk the rewrite freed.
		expect(last.trimmed_bytes).toBeGreaterThan(0);
		expect(typeof last.disk_bytes_freed).toBe('number');
		expect(await fileNode('heartbeat_run_log_chunks')).not.toBe(files[0]);
		expect(await fileNode('heartbeat_runs')).not.toBe(files[1]);
	});

	it('an external compaction pass trims logs but leaves the tables unrewritten', async () => {
		await seedRun('oldBigExternal', { ageDays: 45, log: bigLog() });
		const file = await fileNode('heartbeat_run_log_chunks');
		await startCompaction(db, { olderThanDays: 30 });

		await runLogCompactionTick(db, { backend: 'external' });

		expect(await getActiveCompaction(db)).toBeNull();
		const last = await getLastCompaction(db, 'external');
		expect(last).toMatchObject({
			kind: RunLogPassKind.Compact,
			processed: 1,
			disk_bytes_freed: null,
			rewrite_failure: null,
		});
		if (last?.kind !== RunLogPassKind.Compact) throw new Error('expected a compaction record');
		expect(last.trimmed_bytes).toBeGreaterThan(0);
		expect(await fileNode('heartbeat_run_log_chunks')).toBe(file);
		expect((await readRunLogText(db, runIds.oldBigExternal)).length).toBeLessThan(bigLog().length);
	});

	it('reads a marker and a last record written before reclaim passes existed', async () => {
		await setSystemMeta(
			db,
			LOG_COMPACTION_ACTIVE_KEY,
			JSON.stringify({
				started_at: '2026-01-01T00:00:00.000Z',
				older_than_days: 30,
				total: 10,
				processed: 4,
				bytes_reclaimed: 5000,
			}),
		);
		expect(await getActiveCompaction(db)).toEqual({
			kind: RunLogPassKind.Compact,
			phase: RunLogPassPhase.Trimming,
			started_at: '2026-01-01T00:00:00.000Z',
			older_than_days: 30,
			total: 10,
			processed: 4,
			trimmed_bytes: 5000,
			usage_before_rewrite: null,
		});
		await deleteSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY);

		const saved = await getSystemMeta(db, LOG_COMPACTION_LAST_KEY);
		await setSystemMeta(
			db,
			LOG_COMPACTION_LAST_KEY,
			JSON.stringify({
				finished_at: '2026-01-02T00:00:00.000Z',
				older_than_days: 30,
				processed: 1206,
				bytes_reclaimed: 2_000_000_000,
			}),
		);
		// The one old number was the rewrite's disk figure on the embedded
		// backend, and the trimmed text on external Postgres, which never rewrote.
		expect(await getLastCompaction(db, 'embedded')).toMatchObject({
			trimmed_bytes: null,
			disk_bytes_freed: 2_000_000_000,
		});
		expect(await getLastCompaction(db, 'external')).toMatchObject({
			trimmed_bytes: 2_000_000_000,
			disk_bytes_freed: null,
		});
		if (saved) await setSystemMeta(db, LOG_COMPACTION_LAST_KEY, saved);
	});

	it('a rewrite Postgres refuses is recorded, and the pass still ends', async () => {
		// The real database, except that every VACUUM fails the way a full disk does.
		const refusing: Db = {
			kind: db.kind,
			query: (sql, params) =>
				sql.startsWith('VACUUM')
					? Promise.reject(new Error('could not extend file: No space left on device'))
					: db.query(sql, params),
			exec: (sql) => db.exec(sql),
			transaction: (cb) => db.transaction(cb),
			close: () => db.close(),
		};
		await startSpaceReclaim(db, { backend: 'embedded' });

		await runLogCompactionTick(refusing, { backend: 'embedded' });

		expect(await getActiveCompaction(db)).toBeNull();
		expect(await getLastCompaction(db, 'embedded')).toMatchObject({
			kind: RunLogPassKind.Reclaim,
			rewrite_failure: {
				reason: RunLogRewriteFailureReason.Failed,
				table: 'heartbeat_run_log_chunks',
				message: 'could not extend file: No space left on device',
			},
		});
	});

	it('GET run-log-usage returns the usage shape for a superuser', async () => {
		const res = await ctx.app.request('/api/database-info/run-log-usage?older_than_days=30', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: Record<string, unknown> };
		expect(data.backend).toBe('embedded');
		expect(typeof data.run_log_bytes).toBe('number');
		expect(typeof data.free_bytes).toBe('number');
		expect(data.older_than_days).toBe(30);
		expect(data.compaction).toBeNull();
	});

	it('while a rewrite runs, run-log-usage serves the figures read before it', async () => {
		// Reading the tables' sizes would wait for the rewrite's lock, so the
		// snapshot stands in; it is never sent to the page itself.
		await setSystemMeta(
			db,
			LOG_COMPACTION_ACTIVE_KEY,
			JSON.stringify({
				kind: RunLogPassKind.Reclaim,
				phase: RunLogPassPhase.Rewriting,
				started_at: new Date().toISOString(),
				usage_before_rewrite: { database_bytes: 900, run_log_bytes: 700, run_count: 3 },
			}),
		);
		try {
			const res = await ctx.app.request('/api/database-info/run-log-usage', {
				headers: authHeader(ctx.token),
			});
			const { data } = (await res.json()) as { data: Record<string, unknown> };
			expect(data).toMatchObject({
				database_bytes: 900,
				run_log_bytes: 700,
				run_count: 3,
				free_bytes: 0,
				compaction: { kind: RunLogPassKind.Reclaim, phase: RunLogPassPhase.Rewriting },
			});
			expect(data.compaction).not.toHaveProperty('usage_before_rewrite');
		} finally {
			await deleteSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY);
		}
	});

	it('POST reclaim-run-log-space rewrites both tables and records the result', async () => {
		const files = [await fileNode('heartbeat_run_log_chunks'), await fileNode('heartbeat_runs')];
		const res = await ctx.app.request('/api/database-info/reclaim-run-log-space', {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(201);
		const { data } = (await res.json()) as { data: Record<string, unknown> };
		expect(data).toMatchObject({ kind: RunLogPassKind.Reclaim, phase: RunLogPassPhase.Rewriting });
		expect(data).not.toHaveProperty('usage_before_rewrite');

		// The route kicks the drain in the background; wait for it.
		await waitForBackground();

		expect(await getActiveCompaction(db)).toBeNull();
		const last = await getLastCompaction(db, 'embedded');
		expect(last).toMatchObject({ kind: RunLogPassKind.Reclaim, rewrite_failure: null });
		expect(typeof last?.disk_bytes_freed).toBe('number');
		expect(await fileNode('heartbeat_run_log_chunks')).not.toBe(files[0]);
		expect(await fileNode('heartbeat_runs')).not.toBe(files[1]);
	});

	it('POST compact-run-logs and reclaim-run-log-space 409 while a pass is active', async () => {
		// Seed the active marker directly so the check is deterministic (a real
		// kicked pass drains asynchronously and would race this assertion).
		await setSystemMeta(
			db,
			LOG_COMPACTION_ACTIVE_KEY,
			JSON.stringify({
				kind: RunLogPassKind.Compact,
				phase: RunLogPassPhase.Trimming,
				started_at: new Date().toISOString(),
				older_than_days: 30,
				total: 1,
				processed: 0,
				trimmed_bytes: 0,
				usage_before_rewrite: null,
			}),
		);
		try {
			const compact = await ctx.app.request('/api/database-info/compact-run-logs', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ older_than_days: 30 }),
			});
			expect(compact.status).toBe(409);
			const reclaim = await ctx.app.request('/api/database-info/reclaim-run-log-space', {
				method: 'POST',
				headers: authHeader(ctx.token),
			});
			expect(reclaim.status).toBe(409);
		} finally {
			await deleteSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY);
		}
	});

	it('POST compact-run-logs starts a pass and clamps the window', async () => {
		await seedRun('oldBig2', { ageDays: 90, log: bigLog() });
		const res = await ctx.app.request('/api/database-info/compact-run-logs', {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ older_than_days: 100000 }), // clamps to the max
		});
		expect(res.status).toBe(201);
		const { data } = (await res.json()) as { data: { older_than_days: number } };
		expect(data.older_than_days).toBe(365);
		await waitForBackground();
	});

	it('run-log-usage requires a superuser', async () => {
		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const { signAdminJwt } = await import('../src/middleware/auth');
		const memberToken = await signAdminJwt(ctx.masterKeyManager, nonSuper.rows[0].id);
		const res = await ctx.app.request('/api/database-info/run-log-usage', {
			headers: authHeader(memberToken),
		});
		expect(res.status).toBe(403);
		const reclaim = await ctx.app.request('/api/database-info/reclaim-run-log-space', {
			method: 'POST',
			headers: authHeader(memberToken),
		});
		expect(reclaim.status).toBe(403);
	});
});

/**
 * Run logs are the user's history: an instance may deliberately keep all of it.
 * Compaction is therefore an explicit control on the global Storage settings
 * page, and no scheduled path may start a pass on its own. This locks that in -
 * the cron exists only to *drain* a pass an operator already started.
 */
describe('compaction stays operator-triggered', () => {
	it('the cron drains nothing until an operator marks a pass active', async () => {
		const db = await createTestDbWithMigrations();
		try {
			// A run old and large enough to be a compaction candidate.
			const team = await db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ('Retention', 'retention') RETURNING id`,
			);
			const member = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'agent', 'Worker') RETURNING id`,
				[team.rows[0].id],
			);
			const run = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (team_id, member_id, status, created_at)
				 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now() - interval '400 days')
				 RETURNING id`,
				[team.rows[0].id, member.rows[0].id],
			);
			await appendRunLogChunks(db, run.rows[0].id, 'x'.repeat(200_000));

			// No active marker => the scheduled tick is a no-op and the log is intact.
			expect(await getActiveCompaction(db)).toBeNull();
			await runLogCompactionTick(db, { backend: 'embedded' });
			expect(await getActiveCompaction(db)).toBeNull();

			const after = await readRunLogText(db, run.rows[0].id);
			expect(after.length).toBe(200_000);
			const marker = await db.query<{ log_compacted_at: string | null }>(
				'SELECT log_compacted_at FROM heartbeat_runs WHERE id = $1',
				[run.rows[0].id],
			);
			expect(marker.rows[0].log_compacted_at).toBeNull();
		} finally {
			await safeClose(db);
		}
	});
});
