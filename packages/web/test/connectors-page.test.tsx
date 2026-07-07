import { createGitHubSim, type GitHubSim } from '@hezo/server/test/helpers/github-sim';
import { waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

// Seed a global (instance-wide) saas MCP connector via the project-scoped route.
// `config.dcr` is pre-baked so the redirect "Connect" path can build an authorize
// URL entirely in-process (no PRM discovery / DCR network call).
async function seedSaasConnector(
	ws: SeededWorkspace,
	input: { name: string; url: string; withDcr?: boolean },
): Promise<{ id: string; name: string }> {
	const { apiBase } = getTestContext();
	const config: Record<string, unknown> = { url: input.url };
	if (input.withDcr) {
		config.dcr = {
			client_id: 'dcr-client-id',
			authorization_server_url: 'https://as.example',
			authorization_endpoint: 'https://as.example/authorize',
			token_endpoint: 'https://as.example/token',
			scopes_supported: ['read', 'write'],
		};
	}
	const res = await apiBase(`/api/projects/${ws.internalSlug}/mcp-connections`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ name: input.name, kind: 'saas', config }),
	});
	if (res.status !== 201) throw new Error(`seedSaasConnector failed: ${res.status}`);
	return (await res.json()).data;
}

// Seed a local (stdio) MCP connector — e.g. a self-hosted umami server that logs
// in with a username/password credential placeholder rather than OAuth. Local
// connectors carry a `config.command`, never a url, and never an oauth handshake.
async function seedLocalConnector(
	ws: SeededWorkspace,
	input: { name: string; command: string },
): Promise<{ id: string; name: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/mcp-connections`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({
			name: input.name,
			kind: 'local',
			config: { command: input.command, args: [], env: {} },
		}),
	});
	if (res.status !== 201) throw new Error(`seedLocalConnector failed: ${res.status}`);
	return (await res.json()).data;
}

// Seed an "active" GitHub OAuth connection straight into the DB (the same shape
// finalizeConnectorConnection produces) so the GitHub row renders its connected
// state without driving the full device flow.
async function seedGithubOAuth(scopes: string[]): Promise<{ id: string }> {
	const { db } = getTestContext();
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, 'placeholder', 'api_token', ARRAY['github.com'])
		 RETURNING id`,
		[`OAUTH_GITHUB_${Math.random().toString(16).slice(2, 10)}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		   (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ('github', $1, 'octocat', $2, $3)
		 RETURNING id`,
		[Math.random().toString(16).slice(2, 10), secret.rows[0].id, scopes],
	);
	return conn.rows[0];
}

