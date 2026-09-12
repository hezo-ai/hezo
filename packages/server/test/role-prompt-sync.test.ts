import { ApprovalStatus, ApprovalType, DocumentType } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { resolveApproval } from '../src/services/approval-resolve';
import { upsertDocument } from '../src/services/documents';
import {
	fileRolePromptUpdates,
	findRolePromptUpdates,
	recoverBaseTemplate,
	spliceRolePrompt,
} from '../src/services/role-prompt-sync';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

// Carrying a role doc's improvements into an agent hired before it changed.
//
// The whole mechanism rests on one claim: the role doc as it stood at hire time is
// exactly recoverable, so the release's text can be told apart from everything the
// agent and the admin added on top. These cover that claim, the splice built on
// it, and the offer built on the splice.
let db: Db;
let coachId: string;
let coachTypeId: string;

/** The catalog template the boot seed keeps current from this repo's role docs. */
async function setTemplate(content: string): Promise<void> {
	await db.query('UPDATE agent_types SET system_prompt_template = $1 WHERE id = $2', [
		content,
		coachTypeId,
	]);
}

/** The agent's live prompt, written the way any edit writes it. */
async function setPrompt(content: string, teamId: string): Promise<void> {
	await upsertDocument(db, undefined, {
		scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId: coachId },
		content,
		authorMemberId: null,
	});
}

async function coachTeam(): Promise<string> {
	const r = await db.query<{ team_id: string }>('SELECT team_id FROM members WHERE id = $1', [
		coachId,
	]);
	return r.rows[0].team_id;
}

async function promptDocId(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT id FROM documents WHERE member_agent_id = $1 AND type = $2::document_type`,
		[coachId, DocumentType.AgentSystemPrompt],
	);
	return r.rows[0].id;
}

async function pendingCards(): Promise<{ payload: Record<string, unknown> }[]> {
	const r = await db.query<{ payload: Record<string, unknown> }>(
		`SELECT payload FROM approvals
		  WHERE type = $1::approval_type AND status = $2::approval_status
		    AND payload->>'member_id' = $3`,
		[ApprovalType.RoleUpdate, ApprovalStatus.Pending, coachId],
	);
	return r.rows;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const coach = await db.query<{ id: string; agent_type_id: string }>(
		`SELECT id, agent_type_id FROM member_agents WHERE slug = 'coach' LIMIT 1`,
	);
	coachId = coach.rows[0].id;
	coachTypeId = coach.rows[0].agent_type_id;
});

beforeEach(async () => {
	await db.query(`DELETE FROM approvals WHERE type = $1::approval_type`, [ApprovalType.RoleUpdate]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('spliceRolePrompt', () => {
	it('reports nothing to do when the role doc has not moved', () => {
		expect(spliceRolePrompt('ROLE v1', 'ROLE v1\n\n## Learned Rules\n- a', 'ROLE v1')).toEqual({
			outcome: 'unchanged',
		});
	});

	it('takes the new role wholesale when nothing was ever added', () => {
		expect(spliceRolePrompt('ROLE v1', 'ROLE v1', 'ROLE v2')).toEqual({
			outcome: 'clean',
			content: 'ROLE v2',
		});
	});

	it('keeps an appendix byte for byte, whatever is in it', () => {
		// The appendix is cut at the base's length rather than parsed, so it survives
		// exactly - headings the parser would not recognise, trailing whitespace and
		// all. Anything cleverer would silently reformat an admin's own words.
		const appendix = '\n\n## Learned Rules\n- always check the target env\n\n## My notes\n  raw   ';
		const out = spliceRolePrompt('ROLE v1', `ROLE v1${appendix}`, 'ROLE v2');
		expect(out).toEqual({ outcome: 'clean', content: `ROLE v2${appendix}` });
	});

	it('reads text added after the role as an addition, not an edit', () => {
		// An admin appending their own paragraph is indistinguishable from an agent
		// appending a learned rule, and should be: both are additions and both
		// survive untouched. Only a change *inside* the role text is a conflict.
		const out = spliceRolePrompt('ROLE v1', 'ROLE v1\nmy own note', 'ROLE v2');
		expect(out).toEqual({ outcome: 'clean', content: 'ROLE v2\nmy own note' });
	});

	it('calls it a conflict when the admin edited inside the role text', () => {
		const out = spliceRolePrompt(
			'ROLE v1\nline two\nline three',
			'ROLE v1\nline two EDITED\nline three\n\n## Learned Rules\n- keep me',
			'ROLE v2',
		);
		expect(out.outcome).toBe('conflict');
		// The offer keeps what an agent taught itself and drops the edit, which is
		// what the card has to say out loud - there is no honest merge of two texts
		// that disagree about the same lines.
		expect(out).toMatchObject({ content: expect.stringContaining('ROLE v2') });
		expect((out as { content: string }).content).toContain('## Learned Rules\n- keep me');
		expect((out as { content: string }).content).not.toContain('EDITED');
	});

	it('offers just the new role when a conflicted prompt has no learned rules', () => {
		const out = spliceRolePrompt(
			'ROLE v1\nline two\nline three',
			'ROLE v1\nline two EDITED\nline three',
			'ROLE v2',
		);
		expect(out).toEqual({ outcome: 'conflict', content: 'ROLE v2' });
	});
});

describe('recoverBaseTemplate', () => {
	it('reads an untouched prompt as its own original', async () => {
		const teamId = await coachTeam();
		const docId = await promptDocId();
		const current = await db.query<{ content: string }>(
			'SELECT content FROM documents WHERE id = $1',
			[docId],
		);
		expect(await recoverBaseTemplate(db, docId, current.rows[0].content)).toBe(
			current.rows[0].content,
		);
		expect(teamId).toBeTruthy();
	});

	it('reads the first revision as the original once the prompt has been edited', async () => {
		const teamId = await coachTeam();
		const docId = await promptDocId();
		const original = (
			await db.query<{ content: string }>('SELECT content FROM documents WHERE id = $1', [docId])
		).rows[0].content;

		await setPrompt(`${original}\n\n## Learned Rules\n- one`, teamId);
		await setPrompt(`${original}\n\n## Learned Rules\n- one\n- two`, teamId);

		// A revision holds the content as it was BEFORE a change, so the first one is
		// the text the agent was hired on however many edits followed.
		expect(await recoverBaseTemplate(db, docId, 'anything')).toBe(original);
		await setPrompt(original, teamId);
	});
});

