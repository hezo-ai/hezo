import type { ApprovalType } from '@hezo/shared';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { APPROVAL_HANDLERS } from './approval-handlers';
import type { ApprovalSideEffectCtx, SideEffectBroadcast } from './approval-handlers/types';
import type { ContainerDeps } from './containers';
import type { WebSocketManager } from './ws';

export type { SideEffectBroadcast } from './approval-handlers/types';

function buildCtx(
	db: Db,
	approval: Record<string, unknown>,
	dataDir: string,
	actorMemberId: string | null,
	wsManager?: WebSocketManager,
	containerDeps?: ContainerDeps,
	events?: DomainEventBus,
): ApprovalSideEffectCtx {
	return {
		db,
		approval,
		payload: approval.payload as Record<string, unknown>,
		resolutionNote: (approval.resolution_note as string | null) ?? null,
		dataDir,
		actorMemberId,
		wsManager,
		containerDeps,
		events,
	};
}

/**
 * Run the side effect for a *denied* approval. Dispatches to the handler's
 * optional `applyDenied`; types with no denied side effect return nothing.
 * `wsManager` is threaded through so a denied handler can broadcast its own
 * realtime changes (e.g. the hire handler flipping its proposal comment).
 */
export async function applyApprovalDeniedSideEffect(
	db: Db,
	approval: Record<string, unknown>,
	actorMemberId: string | null,
	wsManager?: WebSocketManager,
): Promise<SideEffectBroadcast[]> {
	const handler = APPROVAL_HANDLERS[approval.type as ApprovalType];
	if (!handler?.applyDenied) return [];
	return handler.applyDenied(buildCtx(db, approval, '', actorMemberId, wsManager));
}

/**
 * Run the side effect for an *approved* approval. Dispatches to the matching
 * handler in `APPROVAL_HANDLERS`; approval types with no materialised side
 * effect (secret access, plan review, deploy, designated-repo) have no handler
 * and resolve to an empty broadcast set.
 */
export async function applyApprovalSideEffect(
	db: Db,
	approval: Record<string, unknown>,
	// Provided by the resolve infra for side effects that touch the data dir; the
	// current set (hire, project creation, skills, …) doesn't need it.
	dataDir: string,
	actorMemberId: string | null,
	wsManager?: WebSocketManager,
	containerDeps?: ContainerDeps,
	events?: DomainEventBus,
): Promise<SideEffectBroadcast[]> {
	const handler = APPROVAL_HANDLERS[approval.type as ApprovalType];
	if (!handler) return [];
	return handler.applyApproved(
		buildCtx(db, approval, dataDir, actorMemberId, wsManager, containerDeps, events),
	);
}
