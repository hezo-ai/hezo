import type { PGlite } from '@electric-sql/pglite';
import { DEFAULT_TEAM_ID, HQ_PROJECT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, mintAgentToken, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamAId: string;
let teamBId: string;
let projectASlug: string;
let projectBSlug: string;
let projectAId: string;
let projectBId: string;

interface ResolveResponse {
	tasks: Array<{ identifier: string; title: string; project_slug: string; status: string }>;
	kb_docs: Array<{ slug: string; title: string; size: number; updated_at: string }>;
	project_docs: Array<{ project_slug: string; filename: string; size: number; updated_at: string }>;
	assets: Array<{
		project_slug: string;
		filename: string;
		id: string;
		content_type: string;
		signed_url: string;
	}>;
	agents: Array<{ slug: string; title: string; project_slug: string }>;
}

async function resolve(
	body: Record<string, unknown>,
	authToken = token,
): Promise<{ status: number; data: ResolveResponse }> {
	const res = await app.request('/api/mentions/resolve', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = res.status === 200 ? (await res.json()).data : undefined;
	return { status: res.status, data: json };
}

async function insertTask(
	teamId: string,
	projectId: string,
	identifier: string,
	number: number,
	title: string,
): Promise<void> {
	await db.query(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5)`,
		[teamId, projectId, number, identifier, title],
	);
}

async function insertProjectDoc(
	teamId: string,
	projectId: string,
	filename: string,
	content: string,
): Promise<void> {
	await db.query(
		`INSERT INTO documents (team_id, project_id, type, slug, title, content)
		 VALUES ($1, $2, 'project_doc'::document_type, $3, $3, $4)`,
		[teamId, projectId, filename, content],
	);
}

async function insertAsset(teamId: string, projectId: string, filename: string): Promise<void> {
	await db.query(
		`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
		 VALUES ($1, $2, 'image/png', 4, 'deadbeef', $3)`,
		[teamId, projectId, filename],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	for (const name of ['Mention Co Alpha', 'Mention Co Beta']) {
		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, template_id: typeId }),
		});
		const teamData = (await teamRes.json()).data;
		if (name.endsWith('Alpha')) teamAId = teamData.id;
		else teamBId = teamData.id;
	}

	projectASlug = await projectSlugFor(db, teamAId);
	projectBSlug = await projectSlugFor(db, teamBId);
	const pA = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectASlug,
	]);
	const pB = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectBSlug,
	]);
	projectAId = pA.rows[0].id;
	projectBId = pB.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /api/mentions/resolve — tasks', () => {
	it('resolves an instance-unique identifier with its project slug', async () => {
		await insertTask(teamAId, projectAId, 'QQ-7', 907, 'Unique ticket');
		const { status, data } = await resolve({ tasks: ['qq-7'] });
		expect(status).toBe(200);
		expect(data.tasks).toEqual([
			expect.objectContaining({
				identifier: 'QQ-7',
				title: 'Unique ticket',
				project_slug: projectASlug,
			}),
		]);
	});

	it('omits identifiers that collide across teams', async () => {
		await insertTask(teamAId, projectAId, 'XX-1', 908, 'Alpha ticket');
		await insertTask(teamBId, projectBId, 'XX-1', 908, 'Beta ticket');
		const { data } = await resolve({ tasks: ['xx-1', 'qq-7'] });
		expect(data.tasks.map((t) => t.identifier)).toEqual(['QQ-7']);
	});

	it('omits unknown identifiers', async () => {
		const { data } = await resolve({ tasks: ['zz-99'] });
		expect(data.tasks).toEqual([]);
	});
});

describe('POST /api/mentions/resolve — docs and assets', () => {
	it('resolves a filename present in exactly one project', async () => {
		await insertProjectDoc(teamAId, projectAId, 'unique.md', 'hello');
		const { data } = await resolve({ filenames: ['unique.md'] });
		expect(data.project_docs).toEqual([
			expect.objectContaining({ project_slug: projectASlug, filename: 'unique.md', size: 5 }),
		]);
	});

	it('omits filenames that exist in multiple projects', async () => {
		await insertProjectDoc(teamAId, projectAId, 'prd.md', 'a');
		await insertProjectDoc(teamBId, projectBId, 'prd.md', 'b');
		const { data } = await resolve({ filenames: ['prd.md', 'unique.md'] });
		expect(data.project_docs.map((d) => d.filename)).toEqual(['unique.md']);
	});

	it('resolves skills (KB docs) by slug — instance-global, no ambiguity rule', async () => {
		await db.query(
			`INSERT INTO skills (slug, name, content) VALUES ('guide.md', 'Guide', 'kb content')`,
		);
		const { data } = await resolve({ filenames: ['guide.md'] });
		expect(data.kb_docs).toEqual([expect.objectContaining({ slug: 'guide.md', title: 'Guide' })]);
	});

	it('resolves unique assets with a signed URL and omits colliding ones', async () => {
		await insertAsset(teamAId, projectAId, 'mock.png');
		await insertAsset(teamAId, projectAId, 'shared.png');
		await insertAsset(teamBId, projectBId, 'shared.png');
		const { data } = await resolve({ assets: ['mock.png', 'shared.png'] });
		expect(data.assets).toHaveLength(1);
		expect(data.assets[0]).toMatchObject({
			project_slug: projectASlug,
			filename: 'mock.png',
			content_type: 'image/png',
		});
		expect(data.assets[0].signed_url).toBeTruthy();
	});
});

describe('POST /api/mentions/resolve — agents', () => {
	it('resolves HQ singletons to the HQ project and omits slugs present in multiple teams', async () => {
		const { data } = await resolve({ agents: ['ceo', 'captain'] });
		expect(data.agents).toEqual([
			expect.objectContaining({ slug: 'ceo', project_slug: HQ_PROJECT_SLUG }),
		]);
	});

	it('ignores disabled agents when counting uniqueness', async () => {
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'
			 WHERE slug = 'architect' AND id IN (SELECT id FROM members WHERE team_id = $1)`,
			[teamBId],
		);
		const { data } = await resolve({ agents: ['architect'] });
		expect(data.agents).toEqual([
			expect.objectContaining({ slug: 'architect', project_slug: projectASlug }),
		]);
	});
});

