import { DocumentType } from '@hezo/shared';
import { logger } from '../../logger';
import { upsertDocument } from '../documents';
import {
	type ApprovalHandler,
	type ApprovalSideEffectCtx,
	ApprovalSideEffectError,
	type SideEffectBroadcast,
} from './types';

const log = logger.child('approval-handlers:role-update');

/**
 * Write the improved role text into an agent's live prompt, once a person accepts.
 *
 * The content written is the content the card carried, not a fresh splice. The
 * admin approved a specific text; recomputing here would quietly apply something
 * they never saw if the role doc moved between the offer and the answer.
 *
 * Written through `upsertDocument` like any other prompt edit, so it records a
 * revision and the existing rollback on the agent's settings page undoes it. That
 * is the whole safety net: a release that makes an agent worse is one click back.
 * A write that fails leaves the card waiting rather than accepted, because an
 * accepted card is what later boots read as the role text the agent runs.
 *
 * Declining needs no side effect. The declined row is itself the record - the
 * detector reads it, keyed on the role doc version refused, and never re-offers
 * that version while still offering the next one.
 */
export const roleUpdateHandler: ApprovalHandler = {
	async applyApproved(ctx: ApprovalSideEffectCtx): Promise<SideEffectBroadcast[]> {
		const { db, approval, payload, actorMemberId, wsManager } = ctx;
		const teamId = approval.team_id as string;
		const memberAgentId = payload.member_id as string | undefined;
		const content = payload.content as string | undefined;
		if (!memberAgentId || typeof content !== 'string') {
			log.error('Role update approved with no target agent or content; nothing written');
			return [];
		}

		// An accepted card is the record of which role text the agent runs, and the
		// next boot measures against it. Left accepted with nothing written, the
		// update would never be offered again, so a write that throws or is refused
		// (an archived prompt) leaves the card waiting instead.
		let written = false;
		try {
			const result = await upsertDocument(db, wsManager, {
				scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId },
				content,
				authorMemberId: actorMemberId,
				changeSummary: `Adopted the updated ${(payload.agent_slug as string) ?? 'agent'} role from this release`,
			});
			written = result.status === 'written';
		} catch (e) {
			log.error('Failed to write the accepted role update:', e);
		}
		if (!written) {
			throw new ApprovalSideEffectError(
				"The updated role could not be saved to the agent's prompt, so nothing changed.",
			);
		}
		// upsertDocument broadcasts the document change itself.
		return [];
	},
};
