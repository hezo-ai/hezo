import type { PGlite } from '@electric-sql/pglite';
import { CHAT_MEMORY_SLUG, HQ_PROJECT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Docs Cov Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Docs Cov Project',
		description: 'Test project for doc route branch coverage.',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

/** The Captain member of the project's team, used to mint an agent JWT. */
async function captainId(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	return r.rows[0].id;
}

describe('PUT /projects/:projectId/docs/:filename — validation + PRD approval', () => {
	it('400s when content is missing from the body', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/spec.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ change_summary: 'no content' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('routes an agent prd.md update into a pending Strategy approval (202)', async () => {
		const agentId = await captainId();
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId,
			},
		);

		const res = await app.request(`/api/projects/${projectId}/docs/prd.md`, {
			method: 'PUT',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# PRD\n\nAgent-proposed product requirements.' }),
		});
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.data.pending_approval).toBe(true);
		expect(body.data.filename).toBe('prd.md');

		// The approval row exists and carries the proposed content + project id.
		const approval = await db.query<{ payload: { action: string; project_id: string } }>(
			`SELECT payload FROM approvals WHERE team_id = $1 AND type = 'strategy'`,
			[teamId],
		);
		expect(approval.rows.length).toBe(1);
		expect(approval.rows[0].payload.action).toBe('update_prd');
		expect(approval.rows[0].payload.project_id).toBe(projectId);

		// And the doc itself was NOT written — the agent path defers to approval.
		const doc = await db.query(
			"SELECT 1 FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = 'prd.md'",
			[projectId],
		);
		expect(doc.rows.length).toBe(0);
	});

	it('an admin prd.md update writes directly (no approval gate)', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/prd.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# PRD\n\nAdmin-written requirements.' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('Admin-written');
	});
});

describe('DELETE /projects/:projectId/docs/:filename — chat-memory guard', () => {
	it('403s when deleting the HQ chatbox memory doc', async () => {
		// The chatbox memory doc only lives in HQ (the default team) at the fixed
		// 'hq' project slug. Attempt the protected delete against it.
		const res = await app.request(`/api/projects/${HQ_PROJECT_SLUG}/docs/${CHAT_MEMORY_SLUG}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});

	it('404s when deleting a doc that does not exist', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/never-existed.md`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('GET /projects/:projectId/docs/:filename/revisions — missing doc', () => {
	it('404s when listing revisions of a doc that does not exist', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/no-such-doc.md/revisions`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});
});

describe('POST /projects/:projectId/docs/:filename/restore — guards', () => {
	it('403s when an agent attempts a restore', async () => {
		const agentId = await captainId();
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId,
			},
		);
		const res = await app.request(`/api/projects/${projectId}/docs/spec.md/restore`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toMatch(/Only the admin/);
	});

	it('400s when revision_number is missing/not a number', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/spec.md/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});
});

describe('GET/PUT /projects/:projectId/agents-md — designated repo branches', () => {
	it('404s on GET when the designated repo exists but AGENTS.md is not on disk', async () => {
		// Stand up a repo-bearing project in its own team (1:1) so the repo lookup
		// succeeds but no AGENTS.md file has been written yet.
		const repoTeamRes = await createTestTeam(db, { name: 'AgentsMd Missing Co' });
		const repoTeamId = (await repoTeamRes.json()).data.id;
		const projRes = await createTestProject(db, repoTeamId, {
			name: 'AgentsMd Missing',
			description: 'Repo project without an on-disk AGENTS.md.',
		});
		const repoProjectId = (await projRes.json()).data.id;

		const repoResult = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'org/missing-md', 'github') RETURNING id`,
			[repoProjectId],
		);
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			repoResult.rows[0].id,
			repoProjectId,
		]);

		const res = await app.request(`/api/projects/${repoProjectId}/agents-md`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/AGENTS\.md not found/);
	});

	it('400s on PUT when content is missing from the body', async () => {
		const repoTeamRes = await createTestTeam(db, { name: 'AgentsMd Put Co' });
		const repoTeamId = (await repoTeamRes.json()).data.id;
		const projRes = await createTestProject(db, repoTeamId, {
			name: 'AgentsMd Put',
			description: 'Repo project for the PUT validation branch.',
		});
		const repoProjectId = (await projRes.json()).data.id;

		const repoResult = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'org/put-md', 'github') RETURNING id`,
			[repoProjectId],
		);
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			repoResult.rows[0].id,
			repoProjectId,
		]);

		const res = await app.request(`/api/projects/${repoProjectId}/agents-md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ not_content: 'x' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('404s on PUT when the project has no designated repo', async () => {
		const res = await app.request(`/api/projects/${projectId}/agents-md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# rules' }),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/no designated repo/);
	});
});
