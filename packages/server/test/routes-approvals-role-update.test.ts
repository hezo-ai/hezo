import { randomUUID } from 'node:crypto';
import { ApprovalType, DocumentType } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAdminJwt } from '../src/middleware/auth';
import { upsertDocument } from '../src/services/documents';
import { authHeader, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * A role update card carries two whole prompts. The inbox list leaves them out,
 * and the preview reads them, with the agent's live prompt, from the single-card
 * read - which must never reach across teams.
 */

let ctx: ServerTestContext;
let projectSlug: string;
let outsiderToken: string;
let cardId: string;
let livePrompt: string;
let agentId: string;
let teamId: string;

async function teamWithProject(name: string): Promise<{ teamId: string; slug: string }> {
	const teamRes = await createTestTeam(ctx.db, { name });
	const teamId = (await teamRes.json()).data.id as string;
	const projectRes = await createTestProject(ctx.db, teamId, { name: `${name} project` });
	return { teamId, slug: (await projectRes.json()).data.slug as string };
}

beforeAll(async () => {
	ctx = await createTestContext();
	const own = await teamWithProject('Role Preview Co');
	projectSlug = own.slug;
	// A board user of a different team, who must not read this team's card.
	const other = await teamWithProject('Someone Else Co');
	const outsider = await ctx.db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Outsider', false) RETURNING id",
	);
	const member = await ctx.db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user', 'Outsider') RETURNING id`,
		[other.teamId],
	);
	await ctx.db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
		member.rows[0].id,
		outsider.rows[0].id,
	]);
	outsiderToken = await signAdminJwt(ctx.masterKeyManager, outsider.rows[0].id);

	const agent = await ctx.db.query<{ id: string; content: string }>(
		`SELECT ma.id, d.content FROM member_agents ma
		   JOIN members m ON m.id = ma.id
		   JOIN documents d ON d.member_agent_id = ma.id AND d.type = $2::document_type
		  WHERE m.team_id = $1 LIMIT 1`,
		[own.teamId, DocumentType.AgentSystemPrompt],
	);
	livePrompt = agent.rows[0].content;
	agentId = agent.rows[0].id;
	teamId = own.teamId;
	const card = await ctx.db.query<{ id: string }>(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb) RETURNING id`,
		[
			own.teamId,
			ApprovalType.RoleUpdate,
			agent.rows[0].id,
			JSON.stringify({
				type: 'role_update',
				member_id: agent.rows[0].id,
				agent_title: 'Captain',
				outcome: 'clean',
				target_hash: 'abc',
				template: 'NEW ROLE',
				content: 'NEW ROLE\n\n## Learned Rules\n- keep me',
			}),
		],
	);
	cardId = card.rows[0].id;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('role update cards over REST', () => {
	it('lists the card without either prompt', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/approvals`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data.find((r: { id: string }) => r.id === cardId);
		expect(row.payload.outcome).toBe('clean');
		expect(row.payload.agent_title).toBe('Captain');
		expect(row.payload).not.toHaveProperty('content');
		expect(row.payload).not.toHaveProperty('template');
	});

	it('reads the card whole, with the prompt it would replace', async () => {
		const res = await ctx.app.request(`/api/approvals/${cardId}`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const card = (await res.json()).data;
		expect(card.payload.content).toBe('NEW ROLE\n\n## Learned Rules\n- keep me');
		expect(card.current_prompt).toBe(livePrompt);
	});

	it('names the lines applying would drop, against the prompt as it is now', async () => {
		// The card was worked out at boot; an admin line written since is lost on
		// Apply too, so the preview's warning has to see it.
		const doc = await ctx.db.query<{ id: string }>(
			`SELECT id FROM documents WHERE member_agent_id = $1 AND type = $2::document_type`,
			[agentId, DocumentType.AgentSystemPrompt],
		);
		const docId = doc.rows[0].id;
		await ctx.db.query('DELETE FROM document_revisions WHERE document_id = $1', [docId]);
		await ctx.db.query('UPDATE documents SET content = $1 WHERE id = $2', ['ROLE\n- a', docId]);
		await upsertDocument(ctx.db, undefined, {
			scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId: agentId },
			content: 'ROLE\n- a\n- written after the card',
			authorMemberId: null,
		});
		const card = await ctx.db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb) RETURNING id`,
			[
				teamId,
				ApprovalType.RoleUpdate,
				agentId,
				JSON.stringify({
					type: 'role_update',
					member_id: agentId,
					outcome: 'clean',
					target_hash: 'def',
					template: 'ROLE v2\n- a',
					content: 'ROLE v2\n- a',
				}),
			],
		);

		const res = await ctx.app.request(`/api/approvals/${card.rows[0].id}`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.lost_lines).toEqual(['- written after the card']);
	});

	it('refuses a user from another team', async () => {
		const res = await ctx.app.request(`/api/approvals/${cardId}`, {
			headers: authHeader(outsiderToken),
		});
		expect(res.status).toBe(403);
	});

	it('answers 404 for a card that does not exist', async () => {
		const res = await ctx.app.request(`/api/approvals/${randomUUID()}`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});
});