// Flip a seeded saas connector to the "active" state (oauth_connection_id +
// activated_at) the way markActive does, so its ConnectorRow shows Disconnect.
async function markConnectorActive(connectorId: string, oauthConnectionId: string): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE mcp_connections SET oauth_connection_id = $2, activated_at = now(), updated_at = now()
		 WHERE id = $1`,
		[connectorId, oauthConnectionId],
	);
}

const CONNECTORS_ROUTE = '/projects/$projectId/connectors';

let sim: GitHubSim | null = null;
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
	if (sim) {
		await sim.destroy();
		sim = null;
	}
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

test('lists a seeded MCP connector alongside the always-present GitHub row', async () => {
	let slug = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedSaasConnector(ws, { name: 'linear', url: 'https://mcp.linear.example/mcp' });
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('Connectors', { selector: 'h1' });
	// The GitHub row is rendered unconditionally.
	await findByText('GitHub');
	// The seeded saas connector renders as its own row with its url.
	await findByText('linear');
	await findByText('https://mcp.linear.example/mcp');

	// The GitHub row, with no connection, shows the pending-connect affordance.
	const list = getByTestId('connectors-list');
	expect(list.querySelector('[data-connector-name="github"][data-status="pending"]')).toBeTruthy();
});

test('shows the empty-state hint when there are no connectors or OAuth connections', async () => {
	let slug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('Connectors', { selector: 'h1' });
	await findByText(/No third-party MCP servers yet/);
});

test('GitHub row renders the connected state and disconnects', async () => {
	window.confirm = () => true;
	let slug = '';
	const { findByText, findByTestId, queryByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedGithubOAuth(['repo', 'workflow', 'read:org']);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('Connectors', { selector: 'h1' });
	// Connected copy + scopes render.
	await findByText(/Connected as/);
	await findByText('octocat');
	await findByText(/repo workflow read:org/);

	// Disconnect calls DELETE /oauth-connections/:id then invalidates the list.
	const disconnect = (await findByTestId('connector-revoke')) as HTMLButtonElement;
	disconnect.click();

	// After deletion the row falls back to the disconnected ("Connect") state.
	await findByTestId('connector-connect');
	await waitFor(() => expect(queryByText('octocat')).toBeNull());
});

test('Connect on a redirect (non-device) connector surfaces the popup-blocked error', async () => {
	// window.open returns null → the component reports the pop-up was blocked.
	const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
	let slug = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedSaasConnector(ws, {
				name: 'linear',
				url: 'https://mcp.linear.example/mcp',
				withDcr: true,
			});
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('linear');
	// Scope to the linear (non-github) connector row's Connect button.
	const linearRow = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!linearRow) throw new Error('linear connector row not found');
	const connectBtn = within(linearRow).getByTestId('connector-connect');
	connectBtn.click();

	// auth-start resolves an authorize URL (in-process, dcr pre-baked); window.open
	// was stubbed to null, so the row shows the pop-up-blocked message.
	await findByText(/Pop-up blocked/);
	expect(openSpy).toHaveBeenCalledTimes(1);
});

test('an active non-GitHub connector renders Disconnect and revokes', async () => {
	window.confirm = () => true;
	let slug = '';
	const { findByText, getByTestId, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const connector = await seedSaasConnector(ws, {
				name: 'linear',
				url: 'https://mcp.linear.example/mcp',
			});
			// An active connector needs a linked oauth connection + activated_at.
			const oauth = await seedGithubOAuth(['repo']);
			await markConnectorActive(connector.id, oauth.id);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('linear');
	// connectorStatus → 'active' (oauth_connection_id + activated_at) renders the
	// Connected badge + a Disconnect button on the connector row.
	const linearRow = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!linearRow) throw new Error('linear connector row not found');
	expect(linearRow.getAttribute('data-status')).toBe('active');

	const revoke = within(linearRow).getByTestId('connector-revoke');
	revoke.click();

	// Revoke (POST .../revoke → markRevoked) flips the row to revoked; the list
	// re-renders with the revoked status badge.
	await waitFor(() => {
		const row = within(getByTestId('connectors-list'))
			.getAllByTestId('connector-row')
			.find((li) => li.getAttribute('data-connector-id'));
		expect(row?.getAttribute('data-status')).toBe('revoked');
	});
	await findByTestId('connector-connect');
});

test('a local (credential-auth) connector renders Connected, not a Connect button', async () => {
	let slug = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedLocalConnector(ws, { name: 'umami', command: 'umami-mcp' });
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('umami');
	// Local connectors have no OAuth handshake — they're connected as soon as the
	// row exists, so the row shows the Connected badge, not "Pending connect".
	const umamiRow = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!umamiRow) throw new Error('umami connector row not found');
	expect(umamiRow.getAttribute('data-status')).toBe('active');
	// A local connector never offers the (OAuth) Connect button — only Disconnect.
	expect(within(umamiRow).queryByTestId('connector-connect')).toBeNull();
	within(umamiRow).getByTestId('connector-revoke');
	await findByText('Connected');
});

test('GitHub Connect drives the device flow to a connected OAuth connection', async () => {
	// Stand up the GitHub simulator and point the device-flow endpoints at it so
	// the in-process device/start + poll round-trip to a real (local) AS.
	sim = await createGitHubSim();
	savedEnv.GITHUB_OAUTH_BASE_URL = process.env.GITHUB_OAUTH_BASE_URL;
	savedEnv.GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
	savedEnv.GITHUB_API_BASE_URL = process.env.GITHUB_API_BASE_URL;
	process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
	// finalize resolves the GitHub identity + registers the team key against the
	// REST API, which uses GITHUB_API_BASE_URL — the simulator serves both.
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;

	// Approve every device flow the moment the sim issues a code, so the first
	// poll succeeds and the loop returns (no in-flight poll racing teardown).
	const approveNewFlows = () => {
		if (!sim) return;
		for (const flow of sim.state.deviceFlows.values()) {
			if (!flow.approvedToken) flow.approvedToken = sim.state.token;
		}
	};

	const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
	let slug = '';
	const { findByText, findByTestId, getByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('GitHub');
	// The GitHub row's Connect button: ensures the connector, then opens the dialog.
	const githubRow = getByTestId('connectors-list').querySelector(
		'[data-connector-name="github"]',
	) as HTMLElement;
	const connectBtn = within(githubRow).getByTestId('connector-connect');
	connectBtn.click();

	// The device-flow dialog mounts (in a portal on document.body) and renders the
	// user code returned by the simulator.
	const dialog = await findByTestId('connector-device-flow-dialog');
	expect(dialog).toBeTruthy();
	const code = await findByTestId('connector-device-code');
	expect(code.textContent).toMatch(/^USR-/);
	// The verification URI was opened in a new tab.
	await waitFor(() => expect(openSpy).toHaveBeenCalled());

	// Approve the flow; the next poll finalizes the connection and the dialog
	// closes itself. Waiting for that close guarantees the polling loop has
	// returned before afterEach tears the simulator down.
	approveNewFlows();
	await waitFor(() => expect(queryByTestId('connector-device-flow-dialog')).toBeNull(), {
		timeout: 15_000,
	});

	// The finalized connection now shows in the GitHub row as connected.
	await findByText(/Connected as/);
}, 30_000);
