import { AuthType, DocumentType } from '@hezo/shared';
import type { Db } from '../db/database';
import { canCoordinateTeam, isHqInstanceAgent } from '../lib/agent-roles';
import { trackBackground } from '../lib/background';
import { checkInjectedTextCap } from '../lib/injected-text-caps';
import { resolveActorMemberId } from '../lib/resolve';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import { enqueueTeamCoherenceReviewTask } from './description-tasks';
import { type DocumentRow, getDocument, upsertDocument } from './documents';
import { authoredPromptError, authoredPromptWarning } from './prompt-style-guard';
import type { WebSocketManager } from './ws';

const log = logger.child('custom-prompt');

export type WriteCustomPromptResult =
	| { status: 'denied'; error: string }
	| { status: 'invalid'; error: string }
	| { status: 'written'; row: DocumentRow; existed: boolean; warning?: string };

/**
 * The single write path for a project's Custom Prompt, shared by the REST route
 * and the MCP tool.
 *
 * Both entry points reach the same `documents` row, so every guard has to live
 * here or the two drift: the route once ran neither the agent role check nor the
 * style guard the tool enforced. Both now apply on both paths.
 *
 * The role gate is deliberately agent-only. An agent may write this just when it
 * coordinates the team (CEO, Coach, or that project's Captain); a human admin
 * reaching it through the web app is the owner of the project and is not gated.
 */
export async function writeCustomPrompt(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: {
		teamId: string;
		content: string;
		changeSummary?: string;
		auth: AuthInfo;
	},
): Promise<WriteCustomPromptResult> {
	const { teamId, content, changeSummary, auth } = input;

	if (auth.type === AuthType.Agent) {
		const allowed =
			(await canCoordinateTeam(db, auth, teamId)) || (await isHqInstanceAgent(db, auth));
		if (!allowed) {
			return {
				status: 'denied',
				error:
					'Access denied: only the CEO, Coach, or Captain can update the project Custom Prompt',
			};
		}
	}

	// The Custom Prompt is injected verbatim into every agent's prompt, so it is
	// held to the same register as one — and to a ceiling.
	const tooLarge = checkInjectedTextCap('team_preferences', content);
	if (tooLarge) return { status: 'invalid', error: tooLarge.error };

	const styleError = authoredPromptError(content);
	if (styleError) return { status: 'invalid', error: styleError };

	const prior = await getDocument(db, { type: DocumentType.TeamPreferences, teamId });
	const authorMemberId = await resolveActorMemberId(db, auth, teamId);
	const doc = await upsertDocument(db, wsManager, {
		scope: { type: DocumentType.TeamPreferences, teamId },
		content,
		changeSummary,
		authorMemberId,
	});

	// The Custom Prompt reaches every agent's prompt, so a real change warrants a
	// team coherence review — whoever made it.
	if ((prior?.content ?? '') !== content) {
		const summary = changeSummary
			? `Project Custom Prompt updated: ${changeSummary}`
			: 'The project Custom Prompt was updated.';
		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, 'custom_prompt_updated', {
				changeSummary: summary,
			}).catch((e) =>
				log.error('Failed to enqueue coherence review after Custom Prompt update:', e),
			),
		);
	}

	const warning = authoredPromptWarning(content);
	return {
		status: 'written',
		row: doc.row,
		existed: prior !== null,
		...(warning ? { warning } : {}),
	};
}
