import { createHash } from 'node:crypto';
import type { HeartbeatRunStatus } from '@hezo/shared';
import type { RunFinishRecord, RunStartRecord } from './exporter';

/**
 * Pure translation from a run record to the OTLP span and metric points Hezo
 * exports. No I/O, no database, no clock of its own: the caller passes the
 * record it read and the time it sampled at.
 *
 * The span object is built as a **closed literal**. It never spreads a row or
 * copies a `details` bag, so a column added to `heartbeat_runs` stays invisible
 * to export until someone adds a line here. That is the privacy model: a field
 * must be named in the attribute table to leave the instance.
 */

/** One OTLP `KeyValue` attribute. */
export interface OtlpAttribute {
	key: string;
	value: { stringValue: string } | { intValue: string };
}

/** The subset of an OTLP span this exporter produces. */
export interface MappedSpan {
	traceId: string;
	spanId: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttribute[];
	status: { code: number };
}

/** The closed set of drop reasons; every counter value comes from here. */
export type DropReason =
	| 'queue_full'
	| 'stale'
	| 'project_not_allowed'
	| 'unresolved_project'
	| 'unresolved_time'
	| 'blocked'
	| 'missing_secret'
	| 'rejected'
	| 'cardinality_cap'
	| 'shutdown_timeout'
	| 'export_error';

export type FailureClass = 'none' | 'cancelled' | 'timeout' | 'run_size' | 'nonzero_exit' | 'error';

export type TokenDirection = 'input' | 'output' | 'cache_read' | 'cache_creation';

interface MetricBase {
	at: string;
}

/**
 * A discriminated union: each kind states its own fields, so a caller cannot
 * construct a point with a dimension the metric does not have.
 *
 * `active` and `uptime` carry no team id because their queries select only a
 * project; the exporter resolves the team from its memoised project map when the
 * point is serialized.
 */
export type MetricSample =
	| (MetricBase & {
			kind: 'run_started';
			teamId: string;
			projectId: string;
			agentMemberId: string;
			triggerSource: string | null;
	  })
	| (MetricBase & {
			kind: 'run_completed';
			teamId: string;
			projectId: string;
			agentMemberId: string;
			status: HeartbeatRunStatus;
			failureClass: FailureClass;
	  })
	| (MetricBase & {
			kind: 'run_duration';
			teamId: string;
			projectId: string;
			agentMemberId: string;
			status: HeartbeatRunStatus;
			value: number;
	  })
	| (MetricBase & {
			kind: 'tokens';
			teamId: string;
			projectId: string;
			agentMemberId: string;
			provider: string | null;
			model: string | null;
			direction: TokenDirection;
			value: number;
	  })
	| (MetricBase & { kind: 'active'; projectId: string; value: number })
	| (MetricBase & { kind: 'uptime'; projectId: string; endReason: string; value: number })
	| (MetricBase & { kind: 'dropped'; dropReason: DropReason; value: number });

/** The fixed value an all-zero run id is remapped to, so neither id is all zero. */
const ZERO_REMAP_UUID = '00000000-0000-4000-8000-000000000001';

/** Caps are applied on code-point boundaries, so a multi-byte character is never split. */
function cap(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return Array.from(value).slice(0, maxChars).join('');
}

/** First line only, then the error cap, then placeholder names are scrubbed. */
function exportableError(raw: string): string {
	const r = raw.indexOf('\r');
	const n = raw.indexOf('\n');
	const cut = r === -1 ? n : n === -1 ? r : Math.min(r, n);
	const firstLine = cut === -1 ? raw : raw.slice(0, cut);
	return cap(firstLine, 512).replace(/__HEZO_SECRET_[A-Z0-9_]+__/g, '[placeholder]');
}

/** `succeeded` -> OK, `failed`/`timed_out` -> ERROR, `cancelled` -> UNSET. */
export function spanStatusCode(status: HeartbeatRunStatus): number {
	if (status === 'succeeded') return 1;
	if (status === 'failed' || status === 'timed_out') return 2;
	return 0;
}

/**
 * A bounded derivation for the completion counter. Never the error text: six
 * values, so the metric's cardinality cannot follow what a run happened to print.
 */
export function failureClass(run: {
	status: HeartbeatRunStatus;
	stopReason: string | null;
	exitCode: number | null;
}): FailureClass {
	switch (run.status) {
		case 'succeeded':
			return 'none';
		case 'cancelled':
			return 'cancelled';
		case 'timed_out':
			return 'timeout';
		case 'failed':
			if (run.stopReason === 'token_ceiling' || run.stopReason === 'tool_call_ceiling') {
				return 'run_size';
			}
			return typeof run.exitCode === 'number' && run.exitCode !== 0 ? 'nonzero_exit' : 'error';
		default:
			// queued/running are not terminal and never reach export; map them to the
			// generic class rather than inventing a seventh value.
			return 'error';
	}
}

/** The run's wall-clock duration in milliseconds, never negative. */
export function runDurationMs(startedAt: string, finishedAt: string): number {
	const started = Date.parse(startedAt);
	const finished = Date.parse(finishedAt);
	if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
	return Math.max(0, finished - started);
}

/** ISO timestamp to OTLP's int64 nanoseconds, as a decimal string. */
export function toUnixNano(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return '0';
	return (BigInt(ms) * 1_000_000n).toString();
}

/**
 * Deterministic ids from the run UUID: the full 16 bytes are the trace id and
 * the first 8 are the span id. A retry that reuses a row keeps its span; a
 * retried run gets a new row and therefore a new trace.
 */
