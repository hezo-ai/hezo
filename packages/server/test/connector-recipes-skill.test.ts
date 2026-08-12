import { REQUIRED_SYSTEM_PROMPT_VARS } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string; // superuser admin
let teamId: string;
let projectId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Recipes Co', description: 'Ships things' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Recipes Project' });
	const pData = (await projectRes.json()).data;
	projectId = pData.id;
	projectSlug = pData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

async function callTool(
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: { project: projectSlug, ...args } },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result?: { content: Array<{ text: string }> };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	try {
		return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
	} catch {
		return { error: body.result.content[0].text };
	}
}

describe('connector-recipes virtual skill: manifest + steering', () => {
	it('always appears in the {{skills_context}} manifest', async () => {
		const result = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			projectId,
			mode: 'placeholders',
		});
		expect(result).toContain('- Connector Recipes (slug: connector-recipes):');
	});

	it('injects the two SHARED_INSTRUCTIONS steering lines into a resolved prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Head\n{{skills_context}}', {
			teamId,
			projectId,
		});
		expect(result).toContain("call `get_skill('connector-recipes')`");
		expect(result).toContain(
			'Never choose an integration that needs an interactive browser/localhost OAuth flow',
		);
	});
});

describe('connector-recipes virtual skill: get_skill', () => {
	it('returns generated content for the reserved slug', async () => {
		const got = await callTool('get_skill', { slug: 'connector-recipes' });
		expect(got.name).toBe('Connector Recipes');
		expect(got.slug).toBe('connector-recipes');
		expect(String(got.content)).toContain('## Connection patterns');
		expect(String(got.content)).toContain('### google-youtube');
		// The lead-in closes the loop: a working connector gets recorded (and kept
		// current) as a skill.
		expect(String(got.content)).toContain('persist what you learned as a skill');
	});

	/**
	 * These three sections used to sit in SHARED_INSTRUCTIONS, costing ~1,060 words
	 * on every agent's every run for guidance only an agent actually connecting a
	 * service needs. They moved here because SHARED_INSTRUCTIONS already orders
	 * every agent to load this skill BEFORE connecting anything, so the detail
	 * arrives exactly when it is needed. If a section is dropped from the builder,
	 * the guidance is gone from the product - it is no longer anywhere else.
	 */
	it('carries the connector detail moved out of SHARED_INSTRUCTIONS', async () => {
		const content = String((await callTool('get_skill', { slug: 'connector-recipes' })).content);

		// Discovering a vendor's MCP URL and its skill file.
		expect(content).toContain('## Discovering a server URL and skill file');
		expect(content).toContain('"<vendor> MCP server"');
		expect(content).toContain('`tools/list` is the authoritative source');

		// Reading connector status: oauth_status is the usable-or-not field, and
		// every one of its six values is accounted for.
		expect(content).toContain('## Connector status');
		expect(content).toContain('Not `install_status`');
		for (const status of ['active', 'pending', 'failed', 'degraded', 'revoked']) {
			expect(content, status).toContain(`| \`${status}\` |`);
		}
		// The never-assert-broken-without-measuring rule and its two instruments.
		expect(content).toContain('`tools_this_run`');
		expect(content).toContain('Never assert a connector is broken');
		expect(content).toContain('test_connector(connector_id)');

		// Recording the service afterwards, scoped to the connector's reach.
		expect(content).toContain('## Record the service as a skill once the connector works');
		expect(content).toContain('Check for an existing public skill first');
		expect(content).toContain("Match the skill's scope to the connector's reach");
		expect(content).toContain('references the general one by slug');
	});
});

describe('connector-recipes virtual skill: reservation', () => {
	it('create_skill rejects the reserved slug', async () => {
		const r = await callTool('create_skill', {
			name: 'Connector Recipes',
			slug: 'connector-recipes',
			content: '# nope',
		});
		expect(String(r.error)).toContain('reserved built-in skill');
	});

	it('create_skill rejects a case/spacing variant that normalizes to the reserved slug', async () => {
		const r = await callTool('create_skill', {
			name: 'x',
			slug: 'Connector-Recipes',
			content: '# nope',
		});
		expect(String(r.error)).toContain('reserved built-in skill');
	});

	it('propose_skill rejects the reserved slug', async () => {
		const r = await callTool('propose_skill', {
			skill_name: 'Connector Recipes',
			skill_slug: 'connector-recipes',
			content: '# nope',
			reason: 'test',
		});
		expect(String(r.error)).toContain('reserved built-in skill');
	});

	it('POST /skills rejects the reserved slug', async () => {
		const res = await app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Connector Recipes', content: '# nope' }),
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain('reserved built-in skill');
	});
});

