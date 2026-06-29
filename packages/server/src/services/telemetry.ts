import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import type { PGlite } from '@electric-sql/pglite';
import { TaskStatus } from '@hezo/shared';
import { getSystemMeta } from '../lib/system-meta';
import { logger } from '../logger';
import { HEZO_VERSION } from '../version';

const log = logger.child('telemetry');

/** `system_meta` key holding this instance's anonymous, randomly-generated id. */
export const INSTANCE_ID_KEY = 'instance_id';

/** Where daily reports are posted unless overridden via config. */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://hezo.ai/api/telemetry';

/**
 * The anonymous daily usage snapshot sent to the central collector. Aggregate
 * counts only — never names, prompts, repo/user identities, secrets, or any
 * monetary figure. The collector stamps the receipt date itself (one row per
 * instance per UTC day), so no timestamp is sent from here.
 */
export interface TelemetryPayload {
	/** Stable random UUID for this install — lets the collector de-dupe and count distinct installs. */
	instance_id: string;
	version: string;
	os: string;
	arch: string;
	teams: number;
	projects: number;
	agents: number;
	tasks_total: number;
	tasks_done: number;
	/** Open tasks: everything not in a terminal (done / cancelled) status. */
	tasks_active: number;
	tasks_completed_24h: number;
	runs_24h: number;
	input_tokens_24h: number;
	output_tokens_24h: number;
	/** Agent-run count by AI provider over the last 24h, e.g. `{ anthropic: 12, openai: 3 }`. */
	provider_mix: Record<string, number>;
}

/**
 * Read this instance's anonymous id, generating and persisting one on first
 * call. The insert is `ON CONFLICT DO NOTHING` and re-reads, so concurrent
 * callers converge on the same id rather than clobbering it — the id is stable
 * for the life of the data dir.
 */
export async function getOrCreateInstanceId(db: PGlite): Promise<string> {
	const existing = await getSystemMeta(db, INSTANCE_ID_KEY);
	if (existing) return existing;
	const id = randomUUID();
	await db.query(
		`INSERT INTO system_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
		[INSTANCE_ID_KEY, id],
	);
	return (await getSystemMeta(db, INSTANCE_ID_KEY)) ?? id;
}

/**
 * Assemble the anonymous aggregate payload from instance-wide tables. These are
 * counts across every team — no per-team filter — since the snapshot describes
 * the whole installation. Token sums are read as `float8` (exact for integers
 * well past any daily volume) to avoid bigint-as-string surprises.
 */
export async function buildTelemetryPayload(db: PGlite): Promise<TelemetryPayload> {
	const instanceId = await getOrCreateInstanceId(db);

	const counts = await db.query<{ teams: number; projects: number; agents: number }>(
		`SELECT
		   (SELECT COUNT(*) FROM teams)::int          AS teams,
		   (SELECT COUNT(*) FROM projects)::int       AS projects,
		   (SELECT COUNT(*) FROM member_agents)::int  AS agents`,
	);

	const tasksByStatus = await db.query<{ status: string; count: number }>(
		`SELECT status::text AS status, COUNT(*)::int AS count FROM tasks GROUP BY status`,
	);
	const statusCount = new Map(tasksByStatus.rows.map((r) => [r.status, Number(r.count)]));
	const tasksTotal = [...statusCount.values()].reduce((a, b) => a + b, 0);
	const tasksDone = statusCount.get(TaskStatus.Done) ?? 0;
	const tasksCancelled = statusCount.get(TaskStatus.Cancelled) ?? 0;
	const tasksActive = tasksTotal - tasksDone - tasksCancelled;

	const completed = await db.query<{ count: number }>(
		`SELECT COUNT(*)::int AS count FROM tasks
		 WHERE status = $1 AND updated_at >= now() - INTERVAL '24 hours'`,
		[TaskStatus.Done],
	);

	const runs = await db.query<{ count: number; input_tokens: number; output_tokens: number }>(
		`SELECT COUNT(*)::int AS count,
		        COALESCE(SUM(input_tokens), 0)::float8  AS input_tokens,
		        COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
		 FROM heartbeat_runs
		 WHERE started_at >= now() - INTERVAL '24 hours'`,
	);

	const providers = await db.query<{ provider: string | null; count: number }>(
		`SELECT provider::text AS provider, COUNT(*)::int AS count
		 FROM heartbeat_runs
		 WHERE started_at >= now() - INTERVAL '24 hours'
		 GROUP BY provider`,
	);
	const providerMix: Record<string, number> = {};
	for (const row of providers.rows) {
		if (row.provider) providerMix[row.provider] = Number(row.count);
	}

	return {
		instance_id: instanceId,
		version: HEZO_VERSION,
		os: platform(),
		arch: arch(),
		teams: Number(counts.rows[0]?.teams ?? 0),
		projects: Number(counts.rows[0]?.projects ?? 0),
		agents: Number(counts.rows[0]?.agents ?? 0),
		tasks_total: tasksTotal,
		tasks_done: tasksDone,
		tasks_active: tasksActive,
		tasks_completed_24h: Number(completed.rows[0]?.count ?? 0),
		runs_24h: Number(runs.rows[0]?.count ?? 0),
		input_tokens_24h: Number(runs.rows[0]?.input_tokens ?? 0),
		output_tokens_24h: Number(runs.rows[0]?.output_tokens ?? 0),
		provider_mix: providerMix,
	};
}

/**
 * Build and POST the daily snapshot. Fail-soft: a network/egress/rate-limit
 * error or a non-2xx response is logged at warn and swallowed — telemetry must
 * never disrupt the instance. Mirrors the update-check's direct `fetch` (server
 * outbound calls do not route through the agent egress proxy).
 */
export async function reportTelemetry(db: PGlite, opts: { endpoint: string }): Promise<void> {
	try {
		const payload = await buildTelemetryPayload(db);
		const res = await fetch(opts.endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': `hezo/${HEZO_VERSION}`,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) {
			log.warn(`Telemetry report rejected (status ${res.status})`);
			return;
		}
		log.debug('Telemetry report sent');
	} catch (err) {
		log.warn('Telemetry report failed', err);
	}
}
