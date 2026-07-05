import { DocumentType } from '@hezo/shared';
import type { Db } from '../db/database';
import { resolveAgentId } from '../lib/resolve';
import { getDocument } from './documents';
import { resolveSystemPrompt } from './template-resolver';

export type SystemPromptMode = 'raw' | 'placeholders' | 'preview';

export type AgentSystemPromptErrorCode = 'NOT_FOUND';

export class AgentSystemPromptError extends Error {
	readonly code: AgentSystemPromptErrorCode;
	constructor(code: AgentSystemPromptErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'AgentSystemPromptError';
	}
}

export interface AgentSystemPromptResult {
	agent_id: string;
	title: string;
	slug: string;
	mode: SystemPromptMode;
	system_prompt: string;
}

export async function fetchAgentSystemPromptForBatch(
	db: Db,
	teamId: string,
	agentIdOrSlug: string,
	mode: SystemPromptMode,
): Promise<AgentSystemPromptResult> {
	const agentId = await resolveAgentId(db, teamId, agentIdOrSlug);
	if (!agentId) {
		throw new AgentSystemPromptError('NOT_FOUND', 'Agent not found in this team');
	}

	const agent = await db.query<{ title: string; slug: string }>(
		`SELECT ma.title, ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.team_id = $2`,
		[agentId, teamId],
	);
	if (agent.rows.length === 0) {
		throw new AgentSystemPromptError('NOT_FOUND', 'Agent not found in this team');
	}

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		teamId,
		memberAgentId: agentId,
	});
	if (!doc) {
		throw new AgentSystemPromptError('NOT_FOUND', 'Agent system prompt not found');
	}

	const system_prompt =
		mode === 'raw'
			? doc.content
			: await resolveSystemPrompt(db, doc.content, {
					teamId,
					agentId,
					mode,
				});

	return {
		agent_id: agentId,
		title: agent.rows[0].title,
		slug: agent.rows[0].slug,
		mode,
		system_prompt,
	};
}
