import { randomBytes } from 'node:crypto';
import { WakeupSource, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { getConnector, markActive, markFailed } from '../services/connectors/lifecycle';
import { pushConnectorToTeamContainers } from '../services/connectors/live-push';
import {
	createConnection,
	deleteConnection,
	findConnectionByAccount,
	getConnectionForTeam,
	listConnectionsForTeam,
} from '../services/oauth/connection-store';
import { registerClient } from '../services/oauth/dcr';
import { discoverMcpAuthorization } from '../services/oauth/prm-discovery';
import {
	buildAuthorizationUrl,
	discoverMetadata,
	exchangeCode,
} from '../services/oauth/provider-generic';
import {
	computeScopeStatus,
	defaultGitHubScopes,
	fetchAccount,
	pollDeviceFlow,
	registerAuthKey,
	registerSigningKey,
	startDeviceFlow,
} from '../services/oauth/provider-github';
import { type ManualOAuthConfig, signState, verifyState } from '../services/oauth/state';
import { generateTeamSSHKey, getTeamSSHKey } from '../services/ssh-keys';
import { createWakeup } from '../services/wakeup';

const log = logger.child('oauth-route');

export const oauthRoutes = new Hono<Env>();

interface DeviceFlowEntry {
	deviceCode: string;
	teamId: string;
	provider: 'github';
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

interface DeviceFlowStartResult {
	flow_id: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

async function startGitHubDeviceFlow(
	teamId: string,
	scopes: string[],
): Promise<DeviceFlowStartResult> {
	pruneDeviceFlows();
	const started = await startDeviceFlow({ scopes });
	const flowId = randomBytes(16).toString('hex');
	deviceFlows.set(flowId, {
		deviceCode: started.deviceCode,
		teamId,
		provider: 'github',
		scopes,
		expiresAt: Date.now() + DEVICE_FLOW_TTL_MS,
	});
	return {
		flow_id: flowId,
		user_code: started.userCode,
		verification_uri: started.verificationUri,
		expires_in: started.expiresIn,
		interval: started.interval,
	};
}

type GitHubDevicePollOutcome =
	| { kind: 'pending'; retryAfter: number }
	| { kind: 'failed'; error: string }
	| {
			kind: 'success';
			connection: {
				id: string;
				provider: string;
				provider_account_id: string;
				provider_account_label: string;
				scopes: string[];
				expires_at: Date | null;
				metadata: Record<string, unknown>;
			};
			isNew: boolean;
	  };

async function completeGitHubDeviceFlow(
	entry: DeviceFlowEntry,
	flowId: string,
	db: import('@electric-sql/pglite').PGlite,
	masterKeyManager: import('../crypto/master-key').MasterKeyManager,
): Promise<GitHubDevicePollOutcome> {
	const result = await pollDeviceFlow(entry.deviceCode);
	if (result.status === 'pending') {
		return { kind: 'pending', retryAfter: result.retryAfter };
	}
	if (result.status === 'failed') {
		deviceFlows.delete(flowId);
		return { kind: 'failed', error: result.error };
	}

	deviceFlows.delete(flowId);

	const account = await fetchAccount(result.accessToken);

	const existing = await findConnectionByAccount(
		{ db, masterKeyManager },
		entry.teamId,
		'github',
		String(account.id),
	);

	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			teamId: entry.teamId,
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

	// Always attempt registration — both helpers treat 422 "already in use" as
	// a no-op, so this is idempotent. Critical for the re-auth path where a
	// pre-existing connection is upgraded to broader scopes (write:public_key);
	// without this, the newly-required auth key would never get registered.
	await ensureTeamKeyRegisteredOnGitHub(
		db,
		masterKeyManager,
		entry.teamId,
		result.accessToken,
	).catch((e) =>
		log.warn('team-key registration failed (non-fatal)', { error: (e as Error).message }),
	);

	return {
		kind: 'success',
		isNew: !existing,
		connection: {
			id: conn.id,
			provider: conn.provider,
			provider_account_id: conn.providerAccountId,
			provider_account_label: conn.providerAccountLabel,
			scopes: conn.scopes,
			expires_at: conn.expiresAt,
			metadata: conn.metadata,
		},
	};
}

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
			teamId: payload.teamId,
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
			`UPDATE mcp_connections SET oauth_connection_id = $1 WHERE id = $2 AND team_id = $3`,
			[conn.id, payload.mcpConnectionId, payload.teamId],
		);
		broadcastChange(c, wsRoom.team(payload.teamId), 'mcp_connections', 'UPDATE', {
			id: payload.mcpConnectionId,
			oauth_connection_id: conn.id,
		});
	}

	broadcastChange(c, wsRoom.team(payload.teamId), 'oauth_connections', 'INSERT', {
		id: conn.id,
		provider: conn.provider,
		provider_account_label: conn.providerAccountLabel,
	});

	return c.html(buildCallbackPage('success', undefined, payload.returnTo), 200);
});

