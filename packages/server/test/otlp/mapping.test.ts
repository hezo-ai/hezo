import { describe, expect, it } from 'vitest';
import type { RunFinishRecord } from '../../src/services/otlp/exporter';
import {
	failureClass,
	isSampledRun,
	mapRunFinishedMetrics,
	mapRunSpan,
	mapRunStartedMetric,
	runDurationMs,
	runTraceIds,
	toUnixNano,
} from '../../src/services/otlp/mapping';

const RUN_ID = '8f14e45f-ceea-167a-5a36-dedd4bea2543';
const TEAM_ID = '5d2a0000-0000-4000-8000-000000000077';
const PROJECT_ID = '0b8f0000-0000-4000-8000-000000000031';
const AGENT_ID = 'a2c10000-0000-4000-8000-00000000009e';
const TASK_ID = 'c0de0000-0000-4000-8000-000000000001';

function record(overrides: Partial<RunFinishRecord> = {}): RunFinishRecord {
	return {
		runId: RUN_ID,
		teamId: TEAM_ID,
		projectId: PROJECT_ID,
		agentMemberId: AGENT_ID,
		taskId: TASK_ID,
		status: 'succeeded',
		exitCode: 0,
		errorText: null,
		startedAt: '2026-11-20T00:00:00.000Z',
		finishedAt: '2026-11-20T00:04:02.000Z',
		provider: 'anthropic',
		model: 'claude-sonnet-5',
		tokens: { input: 48213, output: 2311, cacheRead: 12000, cacheCreation: 800 },
		toolCalls: 15,
		stopReason: 'token_ceiling',
		retryOfRunId: null,
		triggerSource: 'task',
		...overrides,
	};
}

function attributeMap(span: ReturnType<typeof mapRunSpan>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const attribute of span.attributes) {
		const value = attribute.value;
		out[attribute.key] = 'stringValue' in value ? value.stringValue : value.intValue;
	}
	return out;
}

