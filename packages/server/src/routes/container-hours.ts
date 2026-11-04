import {
	type BudgetWindowsContainerSeconds,
	CONTAINER_HOURS_BUDGET_FIELDS,
	HoursBucket,
	isHoursBucket,
	SANDBOX_BACKEND_KIND,
	SandboxBackend,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { runtimeConfig } from '../config/runtime';
import type { Db } from '../db/database';
import { broadcastChange } from '../lib/broadcast';
import { containerHoursBudgetWrite } from '../lib/budget-validation';
import { err, ok } from '../lib/response';
import {
	getMonthlyContainerHours,
	isPinned,
	pinnedSetting,
	setMonthlyContainerHours,
} from '../lib/system-meta';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';
import { getProjectHoursBudgetStatus } from '../services/budget';
import {
	containerHoursByProject,
	containerHoursSeries,
	containerHoursTotals,
	projectHoursLimitsTotal,
} from '../services/container-hours';
import { getSandboxBackendSetting } from '../services/sandbox/backend-store';

export const containerHoursRoutes = new Hono<Env>();

/** The rendered half of the policy - a name and an optional link, never anything to branch on. */
function policyBanner(): { managed_by: string; manage_url: string | null } | null {
	const policy = runtimeConfig().policy;
	if (!policy) return null;
	return { managed_by: policy.managedBy, manage_url: policy.manageUrl ?? null };
}

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

	const [buckets, totals, budget, metered] = await Promise.all([
		containerHoursSeries(db, bucket, projectId),
		containerHoursTotals(db, projectId),
		getProjectHoursBudgetStatus(db, projectId),
		isMetered(db),
	]);
	return ok(c, { bucket, buckets, totals, budget, metered });
});

/**
 * Whether a container-hour is worth budgeting on this instance: true on a
 * remote backend, which bills uptime, and false on a local daemon, where it
 * costs nothing anyone bills. The page renders hours as observability either
 * way and offers the allowance and the per-project limits only where they mean
 * something.
 */
async function isMetered(db: Db): Promise<boolean> {
	const backend = await getSandboxBackendSetting(db);
	return SANDBOX_BACKEND_KIND[backend ?? SandboxBackend.Docker] === 'remote';
}

/**
 * Set a project's hours budget - any of its three windows, in container-seconds,
 * 0 for no limit. Answers with the budget as the read does.
 *
 * **Superuser-only**, unlike the token budget, which a project's admins edit
 * with the project. The hours are one pool every project draws on, so a project
 * admin raising their own limit would be taking hours from the others; deciding
 * where the pool goes is the instance owner's call.
 *
 * **Never HQ.** HQ draws on the instance allowance itself, which is set on its
 * own Hours tab, and a second limit there would be a second number for the same
 * thing.
 *
 * Merged over the stored trio and held to the token budget's floors, so a
 * partial write is checked against what it leaves rather than what it sent.
 */
containerHoursRoutes.patch('/projects/:projectId/container-hours', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const teamId = c.get('teamId') as string;
	const existing = await db.query<BudgetWindowsContainerSeconds & { is_internal: boolean }>(
		`SELECT is_internal, ${CONTAINER_HOURS_BUDGET_FIELDS.join(', ')}
		   FROM projects WHERE id = $1 AND team_id = $2`,
		[projectId, teamId],
	);
	const row = existing.rows[0];
	if (!row) return err(c, 'NOT_FOUND', 'Project not found', 404);
	if (row.is_internal) {
		return err(
			c,
			'INVALID_REQUEST',
			"HQ has no hours budget: it draws on the instance's container-hours allowance, set with PATCH /api/container-hours.",
			400,
		);
	}

	const body: Record<string, unknown> = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({}));
	const stored: BudgetWindowsContainerSeconds = {
		daily_budget_container_seconds: Number(row.daily_budget_container_seconds),
		weekly_budget_container_seconds: Number(row.weekly_budget_container_seconds),
		monthly_budget_container_seconds: Number(row.monthly_budget_container_seconds),
	};
	const write = containerHoursBudgetWrite(body, stored);
	if ('error' in write) return err(c, 'INVALID_REQUEST', write.error, 400);
	if (!write.supplied) {
		return err(
			c,
			'INVALID_REQUEST',
			`Send at least one of ${CONTAINER_HOURS_BUDGET_FIELDS.join(', ')}.`,
			400,
		);
	}

	// Never write a row that has not changed: the embedded database does not
	// vacuum, and a no-op update is storage spent on nothing.
	const changed = CONTAINER_HOURS_BUDGET_FIELDS.some(
		(field) => write.trio[field] !== stored[field],
	);
	if (changed) {
		const updated = await db.query<Record<string, unknown>>(
			`UPDATE projects
			    SET daily_budget_container_seconds = $1,
			        weekly_budget_container_seconds = $2,
			        monthly_budget_container_seconds = $3
			  WHERE id = $4
			  RETURNING *`,
			[
				write.trio.daily_budget_container_seconds,
				write.trio.weekly_budget_container_seconds,
				write.trio.monthly_budget_container_seconds,
				projectId,
			],
		);
		broadcastChange(c, wsRoom.team(teamId), 'projects', 'UPDATE', updated.rows[0]);
	}

	return ok(c, { budget: await getProjectHoursBudgetStatus(db, projectId) });
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
	const [buckets, byProject, totals, monthlyHours, metered, projectLimits] = await Promise.all([
		containerHoursSeries(db, bucket, null),
		containerHoursByProject(db, bucket),
		containerHoursTotals(db, null),
		getMonthlyContainerHours(db),
		isMetered(db),
		projectHoursLimitsTotal(db),
	]);

	return ok(c, {
		bucket,
		buckets,
		by_project: byProject,
		totals,
		monthly_hours: monthlyHours,
		// Provenance, matching the instance-settings payload: the page renders a
		// locked control from this rather than offering an edit the PATCH below
		// will refuse.
		monthly_hours_pinned: isPinned('monthlyContainerHours'),
		// The share of `monthly_hours` that was bought and carries over rather than
		// coming back each period. Only a deployment knows it, so anything else
		// reads 0: the whole allowance is per-period.
		purchased_hours: pinnedSetting('purchasedContainerHours') ?? 0,
		policy: policyBanner(),
		// What the *cap* is worth showing for. On a local daemon a container-hour
		// costs nothing anyone bills, so the page renders the series as
		// observability and leaves the cap controls out rather than inviting an
		// operator to budget a resource that is free.
		metered,
		// How the projects' own monthly hours limits add up against the
		// allowance. A total rather than a list: a limit sets no hours aside, so
		// what the owner needs here is whether the limits promise more than the
		// pool holds, and each project's own figures are on its Hours tab.
		project_limits: projectLimits,
	});
});

/** Set or clear (0) the monthly container-hours cap. Superuser-only, like the read. */
containerHoursRoutes.patch('/container-hours', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	// Refused, never silently ignored - the same rule the instance-settings PATCH
	// applies, and for the same reason: a deployment's tenant is superuser on
	// their own instance and can call this directly.
	const policy = runtimeConfig().policy;
	if (policy && isPinned('monthlyContainerHours')) {
		return err(
			c,
			'CONFLICT',
			`monthly_hours is set by ${policy.managedBy} and cannot be changed here.`,
			409,
		);
	}

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
