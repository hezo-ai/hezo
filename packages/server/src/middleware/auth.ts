import { createHash, timingSafeEqual } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuthType, HeartbeatRunStatus } from '@hezo/shared';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { MasterKeyManager } from '../crypto/master-key';
import { resolveTeamId } from '../lib/resolve';
import type { AuthInfo, Env } from '../lib/types';

const AGENT_JWT_TTL_SECONDS = 60 * 60 * 4;

const PUBLIC_PATHS = ['/health', '/api/status', '/api/auth/token', '/', '/api/oauth/callback'];

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

	// JWT auth
	try {
		const jwtKey = await masterKeyManager.getJwtKey();
		const secret = jwtKey.toString('base64');
		const payload = await verify(token, secret, 'HS256');

		if (payload.member_id && payload.team_id) {
			if (!payload.run_id) return null;
			const memberId = payload.member_id as string;
			const teamId = payload.team_id as string;
			const runId = payload.run_id as string;
			const runResult = await db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1 AND member_id = $2 AND team_id = $3',
				[runId, memberId, teamId],
			);
			const status = runResult.rows[0]?.status;
			if (status !== HeartbeatRunStatus.Running) return null;
			return {
				type: AuthType.Agent,
				memberId,
				teamId,
				runId,
			};
		}
		if (payload.user_id) {
			const userResult = await db.query<{ is_superuser: boolean }>(
				'SELECT is_superuser FROM users WHERE id = $1',
				[payload.user_id],
			);
			const isSuperuser = userResult.rows[0]?.is_superuser ?? false;
			return { type: AuthType.Board, userId: payload.user_id as string, isSuperuser };
		}
		return null;
	} catch {
		return null;
	}
}

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
	const path = new URL(c.req.url).pathname;
	if (PUBLIC_PATHS.includes(path)) return next();
	if (!path.startsWith('/api') && !path.startsWith('/agent-api')) return next();

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

	c.set('auth', auth);
	return next();
});

export async function loadAdminAuth(db: PGlite): Promise<AuthInfo | null> {
	const result = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true LIMIT 1',
	);
	const userId = result.rows[0]?.id;
	if (!userId) return null;
	return { type: AuthType.Board, userId, isSuperuser: true };
}

export async function signBoardJwt(
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
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{
			member_id: memberId,
			team_id: teamId,
			run_id: runId,
			iat: now,
			exp: now + AGENT_JWT_TTL_SECONDS,
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

export async function requireTeamAccess(c: Context<Env>): Promise<{ teamId: string } | Response> {
	const auth = c.get('auth');
	const raw = c.req.param('teamId');

	if (!raw) {
		return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing teamId' } }, 400);
	}

	const db = c.get('db');
	const teamId = await resolveTeamId(db, raw);
	if (!teamId) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Team not found' } }, 404);
	}

	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.teamId !== teamId) {
			return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
		}
		return { teamId };
	}

	if (auth.isSuperuser) {
		return { teamId };
	}

	const result = await db.query(
		'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
		[auth.userId, teamId],
	);
	if (result.rows.length === 0) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
	}
	return { teamId };
}

export async function requireTeamAccessForResource(
	db: PGlite,
	c: Context<Env>,
	resourceTeamId: string,
): Promise<{ teamId: string } | Response> {
	const auth = c.get('auth');

	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.teamId !== resourceTeamId) {
			return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
		}
		return { teamId: resourceTeamId };
	}

	// Superusers can access any team
	if (auth.isSuperuser) {
		return { teamId: resourceTeamId };
	}

	// Board auth
	const result = await db.query(
		'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
		[auth.userId, resourceTeamId],
	);
	if (result.rows.length === 0) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
	}
	return { teamId: resourceTeamId };
}

export function requireSuperuser(c: Context<Env>): Response | null {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Board || !auth.isSuperuser) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Superuser access required' } }, 403);
	}
	return null;
}