oauthRoutes.post('/teams/:teamId/oauth/auth-code/start', async (c) => {
	const teamId = c.get('teamId') as string;

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
		teamId: teamId,
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

type StartConnectorAuthCodeOutcome =
	| { kind: 'auth_url'; authUrl: string }
	| { kind: 'error'; code: string; message: string; status: 400 | 403 | 404 | 503 };

/**
 * Connector-driven MCP OAuth helper: discovers the MCP server's Authorization
 * Server via PRM (RFC 9728), registers this Hezo instance as a public OAuth
 * client via DCR (RFC 7591), generates a PKCE-signed state envelope, and
 * returns the authorize URL for the UI to open in a popup.
 */
async function startConnectorAuthCode(
	c: import('hono').Context<Env>,
	teamId: string,
	connectorId: string,
): Promise<StartConnectorAuthCodeOutcome> {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const connector = await getConnector(db, connectorId);
	if (!connector)
		return { kind: 'error', code: 'NOT_FOUND', message: 'connector not found', status: 404 };
	if (connector.team_id !== teamId)
		return {
			kind: 'error',
			code: 'FORBIDDEN',
			message: 'connector does not belong to this team',
			status: 403,
		};
	if (connector.revoked_at)
		return {
			kind: 'error',
			code: 'CONNECTOR_REVOKED',
			message: 'connector has been revoked; create a new one to reconnect',
			status: 400,
		};
	if (connector.kind !== 'saas')
		return {
			kind: 'error',
			code: 'INVALID_REQUEST',
			message: 'auth-start only applies to saas MCP connectors',
			status: 400,
		};

	const config = connector.config as {
		url?: string;
		dcr?: {
			client_id: string;
			authorization_server_url: string;
			authorization_endpoint: string;
			token_endpoint: string;
			scopes_supported?: string[];
		};
	};
	if (!config.url)
		return {
			kind: 'error',
			code: 'INVALID_REQUEST',
			message: 'connector has no MCP server url',
			status: 400,
		};

	const protocol = c.req.header('x-forwarded-proto') ?? 'http';
	const host = c.req.header('host') ?? 'localhost';
	const redirectUri = `${protocol}://${host}/api/oauth/mcp-callback`;

	let dcr = config.dcr;
	let scopesSupported: string[] = config.dcr?.scopes_supported ?? [];

	if (!dcr) {
		let discovery: Awaited<ReturnType<typeof discoverMcpAuthorization>>;
		try {
			discovery = await discoverMcpAuthorization(config.url);
		} catch (e) {
			await markFailed(db, connector.id, `discovery: ${(e as Error).message}`);
			return {
				kind: 'error',
				code: 'OAUTH_DISCOVERY_FAILED',
				message: (e as Error).message,
				status: 503,
			};
		}
		if (!discovery.asMetadata.registration_endpoint) {
			await markFailed(
				db,
				connector.id,
				'AS does not advertise registration_endpoint (DCR unsupported)',
			);
			return {
				kind: 'error',
				code: 'OAUTH_DCR_UNSUPPORTED',
				message:
					'Authorization Server does not support Dynamic Client Registration; manual client_id setup is not yet implemented',
				status: 400,
			};
		}
		let registered: Awaited<ReturnType<typeof registerClient>>;
		try {
			registered = await registerClient({
				registrationEndpoint: discovery.asMetadata.registration_endpoint,
				redirectUri,
				clientName: `Hezo (${connector.display_name ?? connector.name})`,
				scope: discovery.asMetadata.scopes_supported?.join(' '),
			});
		} catch (e) {
			await markFailed(db, connector.id, `DCR: ${(e as Error).message}`);
			return {
				kind: 'error',
				code: 'OAUTH_DCR_FAILED',
				message: (e as Error).message,
				status: 503,
			};
		}
		dcr = {
			client_id: registered.clientId,
			authorization_server_url: discovery.authorizationServerUrl,
			authorization_endpoint: discovery.asMetadata.authorization_endpoint,
			token_endpoint: discovery.asMetadata.token_endpoint,
			scopes_supported: discovery.asMetadata.scopes_supported,
		};
		scopesSupported = discovery.asMetadata.scopes_supported ?? [];
		const newConfig = { ...config, dcr };
		await db.query(
			`UPDATE mcp_connections SET config = $1::jsonb, updated_at = now() WHERE id = $2`,
			[JSON.stringify(newConfig), connector.id],
		);
	}

	const { state, codeChallenge } = await signState(masterKeyManager, {
		teamId,
		provider: `mcp:${connector.id}`,
		redirectUri,
		returnTo: `/teams/${teamId}/connectors?focus=${connector.id}`,
		mcpConnectionId: connector.id,
		mcpConnectionName: connector.display_name ?? connector.name,
		manualConfig: {
			authorize_url: dcr.authorization_endpoint,
			token_url: dcr.token_endpoint,
			client_id: dcr.client_id,
			scopes: scopesSupported,
		},
		resourceUrl: config.url,
	});

	const authUrl = buildAuthorizationUrl({
		authorizeUrl: dcr.authorization_endpoint,
		clientId: dcr.client_id,
		scopes: scopesSupported,
		redirectUri,
		state,
		codeChallenge,
		resource: config.url,
	});

	return { kind: 'auth_url', authUrl };
}

/**
 * Unified OAuth kickoff. The body picks the flow:
 *   { connector_id: "..." }            → auth-code + PKCE for an MCP connector
 *   { provider: "github", scopes?: [] } → GitHub device flow
 * Response is a discriminated union on `flow`. The web layer dispatches off
 * `flow` to either open a popup (auth_code) or render the device-code modal
 * and start polling `/auth-poll` (device).
 */
oauthRoutes.post('/teams/:teamId/auth-start', async (c) => {
	const teamId = c.get('teamId') as string;
	const body = (await c.req.json().catch(() => ({}))) as {
		connector_id?: string;
		provider?: string;
		scopes?: string[];
	};

	if (body.connector_id) {
		const result = await startConnectorAuthCode(c, teamId, body.connector_id);
		if (result.kind === 'error') return err(c, result.code, result.message, result.status);
		return ok(c, { flow: 'auth_code' as const, auth_url: result.authUrl });
	}

	if (body.provider === 'github') {
		const scopes = body.scopes && body.scopes.length > 0 ? body.scopes : defaultGitHubScopes();
		let started: DeviceFlowStartResult;
		try {
			started = await startGitHubDeviceFlow(teamId, scopes);
		} catch (e) {
			log.warn('github device-flow start failed', { error: (e as Error).message });
			return err(c, 'GITHUB_DEVICE_START_FAILED', (e as Error).message, 503);
		}
		return ok(c, { flow: 'device' as const, ...started });
	}

	return err(
		c,
		'INVALID_REQUEST',
		'body must include connector_id (for MCP connectors) or provider (for device-flow providers)',
		400,
	);
});

/**
 * Unified OAuth polling. Only device flows need polling — the auth-code flow
 * resolves out-of-band via /oauth/mcp-callback and a postMessage to the opener
 * window. Returns 202 with status="pending" while the user is still authorizing,
 * or 200 with status="success" once the connection has been provisioned.
 */
oauthRoutes.post('/teams/:teamId/auth-poll', async (c) => {
	const teamId = c.get('teamId') as string;
	const body = (await c.req.json().catch(() => ({}))) as { flow_id?: string };
	const flowId = body.flow_id;
	if (!flowId) return err(c, 'INVALID_REQUEST', 'flow_id is required', 400);

	const entry = deviceFlows.get(flowId);
	if (!entry) return err(c, 'NOT_FOUND', 'unknown or expired flow_id', 404);
	if (entry.teamId !== teamId) return err(c, 'FORBIDDEN', 'flow does not belong to this team', 403);

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	let outcome: GitHubDevicePollOutcome;
	try {
		outcome = await completeGitHubDeviceFlow(entry, flowId, db, masterKeyManager);
	} catch (e) {
		return err(c, 'GITHUB_ACCOUNT_FETCH_FAILED', (e as Error).message, 503);
	}

	if (outcome.kind === 'pending') {
		return c.json({ data: { status: 'pending' as const, retry_after: outcome.retryAfter } }, 202);
	}
	if (outcome.kind === 'failed') {
		return err(c, 'GITHUB_DEVICE_FAILED', outcome.error, 400);
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'oauth_connections',
		outcome.isNew ? 'INSERT' : 'UPDATE',
		{
			id: outcome.connection.id,
			provider: outcome.connection.provider,
			provider_account_label: outcome.connection.provider_account_label,
		},
	);

	return ok(c, { status: 'success' as const, connection: outcome.connection });
});

/**
 * Callback for the connector-driven MCP OAuth flow. Verifies state, exchanges
 * code at the AS token endpoint, stores the access (+ refresh) token in
 * `oauth_connections`, marks the connector active, pushes the new config to
 * the parent task's container synchronously and to other team containers
 * best-effort, and fires a CredentialProvided wakeup so any agent that was
 * waiting on this connector resumes.
 */
oauthRoutes.get('/oauth/mcp-callback', async (c) => {
	const masterKeyManager = c.get('masterKeyManager');
	const db = c.get('db');
	const docker = c.get('docker');

	const code = c.req.query('code');
	const stateParam = c.req.query('state');
	const errorCode = c.req.query('error');

	if (errorCode) {
		log.warn('mcp oauth callback received error from provider', { error: errorCode });
		return c.html(buildCallbackPage('error', errorCode), 200);
	}
	if (!code || !stateParam) {
		return c.html(buildCallbackPage('error', 'missing_code_or_state'), 200);
	}

	const payload = await verifyState(masterKeyManager, stateParam);
	if (!payload) return c.html(buildCallbackPage('error', 'invalid_state'), 200);
	if (!payload.mcpConnectionId)
		return c.html(buildCallbackPage('error', 'missing_connector_id'), 200);
	if (!payload.manualConfig)
		return c.html(buildCallbackPage('error', 'missing_provider_config'), 200);

	const connector = await getConnector(db, payload.mcpConnectionId);
	if (!connector) return c.html(buildCallbackPage('error', 'connector_not_found'), 200);
	if (connector.team_id !== payload.teamId)
		return c.html(buildCallbackPage('error', 'team_mismatch'), 200);

	let token: Awaited<ReturnType<typeof exchangeCode>>;
	try {
		token = await exchangeCode({
			tokenUrl: payload.manualConfig.token_url,
			clientId: payload.manualConfig.client_id,
			code,
			codeVerifier: payload.codeVerifier,
			redirectUri: payload.redirectUri,
		});
	} catch (e) {
		log.warn('mcp oauth code exchange failed', { error: (e as Error).message });
		await markFailed(db, connector.id, `exchange: ${(e as Error).message}`);
		return c.html(buildCallbackPage('error', 'exchange_failed'), 200);
	}

	const allowedHosts = inferAllowedHosts(payload.resourceUrl, payload.manualConfig.token_url);
	const accountId = `${payload.provider}:${randomBytes(8).toString('hex')}`;
	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			teamId: payload.teamId,
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
				connector_id: connector.id,
			},
		},
	);

	await markActive(db, connector.id, conn.id);

	// Sync push to the parent task's container so the calling agent sees the
	// MCP on its next tool call; other team containers updated best-effort.
	try {
		await pushConnectorToTeamContainers(
			{ db, docker },
			{
				teamId: payload.teamId,
				connectorId: connector.id,
				syncTaskId: connector.created_by_task_id,
			},
		);
	} catch (e) {
		log.warn('live-push failed (non-fatal)', { error: (e as Error).message });
	}

	// Fire CredentialProvided wakeup on the calling task's assignee, if any.
	if (connector.created_by_task_id) {
		const row = await db.query<{ assignee_id: string | null }>(
			`SELECT assignee_id FROM tasks WHERE id = $1`,
			[connector.created_by_task_id],
		);
		const assigneeId = row.rows[0]?.assignee_id;
		if (assigneeId) {
			trackBackground(
				createWakeup(
					db,
					assigneeId,
					payload.teamId,
					WakeupSource.CredentialProvided,
					{ connector_id: connector.id, task_id: connector.created_by_task_id },
					`connector:${connector.id}`,
				).catch((e) =>
					log.warn('wakeup enqueue failed (non-fatal)', { error: (e as Error).message }),
				),
			);
		}
	}

	broadcastChange(c, wsRoom.team(payload.teamId), 'mcp_connections', 'UPDATE', {
		id: connector.id,
		team_id: payload.teamId,
		oauth_connection_id: conn.id,
		status: 'active',
	});
	broadcastChange(c, wsRoom.team(payload.teamId), 'oauth_connections', 'INSERT', {
		id: conn.id,
		provider: conn.provider,
		provider_account_label: conn.providerAccountLabel,
	});

	return c.html(buildCallbackPage('success', undefined, payload.returnTo), 200);
});

