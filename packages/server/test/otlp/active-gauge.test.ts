import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActiveRunGauge, startActiveRunGauge } from '../../src/services/otlp/active-gauge';
import type { OtlpExporterHandle } from '../../src/services/otlp/exporter';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';
import {
	type FakeCollector,
	otlpConfig,
	seedRun,
	seedWorld,
	startExporter,
	startFakeCollector,
	waitFor,
} from './helpers';

interface MetricPoint {
	asInt?: string;
	sum?: number;
	attributes: Array<{ key: string; value: { stringValue?: string } }>;
}

interface Metric {
	name: string;
	gauge?: { dataPoints: MetricPoint[] };
	sum?: { dataPoints: MetricPoint[] };
}

function metricsSince(collector: FakeCollector, from: number): Metric[] {
	const out: Metric[] = [];
	for (const request of collector.requests.slice(from)) {
		if (!request.url.endsWith('/v1/metrics')) continue;
		const parsed = JSON.parse(request.body) as {
			resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Metric[] }> }>;
		};
		for (const scope of parsed.resourceMetrics[0]?.scopeMetrics ?? []) {
			out.push(...scope.metrics);
		}
	}
	return out;
}

function attribute(point: MetricPoint, key: string): string | undefined {
	return point.attributes.find((a) => a.key === key)?.value.stringValue;
}

/** The active gauge's last-value point for one project, if the tick emitted one. */
function activeValue(metrics: Metric[], projectId: string): number | null {
	const gauge = metrics.find((m) => m.name === 'hezo.runs.active');
	const point = gauge?.gauge?.dataPoints.find((p) => attribute(p, 'hezo.project.id') === projectId);
	return point === undefined ? null : Number(point.asInt);
}

/** The cumulative uptime total for one (project, end_reason), if present. */
function uptimeTotal(metrics: Metric[], projectId: string, endReason: string): number | null {
	const sum = metrics.find((m) => m.name === 'hezo.container.uptime');
	const point = sum?.sum?.dataPoints.find(
		(p) =>
			attribute(p, 'hezo.project.id') === projectId &&
			attribute(p, 'hezo.container.end_reason') === endReason,
	);
	return point === undefined ? null : Number(point.asInt);
}

async function seedUptime(
	ctx: ServerTestContext,
	projectId: string,
	seconds: number,
	endReason: string | null,
): Promise<void> {
	await ctx.db.query(
		`INSERT INTO container_uptime_entries
		   (project_id, container_id, started_at, ended_at, end_reason, backend)
		 VALUES ($1, $2,
		         now() - interval '10 seconds' - ($3::int * interval '1 second'),
		         now() - interval '10 seconds', $4, 'docker')`,
		[projectId, `gauge-${Math.random().toString(36).slice(2, 10)}`, seconds, endReason],
	);
}

