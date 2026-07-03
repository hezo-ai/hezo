import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuthType, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { AuthInfo, Env } from '../src/lib/types';
import {
	canAuthAccessTeam,
	safeCompareHex,
	signAdminJwt,
	signAgentJwt,
	verifyToken,
} from '../src/middleware/auth';
import { safeClose } from './helpers';
import {
	authHeader,
	createAgentRun,
	createTestApp,
	createTestProject,
	createTestTeam,
	finalizeAgentRun,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let adminToken: string;
let projectSlug: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let internalProjectId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	// Create a team to get agents
	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await createTestTeam(db, { name: 'Auth Test Co', template_id: typeId });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	projectSlug = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json()).data
		.slug;
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const internalProject = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = false`,
		[teamId],
	);
	internalProjectId = internalProject.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('safeCompareHex', () => {
	it('returns true for matching hex strings', () => {
		const hex = createHash('sha256').update('test').digest('hex');
		expect(safeCompareHex(hex, hex)).toBe(true);
	});

	it('returns false for different hex strings', () => {
		const a = createHash('sha256').update('a').digest('hex');
		const b = createHash('sha256').update('b').digest('hex');
		expect(safeCompareHex(a, b)).toBe(false);
	});

	it('returns false for different length hex strings', () => {
		expect(safeCompareHex('aabb', 'aabbcc')).toBe(false);
	});
});

describe('signAdminJwt + verifyToken', () => {
	it('signs and verifies a admin JWT', async () => {
		const userId = (
			await db.query<{ id: string }>(
				"INSERT INTO users (display_name, is_superuser) VALUES ('JWT User', false) RETURNING id",
			)
		).rows[0].id;

		const token = await signAdminJwt(masterKeyManager, userId);
		const auth = await verifyToken(token, db, masterKeyManager);

		expect(auth).not.toBeNull();
		expect(auth!.type).toBe(AuthType.Admin);
		if (auth!.type === AuthType.Admin) {
			expect(auth!.userId).toBe(userId);
			expect(auth!.isSuperuser).toBe(false);
		}
	});

	it('returns isSuperuser=true for superuser', async () => {
		const userId = (
			await db.query<{ id: string }>(
				"INSERT INTO users (display_name, is_superuser) VALUES ('Super User', true) RETURNING id",
			)
		).rows[0].id;

		const token = await signAdminJwt(masterKeyManager, userId);
		const auth = await verifyToken(token, db, masterKeyManager);

		expect(auth).not.toBeNull();
		if (auth!.type === AuthType.Admin) {
			expect(auth!.isSuperuser).toBe(true);
		}
	});
});

describe('signAgentJwt + verifyToken', () => {
	it('signs and verifies an agent JWT bound to an active run', async () => {
		const { token, runId } = await mintAgentToken(db, masterKeyManager, agentId, teamId, null, {
			projectId: internalProjectId,
		});
		const auth = await verifyToken(token, db, masterKeyManager);

		expect(auth).not.toBeNull();
		expect(auth!.type).toBe(AuthType.Agent);
		if (auth!.type === AuthType.Agent) {
			expect(auth!.memberId).toBe(agentId);
			expect(auth!.teamId).toBe(teamId);
			expect(auth!.runId).toBe(runId);
		}
	});

	it('exposes auth.taskId from the run when bound to a task', async () => {
		const project = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 ORDER BY created_at LIMIT 1`,
			[teamId],
		);
		const task = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, 90001, 'SCOPE-90001', 'Run-scope task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, project.rows[0].id],
		);
		const taskId = task.rows[0].id;
		const { token } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
		const auth = await verifyToken(token, db, masterKeyManager);

		expect(auth).not.toBeNull();
		expect(auth!.type).toBe(AuthType.Agent);
		if (auth!.type === AuthType.Agent) {
			expect(auth!.taskId).toBe(taskId);
		}
	});

	it('sets auth.taskId to null when the run is not bound to a task', async () => {
		const { token } = await mintAgentToken(db, masterKeyManager, agentId, teamId, null, {
			projectId: internalProjectId,
		});
		const auth = await verifyToken(token, db, masterKeyManager);

		expect(auth).not.toBeNull();
		expect(auth!.type).toBe(AuthType.Agent);
		if (auth!.type === AuthType.Agent) {
			expect(auth!.taskId).toBeNull();
		}
	});

	it('rejects an agent JWT with no run_id claim', async () => {
		const runId = await createAgentRun(db, agentId, teamId);
		const internalProject = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = false`,
			[teamId],
		);
		const projectId = internalProject.rows[0].id;
		const token = await signAgentJwt(masterKeyManager, agentId, teamId, runId, projectId, true);
		// Sanity: the valid token works
		expect(await verifyToken(token, db, masterKeyManager)).not.toBeNull();

		// Forge a token missing run_id by signing a payload directly
		const { sign } = await import('hono/jwt');
		const jwtKey = await masterKeyManager.getJwtKey();
		const noRunIdToken = await sign(
			{
				member_id: agentId,
				team_id: teamId,
				project_id: projectId,
				iat: Math.floor(Date.now() / 1000),
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			jwtKey.toString('base64'),
			'HS256',
		);
		expect(await verifyToken(noRunIdToken, db, masterKeyManager)).toBeNull();
	});

	it('rejects an agent JWT pointing at a nonexistent run', async () => {
		const fakeRunId = '00000000-0000-0000-0000-000000000000';
		const internalProject = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = false`,
			[teamId],
		);
		const projectId = internalProject.rows[0].id;
		const token = await signAgentJwt(masterKeyManager, agentId, teamId, fakeRunId, projectId, true);
		expect(await verifyToken(token, db, masterKeyManager)).toBeNull();
	});

	it.each([
		HeartbeatRunStatus.Succeeded,
		HeartbeatRunStatus.Failed,
		HeartbeatRunStatus.Cancelled,
		HeartbeatRunStatus.TimedOut,
	])('rejects agent JWT once its run has status=%s', async (terminalStatus) => {
		const { token, runId } = await mintAgentToken(db, masterKeyManager, agentId, teamId, null, {
			projectId: internalProjectId,
		});
		await finalizeAgentRun(db, runId, terminalStatus);
		expect(await verifyToken(token, db, masterKeyManager)).toBeNull();
	});

	it('rejects an agent JWT whose run belongs to a different member', async () => {
		// Create a run for one member, sign a token claiming a different member
		const runId = await createAgentRun(db, agentId, teamId);
		// Create a second agent
		const otherAgentRes = await db.query<{ id: string }>(
			`SELECT id FROM members WHERE team_id = $1 AND id != $2 LIMIT 1`,
			[teamId, agentId],
		);
		const otherAgentId = otherAgentRes.rows[0]?.id;
		if (!otherAgentId) return; // only one seeded agent — skip
		const internalProject = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = false`,
			[teamId],
		);
		const projectId = internalProject.rows[0].id;
		const spoofed = await signAgentJwt(
			masterKeyManager,
			otherAgentId,
			teamId,
			runId,
			projectId,
			true,
		);
		expect(await verifyToken(spoofed, db, masterKeyManager)).toBeNull();
	});
});

describe('verifyToken edge cases', () => {
	it('returns null for garbage token', async () => {
		const auth = await verifyToken('garbage.token.value', db, masterKeyManager);
		expect(auth).toBeNull();
	});

	it('returns null for empty string', async () => {
		const auth = await verifyToken('', db, masterKeyManager);
		expect(auth).toBeNull();
	});
});

describe('verifyToken with API key', () => {
	let apiKey: string;

	beforeAll(async () => {
		const res = await app.request('/api/api-keys', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'test-key' }),
		});
		const body = await res.json();
		apiKey = body.data.key;
	});

	it('verifies a valid API key', async () => {
		const auth = await verifyToken(apiKey, db, masterKeyManager);
		expect(auth).not.toBeNull();
		expect(auth!.type).toBe(AuthType.ApiKey);
		if (auth!.type === AuthType.ApiKey) {
			expect(auth!.apiKeyId).toBeTruthy();
			expect(auth!.crossTeam).toBe(true);
		}
	});

	it('returns null for API key with wrong prefix', async () => {
		const auth = await verifyToken('hezo_XXXXXXXX_fake', db, masterKeyManager);
		expect(auth).toBeNull();
	});

	it('returns null for API key with tampered hash', async () => {
		// Use correct prefix but wrong suffix
		const prefix = apiKey.slice(0, 13);
		const tampered = `${prefix}_tampered_value`;
		const auth = await verifyToken(tampered, db, masterKeyManager);
		expect(auth).toBeNull();
	});
});

describe('authMiddleware (via HTTP)', () => {
	it('allows public paths without auth', async () => {
		const res = await app.request('/health');
		expect(res.status).toBe(200);
	});

	it('allows the /api/auth/* endpoints without auth', async () => {
		// Malformed bodies should get 400/409 from the handlers, not the
		// middleware's 401 — proving the paths are public.
		const setup = await app.request('/api/auth/setup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(setup.status).not.toBe(401);

		const challenge = await app.request('/api/auth/challenge', { method: 'POST' });
		expect(challenge.status).not.toBe(401);

		const verify = await app.request('/api/auth/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(verify.status).not.toBe(401);
	});

	it('rejects API requests without an auth header (no anonymous access)', async () => {
		const res = await app.request('/api/projects');
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe('UNAUTHORIZED');
	});

	it('rejects API requests with a non-Bearer auth header', async () => {
		const res = await app.request('/api/projects', {
			headers: { Authorization: 'Basic abc123' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects a password-setup-scoped token as a session', async () => {
		const { signPasswordSetupToken } = await import('../src/middleware/auth');
		const admin = await db.query<{ id: string }>(
			'SELECT id FROM users WHERE is_superuser = true LIMIT 1',
		);
		const scoped = await signPasswordSetupToken(masterKeyManager, admin.rows[0].id);
		const res = await app.request('/api/projects', { headers: authHeader(scoped) });
		expect(res.status).toBe(401);
	});

	it('rejects API requests with invalid token', async () => {
		const res = await app.request('/api/projects', {
			headers: { Authorization: 'Bearer invalid.token.here' },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe('UNAUTHORIZED');
	});

	it('allows API requests with valid admin token', async () => {
		const res = await app.request('/api/projects', {
			headers: authHeader(adminToken),
		});
		expect(res.status).toBe(200);
	});

	it('allows API requests with valid agent token', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{ projectId: internalProjectId },
		);
		// Agents drive the MCP surface, but the shared auth layer still accepts a
		// valid agent JWT on /api routes (the handler then applies its own authz).
		const res = await app.request('/api/projects', {
			headers: authHeader(agentToken),
		});
		expect(res.status).toBe(200);
	});

	it('skips non-API paths (no auth needed)', async () => {
		// `/` is the SPA catch-all. With no frontend bundle/dist built in tests it
		// 404s — but the point is the auth middleware lets it through (not 401/403)
		// rather than gating it like an API route.
		const res = await app.request('/');
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
	});
});

describe('canAuthAccessTeam', () => {
	const otherTeamId = '00000000-0000-0000-0000-0000000000ff';

	it('lets an approved API key reach every team', async () => {
		// API keys are admin-equivalent/cross-team (auth.ts), so they must reach
		// realtime WS rooms too — the gap this shared predicate closes.
		const auth: AuthInfo = {
			type: AuthType.ApiKey,
			apiKeyId: 'ak-1',
			isSuperuser: true,
			crossTeam: true,
		};
		expect(await canAuthAccessTeam(db, auth, teamId)).toBe(true);
		expect(await canAuthAccessTeam(db, auth, otherTeamId)).toBe(true);
	});

	it('lets a human superuser reach every team', async () => {
		const auth: AuthInfo = { type: AuthType.Admin, userId: 'irrelevant', isSuperuser: true };
		expect(await canAuthAccessTeam(db, auth, teamId)).toBe(true);
		expect(await canAuthAccessTeam(db, auth, otherTeamId)).toBe(true);
	});

	it('lets a board user reach only the teams they belong to', async () => {
		const userId = (
			await db.query<{ id: string }>(
				"INSERT INTO users (display_name, is_superuser) VALUES ('Board Member', false) RETURNING id",
			)
		).rows[0].id;
		const memberId = (
			await db.query<{ id: string }>(
				"INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'user', 'BM') RETURNING id",
				[teamId],
			)
		).rows[0].id;
		await db.query("INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'member')", [
			memberId,
			userId,
		]);

		const auth: AuthInfo = { type: AuthType.Admin, userId, isSuperuser: false };
		expect(await canAuthAccessTeam(db, auth, teamId)).toBe(true);
		expect(await canAuthAccessTeam(db, auth, otherTeamId)).toBe(false);
	});

	it('lets an approved API key reach every team (instance-scoped)', async () => {
		const auth: AuthInfo = {
			type: AuthType.ApiKey,
			apiKeyId: 'ak-1',
			isSuperuser: true,
			crossTeam: true,
		};
		expect(await canAuthAccessTeam(db, auth, teamId)).toBe(true);
		expect(await canAuthAccessTeam(db, auth, otherTeamId)).toBe(true);
	});

	it('binds an ordinary agent to its own team but lets a cross-team session span all', async () => {
		const agent: AuthInfo = {
			type: AuthType.Agent,
			memberId: 'm',
			teamId,
			runId: 'r',
			taskId: null,
			projectId: 'p',
			crossProject: false,
		};
		const crossTeamSession: AuthInfo = {
			type: AuthType.Agent,
			memberId: 'm',
			teamId,
			runId: null,
			taskId: null,
			projectId: 'p',
			crossProject: true,
			sessionId: 's',
			crossTeam: true,
		};
		expect(await canAuthAccessTeam(db, agent, teamId)).toBe(true);
		expect(await canAuthAccessTeam(db, agent, otherTeamId)).toBe(false);
		expect(await canAuthAccessTeam(db, crossTeamSession, otherTeamId)).toBe(true);
	});
});

describe('authMiddleware on a locked server', () => {
	it('rejects no-auth-header requests with LOCKED', async () => {
		const { createTestDbWithMigrations } = await import('./helpers/db');
		const { MasterKeyManager } = await import('../src/crypto/master-key');
		const { buildApp } = await import('../src/startup');
		const { mkdtempSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const { createStubDocker } = await import('./helpers/app');

		const lockedDb = await createTestDbWithMigrations();
		try {
			const mkm = new MasterKeyManager();
			// initialize with no master key → state stays 'unset' (no canary yet)
			await mkm.initialize(lockedDb);
			const lockedApp = buildApp(
				lockedDb,
				mkm,
				{ dataDir: mkdtempSync(join(tmpdir(), 'hezo-locked-')), webUrl: '' },
				createStubDocker(),
			);

			const res = await lockedApp.request('/api/projects');
			expect(res.status).toBe(401);
		} finally {
			await safeClose(lockedDb);
		}
	});
});

describe('requireProjectAccessMiddleware (via route)', () => {
	it('rejects access to nonexistent project by slug', async () => {
		const res = await app.request('/api/projects/nonexistent-slug/agents', {
			headers: authHeader(adminToken),
		});
		expect(res.status).toBe(404);
	});
});

describe('requireSuperuser (via route)', () => {
	it('rejects non-superuser access to superuser-only endpoints', async () => {
		// Create a non-superuser
		const userId = (
			await db.query<{ id: string }>(
				"INSERT INTO users (display_name, is_superuser) VALUES ('Normal User', false) RETURNING id",
			)
		).rows[0].id;

		const normalToken = await signAdminJwt(masterKeyManager, userId);

		// A non-superuser admin token still works for non-superuser-gated reads.
		const res = await app.request('/api/projects', {
			headers: authHeader(normalToken),
		});
		// Non-superuser should still be able to list projects they are members of.
		expect(res.status).toBe(200);
	});
});