describe('mapRunSpan', () => {
	it('produces the exact golden span for a fully-populated run', () => {
		const span = mapRunSpan(record(), { includeNames: false, includeErrorText: false });
		expect(span).toEqual({
			traceId: '8f14e45fceea167a5a36dedd4bea2543',
			spanId: '8f14e45fceea167a',
			name: 'hezo.agent_run',
			kind: 1,
			startTimeUnixNano: '1795132800000000000',
			endTimeUnixNano: '1795133042000000000',
			attributes: [
				{ key: 'hezo.run.id', value: { stringValue: RUN_ID } },
				{ key: 'hezo.team.id', value: { stringValue: TEAM_ID } },
				{ key: 'hezo.project.id', value: { stringValue: PROJECT_ID } },
				{ key: 'hezo.task.id', value: { stringValue: TASK_ID } },
				{ key: 'hezo.agent.id', value: { stringValue: AGENT_ID } },
				{ key: 'hezo.run.status', value: { stringValue: 'succeeded' } },
				{ key: 'hezo.run.exit_code', value: { intValue: '0' } },
				{ key: 'hezo.run.trigger_source', value: { stringValue: 'task' } },
				{ key: 'hezo.provider', value: { stringValue: 'anthropic' } },
				{ key: 'hezo.model', value: { stringValue: 'claude-sonnet-5' } },
				{ key: 'hezo.tokens.input', value: { intValue: '48213' } },
				{ key: 'hezo.tokens.output', value: { intValue: '2311' } },
				{ key: 'hezo.tokens.cache_read', value: { intValue: '12000' } },
				{ key: 'hezo.tokens.cache_creation', value: { intValue: '800' } },
				{ key: 'hezo.run.stop_reason', value: { stringValue: 'token_ceiling' } },
				{ key: 'hezo.tool.calls', value: { intValue: '15' } },
			],
			status: { code: 1 },
		});
	});

	it('omits every attribute whose source is null', () => {
		const span = mapRunSpan(
			record({
				taskId: null,
				exitCode: null,
				triggerSource: null,
				retryOfRunId: null,
				provider: null,
				model: null,
				tokens: { input: 0, output: 0, cacheRead: null, cacheCreation: null },
				stopReason: null,
				toolCalls: null,
			}),
			{ includeNames: false, includeErrorText: false },
		);
		expect(span.attributes.map((a) => a.key)).toEqual([
			'hezo.run.id',
			'hezo.team.id',
			'hezo.project.id',
			'hezo.agent.id',
			'hezo.run.status',
			'hezo.tokens.input',
			'hezo.tokens.output',
		]);
	});

	it('emits names only when includeNames is on', () => {
		const names = { project: 'Alpha', team: 'Alpha Team', agent: 'Engineer' };
		const off = mapRunSpan(record(), {
			includeNames: false,
			includeErrorText: false,
			names,
		});
		expect(attributeMap(off)['hezo.project.name']).toBeUndefined();

		const on = mapRunSpan(record(), {
			includeNames: true,
			includeErrorText: false,
			names,
		});
		expect(attributeMap(on)).toMatchObject({
			'hezo.project.name': 'Alpha',
			'hezo.team.name': 'Alpha Team',
			'hezo.agent.name': 'Engineer',
		});
	});

	it('cuts error text to its first line, scrubs placeholders, and obeys the flag', () => {
		const raw = `boom __HEZO_SECRET_GITHUB_PAT__ failed\nsecond line`;
		const on = mapRunSpan(record({ errorText: raw }), {
			includeNames: false,
			includeErrorText: true,
		});
		expect(attributeMap(on)['hezo.run.error']).toBe('boom [placeholder] failed');

		const off = mapRunSpan(record({ errorText: raw }), {
			includeNames: false,
			includeErrorText: false,
		});
		expect(attributeMap(off)['hezo.run.error']).toBeUndefined();
	});

	it('caps every free-text attribute at its stated length', () => {
		const long = 'x'.repeat(300);
		const span = mapRunSpan(
			record({
				model: long,
				stopReason: long,
				errorText: 'y'.repeat(600),
			}),
			{
				includeNames: true,
				includeErrorText: true,
				names: { project: long, team: long, agent: long },
			},
		);
		const attributes = attributeMap(span);
		expect(attributes['hezo.model']).toHaveLength(256);
		expect(attributes['hezo.run.stop_reason']).toHaveLength(256);
		expect(attributes['hezo.run.error']).toHaveLength(512);
		expect(attributes['hezo.project.name']).toHaveLength(256);
		expect(attributes['hezo.team.name']).toHaveLength(256);
		expect(attributes['hezo.agent.name']).toHaveLength(256);
	});

	it('keeps hezo.tool.calls a sum and never emits a tool name', () => {
		const recordWithToolMap = record();
		// The mapper receives toolCalls already summed; the map never reaches it.
		const span = mapRunSpan(recordWithToolMap, {
			includeNames: false,
			includeErrorText: false,
		});
		expect(attributeMap(span)['hezo.tool.calls']).toBe('15');
		expect(JSON.stringify(span)).not.toContain('mcp__');
	});

	it('maps status codes for all terminal statuses', () => {
		expect(
			mapRunSpan(record({ status: 'succeeded' }), {
				includeNames: false,
				includeErrorText: false,
			}).status.code,
		).toBe(1);
		expect(
			mapRunSpan(record({ status: 'failed' }), {
				includeNames: false,
				includeErrorText: false,
			}).status.code,
		).toBe(2);
		expect(
			mapRunSpan(record({ status: 'timed_out' }), {
				includeNames: false,
				includeErrorText: false,
			}).status.code,
		).toBe(2);
		expect(
			mapRunSpan(record({ status: 'cancelled' }), {
				includeNames: false,
				includeErrorText: false,
			}).status.code,
		).toBe(0);
	});
});

