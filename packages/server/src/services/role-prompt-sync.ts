import { createHash } from 'node:crypto';
import {
	ApprovalStatus,
	ApprovalType,
	DocumentType,
	LEARNED_RULES_HEADING,
	RoleUpdateOutcome,
} from '@hezo/shared';
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

export type RolePromptSplice =
	/** The role doc has not moved since this agent was hired. */
	| { outcome: 'unchanged' }
	/** Everything the agent and the admin added survives, exactly. */
	| { outcome: typeof RoleUpdateOutcome.Clean; content: string }
	/** The admin edited inside the role doc's own text; something will be lost. */
	| { outcome: typeof RoleUpdateOutcome.Conflict; content: string };

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
	if (current === base) return { outcome: RoleUpdateOutcome.Clean, content: target };
	if (base.length > 0 && current.startsWith(base)) {
		return { outcome: RoleUpdateOutcome.Clean, content: target + current.slice(base.length) };
	}
	const learned = current.indexOf(LEARNED_RULES_HEADING);
	const appendix = learned === -1 ? '' : `\n\n${current.slice(learned).trim()}\n`;
	return { outcome: RoleUpdateOutcome.Conflict, content: target + appendix };
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

interface AdoptedCardRow {
	template: string | null;
	target_hash: string | null;
	content: string | null;
}

/**
 * The role text a person last accepted for this agent, or null when none was.
 *
 * Accepting a card moves the agent onto that card's role text, so from then on it
 * is the base later releases are measured against - not the text the agent was
 * hired on. Measured against the hire-time text, an agent that had accepted one
 * update read as "edited here" on every later boot and was offered the same role
 * again each time.
 *
 * A card filed since this landed carries the text it offered as `template`. One
 * accepted before carries only `target_hash`, the hash of that text, and the text
 * is the prefix of the `content` it wrote: equal to today's role text when the
 * role has not moved since, otherwise found by hashing `content` up to each line
 * break. That search costs two hashes per line of one prompt (80 ms for a 50 KB
 * prompt on Bun 1.4; the shipped role docs are under 11 KB), and runs only for an
 * agent whose last accept predates `template` and whose role has moved since.
 * A withdrawn card (`auto_closed`) never ran, so it is never the base.
 */
async function adoptedRoleText(
	db: Db,
	memberId: string,
	currentTemplate: string,
): Promise<string | null> {
	const r = await db.query<AdoptedCardRow>(
		`SELECT payload->>'template' AS template, payload->>'target_hash' AS target_hash,
		        payload->>'content' AS content
		   FROM approvals
		  WHERE type = $1::approval_type AND status = $2::approval_status
		    AND payload->>'member_id' = $3 AND NOT (payload ? 'auto_closed')
		  ORDER BY resolved_at DESC NULLS LAST, created_at DESC
		  LIMIT 1`,
		[ApprovalType.RoleUpdate, ApprovalStatus.Approved, memberId],
	);
	const card = r.rows[0];
	if (!card) return null;
	if (card.template !== null) return card.template;
	if (!card.target_hash || card.content === null) return null;
	if (hashTemplate(currentTemplate) === card.target_hash) return currentTemplate;
	return prefixWithHash(card.content, card.target_hash);
}

/** The prefix of `content` ending at a line break (either side of it) whose hash is `hash`. */
function prefixWithHash(content: string, hash: string): string | null {
	if (hashTemplate(content) === hash) return content;
	for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) {
		for (const cut of [i, i + 1]) {
			const prefix = content.slice(0, cut);
			if (hashTemplate(prefix) === hash) return prefix;
		}
	}
	return null;
}

/**
 * The payload fields of a role update card that only its preview reads: two
 * whole prompts and the admin's edited lines. Lists leave them out.
 */
export const ROLE_UPDATE_PREVIEW_FIELDS = ['content', 'template', 'edited_lines'] as const;

/** Most edited lines a card names; the preview still shows every removed line. */
export const MAX_EDITED_LINES = 200;

/**
 * The lines an admin wrote inside the role's own text that the offer drops: in
 * the live prompt, but in neither the role text it was built on nor the offer.
 * The preview tags them, because they are the cost of accepting.
 */
export function editedLinesLost(base: string, current: string, offered: string): string[] {
	const known = new Set([...base.split('\n'), ...offered.split('\n')]);
	return current
		.split('\n')
		.filter((line) => line.trim() !== '' && !known.has(line))
		.slice(0, MAX_EDITED_LINES);
}

/** One agent whose role doc has moved on without it. */
export interface RolePromptUpdate {
	memberId: string;
	teamId: string;
	agentSlug: string;
	agentTitle: string;
	outcome: RoleUpdateOutcome;
	/** The prompt that will be written if a person accepts. */
	content: string;
	/** Identifies the role doc revision being offered, so a refusal can be remembered. */
	targetHash: string;
	/** The role doc being offered, which becomes this agent's base once accepted. */
	template: string;
	/** For a conflict, the admin's own lines the offer drops. */
	editedLines: string[];
}