describe('OTLP active gauge and uptime', () => {
	let ctx: ServerTestContext;
	let collector: FakeCollector;
	let exporter: OtlpExporterHandle | null = null;
	let gauge: ActiveRunGauge | null = null;
	let emitCalls = 0;
	let spy: { mockRestore(): void } | null = null;

	beforeEach(async () => {
		ctx = await createTestContext();
		collector = await startFakeCollector();
		emitCalls = 0;
	});

	afterEach(async () => {
		gauge?.stop();
		spy?.mockRestore();
		await exporter?.stop();
		await collector.close();
		vi.useRealTimers();
		await destroyTestContext(ctx);
	});

	/**
	 * Fake only the interval, so the database and `waitFor` polling stay real.
	 * The exporter is created afterwards, keeping its flush timer inert: each
	 * tick is driven explicitly.
	 */
	function startFakeIntervals(): void {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	}

	it('counts running runs by project, emits zero once, and accumulates uptime', async () => {
		const a = await seedWorld(ctx, 'gauge-a');
		const b = await seedWorld(ctx, 'gauge-b');
		const d = await seedWorld(ctx, 'gauge-d');
		// Team C has no project: its taskless run cannot be attributed.
		const orphanSlug = `otlp-gauge-orphan-${Math.random().toString(36).slice(2, 8)}`;
		const orphanTeam = await ctx.db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			[orphanSlug],
		);
		const orphanTeamId = orphanTeam.rows[0].id;
		const orphanMember = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Orphan') RETURNING id`,
			[orphanTeamId],
		);
		const orphanRunId = crypto.randomUUID();
		await ctx.db.query(
			`INSERT INTO heartbeat_runs (id, team_id, member_id, status, started_at)
			 VALUES ($1, $2, $3, 'running', now())`,
			[orphanRunId, orphanTeamId, orphanMember.rows[0].id],
		);

		const runA = await seedRun(ctx, a, { status: 'running', startedAt: null, finishedAt: null });
		// Taskless: resolved through the team's single project.
		const runB = await seedRun(ctx, b, {
			status: 'running',
			taskId: null,
			startedAt: null,
			finishedAt: null,
		});
		const runD = await seedRun(ctx, d, { status: 'running', startedAt: null, finishedAt: null });

		await seedUptime(ctx, a.projectId, 60, 'stopped');
		await seedUptime(ctx, a.projectId, 30, 'stopped');
		await seedUptime(ctx, a.projectId, 10, 'destroyed');
		await seedUptime(ctx, b.projectId, 20, 'suspended');

		startFakeIntervals();
		exporter = await startExporter(ctx, otlpConfig(collector.endpoint, { projects: ['*'] }));
		const emit = exporter.emitMetrics.bind(exporter);
		spy = vi.spyOn(exporter, 'emitMetrics').mockImplementation((sample) => {
			emitCalls += 1;
			emit(sample);
		});
		// Drop the exporter's own flush timer; each tick below is driven explicitly.
		vi.clearAllTimers();
		gauge = startActiveRunGauge(ctx.db, exporter, 30_000);
		void runA;
		void runB;
		void runD;
		void orphanRunId;

		const tick = async (expectedCalls: number): Promise<number> => {
			const from = collector.requests.length;
			vi.advanceTimersByTime(30_000);
			await waitFor(() => emitCalls >= expectedCalls, 5000);
			await exporter?.flush(2000);
			return from;
		};

		// Tick 1: three projects active (A, B via team fallback, D); C excluded.
		let from = await tick(7);
		let metrics = metricsSince(collector, from);
		expect(activeValue(metrics, a.projectId)).toBe(1);
		expect(activeValue(metrics, b.projectId)).toBe(1);
		expect(activeValue(metrics, d.projectId)).toBe(1);
		expect(
			metrics
				.flatMap((m) => m.gauge?.dataPoints ?? [])
				.some((p) => attribute(p, 'hezo.project.id') === orphanTeamId),
		).toBe(false);
		expect(uptimeTotal(metrics, a.projectId, 'stopped')).toBe(90);
		expect(uptimeTotal(metrics, a.projectId, 'destroyed')).toBe(10);
		expect(uptimeTotal(metrics, b.projectId, 'suspended')).toBe(20);

		// Tick 2: D stops, so it is emitted once with zero; uptime is not counted twice.
		await ctx.db.query("UPDATE heartbeat_runs SET status = 'succeeded' WHERE id = $1", [runD]);
		from = await tick(10);
		metrics = metricsSince(collector, from);
		expect(activeValue(metrics, d.projectId)).toBe(0);
		expect(activeValue(metrics, a.projectId)).toBe(1);
		expect(uptimeTotal(metrics, a.projectId, 'stopped')).toBe(90);

		// Tick 3: D is omitted rather than re-emitted at zero.
		from = await tick(12);
		metrics = metricsSince(collector, from);
		expect(activeValue(metrics, d.projectId)).toBeNull();
		expect(activeValue(metrics, a.projectId)).toBe(1);

		// Tick 4: a new interval adds to the same cumulative pair.
		await seedUptime(ctx, a.projectId, 5, 'stopped');
		from = await tick(15);
		metrics = metricsSince(collector, from);
		expect(uptimeTotal(metrics, a.projectId, 'stopped')).toBe(95);
	});

	it('filters both queries by the exporter allowlist', async () => {
		const a = await seedWorld(ctx, 'allow-a');
		const b = await seedWorld(ctx, 'allow-b');
		await seedRun(ctx, a, { status: 'running', startedAt: null, finishedAt: null });
		await seedRun(ctx, b, { status: 'running', startedAt: null, finishedAt: null });
		await seedUptime(ctx, a.projectId, 40, 'stopped');
		await seedUptime(ctx, b.projectId, 40, 'stopped');

		startFakeIntervals();
		exporter = await startExporter(
			ctx,
			otlpConfig(collector.endpoint, { projects: [a.projectId] }),
		);
		const emit = exporter.emitMetrics.bind(exporter);
		spy = vi.spyOn(exporter, 'emitMetrics').mockImplementation((sample) => {
			emitCalls += 1;
			emit(sample);
		});
		vi.clearAllTimers();
		gauge = startActiveRunGauge(ctx.db, exporter, 30_000);

		vi.advanceTimersByTime(30_000);
		await waitFor(() => emitCalls >= 2, 5000);
		await exporter.flush(2000);

		const metrics = metricsSince(collector, 0);
		expect(activeValue(metrics, a.projectId)).toBe(1);
		expect(activeValue(metrics, b.projectId)).toBeNull();
		expect(uptimeTotal(metrics, a.projectId, 'stopped')).toBe(40);
		expect(uptimeTotal(metrics, b.projectId, 'stopped')).toBeNull();
	});
});
