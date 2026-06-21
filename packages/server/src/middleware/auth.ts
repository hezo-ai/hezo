import { createHash, timingSafeEqual } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuthType, CeoSessionStatus, ConnectedAgentStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { MasterKeyManager } from '../crypto/master-key';
import { resolveProject } from '../lib/resolve';
import type { AuthInfo, Env } from '../lib/types';

const AGENT_JWT_TTL_SECONDS = 60 * 60 * 4;
// The CEO chat session outlives a run; the token is revoked structurally via
// the ceo_sessions row status, so a long TTL is safe.
const CEO_SESSION_JWT_TTL_SECONDS = 60 * 60 * 24 * 30;

const PUBLIC_PATHS = [
	'/health',
	'/api/status',
	'/api/auth/setup',
	'/api/auth/challenge',
	'/api/auth/verify',
	'/',
	'/api/oauth/callback',
	// External-agent self-registration + status polling are token-keyed and do
	// their own lookup, so they bypass the bearer-token auth middleware.
	'/api/agent-connections/register',
	'/api/agent-connections/status',
];

/**
 * Shared token verification used by HTTP middleware, MCP, and WebSocket auth.
 * Returns AuthInfo on success, null on failure.
 */
export async function verifyToken(
	token: string,
	db: PGlite,
	masterKeyManager: MasterKeyManager,
): Promise<AuthInfo | null> {
	if (masterKeyManager.getState() !== 'unlocked') return null;

	// API key auth
	if (token.startsWith('hezo_')) {
		const prefix = token.slice(5, 13);
		const result = await db.query<{ id: string; team_id: string; key_hash: string }>(
			'SELECT id, team_id, key_hash FROM api_keys WHERE prefix = $1',
			[prefix],
		);

		if (result.rows.length === 0) return null;

		const tokenHash = createHash('sha256').update(token).digest('hex');
		if (!safeCompareHex(tokenHash, result.rows[0].key_hash)) return null;

		// Update last_used_at
		await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [result.rows[0].id]);

		return { type: AuthType.ApiKey, teamId: result.rows[0].team_id };
	}

	// Connected-agent token: an approved external MCP client, admin-equivalent
	// across every project/team. Validated against the connected_agents row
	// (revoked structurally by deleting the row — instant, no token cache), and
	// inert while still `pending`. Checked before the JWT path; `hezoc_` does not
	// match the `hezo_` prefix above (5th char is `c`, not `_`).
	if (token.startsWith('hezoc_')) {
		const prefix = token.slice(6, 14);
		const result = await db.query<{ id: string; token_hash: string; status: string }>(
			'SELECT id, token_hash, status FROM connected_agents WHERE prefix = $1',
			[prefix],
		);
		if (result.rows.length === 0) return null;

		const tokenHash = createHash('sha256').update(token).digest('hex');
		if (!safeCompareHex(tokenHash, result.rows[0].token_hash)) return null;

		// A pending (not-yet-approved) token grants nothing here; the agent can
		// only poll its own status via the public/onboarding surface.
		if (result.rows[0].status !== ConnectedAgentStatus.Approved) return null;

		await db.query('UPDATE connected_agents SET last_used_at = now() WHERE id = $1', [
			result.rows[0].id,
		]);

		return {
			type: AuthType.ConnectedAgent,
			connectedAgentId: result.rows[0].id,
			isSuperuser: true,
			crossTeam: true,
		};
	}

	// JWT auth
	try {
		const jwtKey = await masterKeyManager.getJwtKey();
		const secret = jwtKey.toString('base64');
		const payload = await verify(token, secret, 'HS256');

		if (payload.member_id && payload.team_id) {
			const memberId = payload.member_id as string;
			const teamId = payload.team_id as string;

			// Persistent CEO chat session principal: validated against the
			// ceo_sessions row (the live-session proof, revoked by flipping its
			// status), not a heartbeat_runs row. Carries cross-team privilege.
			if (payload.session_id) {
				const sessionId = payload.session_id as string;
				const sessionResult = await db.query<{ status: string; project_id: string }>(
					'SELECT status, project_id FROM ceo_sessions WHERE id = $1 AND member_id = $2 AND team_id = $3',
					[sessionId, memberId, teamId],
				);
				const sessionRow = sessionResult.rows[0];
				if (
					sessionRow?.status !== CeoSessionStatus.Starting &&
					sessionRow?.status !== CeoSessionStatus.Running
				) {
					return null;
				}
				return {
					type: AuthType.Agent,
					memberId,
					teamId,
					runId: null,
					taskId: null,
					projectId: sessionRow.project_id,
					crossProject: true,
					sessionId,
					crossTeam: payload.cross_team === true,
				};
			}

			if (!payload.run_id || !payload.project_id) return null;
			const runId = payload.run_id as string;
			const projectId = payload.project_id as string;
			const crossProject = payload.cross_project === true;
			const runResult = await db.query<{ status: string; task_id: string | null }>(
				'SELECT status, task_id FROM heartbeat_runs WHERE id = $1 AND member_id = $2 AND team_id = $3',
				[runId, memberId, teamId],
			);
			const runRow = runResult.rows[0];
			if (runRow?.status !== HeartbeatRunStatus.Running) return null;
			return {
				type: AuthType.Agent,
				memberId,
				teamId,
				runId,
				taskId: runRow.task_id ?? null,
				projectId,
				crossProject,
			};
		}
		if (payload.user_id) {
			const userResult = await db.query<{ is_superuser: boolean }>(
				'SELECT is_superuser FROM users WHERE id = $1',
				[payload.user_id],
			);
			const isSuperuser = userResult.rows[0]?.is_superuser ?? false;
			return { type: AuthType.Admin, userId: payload.user_id as string, isSuperuser };
		}
		return null;
	} catch {
		return null;
	}
}

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
	const path = new URL(c.req.url).pathname;
	if (PUBLIC_PATHS.includes(path)) return next();
	if (!path.startsWith('/api')) return next();

	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');
	const header = c.req.header('Authorization');

	if (!header?.startsWith('Bearer ')) {
		// While the server is unlocked, requests without a token are accepted as
		// the bootstrap admin so the instance is publicly viewable.
		if (masterKeyManager.getState() === 'unlocked') {
			const adminAuth = await loadAdminAuth(db);
			if (adminAuth) {
				c.set('auth', adminAuth);
				return next();
			}
		}
		return c.json(
			{ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } },
			401,
		);
	}

	if (masterKeyManager.getState() !== 'unlocked') {
		return c.json(
			{ error: { code: 'LOCKED', message: 'Server is locked. Provide master key to unlock.' } },
			401,
		);
	}

	const token = header.slice(7);
	const auth = await verifyToken(token, db, masterKeyManager);
	if (!auth) {
		return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
	}

	// API keys authenticate the MCP endpoint (POST /mcp) only. REST is the
	// human/browser surface (user JWT); external/programmatic access goes through MCP.
	if (auth.type === AuthType.ApiKey) {
		return c.json(
			{
				error: {
					code: 'UNAUTHORIZED',
					message:
						'API keys authenticate the MCP endpoint only; use a session token for the REST API.',
				},
			},
			401,
		);
	}

	c.set('auth', auth);
	return next();
});