interface RolePromptScan {
	updates: RolePromptUpdate[];
	/** Agents already running their current role doc. */
	upToDate: string[];
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
	return (await scanRolePrompts(db)).updates;
}

async function scanRolePrompts(db: Db): Promise<RolePromptScan> {
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

	const scan: RolePromptScan = { updates: [], upToDate: [] };
	for (const row of rows.rows) {
		const base =
			(await adoptedRoleText(db, row.member_id, row.template)) ??
			(await recoverBaseTemplate(db, row.document_id, row.content));
		const splice = spliceRolePrompt(base, row.content, row.template);
		if (splice.outcome === 'unchanged') {
			scan.upToDate.push(row.member_id);
			continue;
		}
		scan.updates.push({
			memberId: row.member_id,
			teamId: row.team_id,
			agentSlug: row.slug,
			agentTitle: row.title,
			outcome: splice.outcome,
			content: splice.content,
			targetHash: hashTemplate(row.template),
			template: row.template,
			editedLines:
				splice.outcome === RoleUpdateOutcome.Conflict
					? editedLinesLost(base, row.content, splice.content)
					: [],
		});
	}
	return scan;
}

/**
 * File one pending decision per agent whose role doc has moved, and withdraw the
 * ones that no longer apply.
 *
 * Four states are kept apart, and each matters:
 *
 * - **Already offered, same offer.** Left alone, so a restart does not reissue
 *   a decision the admin is already looking at.
 * - **Already offered, offer changed.** The standing card is rewritten rather
 *   than joined by a second one: the role doc moved again, or the card was
 *   worked out wrongly or filed without the preview's fields by an earlier
 *   release. A stale offer would apply text the
 *   admin is not being shown, and two cards for one agent make them pick.
 * - **Declined for this role doc.** Never re-offered. The declined record is the
 *   memory - keyed on the version refused, so the *next* improvement is still
 *   offered rather than the refusal silencing the agent forever.
 * - **Offered, but the agent already runs this role doc.** Withdrawn: closed
 *   with no side effect and marked `auto_closed`. Earlier releases filed such
 *   cards after every accept, and accepting one would replace the role and keep
 *   only the learned rules, dropping the admin's own additions.
 *
 * The card's wording is the web client's, chosen by `outcome`, so it reads in
 * the admin's language rather than the server's.
 */
export async function fileRolePromptUpdates(db: Db): Promise<number> {
	const { updates, upToDate } = await scanRolePrompts(db);
	for (const memberId of upToDate) {
		try {
			await withdrawStandingCard(db, memberId);
		} catch (e) {
			log.error(`Failed to withdraw a role update card for member ${memberId}:`, e);
		}
	}

	let filed = 0;
	for (const u of updates) {
		const payload = {
			type: 'role_update',
			member_id: u.memberId,
			agent_slug: u.agentSlug,
			agent_title: u.agentTitle,
			outcome: u.outcome,
			target_hash: u.targetHash,
			template: u.template,
			content: u.content,
			edited_lines: u.editedLines,
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

			// Any difference rewrites the card: a new role doc, an offer worked out
			// wrongly, or a card filed by an earlier release without the fields the
			// preview reads (`template`, `edited_lines`). It keeps its place in the
			// inbox unless the role doc itself moved.
			const updated = await db.query(
				`UPDATE approvals
				    SET payload = $1::jsonb,
				        created_at = CASE WHEN payload->>'target_hash' IS DISTINCT FROM $5
				                          THEN now() ELSE created_at END
				  WHERE type = $2::approval_type AND status = $3::approval_status
				    AND payload->>'member_id' = $4
				    AND payload IS DISTINCT FROM $1::jsonb
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

/**
 * Close a standing card for an agent that already runs its current role doc.
 *
 * Written directly rather than through the resolve path, because resolving runs
 * the handler and the handler writes the card's text into the prompt - the very
 * thing a withdrawn card must not do.
 */
async function withdrawStandingCard(db: Db, memberId: string): Promise<void> {
	const closed = await db.query(
		`UPDATE approvals
		    SET status = $1::approval_status, resolved_at = now(),
		        payload = payload || '{"auto_closed": true}'::jsonb
		  WHERE type = $2::approval_type AND status = $3::approval_status
		    AND payload->>'member_id' = $4
		  RETURNING id`,
		[ApprovalStatus.Approved, ApprovalType.RoleUpdate, ApprovalStatus.Pending, memberId],
	);
	if (closed.rows.length > 0) {
		log.info(`Withdrew a role update card for member ${memberId}: it already runs that role`);
	}
}