describe('POST /api/mentions/resolve — validation', () => {
	it('returns empty arrays for an empty body', async () => {
		const { status, data } = await resolve({});
		expect(status).toBe(200);
		expect(data).toEqual({ tasks: [], kb_docs: [], project_docs: [], assets: [], agents: [] });
	});

	it('rejects non-array fields', async () => {
		const { status } = await resolve({ tasks: 'to-1' });
		expect(status).toBe(400);
	});

	it('rejects more than 100 entries', async () => {
		const { status } = await resolve({
			tasks: Array.from({ length: 101 }, (_, i) => `to-${i}`),
		});
		expect(status).toBe(400);
	});
});

describe('POST /api/mentions/resolve — authorization', () => {
	it('rejects a non-superuser with no HQ membership, then allows once added to HQ', async () => {
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Plain User', false) RETURNING id",
		);
		const userId = user.rows[0].id;
		const userToken = await signAdminJwt(masterKeyManager, userId);

		const denied = await resolve({ tasks: ['qq-7'] }, userToken);
		expect(denied.status).toBe(403);

		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'user'::member_type, 'Plain User') RETURNING id`,
			[DEFAULT_TEAM_ID],
		);
		await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
			member.rows[0].id,
			userId,
		]);

		const allowed = await resolve({ tasks: ['qq-7'] }, userToken);
		expect(allowed.status).toBe(200);
	});

	it('rejects an agent token scoped to a non-HQ team', async () => {
		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamAId],
		);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			teamAId,
		);
		const { status } = await resolve({ tasks: ['qq-7'] }, agentToken);
		expect(status).toBe(403);
	});
});