export async function loadAdminAuth(db: PGlite): Promise<AuthInfo | null> {
	const result = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true LIMIT 1',
	);
	const userId = result.rows[0]?.id;
	if (!userId) return null;
	return { type: AuthType.Admin, userId, isSuperuser: true };
}

export async function signAdminJwt(
	masterKeyManager: { getJwtKey: () => Promise<Buffer> },
	userId: string,
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign({ user_id: userId, iat: now, exp: now + 86400 * 7 }, secret, 'HS256');
}

export async function signAgentJwt(
	masterKeyManager: { getJwtKey: () => Promise<Buffer> },
	memberId: string,
	teamId: string,
	runId: string,
	projectId: string,
	crossProject: boolean,
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{
			member_id: memberId,
			team_id: teamId,
			run_id: runId,
			project_id: projectId,
			cross_project: crossProject,
			iat: now,
			exp: now + AGENT_JWT_TTL_SECONDS,
		},
		secret,
		'HS256',
	);
}

/**
 * Mint the long-lived MCP token for the persistent CEO chat session. Unlike a
 * run token it carries `session_id` (validated against `ceo_sessions`) and
 * `cross_team` (act across every team — the team-level analogue of
 * `cross_project`). Revocation is structural via the session row's status, so
 * the TTL is long; the caller is responsible for asserting the member is the
 * instance CEO in the HQ team before minting.
 */
export async function signCeoSessionJwt(
	masterKeyManager: { getJwtKey: () => Promise<Buffer> },
	memberId: string,
	teamId: string,
	sessionId: string,
	projectId: string,
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{
			member_id: memberId,
			team_id: teamId,
			session_id: sessionId,
			project_id: projectId,
			cross_project: true,
			cross_team: true,
			iat: now,
			exp: now + CEO_SESSION_JWT_TTL_SECONDS,
		},
		secret,
		'HS256',
	);
}

