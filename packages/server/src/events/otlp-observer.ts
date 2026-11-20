import type { HeartbeatRunStatus } from '@hezo/shared';
import type { OtlpConfig } from '../config/types';
import type { Db } from '../db/database';
import { trackBackground } from '../lib/background';
import { logger } from '../logger';
import type { OtlpExporter, RunFinishRecord, RunStartRecord } from '../services/otlp/exporter';
import type { SpanNames } from '../services/otlp/mapping';
import type { DomainEventBus } from './bus';
import type { DomainEvent } from './types';

const log = logger.child('otlp-observer');

/**
 * `agent_run.started` carries the trigger source that completion does not, and
 * the start time the row can still be missing. The map is bounded because a
 * run that never completes must not grow it without limit; an evicted entry
 * loses only those two fallbacks, since the row read is the primary path.
 */
interface RunReceipt {
	runId: string;
	teamId: string;
	projectId: string;
	agentMemberId: string;
	taskId: string | null;
	triggerSource: string | null;
	receivedAt: string;
	seenAt: number;
}

const MAX_RECEIPTS = 1000;
const RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_CACHE_TTL_MS = 60 * 1000;
const MAX_NAME_CACHE_ENTRIES = 1000;

interface FinishedRow {
	started_at: string | null;
	finished_at: string | null;
	exit_code: number | null;
	error: string | null;
	input_tokens: string | number;
	output_tokens: string | number;
	cache_read_tokens: string | number | null;
	cache_creation_tokens: string | number | null;
	tool_call_counts: Record<string, number> | null;
	model: string | null;
	provider: string | null;
	stop_reason: string | null;
	retry_of_run_id: string | null;
	team_id: string;
	member_id: string;
	task_id: string | null;
	project_id: string | null;
}

const FINISHED_RUN_SQL = `
SELECT hr.started_at, hr.finished_at, hr.exit_code, hr.error,
       hr.input_tokens, hr.output_tokens, hr.cache_read_tokens, hr.cache_creation_tokens,
       hr.tool_call_counts, hr.model, hr.provider, hr.stop_reason, hr.retry_of_run_id,
       hr.team_id, hr.member_id, hr.task_id,
       COALESCE(t.project_id, p.id) AS project_id
  FROM heartbeat_runs hr
  LEFT JOIN tasks t    ON t.id = hr.task_id
  LEFT JOIN projects p ON p.team_id = hr.team_id
 WHERE hr.id = $1`;

const NAMES_SQL = `
SELECT p.name AS project_name, tm.name AS team_name, ma.title AS agent_name
  FROM projects p
  LEFT JOIN teams tm        ON tm.id = p.team_id
  LEFT JOIN member_agents ma ON ma.id = $2::uuid
 WHERE p.id = $1`;

