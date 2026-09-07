import { ActionCommentKind } from '@hezo/shared';
import type { Db } from '../db/database';
import {
	insertProposalComment,
	type ProposalCommentSpec,
	type ProposalResolution,
	resolveProposalCommentAndWake,
} from './proposal-comment';
import type { WebSocketManager } from './ws';

/**
 * The display snapshot stored in a hire-proposal action comment's `content`.
 * Mirrors the editable hire spec (the agent's full system prompt is intentionally
 * omitted — too long for the inline card; the admin reviews it on the hire page).
 */
function buildContentSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
	return {
		title: payload.title,
		slug: payload.slug,
		role_description: payload.role_description ?? '',
		monthly_budget_cents: payload.monthly_budget_cents ?? 0,
		heartbeat_interval_min: payload.heartbeat_interval_min ?? null,
		touches_code: payload.touches_code ?? false,
	};
}

/**
 * A hire proposal as a proposal-style approval. Modelled on the `setup_repo`
 * approval-linked action comment in `repo-setup.ts`.
 *
 * The assignee fallback is on because the hire form (`POST /agents/onboard`) is
 * filed by a superuser while its onboarding ticket belongs to the CEO — the
 * requester has nothing to resume, the assignee has all of it.
 */
const HIRE_PROPOSAL: ProposalCommentSpec = {
	kind: ActionCommentKind.HireProposal,
	wakeReason: 'hire_resolved',
	wakeKeyPrefix: 'hire-resolved',
	snapshot: buildContentSnapshot,
	wakeTaskAssigneeWhenRequesterIsHuman: true,
};

/**
 * Post a hire-proposal comment on the ticket that prompted the hire. Renders as an
 * `action` comment (`kind: 'hire_proposal'`) carrying the approval id, so the
 * task thread shows the pending proposal alongside the admin inbox — and flips to
 * hired/denied once the approval resolves.
 */
export async function insertHireProposalComment(
	db: Db,
	params: {
		taskId: string;
		approvalId: string;
		payload: Record<string, unknown>;
		teamId: string;
		projectId: string;
	},
	wsManager?: WebSocketManager,
): Promise<Record<string, unknown> | null> {
	return insertProposalComment(db, HIRE_PROPOSAL, params, wsManager);
}

/**
 * Resolve the hire-proposal comment(s) for an approval (flip the rendering to
 * hired/denied via `chosen_option`) and queue the requesting agent to run again so
 * it can review the decision and resume setup. Runs for both approve and deny.
 */
export async function resolveHireProposalCommentAndWake(
	db: Db,
	params: {
		approval: Record<string, unknown>;
		status: ProposalResolution;
		memberAgentSlug?: string | null;
		resolutionNote?: string | null;
	},
	wsManager?: WebSocketManager,
): Promise<void> {
	const { approval, status, memberAgentSlug, resolutionNote } = params;
	return resolveProposalCommentAndWake(
		db,
		HIRE_PROPOSAL,
		{
			approval,
			status,
			chosenExtra: memberAgentSlug ? { member_agent_slug: memberAgentSlug } : undefined,
			resolutionNote,
		},
		wsManager,
	);
}
