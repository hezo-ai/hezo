import {
	ApprovalStatus,
	ApprovalType,
	DEFAULT_EFFORT,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
	isAgentEffort,
	isReservedAgentSlug,
	requiredSystemPromptVarsError,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { checkHumanNameAvailable } from '../lib/agent-identity';
import { budgetWindowsError } from '../lib/budget-validation';
import { resolveAgentId } from '../lib/resolve';
import { toSlug } from '../lib/slug';
import { HEARTBEAT_INTERVAL_FLOOR_MIN } from './heartbeat-schedule';
import { authoredPromptError } from './prompt-style-guard';

const DEFAULT_MONTHLY_BUDGET_CENTS = 3000;

/** Raw hire spec as supplied by the admin form or an agent tool. */
export interface HireProposalInput {
	title: string;
	/**
	 * A human name for the new teammate. Optional, and normally left blank: an
	 * agent is addressed by its role unless the admin asks for a name.
	 */
	human_name?: string;
	role_description?: string;
	system_prompt?: string;
	/** The manager this agent reports to — an existing agent's slug (or id). */
	reports_to?: string;
	default_effort?: string;
	heartbeat_interval_min?: number;
	daily_budget_cents?: number;
	weekly_budget_cents?: number;
	monthly_budget_cents?: number;
	touches_code?: boolean;
}

/** Normalized hire spec stored in the approval payload. */
export interface HireProposalPayload {
	title: string;
	human_name: string | null;
	slug: string;
	role_description: string;
	system_prompt: string;
	/** Manager slug (or id) stored verbatim; resolved to a member id at materialize. */
	reports_to: string | null;
	default_effort: string;
	heartbeat_interval_min: number;
	daily_budget_cents: number;
	weekly_budget_cents: number;
	monthly_budget_cents: number;
	touches_code: boolean;
}

/**
 * Validate a hire spec against the team and produce the normalized payload.
 * Returns an error string when the spec is rejected (missing title, invalid
 * effort/budget, reserved slug, slug already taken, or a pending hire already
 * proposing the same slug).
 */
export async function prepareHireProposal(
	db: Db,
	teamId: string,
	input: HireProposalInput,
): Promise<{ error: string; conflict?: boolean } | { payload: HireProposalPayload }> {
	const title = input.title?.trim();
	if (!title) return { error: 'title is required' };

	const humanName = input.human_name?.trim() || null;
	if (humanName) {
		const rejection = await checkHumanNameAvailable(db, { teamId, name: humanName });
		if (rejection) return { error: rejection.message, conflict: rejection.code === 'TAKEN' };
	}

	if (input.default_effort !== undefined && !isAgentEffort(input.default_effort)) {
		return { error: `Invalid default_effort: ${input.default_effort}` };
	}

	// A sub-floor cadence would be silently clamped up by the scheduler
	// (NEXT_HEARTBEAT_AT_SQL), so reject it here rather than storing a number the
	// agent will never actually tick at. An omitted value still takes the default
	// below: the admin hire form legitimately posts without one, and the MCP tool
	// makes the field required at its own boundary.
	if (
		input.heartbeat_interval_min !== undefined &&
		input.heartbeat_interval_min < HEARTBEAT_INTERVAL_FLOOR_MIN
	) {
		return {
			error: `heartbeat_interval_min must be at least ${HEARTBEAT_INTERVAL_FLOOR_MIN} minutes`,
		};
	}

	const budgetError = budgetWindowsError({
		daily_budget_cents: input.daily_budget_cents ?? 0,
		weekly_budget_cents: input.weekly_budget_cents ?? 0,
		monthly_budget_cents: input.monthly_budget_cents ?? DEFAULT_MONTHLY_BUDGET_CENTS,
	});
	if (budgetError) return { error: budgetError };

	// A supplied prompt must keep the required substitution variables so the
	// agent always receives its identity + live skills/docs/preferences context.
	// An omitted/empty prompt keeps the existing default behaviour.
	const promptError = requiredSystemPromptVarsError(input.system_prompt ?? '');
	if (input.system_prompt?.trim() && promptError) return { error: promptError };
	const styleError = authoredPromptError(input.system_prompt ?? '');
	if (input.system_prompt?.trim() && styleError) return { error: styleError };

	const slug = toSlug(title);
	if (isReservedAgentSlug(slug)) {
		return { error: `Agent slug '${slug}' is reserved` };
	}

	const slugCheck = await db.query(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	if (slugCheck.rows.length > 0) {
		return { error: `Agent with slug '${slug}' already exists in this team`, conflict: true };
	}

	const pendingCheck = await db.query(
		`SELECT id FROM approvals
		 WHERE team_id = $1 AND type = $2::approval_type AND status = $3::approval_status
		   AND payload->>'slug' = $4`,
		[teamId, ApprovalType.Hire, ApprovalStatus.Pending, slug],
	);
	if (pendingCheck.rows.length > 0) {
		return { error: `A pending hire proposal for slug '${slug}' already exists`, conflict: true };
	}

	// Validate the manager (reports_to) resolves to an existing agent in this
	// team. Stored verbatim (slug or id) and resolved to a member id when the
	// hire is materialized.
	let reportsTo: string | null = null;
	if (input.reports_to?.trim()) {
		const raw = input.reports_to.trim();
		if (toSlug(raw) === slug) {
			return { error: 'reports_to: an agent cannot report to itself' };
		}
		const managerId = await resolveAgentId(db, teamId, raw);
		if (!managerId) {
			return { error: `reports_to: no agent '${raw}' in this team` };
		}
		reportsTo = raw;
	}

	return {
		payload: {
			title,
			human_name: humanName,
			slug,
			role_description: input.role_description ?? '',
			system_prompt: input.system_prompt ?? '',
			reports_to: reportsTo,
			default_effort: input.default_effort ?? DEFAULT_EFFORT,
			heartbeat_interval_min: input.heartbeat_interval_min ?? DEFAULT_HEARTBEAT_INTERVAL_MIN,
			daily_budget_cents: input.daily_budget_cents ?? 0,
			weekly_budget_cents: input.weekly_budget_cents ?? 0,
			monthly_budget_cents: input.monthly_budget_cents ?? DEFAULT_MONTHLY_BUDGET_CENTS,
			touches_code: input.touches_code ?? false,
		},
	};
}

/**
 * Insert a pending hire approval holding the normalized spec. When a taskId is
 * given it is merged into the payload so the approval links back to the
 * originating ticket.
 */
export async function insertHireApproval(
	db: Db,
	teamId: string,
	payload: HireProposalPayload,
	requestedByMemberId: string | null,
	taskId?: string | null,
): Promise<Record<string, unknown>> {
	const fullPayload = taskId ? { ...payload, task_id: taskId } : payload;
	const result = await db.query<Record<string, unknown>>(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)
		 RETURNING *`,
		[
			teamId,
			ApprovalType.Hire,
			requestedByMemberId,
			JSON.stringify(fullPayload),
			ApprovalStatus.Pending,
		],
	);
	return result.rows[0];
}

/** Fields an agent or admin may revise on a pending hire proposal. */
export interface HirePayloadPatchInput {
	title?: string;
	human_name?: string;
	role_description?: string;
	system_prompt?: string;
	/** Manager slug (or id); '' / null clears the reporting line. */
	reports_to?: string | null;
	default_effort?: string;
	heartbeat_interval_min?: number;
	daily_budget_cents?: number;
	weekly_budget_cents?: number;
	monthly_budget_cents?: number;
	touches_code?: boolean;
}

/**
 * Build the JSONB patch for revising a pending hire payload. Only fields that
 * were supplied are included; the slug is intentionally fixed once derived.
 */
export function buildHirePayloadPatch(input: HirePayloadPatchInput): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (input.title !== undefined) patch.title = input.title.trim();
	if (input.human_name !== undefined) patch.human_name = input.human_name?.trim() || null;
	if (input.role_description !== undefined) patch.role_description = input.role_description;
	if (input.system_prompt !== undefined) patch.system_prompt = input.system_prompt;
	if (input.reports_to !== undefined) patch.reports_to = input.reports_to?.trim() || null;
	if (input.default_effort !== undefined) patch.default_effort = input.default_effort;
	if (input.heartbeat_interval_min !== undefined)
		patch.heartbeat_interval_min = input.heartbeat_interval_min;
	if (input.daily_budget_cents !== undefined) patch.daily_budget_cents = input.daily_budget_cents;
	if (input.weekly_budget_cents !== undefined)
		patch.weekly_budget_cents = input.weekly_budget_cents;
	if (input.monthly_budget_cents !== undefined)
		patch.monthly_budget_cents = input.monthly_budget_cents;
	if (input.touches_code !== undefined) patch.touches_code = input.touches_code;
	return patch;
}
