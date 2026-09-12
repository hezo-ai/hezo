import { createHash } from 'node:crypto';
import { ApprovalStatus, ApprovalType, DocumentType } from '@hezo/shared';
import type { Db } from '../db/database';
import { logger } from '../logger';

const log = logger.child('role-prompt-sync');

/**
 * Carrying a role doc's improvements to agents that were hired before it changed.
 *
 * A role doc is compiled into the agent catalog, and the boot seed keeps
 * `agent_types.system_prompt_template` current on every instance. But an agent's
 * live prompt is a **document**, copied out of that template once when the agent
 * was hired and never read from it again - because the agent's own learned rules
 * and the admin's edits accumulate there, and a rewrite would destroy both.
 *
 * The consequence, before this: every role-doc improvement reached new instances
 * and no existing one. The two instance singletons feel it hardest, since the CEO
 * and Coach are hired on an instance's first boot and never hired again, so for
 * them "existing instance" means all of them.
 *
 * Nothing here writes a prompt. It works out what the new prompt *would* be and
 * files it for a person to accept, because the document belongs to the admin and
 * the agent, not to the release.
 */

/** The heading agents append their learned rules under. */
const LEARNED_RULES_HEADING = '## Learned Rules';

export type RolePromptSplice =
	/** The role doc has not moved since this agent was hired. */
	| { outcome: 'unchanged' }
	/** Everything the agent and the admin added survives, exactly. */
	| { outcome: 'clean'; content: string }
	/** The admin edited inside the role doc's own text; something will be lost. */
	| { outcome: 'conflict'; content: string };

/**
 * What this agent's prompt becomes if the role doc's changes are carried into it.
 *
 * Three inputs: `base` is the role doc as it stood when the agent was hired,
 * `current` is the prompt the agent runs on now, and `target` is the role doc
 * today. The pair `(base, current)` is what separates the release's text from
 * everyone else's additions, and having a true base is what makes this a splice
 * rather than a guess.
 *
 * The clean case is not a heuristic. Agents are instructed to add only to their
 * learned rules and never to rewrite the role's own text, so an untouched prompt
 * really is `base` followed by an appendix - and cutting at `base.length`
 * reproduces that appendix byte for byte, whatever is in it.
 *
 * Only an admin editing *within* the role doc's own text breaks that, and then
 * there is no honest merge: the two texts disagree about the same lines. The
 * offer becomes the new role doc plus the learned rules, and the caller shows
 * what that costs rather than deciding for anyone.
 */
export function spliceRolePrompt(base: string, current: string, target: string): RolePromptSplice {
	if (base === target) return { outcome: 'unchanged' };
	if (current === base) return { outcome: 'clean', content: target };
	if (base.length > 0 && current.startsWith(base)) {
		return { outcome: 'clean', content: target + current.slice(base.length) };
	}
	const learned = current.indexOf(LEARNED_RULES_HEADING);
	const appendix = learned === -1 ? '' : `\n\n${current.slice(learned).trim()}\n`;
	return { outcome: 'conflict', content: target + appendix };
}

/**
 * The role doc this agent was hired on.
 *
 * A revision holds the content as it stood *before* a change, and creating a
 * document records none - so the first revision is the original, and a document
 * with no revisions has never been edited and is its own original. That makes the
 * base exact and free: no column recording which release a prompt came from, and
 * so nothing that can fall out of step with the prompt it describes.
 */
export async function recoverBaseTemplate(
	db: Db,
	documentId: string,
	currentContent: string,
): Promise<string> {
	const first = await db.query<{ content: string }>(
		`SELECT content FROM document_revisions
		  WHERE document_id = $1 ORDER BY revision_number ASC LIMIT 1`,
		[documentId],
	);
	return first.rows[0]?.content ?? currentContent;
}

/** One agent whose role doc has moved on without it. */
export interface RolePromptUpdate {
	memberId: string;
	teamId: string;
	agentSlug: string;
	agentTitle: string;
	outcome: 'clean' | 'conflict';
	/** The prompt that will be written if a person accepts. */
	content: string;
	/** Identifies the role doc revision being offered, so a refusal can be remembered. */
	targetHash: string;
}

interface BuiltinAgentRow {
	member_id: string;
	team_id: string;
	slug: string;
	title: string;
	template: string;
	document_id: string;
	content: string;
}

function hashTemplate(target: string): string {
	return createHash('sha256').update(target).digest('hex').slice(0, 16);
}

/**
 * Every built-in agent whose live prompt predates its current role doc.
 *
 * Scoped to `is_builtin` types on purpose. Those are the rows the boot seed keeps
 * current from this repo's role docs, so they are the only ones with a newer
 * version to offer. A hire, a marketplace role and a team-template snapshot all
 * carry a `custom` type whose template is a record of what was provisioned, not a
 * release artifact - carrying "changes" into those would be inventing them.
 */
