import {
	DEFAULT_TEAM_ID,
	HeartbeatRunStatus,
	HQ_PROJECT_SLUG,
	REQUIRED_SYSTEM_PROMPT_VARS,
} from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAdminJwt, signAgentJwt } from '../src/middleware/auth';
import { authHeader, createAgentRun, createTestTeam, projectSlugFor } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';
import { compliantPrompt } from './helpers/prompt';

/**
 * Coverage suite for packages/server/src/routes/agents.ts. Exercises the
 * listing query variants, the hire/onboard flow (bootstrap + coordination
 * paths), chat-memory, system-prompt preview/revisions/restore, the PATCH
 * validation matrix, disable/enable, org-chart CEO scoping, and the
 * heartbeat-run fetch/terminate endpoints — all over real HTTP against the
 * test app.
 */

let ctx: ServerTestContext;
let teamId: string;
let projectSlug: string;
let projectId: string;

const json = (token: string) => ({
	...authHeader(token),
	'Content-Type': 'application/json',
});

async function listAgents(): Promise<Array<Record<string, unknown>>> {
	const res = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(ctx.token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

async function findAgent(slug: string): Promise<Record<string, unknown>> {
	const agent = (await listAgents()).find((a) => a.slug === slug);
	if (!agent) throw new Error(`agent ${slug} not found`);
	return agent;
}

async function createAgent(title: string): Promise<Record<string, unknown>> {
	const res = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: json(ctx.token),
		body: JSON.stringify({ title }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function mintAgentTokenFor(agentId: string): Promise<string> {
	const runId = await createAgentRun(ctx.db, agentId, teamId);
	return signAgentJwt(ctx.masterKeyManager, agentId, teamId, runId, projectId, false);
}

beforeAll(async () => {
	ctx = await createTestContext();

	const typesRes = await ctx.app.request('/api/team-templates', {
		headers: authHeader(ctx.token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(ctx.db, {
		name: 'Agents More Coverage Co',
		template_id: typeId,
	});
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(ctx.db, teamId);
	const projectRow = await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectSlug,
	]);
	projectId = projectRow.rows[0].id;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('GET /agents listing', () => {
	it('lists the roster plus HQ virtual members, ordered own-team first', async () => {
		const agents = await listAgents();
		const own = agents.filter((a) => !a.is_instance);
		const instance = agents.filter((a) => a.is_instance);
		expect(own.length).toBeGreaterThan(0);
		expect(instance.map((a) => a.slug).sort()).toEqual(['ceo', 'coach']);
		// Own-team agents sort before the HQ virtual members.
		expect(agents.findIndex((a) => a.is_instance)).toBeGreaterThan(0);
		for (const a of agents) {
			expect(a).toHaveProperty('assigned_task_count');
			expect(a).toHaveProperty('next_heartbeat_at');
			expect(a).toHaveProperty('has_actionable_work');
		}
	});

	it('filters by admin_status', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents?admin_status=disabled`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});
});

describe('POST /agents FK validation', () => {
	it('rejects a reports_to UUID that does not exist with 400', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({
				title: 'Orphan Reporter',
				reports_to: '00000000-0000-4000-8000-000000000000',
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('reports_to');
	});
});

describe('POST /agents/onboard', () => {
	it('rejects an invalid proposal with 400', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({ title: 'Bad Effort', default_effort: 'ludicrous' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a slug conflict with 409', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({ title: 'Captain' }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
	});

	it('bootstrap path (HQ): materializes the agent directly, resolving reports_to', async () => {
		const res = await ctx.app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents/onboard`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({
				title: 'HQ Analyst',
				role_description: 'Analyzes things',
				reports_to: 'ceo',
			}),
		});
		expect(res.status).toBe(201);
		const { agent, task, approval, bootstrap } = (await res.json()).data;
		expect(bootstrap).toBe(true);
		expect(task).toBeNull();
		expect(approval).toBeNull();
		expect(agent.slug).toBe('hq-analyst');
		expect(agent.admin_status).toBe('enabled');

		// reports_to was resolved from the slug to the CEO's member id.
		const row = await ctx.db.query<{ reports_to: string | null }>(
			`SELECT ma.reports_to FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = 'hq-analyst' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		const ceo = await ctx.db.query<{ id: string }>(
			"SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1",
		);
		expect(row.rows[0].reports_to).toBe(ceo.rows[0].id);
	});

	it('bootstrap path without reports_to stores a null manager', async () => {
		const res = await ctx.app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents/onboard`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({ title: 'HQ Loner', role_description: 'Solo' }),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.bootstrap).toBe(true);
		const row = await ctx.db.query<{ reports_to: string | null }>(
			`SELECT ma.reports_to FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = 'hq-loner' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		expect(row.rows[0].reports_to).toBeNull();
	});

	it('coordination path: creates a hire approval + CEO task and wires them together', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({
				title: 'Support Engineer',
				role_description: 'Handles support',
				system_prompt: compliantPrompt('Support prompt'),
			}),
		});
		expect(res.status).toBe(201);
		const { agent, task, approval, bootstrap } = (await res.json()).data;
		expect(bootstrap).toBe(false);
		expect(agent).toBeNull();
		expect(task.title).toBe('Onboard new agent: Support Engineer');
		expect(task.labels).toEqual(expect.arrayContaining(['onboarding', 'hire']));
		expect(task.description).toContain('Support prompt');
		expect(approval.status).toBe('pending');
		expect(approval.payload.slug).toBe('support-engineer');
		expect(approval.payload.task_id).toBe(task.id);

		// The task is assigned to the instance CEO.
		const ceo = await ctx.db.query<{ id: string }>(
			"SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1",
		);
		expect(task.assignee_id).toBe(ceo.rows[0].id);

		// The proposal surfaces as an action comment on the hire ticket.
		const comment = await ctx.db.query(
			`SELECT 1 FROM task_comments
			 WHERE task_id = $1 AND content->>'kind' = 'hire_proposal'`,
			[task.id],
		);
		expect(comment.rows.length).toBe(1);
	});

	it('attributes the request to a non-superuser admin member', async () => {
		const user = await ctx.db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Board Admin', false) RETURNING id",
		);
		const member = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'user', 'Board Admin') RETURNING id`,
			[teamId],
		);
		await ctx.db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
			member.rows[0].id,
			user.rows[0].id,
		]);
		const adminToken = await signAdminJwt(ctx.masterKeyManager, user.rows[0].id);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: json(adminToken),
			body: JSON.stringify({ title: 'Docs Writer', role_description: 'Writes docs' }),
		});
		expect(res.status).toBe(201);
		const { approval } = (await res.json()).data;
		const stored = await ctx.db.query<{ requested_by_member_id: string | null }>(
			'SELECT requested_by_member_id FROM approvals WHERE id = $1',
			[approval.id],
		);
		expect(stored.rows[0].requested_by_member_id).toBe(member.rows[0].id);
	});
});

