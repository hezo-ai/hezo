import type { PGlite } from '@electric-sql/pglite';
import { DocumentType } from '@hezo/shared';
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
	db: PGlite,
	companyId: string,
	agentIdOrSlug: string,
	mode: SystemPromptMode,
): Promise<AgentSystemPromptResult> {
	const agentId = await resolveAgentId(db, companyId, agentIdOrSlug);
	if (!agentId) {
		throw new AgentSystemPromptError('NOT_FOUND', 'Agent not found in this company');
	}

	const agent = await db.query<{ title: string; slug: string }>(
		`SELECT ma.title, ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.company_id = $2`,
		[agentId, companyId],
	);
	if (agent.rows.length === 0) {
		throw new AgentSystemPromptError('NOT_FOUND', 'Agent not found in this company');
	}

	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		companyId,
		memberAgentId: agentId,
	});
	if (!doc) {
		throw new AgentSystemPromptError('NOT_FOUND', 'Agent system prompt not found');
	}

	const system_prompt =
		mode === 'raw'
			? doc.content
			: await resolveSystemPrompt(db, doc.content, {
					companyId,
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
