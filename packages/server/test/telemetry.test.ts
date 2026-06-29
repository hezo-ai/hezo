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

	beforeAll(async () => {
		ctx = await createTestContext();
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
		const before = await buildTelemetryPayload(ctx.db);

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

		const after = await buildTelemetryPayload(ctx.db);

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
		const first = await getOrCreateInstanceId(ctx.db);
		const second = await getOrCreateInstanceId(ctx.db);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(await getSystemMeta(ctx.db, INSTANCE_ID_KEY)).toBe(first);

		const payload = await buildTelemetryPayload(ctx.db);
		expect(payload.instance_id).toBe(first);
	});

	it('POSTs the payload to the endpoint as JSON', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 204 }));
		try {
			await reportTelemetry(ctx.db, { endpoint: 'https://collect.test/api/telemetry' });
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
				reportTelemetry(ctx.db, { endpoint: 'https://collect.test/api/telemetry' }),
			).resolves.toBeUndefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
