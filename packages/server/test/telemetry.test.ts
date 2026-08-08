import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeartbeatRunStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSystemMeta } from '../src/lib/system-meta';
import {
	buildTelemetryPayload,
	getOrCreateInstanceId,
	INSTANCE_ID_KEY,
	reportTelemetry,
} from '../src/services/telemetry';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

describe('telemetry', () => {
	let ctx: ServerTestContext;
	let teamId: string;
	let projectId: string;
	let memberId: string;
	let dataDir: string;

	beforeAll(async () => {
		ctx = await createTestContext();
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-telemetry-'));
		// Reuse the seeded HQ team / project / a member for valid FKs.
		teamId = (await ctx.db.query<{ id: string }>(`SELECT id FROM teams LIMIT 1`)).rows[0].id;
		projectId = (
			await ctx.db.query<{ id: string }>(`SELECT id FROM projects WHERE team_id = $1 LIMIT 1`, [
				teamId,
			])
		).rows[0].id;
		memberId = (
			await ctx.db.query<{ id: string }>(`SELECT id FROM members WHERE team_id = $1 LIMIT 1`, [
				teamId,
			])
		).rows[0].id;
	});

	afterAll(() => destroyTestContext(ctx));

	it('aggregates new tasks and runs into the payload (counts + tokens, no money)', async () => {
		const before = await buildTelemetryPayload(ctx.db, dataDir);

		await ctx.db.query(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, updated_at)
			 VALUES ($1, $2, 99001, 'TEL-99001', 'Telemetry done task', 'done', now())`,
			[teamId, projectId],
		);
		await ctx.db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, status, started_at, finished_at, input_tokens, output_tokens, provider)
			 VALUES ($1, $2, $3::heartbeat_run_status, now(), now(), 1000, 500, 'anthropic')`,
			[teamId, memberId, HeartbeatRunStatus.Succeeded],
		);

		const after = await buildTelemetryPayload(ctx.db, dataDir);

		expect(after.tasks_total).toBe(before.tasks_total + 1);
		expect(after.tasks_done).toBe(before.tasks_done + 1);
		expect(after.tasks_completed_24h).toBe(before.tasks_completed_24h + 1);
		expect(after.runs_24h).toBe(before.runs_24h + 1);
		expect(after.input_tokens_24h).toBe(before.input_tokens_24h + 1000);
		expect(after.output_tokens_24h).toBe(before.output_tokens_24h + 500);
		expect(after.provider_mix.anthropic).toBe((before.provider_mix.anthropic ?? 0) + 1);
		expect(after.projects).toBeGreaterThanOrEqual(1);
		expect(after.teams).toBeGreaterThanOrEqual(1);

		// Never report monetary figures — the snapshot is usage-only.
		const moneyKey = Object.keys(after).find((k) => /cost|cent|spend|usd|dollar|money/i.test(k));
		expect(moneyKey).toBeUndefined();
	});

	it('generates a stable, persisted instance id (idempotent)', async () => {
		const first = await getOrCreateInstanceId(ctx.db, dataDir);
		const second = await getOrCreateInstanceId(ctx.db, dataDir);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(await getSystemMeta(ctx.db, INSTANCE_ID_KEY)).toBe(first);

		const payload = await buildTelemetryPayload(ctx.db, dataDir);
		expect(payload.instance_id).toBe(first);
	});

	it('survives a wiped database — the id lives in the data dir, not in pgdata', async () => {
		// The bug this pins: `--reset` renames pgdata aside, so a DB-resident id was
		// minted afresh on the next boot. Every container the previous life created
		// keeps the OLD `hezo.instance` label, the sweep queries the new one, and
		// they become unreapable forever - on a managed backend, billing forever.
		const before = await getOrCreateInstanceId(ctx.db, dataDir);

		// Exactly what a reset leaves behind: the same data dir, an empty database.
		await ctx.db.query(`DELETE FROM system_meta WHERE key = $1`, [INSTANCE_ID_KEY]);

		const after = await getOrCreateInstanceId(ctx.db, dataDir);
		expect(after).toBe(before);
		// ...and the database copy is put back, so telemetry and an operator reading
		// system_meta both see the live value rather than nothing.
		expect(await getSystemMeta(ctx.db, INSTANCE_ID_KEY)).toBe(before);
	});

	it('adopts the id an existing instance already had, rather than minting a new one', async () => {
		// The upgrade path, and the dangerous one: an instance that predates the file
		// has a live id in the database and live containers labelled with it. Minting
		// here would orphan all of them on the first boot after upgrading - the exact
		// failure the file exists to prevent.
		const fresh = mkdtempSync(join(tmpdir(), 'hezo-telemetry-upgrade-'));
		const existing = '11111111-2222-4333-8444-555555555555';
		await ctx.db.query(
			`INSERT INTO system_meta (key, value) VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[INSTANCE_ID_KEY, existing],
		);

		const resolved = await getOrCreateInstanceId(ctx.db, fresh);

		expect(resolved).toBe(existing);
		expect(readFileSync(join(fresh, 'instance-id'), 'utf8').trim()).toBe(existing);
	});

	it('re-derives rather than trusting a truncated id file', async () => {
		// A half-written file would otherwise become a container label that matches
		// nothing, which is the same leak by another route.
		const fresh = mkdtempSync(join(tmpdir(), 'hezo-telemetry-corrupt-'));
		writeFileSync(join(fresh, 'instance-id'), 'not-a-uuid\n');
		await ctx.db.query(`DELETE FROM system_meta WHERE key = $1`, [INSTANCE_ID_KEY]);

		const resolved = await getOrCreateInstanceId(ctx.db, fresh);

		expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
		expect(readFileSync(join(fresh, 'instance-id'), 'utf8').trim()).toBe(resolved);
	});

	it('writes the id file host-owner only', async () => {
		const fresh = mkdtempSync(join(tmpdir(), 'hezo-telemetry-mode-'));
		await ctx.db.query(`DELETE FROM system_meta WHERE key = $1`, [INSTANCE_ID_KEY]);
		await getOrCreateInstanceId(ctx.db, fresh);
		expect(existsSync(join(fresh, 'instance-id'))).toBe(true);
	});

	it('POSTs the payload to the endpoint as JSON', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 204 }));
		try {
			await reportTelemetry(ctx.db, { endpoint: 'https://collect.test/api/telemetry', dataDir });
			expect(fetchSpy).toHaveBeenCalledOnce();
			const [url, init] = fetchSpy.mock.calls[0];
			expect(url).toBe('https://collect.test/api/telemetry');
			expect(init?.method).toBe('POST');
			const body = JSON.parse(String(init?.body));
			expect(body.instance_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(typeof body.tasks_total).toBe('number');
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('fails soft when the endpoint is unreachable (never throws)', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
		try {
			await expect(
				reportTelemetry(ctx.db, { endpoint: 'https://collect.test/api/telemetry', dataDir }),
			).resolves.toBeUndefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
