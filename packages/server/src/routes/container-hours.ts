import { HoursBucket, isHoursBucket, SANDBOX_BACKEND_KIND, SandboxBackend } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { getMonthlyContainerHours, setMonthlyContainerHours } from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import {
	containerHoursByProject,
	containerHoursSeries,
	containerHoursTotals,
} from '../services/container-hours';
import { getStoredSandboxBackend } from '../services/sandbox/backend-store';

export const containerHoursRoutes = new Hono<Env>();

/**
 * Container hours - what the instance's containers actually cost in uptime, as
 * opposed to what its agents cost in tokens.
 *
 * **A different quantity from `agent-hours`, and the one that gets billed.** That
 * endpoint sums per-agent run wall clock, which over-counts (concurrent runs
 * share one container) and under-counts (build time, warm-idle time and the
 * assistant chat's container are all billed and none of them is a run). This
 * reads the uptime ledger instead: one row per running stretch, written by the
 * pool's own state transitions.
 *
 * **No MCP twin**, like `agent-hours`, `audit-log` and `budget-status` beside
 * it: this is an operator's read of what the instance is spending, and an agent
 * asking how many container-hours are left would be acting on a figure it has no
 * way to change.
 */

/** Shared bucket parsing, so both scopes reject the same values the same way. */
function readBucket(raw: string | undefined): HoursBucket | null {
	const requested = raw ?? HoursBucket.Day;
	return isHoursBucket(requested) ? requested : null;
}

containerHoursRoutes.get('/projects/:projectId/container-hours', async (c) => {
	const bucket = readBucket(c.req.query('bucket'));
	if (!bucket) return err(c, 'INVALID_REQUEST', 'bucket must be one of day, week, month', 400);

	const db = c.get('db');
	// `c.var.projectId` is the resolved UUID from `requireProjectAccessMiddleware`,
	// which has already checked this caller may see this project.
	const projectId = c.get('projectId') as string;

	const [buckets, totals] = await Promise.all([
		containerHoursSeries(db, bucket, projectId),
		containerHoursTotals(db, projectId),
	]);
	return ok(c, { bucket, buckets, totals });
});

/**
 * The instance-wide view, split by project.
 *
 * **Superuser-only**, for the same reason `/containers` is: it crosses every
 * project on the instance, so a board user scoped to one team must not reach it
 * and the per-team gate that protects `/api/projects/:projectId/...` has nothing
 * to check here.
 */
containerHoursRoutes.get('/container-hours', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const bucket = readBucket(c.req.query('bucket'));
	if (!bucket) return err(c, 'INVALID_REQUEST', 'bucket must be one of day, week, month', 400);

	const db = c.get('db');
	const [buckets, byProject, totals, monthlyHours, backend] = await Promise.all([
		containerHoursSeries(db, bucket, null),
		containerHoursByProject(db, bucket),
		containerHoursTotals(db, null),
		getMonthlyContainerHours(db),
		getStoredSandboxBackend(db),
	]);

	return ok(c, {
		bucket,
		buckets,
		by_project: byProject,
		totals,
		monthly_hours: monthlyHours,
		// What the *cap* is worth showing for. On a local daemon a container-hour
		// costs nothing anyone bills, so the page renders the series as
		// observability and leaves the cap controls out rather than inviting an
		// operator to budget a resource that is free.
		metered: SANDBOX_BACKEND_KIND[backend ?? SandboxBackend.Docker] === 'remote',
	});
});

/** Set or clear (0) the monthly container-hours cap. Superuser-only, like the read. */
containerHoursRoutes.patch('/container-hours', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const body: { monthly_hours?: unknown } = await c.req
		.json<{ monthly_hours?: unknown }>()
		.catch(() => ({}));
	const raw = body.monthly_hours;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
		return err(
			c,
			'INVALID_REQUEST',
			'monthly_hours must be a number of hours, or 0 for no cap',
			400,
		);
	}

	const monthlyHours = await setMonthlyContainerHours(c.get('db'), raw);
	return ok(c, { monthly_hours: monthlyHours });
});