oauthRoutes.get('/teams/:teamId/oauth-connections', async (c) => {
	const teamId = c.get('teamId') as string;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const list = await listConnectionsForTeam({ db, masterKeyManager }, teamId);

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

oauthRoutes.get('/teams/:teamId/oauth-connections/:id/scope-status', async (c) => {
	const teamId = c.get('teamId') as string;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const id = c.req.param('id');

	const conn = await getConnectionForTeam({ db, masterKeyManager }, teamId, id);
	if (!conn) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);
	if (conn.provider !== 'github') {
		return err(c, 'INVALID_REQUEST', 'scope-status is only supported for github connections', 400);
	}

	return ok(c, computeScopeStatus(conn.scopes));
});

oauthRoutes.delete('/teams/:teamId/oauth-connections/:id', async (c) => {
	const teamId = c.get('teamId') as string;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const id = c.req.param('id');

	const conn = await getConnectionForTeam({ db, masterKeyManager }, teamId, id);
	if (!conn) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);

	const ok2 = await deleteConnection({ db, masterKeyManager }, id);
	if (!ok2) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);

	broadcastChange(c, wsRoom.team(teamId), 'oauth_connections', 'DELETE', { id });

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
	// targetOrigin is '*' because the callback page lives on the server origin
	// (e.g. localhost:3101) while the opener is on the web origin (e.g.
	// localhost:5174 in dev / CI). Browsers silently drop postMessages whose
	// targetOrigin doesn't match the receiver's origin, so '*' is the only
	// portable choice. The payload carries no sensitive data — just a type
	// tag the opener uses to trigger a refetch — so wildcard delivery is safe.
	if (status === 'success') {
		return `<!doctype html><html><head><title>Connected</title></head><body><script>
			if (window.opener) {
				window.opener.postMessage({ type: 'hezo-oauth-success' }, '*');
				window.close();
			} else {
				location.href = ${JSON.stringify(safeReturn)};
			}
		</script><p>OAuth connection complete. You can close this window.</p></body></html>`;
	}
	return `<!doctype html><html><head><title>OAuth failed</title></head><body><script>
		if (window.opener) {
			window.opener.postMessage({ type: 'hezo-oauth-error', error: ${JSON.stringify(message ?? 'unknown')} }, '*');
		}
	</script><p>OAuth failed: ${message ?? 'unknown'}</p></body></html>`;
}

