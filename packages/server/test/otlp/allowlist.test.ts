import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateOtlpConfig } from '../../src/config/schema';
import { DomainEventBus } from '../../src/events/bus';
import { registerOtlpObserver } from '../../src/events/otlp-observer';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type FakeCollector,
	otlpConfig,
	seedWorld,
	startExporter,
	startFakeCollector,
} from './helpers';

describe('OTLP allowlist', () => {
	let ctx: ServerTestContext;
	let collector: FakeCollector;

	beforeEach(async () => {
		ctx = await createTestContext();
		collector = await startFakeCollector();
	});

	afterEach(async () => {
		await collector.close();
		await destroyTestContext(ctx);
	});

	it("admits any project when the allowlist is '*'", async () => {
		const other = await seedWorld(ctx, 'wildcard-other');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint, { projects: ['*'] }));
		try {
			exporter.emitRunStarted({
				runId: crypto.randomUUID(),
				teamId: other.teamId,
				projectId: other.projectId,
				agentMemberId: other.agentId,
				taskId: other.taskId,
				triggerSource: 'task',
				receivedAt: new Date().toISOString(),
			});
			await exporter.flush(2000);
		} finally {
			await exporter.stop();
		}

		const body = collector.requests.map((r) => r.body).join('\n');
		expect(body).toContain(other.projectId);
		expect(exporter.status()).toMatchObject({ state: 'ready', dropped: 0 });
	});

	it('buffers only the listed projects and counts the rest project_not_allowed', async () => {
		const allowed = await seedWorld(ctx, 'allowed');
		const denied = await seedWorld(ctx, 'denied');
		const exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { projects: [allowed.projectId] }),
		);
		try {
			for (const world of [allowed, denied]) {
				exporter.emitRunStarted({
					runId: crypto.randomUUID(),
					teamId: world.teamId,
					projectId: world.projectId,
					agentMemberId: world.agentId,
					taskId: world.taskId,
					triggerSource: 'task',
					receivedAt: new Date().toISOString(),
				});
			}
			await exporter.flush(2000);
			expect(exporter.status()).toMatchObject({ state: 'ready', dropped: 1 });
		} finally {
			await exporter.stop();
		}

		const body = collector.requests.map((r) => r.body).join('\n');
		expect(body).toContain(allowed.projectId);
		expect(body).not.toContain(denied.projectId);
	});

	it('refuses an empty project list when enabled', () => {
		expect(() =>
			validateOtlpConfig({
				enabled: true,
				endpoint: 'https://collector.example',
				projects: [],
			}),
		).toThrow(/otlp\.projects/);
	});

	it('refuses a wildcard alongside a UUID', () => {
		expect(() =>
			validateOtlpConfig({
				enabled: true,
				endpoint: 'https://collector.example',
				projects: ['*', crypto.randomUUID()],
			}),
		).toThrow(/stand alone/);
	});

	it('refuses an entry that is neither a wildcard nor a UUID', () => {
		expect(() =>
			validateOtlpConfig({
				enabled: true,
				endpoint: 'https://collector.example',
				projects: ['not-a-project'],
			}),
		).toThrow(/not-a-project/);
	});

	it('drops a run whose project cannot be resolved and never emits it', async () => {
		// A team with no project: the only row that reaches unresolved_project.
		const slug = `otlp-orphan-${Math.random().toString(36).slice(2, 8)}`;
		const team = await ctx.db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			[slug],
		);
		const teamId = team.rows[0].id;
		const member = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Orphan') RETURNING id`,
			[teamId],
		);
		const agentId = member.rows[0].id;
		const runId = crypto.randomUUID();
		await ctx.db.query(
			`INSERT INTO heartbeat_runs
			   (id, team_id, member_id, task_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, $3, NULL, 'succeeded', now(), now(), 0)`,
			[runId, teamId, agentId],
		);

		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		const events = new DomainEventBus();
		registerOtlpObserver(events, ctx.db, exporter, otlpConfig(collector.endpoint));
		try {
			events.emit({
				type: 'agent_run.started',
				runId,
				taskId: null,
				agentMemberId: agentId,
				triggerSource: 'heartbeat',
				teamId,
				projectId: null,
			});
			events.emit({
				type: 'agent_run.completed',
				runId,
				taskId: null,
				agentMemberId: agentId,
				status: 'succeeded',
				exitCode: 0,
				teamId,
				projectId: null,
			});
			await exporter.flush(2000);
			expect(exporter.status()).toMatchObject({ state: 'ready' });
			expect((exporter.status() as { dropped: number }).dropped).toBeGreaterThanOrEqual(2);
		} finally {
			await exporter.stop();
		}

		const body = collector.requests.map((r) => r.body).join('\n');
		expect(body).not.toContain(runId);
	});
});
