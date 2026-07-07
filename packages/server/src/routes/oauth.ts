import { randomBytes } from 'node:crypto';
import { type ConnectorCapability, getConnectorCapability, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { requestOrigin } from '../lib/request-origin';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';
import {
	type ConnectorRow,
	fireCredentialProvidedWakeup,
	getConnector,
	markActive,
	markFailed,
} from '../services/connectors/lifecycle';
import { pushConnectorToTeamContainers } from '../services/connectors/live-push';
import {
	computeScopeStatus,
	fetchAccount,
	registerAuthKey,
	registerSigningKey,
} from '../services/github';
import {
	createConnection,
	deleteConnection,
	getConnection,
	listConnections,
} from '../services/oauth/connection-store';
import { registerClient } from '../services/oauth/dcr';
import { pollDeviceFlow, resolveDeviceAuth, startDeviceFlow } from '../services/oauth/device-flow';
import { discoverMcpAuthorization, PrmUnavailableError } from '../services/oauth/prm-discovery';
import {
	buildAuthorizationUrl,
	discoverMetadata,
	exchangeCode,
} from '../services/oauth/provider-generic';
import { type ManualOAuthConfig, signState, verifyState } from '../services/oauth/state';
import { generateTeamSSHKey, getTeamSSHKey } from '../services/ssh-keys';

const log = logger.child('oauth-route');

export const oauthRoutes = new Hono<Env>();

/** A project may see its own connections and global ("all projects") ones. */
function connectionVisibleToProject(
	conn: { projectId: string | null },
	projectId: string,
): boolean {
	return conn.projectId === null || conn.projectId === projectId;
}

/**
 * In-flight GitHub device-flow handshakes, keyed by an opaque flow id handed
 * to the client. The device code never leaves the server. Entries are pruned
 * lazily on each start; a TTL bounds memory if a flow is abandoned.
 */
interface DeviceFlowEntry {
	deviceCode: string;
	teamId: string;
	projectId: string;
	connectorId: string;
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
			projectId: payload.projectId,
			metadata: {
				resource_url: payload.resourceUrl,
				token_url: payload.manualConfig.token_url,
				authorize_url: payload.manualConfig.authorize_url,
			},
		},
	);

	if (payload.mcpConnectionId) {
		await db.query(`UPDATE mcp_connections SET oauth_connection_id = $1 WHERE id = $2`, [
			conn.id,
			payload.mcpConnectionId,
		]);
		// This flow only starts from the project-scoped auth-code route, so a
		// team is always present; the guard narrows the now-nullable state type.
		if (payload.teamId) {
			broadcastChange(c, wsRoom.team(payload.teamId), 'mcp_connections', 'UPDATE', {
				id: payload.mcpConnectionId,
				oauth_connection_id: conn.id,
			});
		}
	}

	if (payload.teamId) {
		broadcastChange(c, wsRoom.team(payload.teamId), 'oauth_connections', 'INSERT', {
			id: conn.id,
			provider: conn.provider,
			provider_account_label: conn.providerAccountLabel,
		});
	}

	// The callback is an unauthenticated browser redirect (state is signed), so
	// the acting member can't be resolved here — attribute to the admin actor.
	c.get('events').emit({
		type: 'connection.created',
		teamId: payload.teamId,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: conn.id,
		provider: conn.provider,
	});

	return c.html(buildCallbackPage('success', undefined, payload.returnTo), 200);
});

