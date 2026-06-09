import type { PGlite } from '@electric-sql/pglite';
import type { DomainEventBus } from '../../events/bus';
import type { ContainerDeps } from '../containers';
import type { WebSocketManager } from '../ws';

/** A row-change to broadcast to subscribed clients after a side effect lands. */
export interface SideEffectBroadcast {
	table: string;
	op: 'INSERT' | 'UPDATE';
	row: Record<string, unknown>;
}

/**
 * Everything an approval side-effect handler needs. Assembled once by the
 * dispatcher in `approval-side-effects.ts` and passed to the matching handler.
 */
export interface ApprovalSideEffectCtx {
	db: PGlite;
	/** The resolved approvals row (status already flipped to approved/denied). */
	approval: Record<string, unknown>;
	/** `approval.payload`, pre-cast for convenience. */
	payload: Record<string, unknown>;
	/** Resolution note from the resolving admin (denied flows use it). */
	resolutionNote: string | null;
	/**
	 * Data dir for side effects that touch the filesystem. The current handler
	 * set (hire, project creation, skills, strategy) doesn't need it.
	 */
	dataDir: string;
	actorMemberId: string | null;
	wsManager?: WebSocketManager;
	containerDeps?: ContainerDeps;
	events?: DomainEventBus;
}

/**
 * One approval type's side effects. `applyApproved` runs when the approval is
 * granted; `applyDenied` (optional) runs when it's rejected — most types have
 * no denied side effect.
 */
export interface ApprovalHandler {
	applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]>;
	applyDenied?(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]>;
}
