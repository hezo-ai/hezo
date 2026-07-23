import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { appendRunLogChunks, readRunLogText } from '../src/db/run-log-chunks';
import { deleteSystemMeta, setSystemMeta } from '../src/lib/system-meta';
import {
	compactRunLogsBatch,
	computeCompactedLog,
	getActiveCompaction,
	getCompactionEstimate,
	getDatabaseUsage,
	getLastCompaction,
	LOG_COMPACTION_ACTIVE_KEY,
	reclaimRunLogSpace,
	runLogCompactionTick,
	startCompaction,
} from '../src/services/log-compaction';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

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
	return `${s}\nSUMMARY: did the thing.\n[done] succeeded turns=5 duration=1000ms tokens=100/200 cost=$0.01`;
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

	it('reports database usage without scanning/detoasting failing', async () => {
		const usage = await getDatabaseUsage(db, 'embedded');
		expect(usage.runCount).toBeGreaterThanOrEqual(5);
		expect(usage.runLogDiskBytes).toBeGreaterThan(0);
		expect(usage.databaseBytes).toBeGreaterThan(0);
	});

	it('estimates only old, large, terminal, uncompacted runs as compactable', async () => {
		const est = await getCompactionEstimate(db, 'embedded', 30);
		// Only oldBig qualifies (oldSmall is below TOAST size, recentBig is inside
		// the window, oldRunning is non-terminal, oldCompacted is already done).
		expect(est.runCount).toBe(1);
		expect(est.reclaimableBytes).toBeGreaterThanOrEqual(0);
	});

	it('external backend reports zero reclaimable (no VACUUM there)', async () => {
		const est = await getCompactionEstimate(db, 'external', 30);
		expect(est.reclaimableBytes).toBe(0);
		expect(await reclaimRunLogSpace(db, 'external')).toBe(0);
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

	it('a full drain tick clears the active marker and records the last pass', async () => {
		await startCompaction(db, { olderThanDays: 30, backend: 'embedded' });
		expect(await getActiveCompaction(db)).not.toBeNull();

		await runLogCompactionTick(db, { backend: 'embedded' });

		expect(await getActiveCompaction(db)).toBeNull();
		const last = await getLastCompaction(db);
		expect(last).not.toBeNull();
		expect(last?.older_than_days).toBe(30);
	});

	it('GET run-log-usage returns the usage shape for a superuser', async () => {
		const res = await ctx.app.request('/api/database-info/run-log-usage?older_than_days=30', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: Record<string, unknown> };
		expect(data.backend).toBe('embedded');
		expect(typeof data.run_log_bytes).toBe('number');
		expect(typeof data.reclaimable_bytes).toBe('number');
		expect(data.older_than_days).toBe(30);
		expect(data.compaction).toBeNull();
	});

	it('POST compact-run-logs 409s when a pass is already active', async () => {
		// Seed the active marker directly so the check is deterministic (a real
		// kicked pass drains asynchronously and would race this assertion).
		await setSystemMeta(
			db,
			LOG_COMPACTION_ACTIVE_KEY,
			JSON.stringify({
				started_at: new Date().toISOString(),
				older_than_days: 30,
				total: 1,
				processed: 0,
				bytes_reclaimed: 0,
			}),
		);
		const res = await ctx.app.request('/api/database-info/compact-run-logs', {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ older_than_days: 30 }),
		});
		expect(res.status).toBe(409);
		await deleteSystemMeta(db, LOG_COMPACTION_ACTIVE_KEY);
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
	});
});
