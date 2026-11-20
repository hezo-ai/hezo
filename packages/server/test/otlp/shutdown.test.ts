import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DomainEventBus } from '../../src/events/bus';
import { registerOtlpObserver } from '../../src/events/otlp-observer';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type FakeCollector,
	otlpConfig,
	seedRun,
	seedWorld,
	startExporter,
	startFakeCollector,
} from './helpers';

function spanRecord(world: Awaited<ReturnType<typeof seedWorld>>, runId: string) {
	return {
		runId,
		teamId: world.teamId,
		projectId: world.projectId,
		agentMemberId: world.agentId,
		taskId: world.taskId,
		status: 'succeeded' as const,
		exitCode: 0,
		errorText: null,
		startedAt: '2026-11-20T00:00:00.000Z',
		finishedAt: '2026-11-20T00:04:02.000Z',
		provider: 'anthropic',
		model: 'claude-sonnet-5',
		tokens: { input: 1, output: 1, cacheRead: null, cacheCreation: null },
		toolCalls: null,
		stopReason: null,
		retryOfRunId: null,
		triggerSource: 'task',
	};
}

describe('OTLP shutdown flush', () => {
	let ctx: ServerTestContext;
	let collector: FakeCollector | null = null;

	beforeEach(async () => {
		ctx = await createTestContext();
	});

	afterEach(async () => {
		await collector?.close();
		collector = null;
		await destroyTestContext(ctx);
	});

	it('resolves within its budget and drops the remainder as shutdown_timeout', async () => {
		let delayMs = 3000;
		collector = await startFakeCollector(async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return { status: 200 };
		});
		const world = await seedWorld(ctx, 'budget');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint, { batchSize: 256 }));
		try {
			for (let i = 0; i < 4; i += 1)
				exporter.emitRunFinished(spanRecord(world, crypto.randomUUID()));

			const startedAt = Date.now();
			await exporter.flush(2000);
			const elapsed = Date.now() - startedAt;
			// Bounded by the argument, not by the collector's 3s response.
			expect(elapsed).toBeLessThan(2800);
			expect((exporter.status() as { dropped: number }).dropped).toBe(4);

			// The drop counter survives the timeout and reports why on the next send.
			// The failed attempt left a backoff, so retry until the counter goes out.
			delayMs = 0;
			const deadline = Date.now() + 10_000;
			while (
				!collector.requests.some((r) => r.body.includes('shutdown_timeout')) &&
				Date.now() < deadline
			) {
				await exporter.flush(500);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(collector.requests.map((r) => r.body).join('\n')).toContain('shutdown_timeout');
		} finally {
			await exporter.stop();
		}
	});

	it('sends a span for a run that completes during the drain', async () => {
		collector = await startFakeCollector();
		const world = await seedWorld(ctx, 'drain');
		const runId = await seedRun(ctx, world);
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		const events = new DomainEventBus();
		registerOtlpObserver(events, ctx.db, exporter, otlpConfig(collector.endpoint));
		try {
			events.emit({
				type: 'agent_run.started',
				runId,
				taskId: world.taskId,
				agentMemberId: world.agentId,
				triggerSource: 'task',
				teamId: world.teamId,
				projectId: world.projectId,
			});
			// `drainRunningRuns` awaits the runner, whose completion event fires
			// inside that await; the observer's row read is tracked background work.
			await (async () => {
				events.emit({
					type: 'agent_run.completed',
					runId,
					taskId: world.taskId,
					agentMemberId: world.agentId,
					status: 'succeeded',
					exitCode: 0,
					teamId: world.teamId,
					projectId: world.projectId,
				});
			})();

			await exporter.flush(2000);
			const trace = collector.requests.find((r) => r.url.endsWith('/v1/traces'));
			expect(trace?.body).toContain(runId);
			expect(trace?.body).toContain('hezo.agent_run');
		} finally {
			await exporter.stop();
		}
	});
});