describe('GET /agents/:agentId detail', () => {
	it('returns full detail with is_instance and chat_enabled flags', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/captain`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const agent = (await res.json()).data;
		expect(agent.slug).toBe('captain');
		expect(agent.is_instance).toBe(false);
		expect(agent.chat_enabled).toBe(false);
		expect(agent).toHaveProperty('assigned_task_count');
	});

	it('404s for an unknown agent', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/nobody-here`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});
});

describe('chat memory', () => {
	it('404s for an unknown agent (GET and PUT)', async () => {
		for (const method of ['GET', 'PUT'] as const) {
			const res = await ctx.app.request(
				`/api/projects/${projectSlug}/agents/nobody-here/chat-memory`,
				{
					method,
					headers: json(ctx.token),
					body: method === 'PUT' ? JSON.stringify({ content: 'x' }) : undefined,
				},
			);
			expect(res.status).toBe(404);
		}
	});

	it('404s for an agent without a conversation (GET and PUT)', async () => {
		const getRes = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/captain/chat-memory`,
			{ headers: authHeader(ctx.token) },
		);
		expect(getRes.status).toBe(404);
		expect((await getRes.json()).error.message).toContain('no chat memory');

		const putRes = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/captain/chat-memory`,
			{ method: 'PUT', headers: json(ctx.token), body: JSON.stringify({ content: 'x' }) },
		);
		expect(putRes.status).toBe(404);
	});

	it('reads empty, rejects non-string content, writes and reads back for the CEO', async () => {
		const ceo = await ctx.db.query<{ id: string }>(
			"SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1",
		);
		await ctx.db.query(
			`INSERT INTO chat_conversations (member_id, team_id, project_id)
			 VALUES ($1, $2, (SELECT id FROM projects WHERE team_id = $2 AND is_internal = true))`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID],
		);

		// No memory yet — empty content, null updated_at.
		const empty = await ctx.app.request(`/api/projects/${projectSlug}/agents/ceo/chat-memory`, {
			headers: authHeader(ctx.token),
		});
		expect(empty.status).toBe(200);
		expect((await empty.json()).data).toEqual({ content: '', updated_at: null });

		// Non-string content is rejected.
		const bad = await ctx.app.request(`/api/projects/${projectSlug}/agents/ceo/chat-memory`, {
			method: 'PUT',
			headers: json(ctx.token),
			body: JSON.stringify({ content: 42 }),
		});
		expect(bad.status).toBe(400);
		expect((await bad.json()).error.message).toContain('content must be a string');

		// Valid write round-trips.
		const put = await ctx.app.request(`/api/projects/${projectSlug}/agents/ceo/chat-memory`, {
			method: 'PUT',
			headers: json(ctx.token),
			body: JSON.stringify({ content: 'Remembered facts' }),
		});
		expect(put.status).toBe(200);
		expect((await put.json()).data.content).toBe('Remembered facts');

		const read = await ctx.app.request(`/api/projects/${projectSlug}/agents/ceo/chat-memory`, {
			headers: authHeader(ctx.token),
		});
		const body = (await read.json()).data;
		expect(body.content).toBe('Remembered facts');
		expect(body.updated_at).not.toBeNull();
	});

	it('PUT is forbidden for an agent JWT', async () => {
		const captain = await findAgent('captain');
		const agentToken = await mintAgentTokenFor(captain.id as string);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/ceo/chat-memory`, {
			method: 'PUT',
			headers: json(agentToken),
			body: JSON.stringify({ content: 'x' }),
		});
		expect(res.status).toBe(403);
	});
});

describe('system prompt fetch / preview / revisions / restore', () => {
	it('fetches the stored system prompt document', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/captain/system-prompt`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect(typeof (await res.json()).data.content).toBe('string');
	});

	it('system-prompt GET 404s for an unknown agent', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/nobody/system-prompt`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('preview resolves placeholders', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/captain/system-prompt/preview`,
			{ headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(200);
		const content = (await res.json()).data.content as string;
		expect(content).not.toMatch(/\{\{[a-z_]+\}\}/);
	});

	it('preview / revisions / restore 404 when the prompt document is missing', async () => {
		const agent = await createAgent('Docless Agent');
		await ctx.db.query(
			`DELETE FROM documents WHERE type = 'agent_system_prompt' AND member_agent_id = $1`,
			[agent.id],
		);

		const preview = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/system-prompt/preview`,
			{ headers: authHeader(ctx.token) },
		);
		expect(preview.status).toBe(404);

		const revisions = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/system-prompt/revisions`,
			{ headers: authHeader(ctx.token) },
		);
		expect(revisions.status).toBe(404);

		const restore = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: json(ctx.token),
				body: JSON.stringify({ revision_number: 1 }),
			},
		);
		expect(restore.status).toBe(404);
	});

	it('revisions 404s for an unknown agent', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/nobody/system-prompt/revisions`,
			{ headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(404);
	});

	it('restore validation: agent JWT 403, unknown agent 404, missing revision_number 400', async () => {
		const captain = await findAgent('captain');
		const agentToken = await mintAgentTokenFor(captain.id as string);
		const forbidden = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: json(agentToken),
				body: JSON.stringify({ revision_number: 1 }),
			},
		);
		expect(forbidden.status).toBe(403);

		const missingAgent = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/nobody/system-prompt/restore`,
			{
				method: 'POST',
				headers: json(ctx.token),
				body: JSON.stringify({ revision_number: 1 }),
			},
		);
		expect(missingAgent.status).toBe(404);

		const missingNumber = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${captain.id}/system-prompt/restore`,
			{ method: 'POST', headers: json(ctx.token), body: JSON.stringify({}) },
		);
		expect(missingNumber.status).toBe(400);
	});

	it('edits create revisions; restore brings back the prior content; unknown revision 404s', async () => {
		const agent = await createAgent('Revisable Agent');
		const v1 = compliantPrompt('Version one');
		const v2 = compliantPrompt('Version two');
		for (const prompt of [v1, v2]) {
			const patch = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
				method: 'PATCH',
				headers: json(ctx.token),
				body: JSON.stringify({ system_prompt: prompt }),
			});
			expect(patch.status).toBe(200);
		}

		const revRes = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/system-prompt/revisions`,
			{ headers: authHeader(ctx.token) },
		);
		expect(revRes.status).toBe(200);
		const revisions = (await revRes.json()).data as Array<Record<string, unknown>>;
		expect(revisions.length).toBeGreaterThanOrEqual(2);
		const v1Revision = revisions.find((r) => (r.content as string).includes('Version one'));
		expect(v1Revision).toBeDefined();

		const badRestore = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: json(ctx.token),
				body: JSON.stringify({ revision_number: 9999 }),
			},
		);
		expect(badRestore.status).toBe(404);

		const restore = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/system-prompt/restore`,
			{
				method: 'POST',
				headers: json(ctx.token),
				body: JSON.stringify({ revision_number: v1Revision!.revision_number }),
			},
		);
		expect(restore.status).toBe(200);
		expect((await restore.json()).data.content).toContain('Version one');
	});
});

describe('POST /agents/system-prompts/batch', () => {
	it('rejects non-array, empty, and oversized items', async () => {
		for (const items of ['nope', [], Array.from({ length: 51 }, () => ({ agent_id: 'x' }))]) {
			const res = await ctx.app.request(
				`/api/projects/${projectSlug}/agents/system-prompts/batch`,
				{ method: 'POST', headers: json(ctx.token), body: JSON.stringify({ items }) },
			);
			expect(res.status).toBe(400);
		}
	});

	it('returns per-item results: success, missing agent_id, unknown agent', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/system-prompts/batch`, {
			method: 'POST',
			headers: json(ctx.token),
			body: JSON.stringify({
				items: [
					{ agent_id: 'captain', mode: 'raw' },
					{ mode: 'preview' },
					{ agent_id: 'nobody-here' },
					{ agent_id: 'captain', mode: 'not-a-mode' },
				],
			}),
		});
		expect(res.status).toBe(200);
		const results = (await res.json()).data as Array<Record<string, unknown>>;
		expect(results).toHaveLength(4);
		expect(results[0].ok).toBe(true);
		expect(results[1].ok).toBe(false);
		expect(results[1].error).toBe('agent_id is required');
		expect(results[2].ok).toBe(false);
		// Invalid mode falls back to placeholders and still succeeds.
		expect(results[3].ok).toBe(true);
	});
});