describe('findRolePromptUpdates', () => {
	it('finds nothing on an instance whose agents match the catalog', async () => {
		const found = await findRolePromptUpdates(db);
		expect(found.find((u) => u.memberId === coachId)).toBeUndefined();
	});

	it('finds a built-in agent whose role doc moved, and preserves its learned rules', async () => {
		const teamId = await coachTeam();
		const original = (
			await db.query<{ content: string }>(
				'SELECT system_prompt_template FROM agent_types WHERE id = $1',
				[coachTypeId],
			)
		).rows[0] as unknown as { system_prompt_template: string };
		const base = original.system_prompt_template;

		await setPrompt(`${base}\n\n## Learned Rules\n- learned this the hard way`, teamId);
		await setTemplate(`${base}\n\n## New Section\nSomething this release added.`);

		const found = await findRolePromptUpdates(db);
		const coach = found.find((u) => u.memberId === coachId);
		expect(coach?.outcome).toBe('clean');
		expect(coach?.content).toContain('Something this release added.');
		expect(coach?.content).toContain('- learned this the hard way');

		await setTemplate(base);
		await setPrompt(base, teamId);
	});

	it('never touches an agent whose type is not built in', async () => {
		// A hire, a marketplace role and a template snapshot all carry a custom type
		// whose template records what was provisioned, not what this release ships.
		// Carrying "changes" into those would be inventing them.
		const teamId = await coachTeam();
		const base = (
			await db.query<{ system_prompt_template: string }>(
				'SELECT system_prompt_template FROM agent_types WHERE id = $1',
				[coachTypeId],
			)
		).rows[0].system_prompt_template;

		await setPrompt(base, teamId);
		await setTemplate(`${base}\nmoved`);
		await db.query('UPDATE agent_types SET is_builtin = false WHERE id = $1', [coachTypeId]);

		expect((await findRolePromptUpdates(db)).find((u) => u.memberId === coachId)).toBeUndefined();

		await db.query('UPDATE agent_types SET is_builtin = true WHERE id = $1', [coachTypeId]);
		await setTemplate(base);
	});
});

