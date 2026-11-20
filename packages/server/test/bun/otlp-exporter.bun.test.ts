// Bun-native tier: the exporter's queue accounting uses `Buffer`, the mapper
// uses `crypto`, and delivery rides the runtime's own `fetch`. Node and Bun
// diverge on all three in ways that fail silently, so one full flush is
// exercised on the production runtime. The test context is the in-process
// PGlite one, so no external database is needed.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type FakeCollector,
	otlpConfig,
	seedWorld,
	startExporter,
	startFakeCollector,
} from '../otlp/helpers';

describe('OTLP exporter on the Bun runtime', () => {
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

	it('flushes a run span and the metric accumulators in one pass', async () => {
		const world = await seedWorld(ctx, 'bun');
		const runId = crypto.randomUUID();
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		try {
			exporter.emitRunStarted({
				runId,
				teamId: world.teamId,
				projectId: world.projectId,
				agentMemberId: world.agentId,
				taskId: world.taskId,
				triggerSource: 'task',
				receivedAt: '2026-11-20T00:00:00.000Z',
			});
			exporter.emitRunFinished({
				runId,
				teamId: world.teamId,
				projectId: world.projectId,
				agentMemberId: world.agentId,
				taskId: world.taskId,
				status: 'succeeded',
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
			});
			await exporter.flush(5000);

			const trace = collector.requests.find((r) => r.url.endsWith('/v1/traces'));
			expect(trace?.body).toContain(runId);
			expect(trace?.body).toContain('hezo.agent_run');
			const metrics = collector.requests.find((r) => r.url.endsWith('/v1/metrics'));
			expect(metrics?.body).toContain('hezo.runs.completed');
			expect(exporter.status().state).toBe('ready');
		} finally {
			await exporter.stop();
		}
	});
});