describe('PATCH /agents/:agentId', () => {
	it('rejects an invalid default_effort', async () => {
		const captain = await findAgent('captain');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/${captain.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ default_effort: 'warp-speed' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects moving the Captain off its fixed reporting line but accepts a no-op resubmit', async () => {
		const captain = await findAgent('captain');
		const move = await ctx.app.request(`/api/projects/${projectSlug}/agents/${captain.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ reports_to: null }),
		});
		// The Captain reports to the CEO; clearing that is rejected.
		expect(move.status).toBe(400);
		expect((await move.json()).error.message).toContain('Captain');

		const current = await ctx.db.query<{ reports_to: string | null }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[captain.id],
		);
		const noop = await ctx.app.request(`/api/projects/${projectSlug}/agents/${captain.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ reports_to: current.rows[0].reports_to }),
		});
		expect(noop.status).toBe(200);
	});

	it('rejects moving the Coach off its admin reporting line', async () => {
		const res = await ctx.app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents/coach`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ reports_to: '00000000-0000-4000-8000-000000000000' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('reports to the admin');
	});

	it('rejects a system_prompt missing required vars for a team agent', async () => {
		const captain = await findAgent('captain');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/${captain.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ system_prompt: 'No variables here at all' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain(REQUIRED_SYSTEM_PROMPT_VARS[0]);
	});

	it('exempts the instance CEO from the required-vars check', async () => {
		const res = await ctx.app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents/ceo`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ system_prompt: 'CEO prompt with no template vars' }),
		});
		expect(res.status).toBe(200);

		const doc = await ctx.app.request(`/api/projects/${HQ_PROJECT_SLUG}/agents/ceo/system-prompt`, {
			headers: authHeader(ctx.token),
		});
		expect((await doc.json()).data.content).toBe('CEO prompt with no template vars');
	});

	it('model override matrix: invalid provider / non-string model / model without provider', async () => {
		const agent = await createAgent('Override Agent');
		const badProvider = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ model_override_provider: 'skynet' }),
		});
		expect(badProvider.status).toBe(400);

		const badModel = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ model_override_model: 7 }),
		});
		expect(badModel.status).toBe(400);

		const orphanModel = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ model_override_model: 'gpt-42' }),
		});
		expect(orphanModel.status).toBe(400);
		expect((await orphanModel.json()).error.message).toContain('requires model_override_provider');
	});

	it('sets, amends, and clears a model override', async () => {
		const agent = await createAgent('Override Agent Two');
		const set = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({
				model_override_provider: 'anthropic',
				model_override_model: '  claude-test-1  ',
			}),
		});
		expect(set.status).toBe(200);
		const setBody = (await set.json()).data;
		expect(setBody.model_override_provider).toBe('anthropic');
		expect(setBody.model_override_model).toBe('claude-test-1');

		// Model-only change is fine once a provider is stored.
		const amend = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ model_override_model: 'claude-test-2' }),
		});
		expect(amend.status).toBe(200);
		expect((await amend.json()).data.model_override_model).toBe('claude-test-2');

		// An explicit null model clears just the model.
		const nullModel = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ model_override_model: null }),
		});
		expect(nullModel.status).toBe(200);
		expect((await nullModel.json()).data.model_override_model).toBeNull();

		// Clearing the provider also clears the model.
		const clear = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ model_override_provider: null }),
		});
		expect(clear.status).toBe(200);
		const cleared = (await clear.json()).data;
		expect(cleared.model_override_provider).toBeNull();
		expect(cleared.model_override_model).toBeNull();
	});

	it('validates the merged budget trio and accepts a coherent single-window change', async () => {
		const agent = await createAgent('Budget Agent');
		// Stored monthly is 3000; a daily above it is incoherent.
		const bad = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ daily_budget_cents: 999999 }),
		});
		expect(bad.status).toBe(400);

		// Daily 90 implies a monthly floor of ceil(90 × 365/12) = 2738 ≤ the stored 3000.
		const good = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ daily_budget_cents: 90 }),
		});
		expect(good.status).toBe(200);
		expect((await good.json()).data.daily_budget_cents).toBe(90);
	});

	it('returns the current row unchanged for an empty PATCH body', async () => {
		const captain = await findAgent('captain');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/${captain.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.slug).toBe('captain');
	});

	it('updates title (syncing display_name) plus settings fields', async () => {
		const agent = await createAgent('Renamable Agent');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({
				title: 'Renamed Agent',
				role_description: 'Updated role',
				heartbeat_interval_min: 90,
				run_timeout_min: 45,
				touches_code: true,
				mcp_servers: [{ name: 'test-mcp' }],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.title).toBe('Renamed Agent');
		expect(body.role_description).toBe('Updated role');
		expect(body.heartbeat_interval_min).toBe(90);
		expect(body.run_timeout_min).toBe(45);
		expect(body.touches_code).toBe(true);

		const member = await ctx.db.query<{ display_name: string }>(
			'SELECT display_name FROM members WHERE id = $1',
			[agent.id],
		);
		expect(member.rows[0].display_name).toBe('Renamed Agent');
	});

	it('reassigns reports_to on a regular agent', async () => {
		const agent = await createAgent('Reassignable Agent');
		const captain = await findAgent('captain');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ reports_to: captain.id }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.reports_to).toBe(captain.id);
	});

	it('404s for an unknown agent', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/nobody`, {
			method: 'PATCH',
			headers: json(ctx.token),
			body: JSON.stringify({ title: 'X' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('disable / enable', () => {
	it('404s for an unknown agent on both endpoints', async () => {
		for (const action of ['disable', 'enable']) {
			const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/nobody/${action}`, {
				method: 'POST',
				headers: authHeader(ctx.token),
			});
			expect(res.status).toBe(404);
		}
	});

	it('refuses to disable the instance CEO', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/ceo/disable`, {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toContain('essential');
	});

	it('enable 404s for an HQ virtual member addressed through another team', async () => {
		// The Coach resolves as an HQ virtual member here, but the status change is
		// scoped to this team, where it is not a member — the service reports
		// not_found and the route maps it to 404.
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/coach/enable`, {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
		// The Coach's real (HQ) status is untouched.
		const row = await ctx.db.query<{ admin_status: string }>(
			"SELECT admin_status FROM member_agents WHERE slug = 'coach'",
		);
		expect(row.rows[0].admin_status).toBe('enabled');
	});

	it('disables then re-enables an agent, rejecting repeats with 409', async () => {
		const agent = await createAgent('Toggle Agent');

		const disable = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/disable`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(disable.status).toBe(200);
		expect((await disable.json()).data.admin_status).toBe('disabled');

		const again = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}/disable`, {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect(again.status).toBe(409);

		const enable = await ctx.app.request(`/api/projects/${projectSlug}/agents/${agent.id}/enable`, {
			method: 'POST',
			headers: authHeader(ctx.token),
		});
		expect(enable.status).toBe(200);
		expect((await enable.json()).data.admin_status).toBe('enabled');

		const enableAgain = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/enable`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(enableAgain.status).toBe(409);

		const row = await ctx.db.query<{ admin_status: string }>(
			'SELECT admin_status FROM member_agents WHERE id = $1',
			[agent.id],
		);
		expect(row.rows[0].admin_status).toBe('enabled');
	});
});

describe('org chart', () => {
	it("nests the roster under the CEO and scopes the CEO's running state to this team", async () => {
		const ceo = await ctx.db.query<{ id: string }>(
			"SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1",
		);
		const ceoId = ceo.rows[0].id;

		// Globally active because of a run in HQ — must not read active here.
		await ctx.db.query(
			`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
			[ceoId],
		);
		await ctx.db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, status)
			 VALUES ($1, $2, 'running'::heartbeat_run_status)`,
			[DEFAULT_TEAM_ID, ceoId],
		);

		let res = await ctx.app.request(`/api/projects/${projectSlug}/org-chart`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		let chart = (await res.json()).data;
		let ceoNode = chart.admin.children.find((n: Record<string, unknown>) => n.slug === 'ceo');
		expect(ceoNode).toBeDefined();
		expect(ceoNode.runtime_status).toBe('idle');
		const captainNode = (ceoNode.children as Array<Record<string, unknown>>).find(
			(n) => n.slug === 'captain',
		);
		expect(captainNode).toBeDefined();

		// A run in *this* team flips the indicator to active.
		await ctx.db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, status)
			 VALUES ($1, $2, 'queued'::heartbeat_run_status)`,
			[teamId, ceoId],
		);
		res = await ctx.app.request(`/api/projects/${projectSlug}/org-chart`, {
			headers: authHeader(ctx.token),
		});
		chart = (await res.json()).data;
		ceoNode = chart.admin.children.find((n: Record<string, unknown>) => n.slug === 'ceo');
		expect(ceoNode.runtime_status).toBe('active');

		// Cleanup so later suites see a quiet CEO.
		await ctx.db.query(
			`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status, finished_at = now()
			 WHERE member_id = $1`,
			[ceoId],
		);
	});
});