function toCount(value: string | number | null): number | null {
	if (value === null) return null;
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

function sumToolCalls(counts: Record<string, number> | null): number | null {
	if (counts === null) return null;
	let total = 0;
	for (const value of Object.values(counts)) {
		if (typeof value === 'number' && Number.isFinite(value)) total += value;
	}
	return total;
}

type EventOf<T extends DomainEvent['type']> = Extract<DomainEvent, { type: T }>;

/**
 * Subscribes to run lifecycle events and turns them into exporter records.
 *
 * Mirrors `registerAuditObserver`: one subscription, a switch on the event
 * type, and nothing thrown back into the bus. The completion read is async, so
 * it is tracked with `trackBackground` and awaited by the exporter's flush
 * during shutdown.
 *
 * Only subscribed when the exporter is not `disabled`, so a disabled exporter
 * costs the run path nothing beyond the bus's existing handler loop.
 */
export function registerOtlpObserver(
	events: DomainEventBus,
	db: Db,
	exporter: OtlpExporter,
	config: OtlpConfig,
): void {
	const receipts = new Map<string, RunReceipt>();
	const nameCache = new Map<string, { names: SpanNames; at: number }>();

	function pruneReceipts(now: number): void {
		for (const [runId, receipt] of receipts) {
			if (now - receipt.seenAt > RECEIPT_TTL_MS) receipts.delete(runId);
		}
		while (receipts.size > MAX_RECEIPTS) {
			const oldest = receipts.keys().next();
			if (oldest.done) break;
			receipts.delete(oldest.value);
		}
	}

	function onStarted(event: EventOf<'agent_run.started'>): void {
		const projectId = event.projectId ?? null;
		if (projectId === null || event.teamId === null) {
			// The allowlist is a per-project gate; there is no honest value to check.
			exporter.emitMetrics({
				kind: 'dropped',
				dropReason: 'unresolved_project',
				value: 1,
				at: new Date().toISOString(),
			});
			return;
		}
		const receivedAt = new Date().toISOString();
		const seenAt = Date.now();
		receipts.set(event.runId, {
			runId: event.runId,
			teamId: event.teamId,
			projectId,
			agentMemberId: event.agentMemberId,
			taskId: event.taskId,
			triggerSource: event.triggerSource,
			receivedAt,
			seenAt,
		});
		pruneReceipts(seenAt);
		const record: RunStartRecord = {
			runId: event.runId,
			teamId: event.teamId,
			projectId,
			agentMemberId: event.agentMemberId,
			taskId: event.taskId,
			triggerSource: event.triggerSource,
			receivedAt,
		};
		exporter.emitRunStarted(record);
	}

	async function readNames(projectId: string, agentMemberId: string): Promise<SpanNames> {
		const key = `${projectId}:${agentMemberId}`;
		const now = Date.now();
		const cached = nameCache.get(key);
		if (cached && now - cached.at <= NAME_CACHE_TTL_MS) return cached.names;
		const { rows } = await db.query<{
			project_name: string | null;
			team_name: string | null;
			agent_name: string | null;
		}>(NAMES_SQL, [projectId, agentMemberId]);
		const row = rows[0];
		const names: SpanNames = {
			project: row?.project_name ?? null,
			team: row?.team_name ?? null,
			agent: row?.agent_name ?? null,
		};
		nameCache.set(key, { names, at: now });
		while (nameCache.size > MAX_NAME_CACHE_ENTRIES) {
			const oldest = nameCache.keys().next();
			if (oldest.done) break;
			nameCache.delete(oldest.value);
		}
		return names;
	}

	async function onCompleted(event: EventOf<'agent_run.completed'>): Promise<void> {
		const receipt = receipts.get(event.runId);
		receipts.delete(event.runId);
		const dropped = (reason: 'unresolved_project' | 'unresolved_time' | 'export_error') =>
			exporter.emitMetrics({
				kind: 'dropped',
				dropReason: reason,
				value: 1,
				at: new Date().toISOString(),
			});

		let row: FinishedRow | undefined;
		try {
			const { rows } = await db.query<FinishedRow>(FINISHED_RUN_SQL, [event.runId]);
			row = rows[0];
		} catch (e) {
			log.error(`Failed to read finished run ${event.runId} for OTLP export:`, e);
			dropped('export_error');
			return;
		}
		if (!row) {
			dropped('export_error');
			return;
		}

		const projectId = row.project_id ?? event.projectId ?? receipt?.projectId ?? null;
		if (projectId === null) {
			dropped('unresolved_project');
			return;
		}
		const finishedAt = row.finished_at;
		const startedAt = row.started_at ?? receipt?.receivedAt ?? row.finished_at;
		if (finishedAt === null || startedAt === null) {
			dropped('unresolved_time');
			return;
		}

		const record: RunFinishRecord = {
			runId: event.runId,
			teamId: row.team_id,
			projectId,
			agentMemberId: row.member_id,
			taskId: row.task_id,
			status: event.status as HeartbeatRunStatus,
			exitCode: row.exit_code ?? event.exitCode ?? null,
			errorText: row.error ?? event.error ?? null,
			startedAt,
			finishedAt,
			provider: row.provider,
			model: row.model,
			tokens: {
				input: toCount(row.input_tokens) ?? 0,
				output: toCount(row.output_tokens) ?? 0,
				cacheRead: toCount(row.cache_read_tokens),
				cacheCreation: toCount(row.cache_creation_tokens),
			},
			toolCalls: sumToolCalls(row.tool_call_counts),
			stopReason: row.stop_reason,
			retryOfRunId: row.retry_of_run_id,
			triggerSource: receipt?.triggerSource ?? null,
		};

		if (config.includeNames) {
			try {
				record.names = await readNames(projectId, record.agentMemberId);
			} catch (e) {
				// Names are optional decoration; losing them must not lose the span.
				log.debug(`Could not read display names for run ${event.runId}:`, e);
			}
		}

		exporter.emitRunFinished(record);
	}

	events.subscribe((event) => {
		switch (event.type) {
			case 'agent_run.started':
				onStarted(event);
				return;
			case 'agent_run.completed':
				trackBackground(
					onCompleted(event).catch((e) => log.error(`Failed to export run ${event.runId}:`, e)),
				);
				return;
			default:
				return;
		}
	});
}
