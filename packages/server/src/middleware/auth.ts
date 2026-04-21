import { createHash, timingSafeEqual } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuthType, HeartbeatRunStatus } from '@hezo/shared';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { MasterKeyManager } from '../crypto/master-key';
import { resolveCompanyId } from '../lib/resolve';
import type { AuthInfo, Env } from '../lib/types';

const AGENT_JWT_TTL_SECONDS = 60 * 60 * 4;

const PUBLIC_PATHS = ['/health', '/api/status', '/api/auth/token', '/'];

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
		const result = await db.query<{ id: string; company_id: string; key_hash: string }>(
			'SELECT id, company_id, key_hash FROM api_keys WHERE prefix = $1',
			[prefix],
		);

		if (result.rows.length === 0) return null;

		const tokenHash = createHash('sha256').update(token).digest('hex');
		if (!safeCompareHex(tokenHash, result.rows[0].key_hash)) return null;

		// Update last_used_at
		await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [result.rows[0].id]);

		return { type: AuthType.ApiKey, companyId: result.rows[0].company_id };
	}

	// JWT auth
	try {
		const jwtKey = await masterKeyManager.getJwtKey();
		const secret = jwtKey.toString('base64');
		const payload = await verify(token, secret, 'HS256');

		if (payload.member_id && payload.company_id) {
			if (!payload.run_id) return null;
			const memberId = payload.member_id as string;
			const companyId = payload.company_id as string;
			const runId = payload.run_id as string;
			const runResult = await db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1 AND member_id = $2 AND company_id = $3',
				[runId, memberId, companyId],
			);
			const status = runResult.rows[0]?.status;
			if (status !== HeartbeatRunStatus.Running) return null;
			return {
				type: AuthType.Agent,
				memberId,
				companyId,
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

	const header = c.req.header('Authorization');
	if (!header?.startsWith('Bearer ')) {
		return c.json(
			{ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } },
			401,
		);
	}

	const token = header.slice(7);
	const masterKeyManager = c.get('masterKeyManager');

	if (masterKeyManager.getState() !== 'unlocked') {
		return c.json(
			{ error: { code: 'LOCKED', message: 'Server is locked. Provide master key to unlock.' } },
			401,
		);
	}

	const db = c.get('db');
	const auth = await verifyToken(token, db, masterKeyManager);
	if (!auth) {
		return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
	}

	c.set('auth', auth);
	return next();
});

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
	companyId: string,
	runId: string,
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{
			member_id: memberId,
			company_id: companyId,
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

export async function requireCompanyAccess(
	c: Context<Env>,
): Promise<{ companyId: string } | Response> {
	const auth = c.get('auth');
	const raw = c.req.param('companyId');

	if (!raw) {
		return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing companyId' } }, 400);
	}

	const db = c.get('db');
	const companyId = await resolveCompanyId(db, raw);
	if (!companyId) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Company not found' } }, 404);
	}

	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.companyId !== companyId) {
			return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
		}
		return { companyId };
	}

	if (auth.isSuperuser) {
		return { companyId };
	}

	const result = await db.query(
		'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.company_id = $2',
		[auth.userId, companyId],
	);
	if (result.rows.length === 0) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
	}
	return { companyId };
}

export async function requireCompanyAccessForResource(
	db: PGlite,
	c: Context<Env>,
	resourceCompanyId: string,
): Promise<{ companyId: string } | Response> {
	const auth = c.get('auth');

	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.companyId !== resourceCompanyId) {
			return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
		}
		return { companyId: resourceCompanyId };
	}

	// Superusers can access any company
	if (auth.isSuperuser) {
		return { companyId: resourceCompanyId };
	}

	// Board auth
	const result = await db.query(
		'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.company_id = $2',
		[auth.userId, resourceCompanyId],
	);
	if (result.rows.length === 0) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
	}
	return { companyId: resourceCompanyId };
}

export function requireSuperuser(c: Context<Env>): Response | null {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Board || !auth.isSuperuser) {
		return c.json({ error: { code: 'FORBIDDEN', message: 'Superuser access required' } }, 403);
	}
	return null;
}
