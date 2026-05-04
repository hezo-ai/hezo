import { randomBytes } from 'node:crypto';
import { wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import {
	createConnection,
	deleteConnection,
	findConnectionByAccount,
	getConnectionForCompany,
	listConnectionsForCompany,
} from '../services/oauth/connection-store';
import {
	buildAuthorizationUrl,
	discoverMetadata,
	exchangeCode,
} from '../services/oauth/provider-generic';
import {
	defaultGitHubScopes,
	fetchAccount,
	pollDeviceFlow,
	registerSigningKey,
	startDeviceFlow,
} from '../services/oauth/provider-github';
import { type ManualOAuthConfig, signState, verifyState } from '../services/oauth/state';
import { generateCompanySSHKey, getCompanySSHKey } from '../services/ssh-keys';

const log = logger.child('oauth-route');

export const oauthRoutes = new Hono<Env>();

interface DeviceFlowEntry {
	deviceCode: string;
	companyId: string;
	scopes: string[];
	expiresAt: number;
}

const deviceFlows = new Map<string, DeviceFlowEntry>();
const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;

function pruneDeviceFlows(): void {
	const now = Date.now();
	for (const [id, entry] of deviceFlows) {
		if (entry.expiresAt < now) deviceFlows.delete(id);
	}
}

oauthRoutes.post('/companies/:companyId/oauth/github/device-start', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	pruneDeviceFlows();

	const body = (await c.req.json().catch(() => ({}))) as { scopes?: string[] };
	const scopes = body.scopes && body.scopes.length > 0 ? body.scopes : defaultGitHubScopes();

	let started: Awaited<ReturnType<typeof startDeviceFlow>>;
	try {
		started = await startDeviceFlow({ scopes });
	} catch (e) {
		log.warn('github device-flow start failed', { error: (e as Error).message });
		return err(c, 'GITHUB_DEVICE_START_FAILED', (e as Error).message, 503);
	}

	const flowId = randomBytes(16).toString('hex');
	deviceFlows.set(flowId, {
		deviceCode: started.deviceCode,
		companyId: access.companyId,
		scopes,
		expiresAt: Date.now() + DEVICE_FLOW_TTL_MS,
	});

	return ok(c, {
		flow_id: flowId,
		user_code: started.userCode,
		verification_uri: started.verificationUri,
		expires_in: started.expiresIn,
		interval: started.interval,
	});
});

oauthRoutes.post('/companies/:companyId/oauth/github/device-poll', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const body = (await c.req.json().catch(() => ({}))) as { flow_id?: string };
	const flowId = body.flow_id;
	if (!flowId) return err(c, 'INVALID_REQUEST', 'flow_id is required', 400);

	const entry = deviceFlows.get(flowId);
	if (!entry) return err(c, 'NOT_FOUND', 'unknown or expired flow_id', 404);
	if (entry.companyId !== access.companyId)
		return err(c, 'FORBIDDEN', 'flow does not belong to this company', 403);

	const result = await pollDeviceFlow(entry.deviceCode);
	if (result.status === 'pending') {
		return c.json({ data: { status: 'pending', retry_after: result.retryAfter } }, 202);
	}
	if (result.status === 'failed') {
		deviceFlows.delete(flowId);
		return err(c, 'GITHUB_DEVICE_FAILED', result.error, 400);
	}

	deviceFlows.delete(flowId);

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	let account: Awaited<ReturnType<typeof fetchAccount>>;
	try {
		account = await fetchAccount(result.accessToken);
	} catch (e) {
		return err(c, 'GITHUB_ACCOUNT_FETCH_FAILED', (e as Error).message, 503);
	}

	const existing = await findConnectionByAccount(
		{ db, masterKeyManager },
		access.companyId,
		'github',
		String(account.id),
	);

	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			companyId: access.companyId,
			provider: 'github',
			providerAccountId: String(account.id),
			providerAccountLabel: account.login,
			accessToken: result.accessToken,
			scopes: result.scope ? result.scope.split(/[,\s]+/).filter(Boolean) : entry.scopes,
			expiresAt: null,
			allowedHosts: ['github.com', 'api.github.com'],
			metadata: {
				avatar_url: account.avatarUrl,
				email: account.email,
				login: account.login,
				github_user_id: account.id,
			},
		},
	);

	if (!existing) {
		await ensureSigningKeyRegisteredOnGitHub(
			db,
			masterKeyManager,
			access.companyId,
			result.accessToken,
		).catch((e) =>
			log.warn('signing-key registration failed (non-fatal)', { error: (e as Error).message }),
		);
	}

	broadcastChange(
		c,
		wsRoom.company(access.companyId),
		'oauth_connections',
		existing ? 'UPDATE' : 'INSERT',
		{
			id: conn.id,
			provider: conn.provider,
			provider_account_label: conn.providerAccountLabel,
		},
	);

	return ok(c, {
		status: 'success',
		connection: {
			id: conn.id,
			provider: conn.provider,
			provider_account_id: conn.providerAccountId,
			provider_account_label: conn.providerAccountLabel,
			scopes: conn.scopes,
			expires_at: conn.expiresAt,
			metadata: conn.metadata,
		},
	});
});