describe('connector-recipes virtual skill: read-only admin view', () => {
	it('GET /skills includes the synthetic read-only entry', async () => {
		const res = await app.request('/api/skills', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		const virtual = rows.find((r) => r.id === 'connector-recipes');
		expect(virtual).toBeDefined();
		expect(virtual?.readonly).toBe(true);
		expect(virtual?.slug).toBe('connector-recipes');
		// Stored rows are annotated readonly:false.
		expect(rows.every((r) => typeof r.readonly === 'boolean')).toBe(true);
	});

	it('GET /skills/connector-recipes returns generated content', async () => {
		const res = await app.request('/api/skills/connector-recipes', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const skill = (await res.json()).data as Record<string, unknown>;
		expect(skill.readonly).toBe(true);
		expect(String(skill.content)).toContain('## Service recipes');
	});

	it('PATCH /skills/connector-recipes is rejected', async () => {
		const res = await app.request('/api/skills/connector-recipes', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# edited' }),
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain('built-in skill');
	});

	it('DELETE /skills/connector-recipes is rejected', async () => {
		const res = await app.request('/api/skills/connector-recipes', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain('built-in skill');
	});
});

describe('connector-recipes virtual skill: per-project read-only view', () => {
	it('GET /projects/:projectId/skills surfaces the built-in skill as a global read-only entry', async () => {
		const res = await app.request(`/api/projects/${projectId}/skills`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		const virtual = rows.find((r) => r.id === 'connector-recipes');
		expect(virtual).toBeDefined();
		expect(virtual?.readonly).toBe(true);
		// Global scope (project_id null) so it renders under "Global (all projects)".
		expect(virtual?.project_id).toBeNull();
		// Stored rows are annotated readonly:false so the UI can tell them apart.
		expect(rows.every((r) => typeof r.readonly === 'boolean')).toBe(true);
	});

	it('GET /projects/:projectId/skills/connector-recipes returns generated content', async () => {
		const res = await app.request(`/api/projects/${projectId}/skills/connector-recipes`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const skill = (await res.json()).data as Record<string, unknown>;
		expect(skill.readonly).toBe(true);
		expect(String(skill.content)).toContain('## Service recipes');
	});
});

/**
 * The prompts have to *name* the substitution variables a hire proposal must
 * contain, and naming them used to mean writing `{{team_name}}` in prose - which
 * every substitution branch happily replaced. A real CEO run was therefore told
 * its required variables were the team's name, an empty string, and "No
 * preferences set.", while `create_hire_proposal` rejects a prompt missing the
 * real ones. Every hire it filed would have bounced.
 */
describe('the required-variable list survives resolution', () => {
	it('renders the literal placeholders, not their values', async () => {
		const result = await resolveSystemPrompt(
			db,
			'A new prompt must keep {{required_prompt_vars}} or it is rejected.',
			{ teamId, projectId },
		);

		for (const name of REQUIRED_SYSTEM_PROMPT_VARS) {
			expect(result).toContain(name);
		}
	});

	it('is not itself eaten by the variables it names', async () => {
		// The list contains `{{team_name}}`, and the team is really called
		// something - so a resolver that re-scanned its own output would replace it
		// and reintroduce the bug in exactly the shape it had.
		const result = await resolveSystemPrompt(db, 'Keep {{required_prompt_vars}}.', {
			teamId,
			projectId,
		});
		expect(result).toContain('{{team_name}}');
		// The exact shape of the bug: the team's real name appearing where the
		// variable's *name* was meant to be.
		expect(result).not.toContain('`Recipes Co`');
	});

	it('still substitutes a variable that is genuinely used', async () => {
		// The guard above must not have turned substitution off for real uses.
		const result = await resolveSystemPrompt(db, 'Team: {{team_name}}.', { teamId, projectId });
		expect(result).not.toContain('{{team_name}}');
	});
});
