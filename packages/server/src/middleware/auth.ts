import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiKeyStatus, AuthType, ChatSessionStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { resolveProject } from '../lib/resolve';
import type { AuthInfo, Env } from '../lib/types';

const AGENT_JWT_TTL_SECONDS = 60 * 60 * 4;
// The CEO chat session outlives a run; the token is revoked structurally via
// the chat_sessions row status, so a long TTL is safe.
const CEO_SESSION_JWT_TTL_SECONDS = 60 * 60 * 24 * 30;

const PUBLIC_PATHS = [
	'/health',
	'/api/status',
	'/api/auth/setup',
	'/api/auth/challenge',
	'/api/auth/verify',
	// Password login is challenge-response: fetch a nonce+salt, then verify a
	// signature. Both are token-keyed and self-authenticating.
	'/api/auth/password-challenge',
	'/api/auth/password-verify',
	// Set/change the password verifier. Public path but self-authenticating: it
	// accepts either a full session JWT or a password-setup-scoped JWT and checks
	// the bearer itself (the scoped token is rejected everywhere else).
	'/api/auth/password',
	'/',
	// OAuth provider redirect targets: the browser arrives here from the provider
	// with no session token; security comes from the signed `state` param, verified
	// server-side. (Both the generic and the DCR/MCP callback.)
	'/api/oauth/callback',
	'/api/oauth/mcp-callback',
	// API-key self-registration + status polling are token-keyed and do their own
	// lookup, so they bypass the bearer-token auth middleware.
	'/api/api-keys/register',
	'/api/api-keys/status',
];

/**
 * JWT scope for the short-lived token minted by the mnemonic flows (setup /
 * unlock / recovery). Its ONLY accepted use is `POST /api/auth/password`; it is
 * rejected as a session everywhere else (see `verifyToken`). This is what keeps
 * the master key an *unlock* credential, never a general login — a session is
 * only ever minted by the password.
 */
export const PASSWORD_SETUP_SCOPE = 'password_setup';

/**
 * Shared token verification used by HTTP middleware, MCP, and WebSocket auth.
 * Returns AuthInfo on success, null on failure.
 */