export function runTraceIds(runId: string): { traceId: string; spanId: string } {
	const stripped = runId.toLowerCase().replaceAll('-', '');
	let hex = /^[0-9a-f]{32}$/.test(stripped) ? stripped : '';
	if (hex === '' || /^0+$/.test(hex)) {
		hex = ZERO_REMAP_UUID.replaceAll('-', '');
	}
	return { traceId: hex, spanId: hex.slice(0, 16) };
}

/**
 * Sampling is deterministic per run id, so the same run is sampled or not on
 * every retry and after every restart, and the decision is explainable from the
 * id. Spans only; counters are never sampled.
 */
export function isSampledRun(runId: string, sampleRatio: number): boolean {
	if (sampleRatio >= 1) return true;
	const hash = createHash('sha256').update(runId).digest();
	return hash.readUInt32BE(0) / 2 ** 32 < sampleRatio;
}

export interface SpanNames {
	project: string | null;
	team: string | null;
	agent: string | null;
}

export interface SpanMappingOptions {
	includeNames: boolean;
	includeErrorText: boolean;
	/** Present only when `includeNames`; the observer does not read names otherwise. */
	names?: SpanNames;
}

/**
 * The one run span, built at completion. `hezo.tokens.input` keeps the schema's
 * meaning (total input, including both cache buckets); the cache attributes are
 * emitted only when the row recorded them.
 */
export function mapRunSpan(run: RunFinishRecord, opts: SpanMappingOptions): MappedSpan {
	const { traceId, spanId } = runTraceIds(run.runId);
	const attributes: OtlpAttribute[] = [];
	const str = (key: string, value: string): void => {
		attributes.push({ key, value: { stringValue: value } });
	};
	const int = (key: string, value: number): void => {
		attributes.push({ key, value: { intValue: String(value) } });
	};

	str('hezo.run.id', run.runId);
	str('hezo.team.id', run.teamId);
	str('hezo.project.id', run.projectId);
	if (run.taskId !== null) str('hezo.task.id', run.taskId);
	str('hezo.agent.id', run.agentMemberId);
	str('hezo.run.status', run.status);
	if (run.exitCode !== null) int('hezo.run.exit_code', run.exitCode);
	if (run.triggerSource !== null) str('hezo.run.trigger_source', run.triggerSource);
	if (run.retryOfRunId !== null) str('hezo.run.retry_of', run.retryOfRunId);
	if (run.provider !== null) str('hezo.provider', run.provider);
	if (run.model !== null) str('hezo.model', cap(run.model, 256));
	int('hezo.tokens.input', run.tokens.input);
	int('hezo.tokens.output', run.tokens.output);
	if (run.tokens.cacheRead !== null) int('hezo.tokens.cache_read', run.tokens.cacheRead);
	if (run.tokens.cacheCreation !== null) {
		int('hezo.tokens.cache_creation', run.tokens.cacheCreation);
	}
	if (run.stopReason !== null) str('hezo.run.stop_reason', cap(run.stopReason, 256));
	if (run.toolCalls !== null) int('hezo.tool.calls', run.toolCalls);
	if (opts.includeErrorText && run.errorText !== null) {
		str('hezo.run.error', exportableError(run.errorText));
	}
	if (opts.includeNames && opts.names) {
		if (opts.names.project !== null) str('hezo.project.name', cap(opts.names.project, 256));
		if (opts.names.team !== null) str('hezo.team.name', cap(opts.names.team, 256));
		if (opts.names.agent !== null) str('hezo.agent.name', cap(opts.names.agent, 256));
	}

	return {
		traceId,
		spanId,
		name: 'hezo.agent_run',
		kind: 1,
		startTimeUnixNano: toUnixNano(run.startedAt),
		endTimeUnixNano: toUnixNano(run.finishedAt),
		attributes,
		status: { code: spanStatusCode(run.status) },
	};
}

/** The start-event counter point. */
export function mapRunStartedMetric(run: RunStartRecord): MetricSample {
	return {
		kind: 'run_started',
		teamId: run.teamId,
		projectId: run.projectId,
		agentMemberId: run.agentMemberId,
		triggerSource: run.triggerSource,
		at: run.receivedAt,
	};
}

/**
 * Completion points: the counter, the duration histogram sample, and one token
 * point per direction the row recorded. Emitted in full even when the span is
 * sampled out: a sampled counter would disagree with the database for no reason
 * an operator could see.
 */
export function mapRunFinishedMetrics(run: RunFinishRecord): MetricSample[] {
	const samples: MetricSample[] = [
		{
			kind: 'run_completed',
			teamId: run.teamId,
			projectId: run.projectId,
			agentMemberId: run.agentMemberId,
			status: run.status,
			failureClass: failureClass(run),
			at: run.finishedAt,
		},
		{
			kind: 'run_duration',
			teamId: run.teamId,
			projectId: run.projectId,
			agentMemberId: run.agentMemberId,
			status: run.status,
			value: runDurationMs(run.startedAt, run.finishedAt),
			at: run.finishedAt,
		},
	];
	const directions: Array<[TokenDirection, number | null]> = [
		['input', run.tokens.input],
		['output', run.tokens.output],
		['cache_read', run.tokens.cacheRead],
		['cache_creation', run.tokens.cacheCreation],
	];
	for (const [direction, value] of directions) {
		if (value === null) continue;
		samples.push({
			kind: 'tokens',
			teamId: run.teamId,
			projectId: run.projectId,
			agentMemberId: run.agentMemberId,
			provider: run.provider,
			model: run.model === null ? null : cap(run.model, 256),
			direction,
			value,
			at: run.finishedAt,
		});
	}
	return samples;
}
