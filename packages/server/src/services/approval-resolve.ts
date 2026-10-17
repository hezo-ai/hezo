import { ApprovalStatus } from '@hezo/shared';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { ApprovalSideEffectError } from './approval-handlers/types';
import {
	applyApprovalDeniedSideEffect,
	applyApprovalSideEffect,
	type SideEffectBroadcast,
} from './approval-side-effects';
import type { ContainerDeps } from './containers';
import type { WebSocketManager } from './ws';

export type { SideEffectBroadcast } from './approval-side-effects';

export type ResolveApprovalError = 'NOT_FOUND' | 'INVALID_STATE' | 'SIDE_EFFECT_FAILED';

export interface ResolveApprovalInput {
	status: typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied;
	resolutionNote: string | null;
	dataDir: string;
	actorMemberId: string | null;
	/**
	 * The person who settled it, recorded on the row: the user, or the API key
	 * acting for the admin. Both null when an agent or the system settled it,
	 * which a hold waiting on a person does not count.
	 */
	decider: { user_id: string | null; api_key_id: string | null };
	wsManager?: WebSocketManager;
	containerDeps?: ContainerDeps;
	events?: DomainEventBus;
}

export type ResolveApprovalResult =
	| { ok: true; row: Record<string, unknown>; sideEffects: SideEffectBroadcast[] }
	| { ok: false; error: ResolveApprovalError; message: string };

export async function resolveApproval(
	db: Db,
	approvalId: string,
	input: ResolveApprovalInput,
): Promise<ResolveApprovalResult> {
	const existing = await db.query<{ status: string; team_id: string }>(
		'SELECT status, team_id FROM approvals WHERE id = $1',
		[approvalId],
	);
	if (existing.rows.length === 0) {
		return { ok: false, error: 'NOT_FOUND', message: 'Approval not found' };
	}
	if (existing.rows[0].status !== ApprovalStatus.Pending) {
		return { ok: false, error: 'INVALID_STATE', message: 'Approval is already resolved' };
	}

	// The claim is the update itself: only one of two concurrent decisions on a
	// pending row gets it back, so a side effect never runs twice.
	const result = await db.query(
		`UPDATE approvals
		    SET status = $1::approval_status, resolution_note = $2, resolved_at = now(),
		        resolved_by_user_id = $4, resolved_by_api_key_id = $5
		  WHERE id = $3 AND status = $6::approval_status RETURNING *`,
		[
			input.status,
			input.resolutionNote,
			approvalId,
			input.decider.user_id,
			input.decider.api_key_id,
			ApprovalStatus.Pending,
		],
	);
	const row = result.rows[0] as Record<string, unknown> | undefined;
	if (!row) {
		return { ok: false, error: 'INVALID_STATE', message: 'Approval is already resolved' };
	}

	let sideEffects: SideEffectBroadcast[] = [];
	try {
		sideEffects =
			input.status === ApprovalStatus.Approved
				? await applyApprovalSideEffect(
						db,
						row,
						input.dataDir,
						input.actorMemberId,
						input.wsManager,
						input.containerDeps,
						input.events,
					)
				: // Denied: dispatch to any handler that defines a denied side effect
					// (the proposal-style ones flip their card and re-wake the requester).
					await applyApprovalDeniedSideEffect(db, row, input.actorMemberId, input.wsManager);
	} catch (e) {
		if (!(e instanceof ApprovalSideEffectError)) throw e;
		// The handler wrote nothing, so the decision is undone rather than left
		// reading as decided with nothing behind it.
		await db.query(
			`UPDATE approvals
			    SET status = $2::approval_status, resolution_note = NULL, resolved_at = NULL,
			        resolved_by_user_id = NULL, resolved_by_api_key_id = NULL
			  WHERE id = $1`,
			[approvalId, ApprovalStatus.Pending],
		);
		return { ok: false, error: 'SIDE_EFFECT_FAILED', message: e.message };
	}

	return { ok: true, row, sideEffects };
}