describe('heartbeat runs', () => {
	it('list 404s for an unknown agent', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/agents/nobody/heartbeat-runs`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('lists runs newest-first with trigger/task metadata', async () => {
		const agent = await createAgent('Runner Agent');
		await ctx.db.query(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, exit_code, log_text)
			 VALUES ($1, $2, 'succeeded', now() - interval '10 minutes', now() - interval '9 minutes', 0, 'older'),
			        ($1, $2, 'failed', now() - interval '2 minutes', now() - interval '1 minute', 1, 'newer')`,
			[agent.id, teamId],
		);
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs`,
			{ headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(200);
		const runs = (await res.json()).data;
		expect(runs).toHaveLength(2);
		expect(runs[0].log_text).toBe('newer');
		expect(runs[0].created_tasks).toEqual([]);
		expect(runs[1].log_text).toBe('older');
	});

	it('fetches a single run, 404s for unknown agent/run', async () => {
		const agent = await createAgent('Single Run Agent');
		const inserted = await ctx.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, 'succeeded', now(), now(), 0) RETURNING id`,
			[agent.id, teamId],
		);
		const runId = inserted.rows[0].id;

		const ok = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs/${runId}`,
			{ headers: authHeader(ctx.token) },
		);
		expect(ok.status).toBe(200);
		expect((await ok.json()).data.id).toBe(runId);

		const badAgent = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/nobody/heartbeat-runs/${runId}`,
			{ headers: authHeader(ctx.token) },
		);
		expect(badAgent.status).toBe(404);

		const badRun = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs/00000000-0000-4000-8000-000000000000`,
			{ headers: authHeader(ctx.token) },
		);
		expect(badRun.status).toBe(404);
	});

	it('terminate: 404s, 409 on a finished run, and cancels a queued run', async () => {
		const agent = await createAgent('Terminable Agent');
		const finished = await ctx.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, exit_code)
			 VALUES ($1, $2, 'succeeded', now(), now(), 0) RETURNING id`,
			[agent.id, teamId],
		);
		const queued = await ctx.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status)
			 VALUES ($1, $2, 'queued') RETURNING id`,
			[agent.id, teamId],
		);

		const badAgent = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/nobody/heartbeat-runs/${queued.rows[0].id}/terminate`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(badAgent.status).toBe(404);

		const badRun = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs/00000000-0000-4000-8000-000000000000/terminate`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(badRun.status).toBe(404);

		const conflict = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs/${finished.rows[0].id}/terminate`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error.message).toContain('already succeeded');

		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/agents/${agent.id}/heartbeat-runs/${queued.rows[0].id}/terminate`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.terminated).toBe(true);
		expect(body.status).toBe(HeartbeatRunStatus.Cancelled);

		const row = await ctx.db.query<{ status: string; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[queued.rows[0].id],
		);
		expect(row.rows[0].status).toBe('cancelled');
		expect(row.rows[0].error).toBe('Terminated by user');
	});
});
