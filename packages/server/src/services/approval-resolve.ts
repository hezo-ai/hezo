import type { PGlite } from '@electric-sql/pglite';
import { ApprovalStatus } from '@hezo/shared';
import type { DomainEventBus } from '../events/bus';
import {
	applyApprovalDeniedSideEffect,
	applyApprovalSideEffect,
	type SideEffectBroadcast,
} from './approval-side-effects';
import type { ContainerDeps } from './containers';
import type { WebSocketManager } from './ws';

export type { SideEffectBroadcast } from './approval-side-effects';

export type ResolveApprovalError = 'NOT_FOUND' | 'INVALID_STATE';

export interface ResolveApprovalInput {
	status: typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied;
	resolutionNote: string | null;
	dataDir: string;
	actorMemberId: string | null;
	wsManager?: WebSocketManager;
	containerDeps?: ContainerDeps;
	events?: DomainEventBus;
}

export type ResolveApprovalResult =
	| { ok: true; row: Record<string, unknown>; sideEffects: SideEffectBroadcast[] }
	| { ok: false; error: ResolveApprovalError; message: string };

export async function resolveApproval(
	db: PGlite,
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

	const result = await db.query(
		`UPDATE approvals SET status = $1::approval_status, resolution_note = $2, resolved_at = now()
		 WHERE id = $3 RETURNING *`,
		[input.status, input.resolutionNote, approvalId],
	);
	const row = result.rows[0] as Record<string, unknown>;

	let sideEffects: SideEffectBroadcast[] = [];
	if (input.status === ApprovalStatus.Approved) {
		sideEffects = await applyApprovalSideEffect(
			db,
			row,
			input.dataDir,
			input.actorMemberId,
			input.wsManager,
			input.containerDeps,
			input.events,
		);
	} else {
		// Denied: dispatch to any handler that defines a denied side effect (today
		// the hire handler flips its proposal comment and re-wakes the requester).
		sideEffects = await applyApprovalDeniedSideEffect(
			db,
			row,
			input.actorMemberId,
			input.wsManager,
		);
	}

	return { ok: true, row, sideEffects };
}
