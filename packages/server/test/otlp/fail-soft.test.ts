import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OtlpExporterHandle } from '../../src/services/otlp/exporter';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type CollectorReply,
	type CollectorRequest,
	type FakeCollector,
	otlpConfig,
	seedWorld,
	startExporter,
	startFakeCollector,
	waitFor,
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

function traceRequests(collector: FakeCollector): CollectorRequest[] {
	return collector.requests.filter((r) => r.url.endsWith('/v1/traces'));
}

function allBodies(collector: FakeCollector): string {
	return collector.requests.map((r) => r.body).join('\n');
}

/** Requests the collector answered 2xx and that carried this run's span. */
function accepted(collector: FakeCollector, runId: string): CollectorRequest[] {
	return collector.requests.filter((r) => r.status === 200 && r.body.includes(runId));
}

function droppedCount(exporter: OtlpExporterHandle): number {
	return (exporter.status() as { dropped: number }).dropped;
}

describe('OTLP fail-soft', () => {
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

	it('retries 503 with backoff and delivers exactly once', async () => {
		collector = await startFakeCollector((_req, index) =>
			index < 3 ? { status: 503 } : { status: 200 },
		);
		const world = await seedWorld(ctx, 'retry');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		const runId = crypto.randomUUID();
		try {
			exporter.emitRunFinished(spanRecord(world, runId));
			// The background flush interval drives the retries; a manual flush
			// would spend its budget and drop the queued span if the backoff has
			// not elapsed yet.
			await waitFor(() => accepted(collector as FakeCollector, runId).length === 1, 15_000);
			const status = exporter.status();
			expect(status.state).toBe('ready');
			expect(status).toMatchObject({ lastError: null, dropped: 0 });
			// Three refused attempts, then the same span accepted exactly once.
			expect(traceRequests(collector)).toHaveLength(4);
			expect(accepted(collector, runId)).toHaveLength(1);
		} finally {
			await exporter.stop();
		}
		// Full-jitter backoff after three refusals can wait up to 1s + 2s + 4s,
		// so the default 5s ceiling would fail a correct run on an unlucky draw.
	}, 20_000);

	it('drops a 400 batch as rejected and keeps sending the next one', async () => {
		collector = await startFakeCollector((req) =>
			req.url.endsWith('/v1/traces') && collector?.requests.length === 1
				? { status: 400, body: 'bad request' }
				: { status: 200 },
		);
		const world = await seedWorld(ctx, 'reject');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		const runId = crypto.randomUUID();
		try {
			exporter.emitRunFinished(spanRecord(world, runId));
			await waitFor(() => droppedCount(exporter) === 1, 10_000);
			await exporter.flush(2000);
			expect(droppedCount(exporter)).toBe(1);
			// The rejected batch is not retried; the next flush still goes out.
			expect(traceRequests(collector).filter((r) => r.status === 400)).toHaveLength(1);
			expect(collector.requests.length).toBeGreaterThanOrEqual(2);
			expect(allBodies(collector)).toContain('rejected');
		} finally {
			await exporter.stop();
		}
	});

	it('drops a 500 batch and does not retry it', async () => {
		collector = await startFakeCollector((req) =>
			req.url.endsWith('/v1/traces') ? { status: 500, body: 'boom' } : { status: 200 },
		);
		const world = await seedWorld(ctx, 'nonretryable');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		const runId = crypto.randomUUID();
		try {
			exporter.emitRunFinished(spanRecord(world, runId));
			await waitFor(() => droppedCount(exporter) === 1, 10_000);
			await exporter.flush(1000);
			// A 500 is permanent: the one attempted trace request is the only one.
			expect(traceRequests(collector)).toHaveLength(1);
			expect(traceRequests(collector)[0]?.status).toBe(500);
		} finally {
			await exporter.stop();
		}
	});

	it('records a partial success rejected count without retrying', async () => {
		const partial: CollectorReply = {
			status: 200,
			body: '{"partialSuccess":{"rejectedSpans":"2","errorMessage":"bad spans"}}',
		};
		collector = await startFakeCollector(() => partial);
		const world = await seedWorld(ctx, 'partial');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
		const runId = crypto.randomUUID();
		try {
			exporter.emitRunFinished(spanRecord(world, runId));
			await waitFor(
				() => (exporter.status() as { lastError: string | null }).lastError !== null,
				10_000,
			);
			expect(traceRequests(collector)).toHaveLength(1);
			expect((exporter.status() as { lastError: string | null }).lastError).toContain('2');
		} finally {
			await exporter.stop();
		}
	});

	it('drops a record older than five minutes as stale', async () => {
		try {
			vi.useFakeTimers({ toFake: ['Date'] });
			let failing = true;
			collector = await startFakeCollector(() => (failing ? { status: 503 } : { status: 200 }));
			const world = await seedWorld(ctx, 'stale');
			const exporter = await startExporter(ctx, otlpConfig(collector.endpoint));
			const runId = crypto.randomUUID();
			try {
				exporter.emitRunFinished(spanRecord(world, runId));
				await waitFor(() => traceRequests(collector as FakeCollector).length >= 1, 10_000);
				vi.setSystemTime(Date.now() + 6 * 60 * 1000);
				failing = false;
				await waitFor(() => allBodies(collector as FakeCollector).includes('stale'), 10_000);
				// The runId appears only in the refused attempt: the aged record is
				// never sent again, and the dropped counter reports why.
				expect(
					collector.requests.filter((r) => r.body.includes(runId)).every((r) => r.status === 503),
				).toBe(true);
			} finally {
				await exporter.stop();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts a request that outlives timeoutMs and retries the same batch', async () => {
		collector = await startFakeCollector(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return { status: 200 };
		});
		const world = await seedWorld(ctx, 'timeout');
		const exporter = await startExporter(ctx, otlpConfig(collector.endpoint, { timeoutMs: 80 }));
		const runId = crypto.randomUUID();
		try {
			exporter.emitRunFinished(spanRecord(world, runId));
			await waitFor(() => (collector as FakeCollector).requests.length >= 2, 10_000);
			expect((collector as FakeCollector).requests.length).toBeGreaterThanOrEqual(2);
		} finally {
			await exporter.stop();
		}
	});

	it('bounds the queue by bytes and drops the oldest as queue_full', async () => {
		// Every request succeeds but is slow, so the synchronous burst of emits
		// outruns the one in-flight pump and the byte bound has to apply.
		collector = await startFakeCollector(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { status: 200 };
		});
		const world = await seedWorld(ctx, 'bound');
		const exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { maxQueueBytes: 600, batchSize: 1000 }),
		);
		try {
			for (let i = 0; i < 40; i += 1) {
				exporter.emitRunFinished(spanRecord(world, crypto.randomUUID()));
			}
			expect(droppedCount(exporter)).toBeGreaterThan(0);
			await waitFor(() => allBodies(collector as FakeCollector).includes('queue_full'), 10_000);
			await exporter.flush(2000);
			// The successful payload holds only the freshest window, not all 40 spans.
			const delivered = (allBodies(collector).match(/"name":"hezo\.agent_run"/g) ?? []).length;
			expect(delivered).toBeLessThan(40);
		} finally {
			await exporter.stop();
		}
	});
});