export async function verifyToken(
	token: string,
	db: Db,
	masterKeyManager: MasterKeyManager,
): Promise<AuthInfo | null> {
	if (masterKeyManager.getState() !== 'unlocked') return null;

	// API key auth: the instance-scoped MCP credential. Validated against the
	// api_keys row (revoked structurally by deleting the row — instant, no token
	// cache), and inert while still `pending` (a self-registered key not yet
	// approved by an admin can only poll its own status via the onboarding surface).
	// Once approved a key is admin-equivalent across every project/team.
	if (token.startsWith('hezo_')) {
		const prefix = token.slice(5, 13);
		const result = await db.query<{ id: string; key_hash: string; status: string }>(
			'SELECT id, key_hash, status FROM api_keys WHERE prefix = $1',
			[prefix],
		);

		if (result.rows.length === 0) return null;

		const tokenHash = createHash('sha256').update(token).digest('hex');
		if (!safeCompareHex(tokenHash, result.rows[0].key_hash)) return null;

		if (result.rows[0].status !== ApiKeyStatus.Approved) return null;

		// Update last_used_at
		await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [result.rows[0].id]);

		return {
			type: AuthType.ApiKey,
			apiKeyId: result.rows[0].id,
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
			// chat_sessions row (the live-session proof, revoked by flipping its
			// status), not a heartbeat_runs row. Carries cross-team privilege.
			if (payload.session_id) {
				const sessionId = payload.session_id as string;
				const sessionResult = await db.query<{ status: string; project_id: string }>(
					'SELECT status, project_id FROM chat_sessions WHERE id = $1 AND member_id = $2 AND team_id = $3',
					[sessionId, memberId, teamId],
				);
				const sessionRow = sessionResult.rows[0];
				if (
					sessionRow?.status !== ChatSessionStatus.Starting &&
					sessionRow?.status !== ChatSessionStatus.Running
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
			// A password-setup-scoped token proves master-key ownership but is NOT a
			// session — it can only reach `/api/auth/password` (which validates it
			// directly, bypassing this path). Reject it as a general credential.
			if (payload.scope === PASSWORD_SETUP_SCOPE) return null;
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
		// No anonymous access. Every session is authenticated by the admin
		// password (JWT); a tokenless request is rejected so the instance is safe
		// to expose on a public network. (Public, token-keyed endpoints are handled
		// above via PUBLIC_PATHS.)
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

export async function signAdminJwt(
	masterKeyManager: { getJwtKey: () => Promise<Buffer> },
	userId: string,
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign({ user_id: userId, iat: now, exp: now + 86400 * 7 }, secret, 'HS256');
}

/**
 * Short-lived, single-purpose token minted by the mnemonic flows (setup / unlock
 * / recovery). It carries `scope: PASSWORD_SETUP_SCOPE` and is accepted ONLY by
 * `POST /api/auth/password`; `verifyToken` rejects it as a session everywhere
 * else, so the master key can never stand in for the password.
 */
export async function signPasswordSetupToken(
	masterKeyManager: { getJwtKey: () => Promise<Buffer> },
	userId: string,
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{ user_id: userId, scope: PASSWORD_SETUP_SCOPE, iat: now, exp: now + 600 },
		secret,
		'HS256',
	);
}

/**
 * Authorize a password mutation (`POST /api/auth/password`). Accepts a bearer
 * that is EITHER a full admin session JWT (logged-in change) OR a
 * password-setup-scoped JWT (initial-set / recovery), and returns the superuser
 * id it authorizes plus which of the two it was — or `null` if the token is
 * anything else. Kept separate from `verifyToken` precisely because that path
 * rejects the scoped token. `isSetupScoped` lets the route exempt master-key
 * recovery from the current-password proof a session-authenticated change needs.
 */
export async function resolvePasswordMutationUserId(
	token: string,
	db: Db,
	masterKeyManager: MasterKeyManager,
): Promise<{ userId: string; isSetupScoped: boolean } | null> {
	if (masterKeyManager.getState() !== 'unlocked') return null;
	try {
		const jwtKey = await masterKeyManager.getJwtKey();
		const payload = await verify(token, jwtKey.toString('base64'), 'HS256');
		const userId = payload.user_id as string | undefined;
		if (!userId) return null;
		// Only a full session or the password-setup scope may set a password. Agent
		// / CEO tokens (member_id/session_id) never can.
		if (payload.member_id || payload.session_id) return null;
		if (payload.scope !== undefined && payload.scope !== PASSWORD_SETUP_SCOPE) return null;
		const result = await db.query<{ is_superuser: boolean }>(
			'SELECT is_superuser FROM users WHERE id = $1',
			[userId],
		);
		if (!result.rows[0]?.is_superuser) return null;
		return { userId, isSetupScoped: payload.scope === PASSWORD_SETUP_SCOPE };
	} catch {
		return null;
	}
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
 * run token it carries `session_id` (validated against `chat_sessions`) and
 * `cross_team` (act across every team — the team-level analogue of
 * `cross_project`). Revocation is structural via the session row's status, so
 * the TTL is long; the caller is responsible for asserting the member is the
 * instance CEO in the HQ team before minting.
 */
export async function signChatSessionJwt(
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
 * Shared by the HTTP gate (`assertTeamAccess`) and the WebSocket room-access check
 * (`canAccessTeam` in `index.ts`) so the two can't drift — an API key must reach its
 * realtime rooms just as it reaches MCP. Mirrors `getAccessibleTeamIds`: an ordinary
 * agent run is bound to its single team; an approved API key and the instance CEO
 * chat session (`crossTeam`) span every team; a human superuser spans all teams; a
 * board user gets the teams they belong to.
 */
export async function canAuthAccessTeam(db: Db, auth: AuthInfo, teamId: string): Promise<boolean> {
	if (auth.type === AuthType.Agent) {
		// The instance CEO chat session acts across every team (gated at mint time).
		if (auth.crossTeam) return true;
		return auth.teamId === teamId;
	}
	// An approved API key is admin-equivalent across every team.
	if (auth.type === AuthType.ApiKey) return true;
	if (auth.isSuperuser) return true;

	const result = await db.query(
		'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
		[auth.userId, teamId],
	);
	return result.rows.length > 0;
}

/**
 * HTTP gate wrapping `canAuthAccessTeam`: returns `null` on success, or a 403
 * `Response` to short-circuit the handler.
 */
async function assertTeamAccess(
	db: Db,
	auth: AuthInfo,
	c: Context<Env>,
	teamId: string,
): Promise<Response | null> {
	if (await canAuthAccessTeam(db, auth, teamId)) return null;
	return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
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
	db: Db,
	c: Context<Env>,
	resourceTeamId: string,
): Promise<{ teamId: string } | Response> {
	const denied = await assertTeamAccess(db, c.get('auth'), c, resourceTeamId);
	if (denied) return denied;
	return { teamId: resourceTeamId };
}

/**
 * Every team id the auth principal may read across, for global (non-project)
 * endpoints like search. Mirrors `assertTeamAccess`: a normal agent run is bound to
 * its single team; an approved API key, the instance CEO chat session (`crossTeam`),
 * and superusers span all teams (HQ included); a board user gets the teams they
 * belong to. Returns team ids — the caller decides how to use them.
 */
export async function getAccessibleTeamIds(db: Db, auth: AuthInfo): Promise<string[]> {
	const allTeams = async (): Promise<string[]> => {
		const rows = await db.query<{ id: string }>('SELECT id FROM teams');
		return rows.rows.map((r) => r.id);
	};

	// An approved API key spans the whole instance.
	if (auth.type === AuthType.ApiKey) return allTeams();
	if (auth.type === AuthType.Agent) return auth.crossTeam ? allTeams() : [auth.teamId];
	if (auth.isSuperuser) return allTeams();

	const rows = await db.query<{ team_id: string }>(
		'SELECT DISTINCT m.team_id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1',
		[auth.userId],
	);
	return rows.rows.map((r) => r.team_id);
}

/**
 * Strict gate: only the human superuser passes. Used for routes that must stay
 * exclusively human-controlled — notably API-key management, so an API key can
 * never mint, approve, or revoke keys (its own or its peers').
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
 * and any approved API key (the instance-scoped MCP credential the admin minted
 * or approved, which is "virtually the admin"). API keys are intentionally
 * excluded from `requireSuperuser` — they have every admin power EXCEPT managing
 * API keys.
 */
export function isAdminEquivalent(auth: AuthInfo): boolean {
	return (auth.type === AuthType.Admin && auth.isSuperuser) || auth.type === AuthType.ApiKey;
}

/**
 * Gate for instance-management routes an approved API key should reach (create
 * projects, AI providers, secrets, connectors, skills, instance settings, …).
 * Allows the human superuser and approved API keys; still rejects board users
 * and ordinary agent runs. (API keys are MCP-only — `authMiddleware` rejects them
 * on REST before any handler runs — so on REST this is effectively superuser-only.)
 */
export function requireAdminEquivalent(c: Context<Env>): Response | null {
	const auth = c.get('auth');
	if (!isAdminEquivalent(auth)) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
	}
	return null;
}