oauthRoutes.get('/oauth/callback', async (c) => {
	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');

	const code = c.req.query('code');
	const stateParam = c.req.query('state');
	const errorCode = c.req.query('error');

	if (errorCode) {
		log.warn('oauth callback received error from provider', { error: errorCode });
		return c.html(buildCallbackPage('error', errorCode), 200);
	}
	if (!code || !stateParam) {
		return c.html(buildCallbackPage('error', 'missing_code_or_state'), 200);
	}

	const payload = await verifyState(masterKeyManager, stateParam);
	if (!payload) return c.html(buildCallbackPage('error', 'invalid_state'), 200);
	if (!payload.manualConfig)
		return c.html(buildCallbackPage('error', 'missing_provider_config'), 200);

	let token: Awaited<ReturnType<typeof exchangeCode>>;
	try {
		token = await exchangeCode({
			tokenUrl: payload.manualConfig.token_url,
			clientId: payload.manualConfig.client_id,
			clientSecret: payload.manualConfig.client_secret,
			code,
			codeVerifier: payload.codeVerifier,
			redirectUri: payload.redirectUri,
		});
	} catch (e) {
		log.warn('oauth code exchange failed', { error: (e as Error).message });
		return c.html(buildCallbackPage('error', 'exchange_failed'), 200);
	}

	const allowedHosts = inferAllowedHosts(payload.resourceUrl, payload.manualConfig.token_url);
	const accountId = `${payload.provider}:${randomBytes(8).toString('hex')}`;
	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			companyId: payload.companyId,
			provider: payload.provider,
			providerAccountId: accountId,
			providerAccountLabel: payload.mcpConnectionName ?? payload.provider,
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			scopes: token.scope
				? token.scope.split(/[,\s]+/).filter(Boolean)
				: payload.manualConfig.scopes,
			expiresAt: token.expiresAt ?? null,
			allowedHosts,
			metadata: {
				resource_url: payload.resourceUrl,
				token_url: payload.manualConfig.token_url,
				authorize_url: payload.manualConfig.authorize_url,
			},
		},
	);

	if (payload.mcpConnectionId) {
		await db.query(
			`UPDATE mcp_connections SET oauth_connection_id = $1 WHERE id = $2 AND company_id = $3`,
			[conn.id, payload.mcpConnectionId, payload.companyId],
		);
		broadcastChange(c, wsRoom.company(payload.companyId), 'mcp_connections', 'UPDATE', {
			id: payload.mcpConnectionId,
			oauth_connection_id: conn.id,
		});
	}

	broadcastChange(c, wsRoom.company(payload.companyId), 'oauth_connections', 'INSERT', {
		id: conn.id,
		provider: conn.provider,
		provider_account_label: conn.providerAccountLabel,
	});

	return c.html(buildCallbackPage('success', undefined, payload.returnTo), 200);
});

oauthRoutes.post('/companies/:companyId/oauth/auth-code/start', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const masterKeyManager = c.get('masterKeyManager');

	const body = (await c.req.json().catch(() => ({}))) as {
		provider?: string;
		server_url?: string;
		manual_config?: ManualOAuthConfig;
		scopes?: string[];
		return_to?: string;
		mcp_connection_id?: string;
		mcp_connection_name?: string;
	};

	if (!body.provider?.trim()) return err(c, 'INVALID_REQUEST', 'provider is required', 400);
	if (!body.server_url && !body.manual_config) {
		return err(
			c,
			'INVALID_REQUEST',
			'provide either server_url (for spec discovery) or manual_config',
			400,
		);
	}

	let authorizeUrl: string;
	let tokenUrl: string;
	let clientId: string;
	let clientSecret: string | undefined;
	let scopes: string[];

	if (body.manual_config) {
		authorizeUrl = body.manual_config.authorize_url;
		tokenUrl = body.manual_config.token_url;
		clientId = body.manual_config.client_id;
		clientSecret = body.manual_config.client_secret;
		scopes = body.scopes ?? body.manual_config.scopes;
	} else {
		try {
			const metadata = await discoverMetadata(body.server_url as string);
			authorizeUrl = metadata.authorization_endpoint;
			tokenUrl = metadata.token_endpoint;
		} catch (e) {
			return err(c, 'OAUTH_DISCOVERY_FAILED', (e as Error).message, 503);
		}
		// In spec mode, the user still has to provide a client_id (registered via Dynamic Client Registration
		// out-of-band, or hardcoded for the MCP server). For now, require it as part of the request.
		if (!body.manual_config) {
			return err(
				c,
				'OAUTH_MANUAL_CONFIG_REQUIRED',
				'spec discovery succeeded but Dynamic Client Registration is not yet implemented; supply manual_config with client_id alongside server_url',
				400,
			);
		}
		clientId = (body.manual_config as ManualOAuthConfig).client_id;
		clientSecret = (body.manual_config as ManualOAuthConfig).client_secret;
		scopes = body.scopes ?? (body.manual_config as ManualOAuthConfig).scopes;
	}

	const protocol = c.req.header('x-forwarded-proto') ?? 'http';
	const host = c.req.header('host') ?? 'localhost';
	const redirectUri = `${protocol}://${host}/api/oauth/callback`;

	const { state, codeChallenge } = await signState(masterKeyManager, {
		companyId: access.companyId,
		provider: body.provider,
		redirectUri,
		returnTo: body.return_to ?? '/',
		mcpConnectionId: body.mcp_connection_id,
		mcpConnectionName: body.mcp_connection_name,
		manualConfig: {
			authorize_url: authorizeUrl,
			token_url: tokenUrl,
			client_id: clientId,
			client_secret: clientSecret,
			scopes,
		},
		resourceUrl: body.server_url,
	});

	const authUrl = buildAuthorizationUrl({
		authorizeUrl,
		clientId,
		scopes,
		redirectUri,
		state,
		codeChallenge,
		resource: body.server_url,
	});

	return ok(c, { auth_url: authUrl });
});