describe('fileRolePromptUpdates', () => {
	let base: string;

	beforeEach(async () => {
		const teamId = await coachTeam();
		base = (
			await db.query<{ system_prompt_template: string }>(
				'SELECT system_prompt_template FROM agent_types WHERE id = $1',
				[coachTypeId],
			)
		).rows[0].system_prompt_template;
		await setPrompt(base, teamId);
	});

	it('offers the update once, and does not reissue it on the next boot', async () => {
		await setTemplate(`${base}\nv2`);
		expect(await fileRolePromptUpdates(db)).toBeGreaterThan(0);
		expect(await pendingCards()).toHaveLength(1);

		// The decision the admin is already looking at must not be duplicated every
		// time the instance restarts.
		await fileRolePromptUpdates(db);
		expect(await pendingCards()).toHaveLength(1);
		await setTemplate(base);
	});

	it('rewrites a standing offer when the role doc moves again, rather than adding a second', async () => {
		await setTemplate(`${base}\nv2`);
		await fileRolePromptUpdates(db);
		await setTemplate(`${base}\nv3`);
		await fileRolePromptUpdates(db);

		const cards = await pendingCards();
		expect(cards).toHaveLength(1);
		// Two cards would make the admin choose between them, and a stale one applies
		// text from a release ago.
		expect(cards[0].payload.content).toContain('v3');
		expect(cards[0].payload.content).not.toContain('v2');
		await setTemplate(base);
	});

	it('never re-offers a role doc the admin declined', async () => {
		await setTemplate(`${base}\nv2`);
		await fileRolePromptUpdates(db);
		await db.query(
			`UPDATE approvals SET status = $1::approval_status, resolved_at = now()
			  WHERE type = $2::approval_type AND payload->>'member_id' = $3`,
			[ApprovalStatus.Denied, ApprovalType.RoleUpdate, coachId],
		);

		await fileRolePromptUpdates(db);
		expect(await pendingCards()).toHaveLength(0);
		await setTemplate(base);
	});

	it('offers the next improvement even after one was declined', async () => {
		// The refusal is remembered against the version refused, not against the
		// agent - otherwise one "no" silences every future improvement.
		await setTemplate(`${base}\nv2`);
		await fileRolePromptUpdates(db);
		await db.query(
			`UPDATE approvals SET status = $1::approval_status, resolved_at = now()
			  WHERE type = $2::approval_type AND payload->>'member_id' = $3`,
			[ApprovalStatus.Denied, ApprovalType.RoleUpdate, coachId],
		);

		await setTemplate(`${base}\nv3`);
		await fileRolePromptUpdates(db);
		const cards = await pendingCards();
		expect(cards).toHaveLength(1);
		expect(cards[0].payload.content).toContain('v3');
		await setTemplate(base);
	});

	it('files nothing on an instance already running this release', async () => {
		expect(await fileRolePromptUpdates(db)).toBe(0);
		expect(await pendingCards()).toHaveLength(0);
	});
});

describe('accepting an offered role update', () => {
	it('writes the offered text and leaves a revision to roll back to', async () => {
		// The safety net for the whole mechanism: a release that makes an agent worse
		// is one click back on the agent's settings page, because the write goes
		// through the same path any prompt edit takes.
		const teamId = await coachTeam();
		const base = (
			await db.query<{ system_prompt_template: string }>(
				'SELECT system_prompt_template FROM agent_types WHERE id = $1',
				[coachTypeId],
			)
		).rows[0].system_prompt_template;
		await setPrompt(`${base}\n\n## Learned Rules\n- keep me`, teamId);
		await setTemplate(`${base}\n\n## New Section\nadded by the release`);
		await fileRolePromptUpdates(db);

		const card = await db.query<{ id: string }>(
			`SELECT id FROM approvals
			  WHERE type = $1::approval_type AND status = $2::approval_status
			    AND payload->>'member_id' = $3`,
			[ApprovalType.RoleUpdate, ApprovalStatus.Pending, coachId],
		);
		const resolved = await resolveApproval(db, card.rows[0].id, {
			status: ApprovalStatus.Approved,
			resolutionNote: null,
			dataDir: '',
			actorMemberId: null,
		});
		expect(resolved.ok).toBe(true);

		const after = await db.query<{ content: string }>(
			`SELECT content FROM documents WHERE member_agent_id = $1 AND type = $2::document_type`,
			[coachId, DocumentType.AgentSystemPrompt],
		);
		expect(after.rows[0].content).toContain('added by the release');
		expect(after.rows[0].content).toContain('- keep me');

		const revisions = await db.query<{ content: string }>(
			`SELECT r.content FROM document_revisions r
			   JOIN documents d ON d.id = r.document_id
			  WHERE d.member_agent_id = $1 ORDER BY r.revision_number DESC LIMIT 1`,
			[coachId],
		);
		// The newest revision holds what the prompt was before this write, which is
		// exactly what rollback restores.
		expect(revisions.rows[0].content).toContain('- keep me');
		expect(revisions.rows[0].content).not.toContain('added by the release');

		await setTemplate(base);
		await setPrompt(base, teamId);
	});

	it('writes nothing and does not throw when the card names no agent', async () => {
		const teamId = await coachTeam();
		const before = (
			await db.query<{ content: string }>(
				`SELECT content FROM documents WHERE member_agent_id = $1 AND type = $2::document_type`,
				[coachId, DocumentType.AgentSystemPrompt],
			)
		).rows[0].content;
		const card = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, $2::approval_type, $3::jsonb) RETURNING id`,
			[teamId, ApprovalType.RoleUpdate, JSON.stringify({ type: 'role_update' })],
		);
		const resolved = await resolveApproval(db, card.rows[0].id, {
			status: ApprovalStatus.Approved,
			resolutionNote: null,
			dataDir: '',
			actorMemberId: null,
		});
		expect(resolved.ok).toBe(true);
		const after = await db.query<{ content: string }>(
			`SELECT content FROM documents WHERE member_agent_id = $1 AND type = $2::document_type`,
			[coachId, DocumentType.AgentSystemPrompt],
		);
		expect(after.rows[0].content).toBe(before);
	});
});