export function safeCompareHex(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'hex');
	const bufB = Buffer.from(b, 'hex');
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * Single source of truth for "does this auth principal have access to this team?".
 * Returns `null` on success, or a 403 `Response` to short-circuit the handler.
 */
async function assertTeamAccess(
	db: PGlite,
	auth: AuthInfo,
	c: Context<Env>,
	teamId: string,
): Promise<Response | null> {
	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		// The instance CEO chat session acts across every team (gated at mint time).
		if (auth.type === AuthType.Agent && auth.crossTeam) return null;
		if (auth.teamId !== teamId) {
			return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
		}
		return null;
	}

	// An approved connected agent is admin-equivalent across every team.
	if (auth.type === AuthType.ConnectedAgent) return null;

	if (auth.isSuperuser) {
		return null;
	}

	const result = await db.query(
		'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
		[auth.userId, teamId],
	);
	if (result.rows.length === 0) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
	}
	return null;
}

/**
 * Hono middleware for routes mounted under `/api/projects/:projectId/*`. The
 * project slug is the public handle, so this resolves `:projectId` (slug or
 * UUID) to its project and backing team, asserts team access, and exposes both
 * `c.var.projectId` and `c.var.teamId` for downstream handlers.
 */
export const requireProjectAccessMiddleware = createMiddleware<Env>(async (c, next) => {
	const raw = c.req.param('projectId');
	if (!raw) {
		return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing projectId' } }, 400);
	}

	const db = c.get('db');
	const project = await resolveProject(db, raw);
	if (!project) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
	}

	const denied = await assertTeamAccess(db, c.get('auth'), c, project.teamId);
	if (denied) return denied;

	c.set('teamId', project.teamId);
	c.set('projectId', project.projectId);
	return next();
});

export async function requireTeamAccessForResource(
	db: PGlite,
	c: Context<Env>,
	resourceTeamId: string,
): Promise<{ teamId: string } | Response> {
	const denied = await assertTeamAccess(db, c.get('auth'), c, resourceTeamId);
	if (denied) return denied;
	return { teamId: resourceTeamId };
}

/**
 * Every team id the auth principal may read across, for global (non-project)
 * endpoints like search. Mirrors `assertTeamAccess`: API keys and normal agents
 * are bound to their single team; the instance CEO chat session (`crossTeam`) and
 * superusers span all teams (HQ included); a board user gets the teams they belong
 * to. Returns team ids — the caller decides how to use them.
 */
export async function getAccessibleTeamIds(db: PGlite, auth: AuthInfo): Promise<string[]> {
	const allTeams = async (): Promise<string[]> => {
		const rows = await db.query<{ id: string }>('SELECT id FROM teams');
		return rows.rows.map((r) => r.id);
	};

	if (auth.type === AuthType.ApiKey) return [auth.teamId];
	if (auth.type === AuthType.Agent) return auth.crossTeam ? allTeams() : [auth.teamId];
	// An approved connected agent spans the whole instance.
	if (auth.type === AuthType.ConnectedAgent) return allTeams();
	if (auth.isSuperuser) return allTeams();

	const rows = await db.query<{ team_id: string }>(
		'SELECT DISTINCT m.team_id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1',
		[auth.userId],
	);
	return rows.rows.map((r) => r.team_id);
}

/**
 * Strict gate: only the human superuser passes. Used for routes that must stay
 * exclusively human-controlled — notably connected-agent management, so a
 * connected agent can never approve other agents or disconnect itself/peers.
 */
export function requireSuperuser(c: Context<Env>): Response | null {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin || !auth.isSuperuser) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Superuser access required' } }, 403);
	}
	return null;
}

/**
 * True for principals that act with full admin authority: the human superuser
 * and any approved connected agent (an external MCP client the admin approved,
 * which is "virtually the admin"). Connected agents are intentionally excluded
 * from `requireSuperuser` — they have every admin power EXCEPT managing
 * connected agents.
 */
export function isAdminEquivalent(auth: AuthInfo): boolean {
	return (
		(auth.type === AuthType.Admin && auth.isSuperuser) || auth.type === AuthType.ConnectedAgent
	);
}

/**
 * Gate for instance-management routes a connected agent should reach (create
 * projects, AI providers, secrets, connectors, skills, instance settings, …).
 * Allows the human superuser and approved connected agents; still rejects
 * board users, API keys, and ordinary agent runs.
 */
export function requireAdminEquivalent(c: Context<Env>): Response | null {
	const auth = c.get('auth');
	if (!isAdminEquivalent(auth)) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
	}
	return null;
}