oauthRoutes.post('/projects/:projectId/oauth/auth-code/start', async (c) => {
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

	const redirectUri = `${requestOrigin(c)}/api/oauth/callback`;

	const { state, codeChallenge } = await signState(masterKeyManager, {
		teamId: teamId,
		projectId: c.get('projectId') as string,
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
	| { kind: 'no_oauth'; reason: string }
	| { kind: 'error'; code: string; message: string; status: 400 | 403 | 404 | 503 };

interface StartConnectorAuthCodeOpts {
	/** Team that initiated the connect; null for the instance-admin surface. */
	teamId: string | null;
	/** Project that initiated the connect; null for the instance-admin surface. */
	projectId: string | null;
	/** Path the callback page navigates to when opened without a popup opener. */
	returnTo: string;
	/**
	 * Resolve an MCP server that advertises no Protected Resource Metadata to
	 * the `no_oauth` outcome (connector left untouched) instead of a failure.
	 * The admin connectors page probes every manually-added connector
	 * speculatively, and public / header-authenticated MCPs legitimately have
	 * no PRM. Errors past discovery (broken AS metadata, DCR unsupported or
	 * rejected) still mark the connector failed — there OAuth *is* advertised.
	 */
	missingPrmMeansNoOAuth?: boolean;
}

/**
 * Connector-driven MCP OAuth helper: discovers the MCP server's Authorization
 * Server via PRM (RFC 9728), registers this Hezo instance as a public OAuth
 * client via DCR (RFC 7591), generates a PKCE-signed state envelope, and
 * returns the authorize URL for the UI to open in a popup.
 */
async function startConnectorAuthCode(
	c: import('hono').Context<Env>,
	connectorId: string,
	opts: StartConnectorAuthCodeOpts,
): Promise<StartConnectorAuthCodeOutcome> {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const connector = await getConnector(db, connectorId);
	if (!connector)
		return { kind: 'error', code: 'NOT_FOUND', message: 'connector not found', status: 404 };
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

	// Providers whose AS can't do DCR declare a `deviceAuth` capability and
	// authorize through the device flow instead. The UI routes them there
	// directly; this guards the API from a misdirected auth-start.
	if (getConnectorCapability(connector.name)?.deviceAuth)
		return {
			kind: 'error',
			code: 'USE_DEVICE_FLOW',
			message: 'this connector authorizes via the device flow; call connectors/:id/device/start',
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

	const redirectUri = `${requestOrigin(c)}/api/oauth/mcp-callback`;

	const capability = getConnectorCapability(connector.name);

	let dcr = config.dcr;
	let scopesSupported: string[] = config.dcr?.scopes_supported ?? [];

	if (!dcr) {
		let discovery: Awaited<ReturnType<typeof discoverMcpAuthorization>>;
		try {
			discovery = await discoverMcpAuthorization(config.url);
		} catch (e) {
			if (opts.missingPrmMeansNoOAuth && e instanceof PrmUnavailableError) {
				return { kind: 'no_oauth', reason: (e as Error).message };
			}
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
					"This provider's Authorization Server does not support Dynamic Client Registration. If it supports the OAuth device flow, add a registry capability with a `deviceAuth` client_id (see the github entry); otherwise connect it with a pasted token.",
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

	// Registry override: capabilities with an explicit scope list narrow the
	// request to a known-good union. Without this, providers whose AS
	// advertises every OAuth scope (e.g. GitHub) would produce an
	// unreviewable consent screen.
	const requestedScopes = capability?.scopes ?? scopesSupported;

	const { state, codeChallenge } = await signState(masterKeyManager, {
		teamId: opts.teamId,
		projectId: opts.projectId,
		provider: `mcp:${connector.id}`,
		redirectUri,
		returnTo: opts.returnTo,
		mcpConnectionId: connector.id,
		mcpConnectionName: connector.display_name ?? connector.name,
		manualConfig: {
			authorize_url: dcr.authorization_endpoint,
			token_url: dcr.token_endpoint,
			client_id: dcr.client_id,
			scopes: requestedScopes,
		},
		resourceUrl: config.url,
	});

	const authUrl = buildAuthorizationUrl({
		authorizeUrl: dcr.authorization_endpoint,
		clientId: dcr.client_id,
		scopes: requestedScopes,
		redirectUri,
		state,
		codeChallenge,
		resource: config.url,
	});

	return { kind: 'auth_url', authUrl };
}

/**
 * OAuth kickoff for an MCP connector. Returns the authorize URL the UI opens
 * in a popup; the flow completes server-side via /oauth/mcp-callback and a
 * window.postMessage back to the opener.
 */
oauthRoutes.post('/projects/:projectId/auth-start', async (c) => {
	const teamId = c.get('teamId') as string;
	const body = (await c.req.json().catch(() => ({}))) as { connector_id?: string };

	if (!body.connector_id) return err(c, 'INVALID_REQUEST', 'connector_id is required', 400);

	const result = await startConnectorAuthCode(c, body.connector_id, {
		teamId,
		projectId: c.get('projectId') as string,
		returnTo: `/projects/${c.req.param('projectId')}/connectors?focus=${body.connector_id}`,
	});
	if (result.kind === 'error') return err(c, result.code, result.message, result.status);
	// Unreachable without `missingPrmMeansNoOAuth`; kept for exhaustiveness.
	if (result.kind === 'no_oauth') return err(c, 'OAUTH_DISCOVERY_FAILED', result.reason, 503);
	return ok(c, { auth_url: result.authUrl });
});

/**
 * OAuth kickoff for a connector from the instance-admin surface
 * (`/settings/connectors`). Same DCR walk as the project-scoped auth-start,
 * with two differences: there is no team context (the state envelope carries
 * `teamId: null` and the callback skips team-scoped side effects), and an MCP
 * server that advertises no OAuth resolves to `{ auth_url: null }` instead of
 * a failure — the admin page probes every manually-added connector, and
 * header-authenticated / public MCPs legitimately have no PRM.
 */
oauthRoutes.post('/mcp-connections/:id/auth-start', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const connectorId = c.req.param('id');

	const result = await startConnectorAuthCode(c, connectorId, {
		teamId: null,
		projectId: null,
		returnTo: `/settings/connectors?focus=${connectorId}`,
		missingPrmMeansNoOAuth: true,
	});
	if (result.kind === 'error') return err(c, result.code, result.message, result.status);
	if (result.kind === 'no_oauth') return ok(c, { auth_url: null, reason: result.reason });
	return ok(c, { auth_url: result.authUrl });
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

	// The DCR/auth-code path only ever lands non-device providers here: GitHub
	// (the lone device-flow provider today) can't complete `auth-start` at all,
	// since its AS advertises no registration_endpoint. So this is the generic
	// MCP branch — finalize through the same helper the device flow uses.
	const grantedScopes = token.scope
		? token.scope.split(/[,\s]+/).filter(Boolean)
		: payload.manualConfig.scopes;

	try {
		await finalizeConnectorConnection(c, {
			teamId: payload.teamId,
			projectId: payload.projectId,
			connector,
			capability: getConnectorCapability(connector.name),
			provider: payload.provider,
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			scopes: grantedScopes,
			expiresAt: token.expiresAt ?? null,
			allowedHosts: inferAllowedHosts(payload.resourceUrl, payload.manualConfig.token_url),
			label: payload.mcpConnectionName ?? payload.provider,
			baseMetadata: {
				resource_url: payload.resourceUrl,
				token_url: payload.manualConfig.token_url,
				authorize_url: payload.manualConfig.authorize_url,
			},
		});
	} catch (e) {
		log.warn('mcp oauth finalize failed', { error: (e as Error).message });
		await markFailed(db, connector.id, `finalize: ${(e as Error).message}`);
		return c.html(buildCallbackPage('error', 'finalize_failed'), 200);
	}

	return c.html(buildCallbackPage('success', undefined, payload.returnTo), 200);
});

oauthRoutes.get('/projects/:projectId/oauth-connections', async (c) => {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const projectId = c.get('projectId') as string;
	// This project's own connections plus global ("all projects") ones.
	const list = await listConnections({ db, masterKeyManager }, projectId);

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
			project_id: conn.projectId,
			created_at: conn.createdAt,
			updated_at: conn.updatedAt,
		})),
	);
});

oauthRoutes.get('/projects/:projectId/oauth-connections/:id/scope-status', async (c) => {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const id = c.req.param('id');

	const projectId = c.get('projectId') as string;
	const conn = await getConnection({ db, masterKeyManager }, id);
	if (!conn || !connectionVisibleToProject(conn, projectId)) {
		return err(c, 'NOT_FOUND', 'oauth connection not found', 404);
	}
	if (conn.provider !== 'github') {
		return err(c, 'INVALID_REQUEST', 'scope-status is only supported for github connections', 400);
	}

	return ok(c, computeScopeStatus(conn.scopes));
});

oauthRoutes.delete('/projects/:projectId/oauth-connections/:id', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const id = c.req.param('id');

	const conn = await getConnection({ db, masterKeyManager }, id);
	if (!conn || !connectionVisibleToProject(conn, projectId)) {
		return err(c, 'NOT_FOUND', 'oauth connection not found', 404);
	}

	const ok2 = await deleteConnection({ db, masterKeyManager }, id);
	if (!ok2) return err(c, 'NOT_FOUND', 'oauth connection not found', 404);

	broadcastChange(c, wsRoom.team(teamId), 'oauth_connections', 'DELETE', { id });

	return ok(c, { deleted: true });
});

/**
 * Begin the OAuth device flow (RFC 8628) for a connector. Used by providers
 * whose Authorization Server supports neither Dynamic Client Registration nor a
 * redirect-friendly public client (GitHub today; GitLab / Google / Microsoft
 * fit the same shape). Such a provider declares a `deviceAuth` descriptor in
 * the capability registry and never goes through the DCR `auth-start` path.
 * Returns the user code + verification URL for the UI to display; the device
 * code stays server side, referenced by an opaque flow id.
 */
oauthRoutes.post('/projects/:projectId/connectors/:connectorId/device/start', async (c) => {
	const teamId = c.get('teamId') as string;
	const connectorId = c.req.param('connectorId');
	const db = c.get('db');

	const connector = await getConnector(db, connectorId);
	if (!connector) return err(c, 'NOT_FOUND', 'connector not found', 404);
	const capability = getConnectorCapability(connector.name);
	if (!capability?.deviceAuth)
		return err(c, 'INVALID_REQUEST', 'connector does not support the device flow', 400);

	pruneDeviceFlows();

	const scopes = capability.scopes ?? [];
	let started: Awaited<ReturnType<typeof startDeviceFlow>>;
	try {
		const resolved = resolveDeviceAuth(capability.deviceAuth);
		started = await startDeviceFlow({
			deviceCodeUrl: resolved.deviceCodeUrl,
			clientId: resolved.clientId,
			scopes,
		});
	} catch (e) {
		log.warn('device-flow start failed', { connector: capability.id, error: (e as Error).message });
		return err(c, 'DEVICE_START_FAILED', (e as Error).message, 503);
	}

	const flowId = randomBytes(16).toString('hex');
	deviceFlows.set(flowId, {
		deviceCode: started.deviceCode,
		teamId,
		projectId: c.get('projectId') as string,
		connectorId,
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

/**
 * Poll a device flow. Returns 202 `pending` while the user hasn't yet
 * authorized; on success, finalizes the connection (token storage, connector
 * activation, provider side effects) via the same helper the OAuth callback
 * uses, so the connector ends up identical regardless of acquisition path.
 */
oauthRoutes.post('/projects/:projectId/connectors/:connectorId/device/poll', async (c) => {
	const teamId = c.get('teamId') as string;
	const connectorId = c.req.param('connectorId');

	const body = (await c.req.json().catch(() => ({}))) as { flow_id?: string };
	const flowId = body.flow_id;
	if (!flowId) return err(c, 'INVALID_REQUEST', 'flow_id is required', 400);

	const entry = deviceFlows.get(flowId);
	if (!entry) return err(c, 'NOT_FOUND', 'unknown or expired flow_id', 404);
	if (entry.teamId !== teamId || entry.connectorId !== connectorId)
		return err(c, 'FORBIDDEN', 'flow does not belong to this connector', 403);

	const db = c.get('db');
	const connector = await getConnector(db, connectorId);
	if (!connector) return err(c, 'NOT_FOUND', 'connector not found', 404);
	const capability = getConnectorCapability(connector.name);
	if (!capability?.deviceAuth)
		return err(c, 'INVALID_REQUEST', 'connector does not support the device flow', 400);

	const resolved = resolveDeviceAuth(capability.deviceAuth);
	const result = await pollDeviceFlow({
		tokenUrl: resolved.tokenUrl,
		clientId: resolved.clientId,
		deviceCode: entry.deviceCode,
	});
	if (result.status === 'pending') {
		return c.json({ data: { status: 'pending', retry_after: result.retryAfter } }, 202);
	}
	if (result.status === 'failed') {
		deviceFlows.delete(flowId);
		return err(c, 'DEVICE_FAILED', result.error, 400);
	}

	deviceFlows.delete(flowId);

	const scopes = result.scope ? result.scope.split(/[,\s]+/).filter(Boolean) : entry.scopes;
	let finalized: Awaited<ReturnType<typeof finalizeConnectorConnection>>;
	try {
		finalized = await finalizeConnectorConnection(c, {
			teamId,
			projectId: entry.projectId,
			connector,
			capability,
			provider: capability.id,
			accessToken: result.accessToken,
			scopes,
			allowedHosts: capability.allowedHosts,
		});
	} catch (e) {
		log.warn('device finalize failed', { connector: capability.id, error: (e as Error).message });
		await markFailed(db, connector.id, `finalize: ${(e as Error).message}`);
		return err(c, 'DEVICE_FINALIZE_FAILED', (e as Error).message, 503);
	}

	return ok(c, {
		status: 'success',
		connection: { id: finalized.connectionId, provider_account_label: finalized.label },
	});
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
 * On first connect, ensure the project's Ed25519 public key is registered on
 * the connecting user's GitHub account as both a signing key (so commits agents
 * push appear Verified) and an authentication key (so the ssh-agent-backed git
 * clone/fetch/push over `git@github.com:` works without exchanging tokens).
 */
async function ensureTeamKeyRegisteredOnGitHub(
	db: import('../db/database').Db,
	masterKeyManager: import('../crypto/master-key').MasterKeyManager,
	teamId: string,
	accessToken: string,
): Promise<void> {
	let teamKey = await getTeamSSHKey(db, teamId, masterKeyManager);
	if (!teamKey) {
		await generateTeamSSHKey(db, teamId, masterKeyManager);
		teamKey = await getTeamSSHKey(db, teamId, masterKeyManager);
		if (!teamKey) throw new Error('failed to generate project ssh key');
	}

	const signing = await registerSigningKey(accessToken, teamKey.publicKey, 'Hezo signing key');
	log.info(
		signing.status === 'already_exists'
			? 'project ssh signing key already registered on GitHub'
			: 'registered project ssh key on GitHub for signing',
		{ teamId },
	);

	const auth = await registerAuthKey(accessToken, teamKey.publicKey, 'Hezo authentication key');
	log.info(
		auth.status === 'already_exists'
			? 'project ssh auth key already registered on GitHub'
			: 'registered project ssh key on GitHub for authentication',
		{ teamId },
	);
}

/**
 * The upstream account a connection authenticates as. For providers with no
 * identity endpoint we synthesize an opaque id; providers that expose one (e.g.
 * GitHub `/user`) resolve the real account via {@link ProviderConnectHooks}.
 */
interface ConnectIdentity {
	accountId: string;
	label: string;
	metadata: Record<string, unknown>;
}

/**
 * Provider-specific behavior layered onto the otherwise-uniform connect flow.
 * Keyed by capability id; absent for the generic case (synthetic identity, no
 * side effects). GitHub resolves its real identity and registers the project's
 * SSH key so signed-commit + SSH git ops work.
 */
interface ProviderConnectHooks {
	fetchIdentity?(accessToken: string): Promise<ConnectIdentity>;
	afterConnect?(
		ctx: {
			db: import('../db/database').Db;
			masterKeyManager: import('../crypto/master-key').MasterKeyManager;
			teamId: string;
		},
		accessToken: string,
	): Promise<void>;
}

const PROVIDER_CONNECT_HOOKS: Record<string, ProviderConnectHooks> = {
	github: {
		async fetchIdentity(accessToken) {
			const account = await fetchAccount(accessToken);
			return {
				accountId: String(account.id),
				label: account.login,
				metadata: {
					avatar_url: account.avatarUrl,
					email: account.email,
					login: account.login,
					github_user_id: account.id,
				},
			};
		},
		afterConnect: ({ db, masterKeyManager, teamId }, accessToken) =>
			ensureTeamKeyRegisteredOnGitHub(db, masterKeyManager, teamId, accessToken),
	},
};

/**
 * Persist a freshly-acquired access token against a connector: resolve the
 * provider identity, store the token in the vault as an `oauth_connections`
 * row, link + activate the connector, run provider side effects, push the live
 * config to running containers, and wake any agent waiting on the connector.
 * Shared by the device-flow poll route and the auth-code OAuth callback so the
 * resulting state is identical regardless of how the token was obtained. Throws
 * if identity resolution fails (the caller maps that to a connector failure).
 */
async function finalizeConnectorConnection(
	c: import('hono').Context<Env>,
	opts: {
		// teamId is the team that initiated the connect (from the OAuth state /
		// request context); null when the connect started from the instance-admin
		// surface. The GitHub key registration, container push, and WS broadcasts
		// are per-team and are skipped without one. The wakeup resolves its own
		// team from the requesting task.
		teamId: string | null;
		// projectId scopes the resulting oauth connection to the initiating project
		// (matching its connector's scope); null for the instance-admin surface.
		projectId: string | null;
		connector: ConnectorRow;
		capability: ConnectorCapability | undefined;
		provider: string;
		accessToken: string;
		refreshToken?: string | null;
		scopes: string[];
		expiresAt?: Date | null;
		allowedHosts: string[];
		label?: string;
		baseMetadata?: Record<string, unknown>;
	},
): Promise<{ connectionId: string; label: string }> {
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const docker = c.get('docker');
	const { connector, capability, provider, accessToken, teamId } = opts;
	const hooks = PROVIDER_CONNECT_HOOKS[capability?.id ?? ''] ?? {};

	const identity: ConnectIdentity = hooks.fetchIdentity
		? await hooks.fetchIdentity(accessToken)
		: {
				accountId: `${provider}:${randomBytes(8).toString('hex')}`,
				label: opts.label ?? connector.display_name ?? connector.name,
				metadata: {},
			};

	const conn = await createConnection(
		{ db, masterKeyManager },
		{
			provider,
			providerAccountId: identity.accountId,
			providerAccountLabel: identity.label,
			accessToken,
			refreshToken: opts.refreshToken,
			scopes: opts.scopes,
			expiresAt: opts.expiresAt ?? null,
			allowedHosts: opts.allowedHosts,
			projectId: opts.projectId,
			metadata: { connector_id: connector.id, ...opts.baseMetadata, ...identity.metadata },
		},
	);

	await markActive(db, connector.id, conn.id);

	// Provider side effects (e.g. GitHub SSH-key registration) are non-fatal —
	// the connection itself is already usable; a failed key registration just
	// degrades git ops and is logged, not surfaced as a connect failure.
	// They are per-team, so an instance-admin connect (no team) skips them —
	// today that's unreachable anyway (GitHub, the only hooked provider, is
	// device-flow and the device routes are project-scoped).
	if (hooks.afterConnect && teamId) {
		await hooks.afterConnect({ db, masterKeyManager, teamId }, accessToken).catch((e) =>
			log.warn('post-connect side effect failed (non-fatal)', {
				connector: capability?.id,
				error: (e as Error).message,
			}),
		);
	}

	// Sync push to the parent task's container so the calling agent sees the
	// MCP on its next tool call; other team containers updated best-effort.
	if (teamId) {
		try {
			await pushConnectorToTeamContainers(
				{ db, docker },
				{ teamId, connectorId: connector.id, syncTaskId: connector.created_by_task_id },
			);
		} catch (e) {
			log.warn('live-push failed (non-fatal)', { error: (e as Error).message });
		}
	}

	await fireCredentialProvidedWakeup(db, connector);

	// The instance-admin flow has no team room to target; the settings page
	// refetches off the popup's hezo-oauth-success postMessage instead.
	if (teamId) {
		broadcastChange(c, wsRoom.team(teamId), 'mcp_connections', 'UPDATE', {
			id: connector.id,
			oauth_connection_id: conn.id,
			status: 'active',
		});
		broadcastChange(c, wsRoom.team(teamId), 'oauth_connections', 'INSERT', {
			id: conn.id,
			provider: conn.provider,
			provider_account_label: conn.providerAccountLabel,
		});
	}

	return { connectionId: conn.id, label: conn.providerAccountLabel };
}