describe('failureClass', () => {
	it('maps all six bounded values', () => {
		expect(failureClass({ status: 'succeeded', stopReason: null, exitCode: 0 })).toBe('none');
		expect(failureClass({ status: 'cancelled', stopReason: null, exitCode: null })).toBe(
			'cancelled',
		);
		expect(failureClass({ status: 'timed_out', stopReason: null, exitCode: null })).toBe('timeout');
		expect(failureClass({ status: 'failed', stopReason: 'token_ceiling', exitCode: 1 })).toBe(
			'run_size',
		);
		expect(failureClass({ status: 'failed', stopReason: 'tool_call_ceiling', exitCode: 1 })).toBe(
			'run_size',
		);
		expect(failureClass({ status: 'failed', stopReason: null, exitCode: 2 })).toBe('nonzero_exit');
		expect(failureClass({ status: 'failed', stopReason: null, exitCode: null })).toBe('error');
	});
});

describe('timestamps and duration', () => {
	it('converts ISO to int64 nanoseconds as a decimal string', () => {
		expect(toUnixNano('2026-11-20T00:00:00.000Z')).toBe('1795132800000000000');
	});

	it('computes a non-negative duration', () => {
		expect(runDurationMs('2026-11-20T00:00:00.000Z', '2026-11-20T00:04:02.000Z')).toBe(242000);
		expect(runDurationMs('2026-11-20T00:00:02.000Z', '2026-11-20T00:00:00.000Z')).toBe(0);
	});
});

describe('runTraceIds', () => {
	it('derives a 16-byte trace id and an 8-byte span id, lowercase hex', () => {
		expect(runTraceIds('8F14E45F-CEEA-167A-5A36-DEDD4BEA2543')).toEqual({
			traceId: '8f14e45fceea167a5a36dedd4bea2543',
			spanId: '8f14e45fceea167a',
		});
	});

	it('remaps the all-zero id so neither id is all zero', () => {
		expect(runTraceIds('00000000-0000-0000-0000-000000000000')).toEqual({
			traceId: '00000000000040008000000000000001',
			spanId: '0000000000004000',
		});
	});
});

describe('isSampledRun', () => {
	it('is deterministic per run id and roughly matches the ratio', () => {
		const first = isSampledRun(RUN_ID, 0.25);
		for (let i = 0; i < 10; i += 1) expect(isSampledRun(RUN_ID, 0.25)).toBe(first);

		let sampled = 0;
		const total = 10_000;
		for (let i = 0; i < total; i += 1) {
			const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
			if (isSampledRun(id, 0.3)) sampled += 1;
		}
		expect(sampled / total).toBeGreaterThan(0.27);
		expect(sampled / total).toBeLessThan(0.33);
	});

	it('samples everything at ratio 1', () => {
		expect(isSampledRun(RUN_ID, 1)).toBe(true);
	});
});

describe('metric mapping', () => {
	it('emits started, completed, duration and one token point per recorded direction', () => {
		const started = mapRunStartedMetric({
			runId: RUN_ID,
			teamId: TEAM_ID,
			projectId: PROJECT_ID,
			agentMemberId: AGENT_ID,
			taskId: TASK_ID,
			triggerSource: 'task',
			receivedAt: '2026-11-20T00:00:00.000Z',
		});
		expect(started).toMatchObject({ kind: 'run_started', triggerSource: 'task' });

		const samples = mapRunFinishedMetrics(record());
		expect(samples.map((s) => s.kind)).toEqual([
			'run_completed',
			'run_duration',
			'tokens',
			'tokens',
			'tokens',
			'tokens',
		]);
		const tokenDirections = samples
			.filter((s) => s.kind === 'tokens')
			.map((s) => (s.kind === 'tokens' ? s.direction : ''));
		expect(tokenDirections).toEqual(['input', 'output', 'cache_read', 'cache_creation']);
	});

	it('omits token points for null cache buckets', () => {
		const samples = mapRunFinishedMetrics(
			record({ tokens: { input: 10, output: 20, cacheRead: null, cacheCreation: null } }),
		);
		expect(samples.filter((s) => s.kind === 'tokens')).toHaveLength(2);
	});
});
