import { OAUTH_CALLBACK_PATH } from '@hezo/shared';
import { Hono } from 'hono';
import { signOAuthState } from '../crypto/state';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import { removeSSHKeyFromGitHub } from '../services/github';
import { getCompanySSHKey } from '../services/ssh-keys';
import { getOAuthToken } from '../services/token-store';

const SUPPORTED_PLATFORMS = new Set(['github', 'anthropic', 'openai', 'google']);

export const connectionsRoutes = new Hono<Env>();

connectionsRoutes.get('/companies/:companyId/connections', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT id, platform, status, scopes, metadata, token_expires_at, connected_at
		 FROM connected_platforms
		 WHERE company_id = $1
		 ORDER BY connected_at DESC`,
		[companyId],
	);

	return ok(c, result.rows);
});

connectionsRoutes.post('/companies/:companyId/connections/:platform/start', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const connectUrl = c.get('connectUrl');
	const { companyId } = access;
	const platform = c.req.param('platform');

	if (!SUPPORTED_PLATFORMS.has(platform)) {
		return err(c, 'UNSUPPORTED_PLATFORM', `Platform "${platform}" is not supported`, 400);
	}

	if (!connectUrl) {
		return err(c, 'CONNECT_UNAVAILABLE', 'Hezo Connect URL is not configured', 503);
	}

	let issueId: string | undefined;
	if (c.req.header('content-type')?.includes('application/json')) {
		try {
			const body = await c.req.json<{ issue_id?: string }>();
			if (body?.issue_id) {
				const issueCheck = await db.query<{ id: string }>(
					'SELECT id FROM issues WHERE id = $1 AND company_id = $2',
					[body.issue_id, companyId],
				);
				if (issueCheck.rows.length === 0) {
					return err(c, 'NOT_FOUND', 'Issue not found for this company', 404);
				}
				issueId = body.issue_id;
			}
		} catch {
			// Ignore malformed body; issue_id is optional.
		}
	}

	const state = await signOAuthState(
		{ company_id: companyId, ...(issueId ? { issue_id: issueId } : {}) },
		masterKeyManager,
	);

	// Derive the callback URL from the request origin
	const origin = new URL(c.req.url).origin;
	const callbackUrl = `${origin}${OAUTH_CALLBACK_PATH}`;

	const authUrl = `${connectUrl}/auth/${platform}/start?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

	return ok(c, { auth_url: authUrl, state });
});

connectionsRoutes.delete('/companies/:companyId/connections/:connectionId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const { companyId } = access;
	const connectionId = c.req.param('connectionId');

	const connection = await db.query<{
		id: string;
		platform: string;
		access_token_secret_id: string | null;
		refresh_token_secret_id: string | null;
	}>(
		'SELECT id, platform, access_token_secret_id, refresh_token_secret_id FROM connected_platforms WHERE id = $1 AND company_id = $2',
		[connectionId, companyId],
	);

	if (connection.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Connection not found', 404);
	}

	const conn = connection.rows[0];

	// Remove SSH key from GitHub if applicable
	if (conn.platform === 'github') {
		try {
			const sshKey = await getCompanySSHKey(db, companyId, masterKeyManager);
			if (sshKey?.githubKeyId) {
				const token = await getOAuthToken(db, masterKeyManager, companyId, 'github');
				if (token) {
					await removeSSHKeyFromGitHub(sshKey.githubKeyId, token);
				}
			}
		} catch {
			// Non-fatal if GitHub cleanup fails
		}

		// Delete company SSH keys
		await db.query('DELETE FROM company_ssh_keys WHERE company_id = $1', [companyId]);
	}

	// Delete associated secrets
	if (conn.access_token_secret_id) {
		await db.query('DELETE FROM secrets WHERE id = $1', [conn.access_token_secret_id]);
	}
	if (conn.refresh_token_secret_id) {
		await db.query('DELETE FROM secrets WHERE id = $1', [conn.refresh_token_secret_id]);
	}

	// Delete the connection
	await db.query('DELETE FROM connected_platforms WHERE id = $1', [connectionId]);

	return ok(c, { deleted: true });
});

connectionsRoutes.post('/companies/:companyId/connections/:connectionId/refresh', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const connectionId = c.req.param('connectionId');

	const result = await db.query<{ status: string; token_expires_at: string | null }>(
		'SELECT status, token_expires_at FROM connected_platforms WHERE id = $1 AND company_id = $2',
		[connectionId, companyId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Connection not found', 404);
	}

	return ok(c, {
		status: result.rows[0].status,
		token_expires_at: result.rows[0].token_expires_at,
	});
});