export async function findRolePromptUpdates(db: Db): Promise<RolePromptUpdate[]> {
	const rows = await db.query<BuiltinAgentRow>(
		`SELECT ma.id AS member_id, m.team_id, ma.slug, ma.title,
		        at.system_prompt_template AS template,
		        d.id AS document_id, d.content
		   FROM member_agents ma
		   JOIN members m ON m.id = ma.id
		   JOIN agent_types at ON at.id = ma.agent_type_id AND at.is_builtin = true
		   JOIN documents d ON d.member_agent_id = ma.id AND d.type = $1::document_type
		  ORDER BY ma.slug`,
		[DocumentType.AgentSystemPrompt],
	);

	const updates: RolePromptUpdate[] = [];
	for (const row of rows.rows) {
		const base = await recoverBaseTemplate(db, row.document_id, row.content);
		const splice = spliceRolePrompt(base, row.content, row.template);
		if (splice.outcome === 'unchanged') continue;
		updates.push({
			memberId: row.member_id,
			teamId: row.team_id,
			agentSlug: row.slug,
			agentTitle: row.title,
			outcome: splice.outcome,
			content: splice.content,
			targetHash: hashTemplate(row.template),
		});
	}
	return updates;
}

function describe(update: RolePromptUpdate): string {
	return update.outcome === 'clean'
		? `${update.agentTitle}'s role has been improved in this release. Accepting rewrites the role's own instructions and keeps everything added since - learned rules and your own additions alike.`
		: `${update.agentTitle}'s role has been improved in this release, but its instructions have been edited here since it was hired. Accepting replaces them with the new role and keeps only the learned rules; declining keeps what you have.`;
}

/**
 * File one pending decision per agent whose role doc has moved.
 *
 * Three states are kept apart, and each matters:
 *
 * - **Already offered, same role doc.** Left alone, so a restart does not reissue
 *   a decision the admin is already looking at.
 * - **Already offered, role doc moved again.** The standing card is rewritten
 *   rather than joined by a second one. A superseded offer would apply text two
 *   releases old, and two cards for one agent make the admin pick between them.
 * - **Declined for this role doc.** Never re-offered. The declined record is the
 *   memory - keyed on the version refused, so the *next* improvement is still
 *   offered rather than the refusal silencing the agent forever.
 */
export async function fileRolePromptUpdates(db: Db): Promise<number> {
	const updates = await findRolePromptUpdates(db);
	let filed = 0;
	for (const u of updates) {
		const payload = {
			type: 'role_update',
			member_id: u.memberId,
			agent_slug: u.agentSlug,
			agent_title: u.agentTitle,
			outcome: u.outcome,
			target_hash: u.targetHash,
			content: u.content,
			message: describe(u),
		};
		try {
			const declined = await db.query(
				`SELECT 1 FROM approvals
				  WHERE type = $1::approval_type AND status = $2::approval_status
				    AND payload->>'member_id' = $3 AND payload->>'target_hash' = $4
				  LIMIT 1`,
				[ApprovalType.RoleUpdate, ApprovalStatus.Denied, u.memberId, u.targetHash],
			);
			if (declined.rows.length > 0) continue;

			const updated = await db.query(
				`UPDATE approvals SET payload = $1::jsonb, created_at = now()
				  WHERE type = $2::approval_type AND status = $3::approval_status
				    AND payload->>'member_id' = $4
				    AND payload->>'target_hash' IS DISTINCT FROM $5
				  RETURNING id`,
				[
					JSON.stringify(payload),
					ApprovalType.RoleUpdate,
					ApprovalStatus.Pending,
					u.memberId,
					u.targetHash,
				],
			);
			if (updated.rows.length > 0) {
				filed += 1;
				continue;
			}

			const inserted = await db.query(
				`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
				 SELECT $1, $2::approval_type, $3::uuid, $4::jsonb
				  WHERE NOT EXISTS (
				    SELECT 1 FROM approvals
				     WHERE type = $2::approval_type AND status = $5::approval_status
				       AND payload->>'member_id' = $6
				  )
				 RETURNING id`,
				[
					u.teamId,
					ApprovalType.RoleUpdate,
					u.memberId,
					JSON.stringify(payload),
					ApprovalStatus.Pending,
					u.memberId,
				],
			);
			if (inserted.rows.length > 0) filed += 1;
		} catch (e) {
			// One agent's card must not stop the rest being offered.
			log.error(`Failed to file role update for ${u.agentSlug}:`, e);
		}
	}
	if (filed > 0) log.info(`Filed ${filed} role prompt update(s) for review`);
	return filed;
}