oauthRoutes.get('/companies/:companyId/oauth-connections', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const list = await listConnectionsForCompany({ db, masterKeyManager }, access.companyId);

	return ok(
		c,
		list.map((conn) => ({
			id: conn.id,
			provider: conn.provider,
			provider_account_id: conn.providerAccountId,
			provider_account_label: conn.providerAccountLabel,
			scopes: conn.scopes,
			expires_at: conn.expiresAt,
			metadata: conn.metadata,
			created_at: conn.createdAt,
			updated_at: conn.updatedAt,
		})),
	);
});

oauthRoutes.delete('/companies/:companyId/oauth-connections/:id', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const id = c.req.param('id');

	const conn = await getConnectionForCompany({ db, masterKeyManager }, access.companyId, id);
	if (!conn) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);

	const ok2 = await deleteConnection({ db, masterKeyManager }, id);
	if (!ok2) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);

	broadcastChange(c, wsRoom.company(access.companyId), 'oauth_connections', 'DELETE', { id });

	return ok(c, { deleted: true });
});

function inferAllowedHosts(resourceUrl: string | undefined, tokenUrl: string): string[] {
	const hosts = new Set<string>();
	for (const url of [resourceUrl, tokenUrl]) {
		if (!url) continue;
		try {
			hosts.add(new URL(url).host.toLowerCase());
		} catch {
			// ignore malformed
		}
	}
	return [...hosts];
}

function buildCallbackPage(
	status: 'success' | 'error',
	message?: string,
	returnTo?: string,
): string {
	const safeReturn = returnTo && /^\/[a-zA-Z0-9_/?=&%-]*$/.test(returnTo) ? returnTo : '/';
	if (status === 'success') {
		return `<!doctype html><html><head><title>Connected</title></head><body><script>
			if (window.opener) {
				window.opener.postMessage({ type: 'hezo-oauth-success' }, window.location.origin);
				window.close();
			} else {
				location.href = ${JSON.stringify(safeReturn)};
			}
		</script><p>OAuth connection complete. You can close this window.</p></body></html>`;
	}
	return `<!doctype html><html><head><title>OAuth failed</title></head><body><script>
		if (window.opener) {
			window.opener.postMessage({ type: 'hezo-oauth-error', error: ${JSON.stringify(message ?? 'unknown')} }, window.location.origin);
		}
	</script><p>OAuth failed: ${message ?? 'unknown'}</p></body></html>`;
}

/**
 * On first connect, ensure the company's Ed25519 public key is registered as
 * a signing key on the GitHub account. This drives "Verified" badges on
 * commits the agents push without any manual step from the human.
 */
async function ensureSigningKeyRegisteredOnGitHub(
	db: import('@electric-sql/pglite').PGlite,
	masterKeyManager: import('../crypto/master-key').MasterKeyManager,
	companyId: string,
	accessToken: string,
): Promise<void> {
	let companyKey = await getCompanySSHKey(db, companyId, masterKeyManager);
	if (!companyKey) {
		await generateCompanySSHKey(db, companyId, masterKeyManager);
		companyKey = await getCompanySSHKey(db, companyId, masterKeyManager);
		if (!companyKey) throw new Error('failed to generate company ssh key');
	}
	await registerSigningKey(accessToken, companyKey.publicKey, 'Hezo signing key');
	log.info('registered company ssh key on GitHub for signing', { companyId });
}