/**
 * On first connect, ensure the team's Ed25519 public key is registered on
 * the connecting user's GitHub account as both a signing key (so commits agents
 * push appear Verified) and an authentication key (so the ssh-agent-backed git
 * clone/fetch/push over `git@github.com:` works without exchanging tokens).
 */
async function ensureTeamKeyRegisteredOnGitHub(
	db: import('@electric-sql/pglite').PGlite,
	masterKeyManager: import('../crypto/master-key').MasterKeyManager,
	teamId: string,
	accessToken: string,
): Promise<void> {
	let teamKey = await getTeamSSHKey(db, teamId, masterKeyManager);
	if (!teamKey) {
		await generateTeamSSHKey(db, teamId, masterKeyManager);
		teamKey = await getTeamSSHKey(db, teamId, masterKeyManager);
		if (!teamKey) throw new Error('failed to generate team ssh key');
	}

	const signing = await registerSigningKey(accessToken, teamKey.publicKey, 'Hezo signing key');
	log.info(
		signing.status === 'already_exists'
			? 'team ssh signing key already registered on GitHub'
			: 'registered team ssh key on GitHub for signing',
		{ teamId },
	);

	const auth = await registerAuthKey(accessToken, teamKey.publicKey, 'Hezo authentication key');
	log.info(
		auth.status === 'already_exists'
			? 'team ssh auth key already registered on GitHub'
			: 'registered team ssh key on GitHub for authentication',
		{ teamId },
	);
}
