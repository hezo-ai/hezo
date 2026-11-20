import type { Db } from '../../db/database';
import type { OtlpExporterHandle } from './exporter';
import type { MetricSample } from './mapping';

/** The timer handle and its one method: the runtime stops it before flushing. */
export interface ActiveRunGauge {
	stop(): void;
}

const ACTIVE_RUNS_SQL = `
SELECT COALESCE(t.project_id, p.id) AS project_id, COUNT(*)::int AS active
  FROM heartbeat_runs hr
  LEFT JOIN tasks t    ON t.id = hr.task_id
  LEFT JOIN projects p ON p.team_id = hr.team_id
 WHERE hr.status = 'running'
   AND COALESCE(t.project_id, p.id) IS NOT NULL
   AND ($1::uuid[] IS NULL OR COALESCE(t.project_id, p.id) = ANY($1::uuid[]))
 GROUP BY 1`;

/**
 * A one-minute lookback covers a 30-second tick plus slack, so a row that ends
 * near a boundary is seen by two ticks. `id` is required to tell the second
 * sighting from a new row; it is not part of the exported sample.
 */
const UPTIME_SQL = `
SELECT id, project_id, end_reason,
       EXTRACT(EPOCH FROM (ended_at - started_at))::float8 AS seconds
  FROM container_uptime_entries
 WHERE ended_at IS NOT NULL
   AND ended_at > now() - $2::interval
   AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`;

const UPTIME_LOOKBACK = '1 minute';

interface ActiveRow {
	project_id: string;
	active: number;
}

interface UptimeRow {
	id: string;
	project_id: string | null;
	end_reason: string | null;
	seconds: number;
}

/**
 * Samples running runs and container uptime every `intervalMs` and hands each
 * project's value to the exporter.
 *
 * The active gauge is last-value: a project that drops to zero is emitted once
 * with `0` and then omitted, because an omitted point means "carry the last
 * value", not "zero". Uptime is a sum, so each tick emits only the rows it has
 * not already counted; the exporter accumulates the total.
 *
 * Both queries filter by the exporter's allowlist so a project that can never
 * export cannot make the gauge do work.
 */
export function startActiveRunGauge(
	db: Db,
	exporter: OtlpExporterHandle,
	intervalMs: number,
): ActiveRunGauge {
	const allowlist = exporter.allowedProjectIds();
	const params = allowlist === null ? [null] : [allowlist];
	const seenEntryIds = new Set<string>();
	const activeProjects = new Set<string>();
	let ticking = false;

	async function sample(): Promise<void> {
		const at = new Date().toISOString();

		const active = await db.query<ActiveRow>(ACTIVE_RUNS_SQL, params);
		const current = new Set<string>();
		for (const row of active.rows) {
			current.add(row.project_id);
			activeProjects.add(row.project_id);
			exporter.emitMetrics({
				kind: 'active',
				projectId: row.project_id,
				value: row.active,
				at,
			});
		}
		for (const projectId of activeProjects) {
			if (current.has(projectId)) continue;
			activeProjects.delete(projectId);
			exporter.emitMetrics({ kind: 'active', projectId, value: 0, at });
		}

		const uptime = await db.query<UptimeRow>(UPTIME_SQL, [...params, UPTIME_LOOKBACK]);
		const thisTick = new Set<string>();
		for (const row of uptime.rows) {
			thisTick.add(row.id);
			if (seenEntryIds.has(row.id)) continue;
			// The query's allowlist already excludes these; the null guard keeps the
			// fail-closed rule if a wildcard allowlist ever lets one through.
			if (row.project_id === null) continue;
			const samplePoint: MetricSample = {
				kind: 'uptime',
				projectId: row.project_id,
				endReason: row.end_reason ?? 'unknown',
				value: row.seconds,
				at,
			};
			exporter.emitMetrics(samplePoint);
		}
		// Replace rather than grow: the lookback window bounds this set, so rows
		// that aged out can never return.
		seenEntryIds.clear();
		for (const id of thisTick) seenEntryIds.add(id);
	}

	async function tick(): Promise<void> {
		if (ticking) return;
		ticking = true;
		try {
			await sample();
		} catch {
			// Best effort: a gauge read that fails must not take down the server or
			// stop later ticks.
		} finally {
			ticking = false;
		}
	}

	const timer = setInterval(() => {
		void tick();
	}, intervalMs);
	// Never hold the process open for a gauge.
	timer.unref?.();

	return {
		stop(): void {
			clearInterval(timer);
		},
	};
}
