import { createHash, timingSafeEqual } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { Env } from '../lib/types';

const PUBLIC_PATHS = ['/health', '/api/status', '/api/auth/token', '/'];

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

	// API key auth
	if (token.startsWith('hezo_')) {
		const db = c.get('db');
		const prefix = token.slice(5, 13);
		const result = await db.query<{ id: string; company_id: string; key_hash: string }>(
			'SELECT id, company_id, key_hash FROM api_keys WHERE prefix = $1',
			[prefix],
		);

		if (result.rows.length === 0) {
			return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }, 401);
		}

		const tokenHash = createHash('sha256').update(token).digest('hex');
		const matched = safeCompareHex(tokenHash, result.rows[0].key_hash);
		if (!matched) {
			return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }, 401);
		}

		// Update last_used_at
		await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [result.rows[0].id]);

		c.set('auth', { type: AuthType.ApiKey, companyId: result.rows[0].company_id });
		return next();
	}

	// JWT auth
	try {
		const jwtKey = await masterKeyManager.getJwtKey();
		const secret = jwtKey.toString('base64');
		const payload = await verify(token, secret, 'HS256');

		if (payload.member_id && payload.company_id) {
			c.set('auth', {
				type: AuthType.Agent,
				memberId: payload.member_id as string,
				companyId: payload.company_id as string,
			});
		} else if (payload.user_id) {
			const db = c.get('db');
			const userResult = await db.query<{ is_superuser: boolean }>(
				'SELECT is_superuser FROM users WHERE id = $1',
				[payload.user_id],
			);
			const isSuperuser = userResult.rows[0]?.is_superuser ?? false;
			c.set('auth', { type: AuthType.Board, userId: payload.user_id as string, isSuperuser });
		} else {
			return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token payload' } }, 401);
		}

		return next();
	} catch {
		return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
	}
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
): Promise<string> {
	const jwtKey = await masterKeyManager.getJwtKey();
	const secret = jwtKey.toString('base64');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{ member_id: memberId, company_id: companyId, iat: now, exp: now + 86400 * 30 },
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
	const companyId = c.req.param('companyId');

	if (!companyId) {
		return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing companyId' } }, 400);
	}

	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.companyId !== companyId) {
			return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
		}
		return { companyId };
	}

	// Superusers can access any company
	if (auth.isSuperuser) {
		return { companyId };
	}

	// Board auth — verify membership per-request
	const db = c.get('db');
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
