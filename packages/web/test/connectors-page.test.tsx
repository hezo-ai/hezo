import { createGitHubSim, type GitHubSim } from '@hezo/server/test/helpers/github-sim';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

// Seed a global (instance-wide) saas MCP connector via the project-scoped route.
// `config.dcr` is pre-baked so the redirect "Connect" path can build an authorize
// URL entirely in-process (no PRM discovery / DCR network call).
/**
 * Seed a hosted (saas) MCP connector.
 *
 * The create route probes the server and records what came back, and the
 * harness reroutes any `/mcp` path into the in-process Hono app, so an
 * `https://…/mcp` seed URL would answer the probe and land the row `active`.
 * Pass `probed: true` for a connector these specs mean to be reachable;
 * otherwise the evidence is cleared, leaving the freshly-registered state the
 * spec is describing.
 */
async function seedSaasConnector(
	ws: SeededWorkspace,
	input: { name: string; url: string; withDcr?: boolean; probed?: boolean },
): Promise<{ id: string; name: string }> {
	const { apiBase, db } = getTestContext();
	const config: Record<string, unknown> = { url: input.url };
	if (input.withDcr) {
		config.dcr = {
			client_id: 'dcr-client-id',
			authorization_server_url: 'https://as.example',
			authorization_endpoint: 'https://as.example/authorize',
			token_endpoint: 'https://as.example/token',
			scopes_supported: ['read', 'write'],
			// Must match the callback origin the in-process backend resolves
			// (`${requestOrigin(c)}/api/oauth/mcp-callback`, host `localhost`), so
			// auth-start reuses this cached registration instead of re-running live
			// PRM discovery / DCR for a changed origin.
			redirect_uri: 'http://localhost/api/oauth/mcp-callback',
		};
	}
	const res = await apiBase(`/api/projects/${ws.internalSlug}/connectors`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ name: input.name, kind: 'saas', config }),
	});
	if (res.status !== 201) throw new Error(`seedSaasConnector failed: ${res.status}`);
	const row = (await res.json()).data as { id: string; name: string };
	if (!input.probed) {
		await db.query(
			`UPDATE mcp_connections SET probed_at = NULL, probe_error = NULL WHERE id = $1`,
			[row.id],
		);
	}
	return row;
}

// Seed a local (stdio) MCP connector — e.g. a self-hosted umami server that logs
// in with a username/password credential placeholder rather than OAuth. Local
// connectors carry a `config.command`, never a url, and never an oauth handshake.
async function seedLocalConnector(
	ws: SeededWorkspace,
	input: { name: string; command: string },
): Promise<{ id: string; name: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/connectors`, {
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

// Seed a REST-API connector (kind `api`) via the project-scoped route — a
// direct REST API with no MCP server, the transport the generic OAuth broker
// attaches its managed token to.
async function seedApiConnector(
	ws: SeededWorkspace,
	input: {
		name: string;
		baseUrl: string;
		hosts: string[];
		oauthProviderId?: string;
		auth?: { placement: 'header' | 'query'; name: string; scheme?: string };
	},
): Promise<{ id: string; name: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/connectors`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({
			name: input.name,
			kind: 'api',
			config: {
				base_url: input.baseUrl,
				allowed_hosts: input.hosts,
				auth: input.auth ?? { placement: 'header', name: 'Authorization', scheme: 'Bearer ' },
				...(input.oauthProviderId ? { oauth_provider_id: input.oauthProviderId } : {}),
			},
		}),
	});
	if (res.status !== 201) throw new Error(`seedApiConnector failed: ${res.status}`);
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

// Seed a genuinely global connector (project_id NULL) straight into the DB so
// the project page renders it read-only (managed on the global settings page).
async function seedGlobalConnector(name: string, url: string): Promise<{ id: string }> {
	const { db } = getTestContext();
	const r = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
		 VALUES ($1, 'saas', $2::jsonb, 'installed', NULL)
		 RETURNING id`,
		[name, JSON.stringify({ url })],
	);
	return r.rows[0];
}

// Clear `touches_code` across the whole roster, turning the seeded App Team into
// a team that does no git work (the shape of the shipped investment/influencer
// marketplace teams, whose rosters are entirely non-code).
async function clearTouchesCode(ws: SeededWorkspace): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE member_agents SET touches_code = false
		   WHERE id IN (SELECT id FROM members WHERE team_id = $1)`,
		[ws.team.id],
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

test('lists a seeded MCP connector above the GitHub row on a code-touching team', async () => {
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
	await findByText('GitHub');
	// The seeded saas connector renders as its own row with its url.
	await findByText('linear');
	await findByText('https://mcp.linear.example/mcp');

	// The App Team roster has `touches_code` agents, so GitHub is a real setup
	// step: pending-connect affordance, and first in the list.
	const list = getByTestId('connectors-list');
	await waitFor(() => {
		expect(
			list.querySelector('[data-connector-name="github"][data-status="pending"]'),
		).toBeTruthy();
	});
	expect(list.firstElementChild?.getAttribute('data-connector-name')).toBe('github');
});

test('demotes GitHub to an optional row when no agent on the team touches code', async () => {
	let slug = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await clearTouchesCode(ws);
			await seedSaasConnector(ws, { name: 'linear', url: 'https://mcp.linear.example/mcp' });
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('Connectors', { selector: 'h1' });
	await findByText('linear');

	// Still offered - just not as an unfinished setup step: neutral "Optional"
	// badge instead of the amber "Pending connect", and last in the list.
	const list = getByTestId('connectors-list');
	await waitFor(() => {
		expect(
			list.querySelector('[data-connector-name="github"][data-status="optional"]'),
		).toBeTruthy();
	});
	expect(list.querySelector('[data-connector-name="github"][data-status="pending"]')).toBeNull();
	const githubRow = list.lastElementChild as HTMLElement;
	expect(githubRow.getAttribute('data-connector-name')).toBe('github');
	await findByText('Optional');
	await findByText(/No agents on this team touch code/);
	// The connect affordance is still there — demoted, not hidden.
	expect(within(githubRow).getByTestId('connector-connect')).toBeTruthy();
});

test('promotes GitHub back to the top once an agent is flagged as touching code', async () => {
	let ws!: SeededWorkspace;
	let engineerId = '';
	const { findByRole, findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer');
			if (!engineer) throw new Error('engineer missing from seeded workspace');
			engineerId = engineer.id;
			await clearTouchesCode(ws);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: ws.internalSlug } });
	await waitFor(() => {
		expect(
			getByTestId('connectors-list').querySelector(
				'[data-connector-name="github"][data-status="optional"]',
			),
		).toBeTruthy();
	});

	// Turn "Touches code" back on from the agent's own settings page. Saving must
	// refresh the project payload the Connectors page reads, not leave the stale
	// `code_agent_count` in the query cache for its full staleTime.
	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: ws.internalSlug, agentId: engineerId },
	});
	const checkbox = (await findByRole(
		'checkbox',
		{ name: /Touches code/i },
		{
			timeout: 15_000,
		},
	)) as HTMLInputElement;
	expect(checkbox.checked).toBe(false);
	fireEvent.click(checkbox);
	fireEvent.submit(checkbox.closest('form') as HTMLFormElement);

	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: ws.internalSlug } });
	await findByText('Connectors', { selector: 'h1' });
	await waitFor(
		() => {
			const list = getByTestId('connectors-list');
			expect(
				list.querySelector('[data-connector-name="github"][data-status="pending"]'),
			).toBeTruthy();
			expect(list.firstElementChild?.getAttribute('data-connector-name')).toBe('github');
		},
		{ timeout: 15_000 },
	);
});

test('the Add form creates a project-scoped connector and auto-probes OAuth', async () => {
	let slug = '';
	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });
	await findByText('Connectors', { selector: 'h1' });

	// Stub the post-create auth-start so submitting doesn't drive the real DCR
	// discovery machinery (network) — return an authorize URL and capture the
	// popup the form opens with it.
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/auth-start$/.test(url)) {
			return new Response(
				JSON.stringify({ data: { auth_url: 'https://as.example.com/authorize' } }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}
		return original(input, init);
	}, original);
	const opened: Array<string | URL | undefined> = [];
	const originalOpen = window.open;
	window.open = ((u?: string | URL) => {
		opened.push(u);
		return {} as Window;
	}) as typeof window.open;

	try {
		// Open the Add form, fill name + URL, submit.
		(await findByTestId('connector-add-toggle')).click();
		await user.type(await findByTestId('connector-add-name'), 'linear');
		await user.type(await findByTestId('connector-add-url'), 'https://mcp.linear.example/mcp');
		(await findByTestId('connector-add-submit')).click();

		// The created connector renders as its own row with its url (create → refetch).
		await findByText('linear');
		await findByText('https://mcp.linear.example/mcp');
		// The auto-probe opened the authorize popup with the returned URL.
		await waitFor(() => expect(opened).toContain('https://as.example.com/authorize'));
	} finally {
		window.open = originalOpen;
		globalThis.fetch = original;
	}
});

test('the Add form creates a REST-API connector (base_url shown, no OAuth Connect, API-key attach)', async () => {
	let slug = '';
	const { findByText, findByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });
	await findByText('Connectors', { selector: 'h1' });

	// Open the Add form and switch to the REST API transport.
	(await findByTestId('connector-add-toggle')).click();
	(await findByTestId('connector-add-type-api')).click();

	await user.type(await findByTestId('connector-add-name'), 'weather');
	await user.type(await findByTestId('connector-add-base-url'), 'https://api.weather.example/v1');
	await user.type(await findByTestId('connector-add-allowed-hosts'), 'api.weather.example');
	// auth name defaults to "Authorization" — leave it. Submit (no OAuth probe for api).
	(await findByTestId('connector-add-submit')).click();

	// The created api connector renders with its base_url (create → refetch).
	await findByText('weather');
	await findByText('https://api.weather.example/v1');

	// An api connector has no OAuth — its row offers the API-key attach only, never
	// the OAuth Connect button.
	const row = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!row) throw new Error('api connector row not found');
	expect(within(row).queryByTestId('connector-connect')).toBeNull();
	// The API-key attach lives in the card's Settings disclosure.
	await user.click(within(row).getByTestId('connector-settings-toggle'));
	within(row).getByTestId('connector-api-key-toggle');
});

test('an api connector offers Connect OAuth, opening the device-flow broker form', async () => {
	let slug = '';
	const { findByText, getByTestId, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedApiConnector(ws, {
				name: 'youtube',
				baseUrl: 'https://www.googleapis.com',
				hosts: ['*.googleapis.com'],
			});
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('youtube');
	const row = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!row) throw new Error('api connector row not found');

	// The api row offers "Complete connection" (distinct from the saas
	// `connector-connect`) alongside API-key attach.
	const broker = within(row).getByTestId('connector-oauth-broker');
	await user.click(broker);

	// It expands the broker form INLINE (no modal). With no agent-preset provider,
	// the manual provider picker (populated from GET /api/connectors/oauth-providers)
	// is shown alongside the client-id / secret fields.
	await findByTestId('connector-complete-inline');
	await findByTestId('broker-form');
	const providerSelect = await findByTestId('broker-provider-select');
	// The bundled google-youtube descriptor is an option.
	await waitFor(() => expect(within(providerSelect).queryByText('google-youtube')).toBeTruthy());
	await findByTestId('broker-client-id');
	await findByTestId('broker-client-secret');
});

test('an api connector with an agent-preset provider locks the picker on the Connectors page', async () => {
	let slug = '';
	const { getByTestId, findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedApiConnector(ws, {
				name: 'youtube',
				baseUrl: 'https://www.googleapis.com',
				hosts: ['*.googleapis.com'],
				oauthProviderId: 'google-youtube',
			});
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('youtube');
	const row = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!row) throw new Error('api connector row not found');

	await user.click(within(row).getByTestId('connector-oauth-broker'));
	await findByTestId('connector-complete-inline');
	await findByTestId('broker-form');
	// Provider is fixed by the agent: the picker is hidden, shown read-only instead.
	const locked = await findByTestId('broker-locked-provider');
	expect(locked.textContent).toContain('google-youtube');
	expect(
		within(getByTestId('connector-complete-inline')).queryByTestId('broker-provider-select'),
	).toBeNull();
	await findByTestId('broker-client-id');
});

test('a static-key api connector (query-param key) leads with the API-key form, no OAuth broker', async () => {
	let slug = '';
	const { findByText, getByTestId, queryByTestId, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedApiConnector(ws, {
				name: 'youtube',
				baseUrl: 'https://www.googleapis.com/youtube/v3',
				hosts: ['*.googleapis.com'],
				auth: { placement: 'query', name: 'key' },
			});
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('youtube');
	const row = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!row) throw new Error('api connector row not found');

	// No "Complete connection" OAuth affordance — this is a plain API key.
	expect(within(row).queryByTestId('connector-oauth-broker')).toBeNull();
	// Opening Settings shows the API-key form already expanded (the primary
	// action for a static-key connector) with its guide.
	await user.click(within(row).getByTestId('connector-settings-toggle'));
	await findByTestId('connector-api-key-form');
	const guide = await findByTestId('connector-api-key-guide');
	expect(guide.textContent).toContain('YouTube Data API key');
	expect(queryByTestId('broker-form')).toBeNull();
});

test('a global connector is read-only on the project page (badge + manage link, no actions)', async () => {
	let slug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedGlobalConnector('shared-global', 'https://global.example/mcp');
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('shared-global');
	const row = (await findByText('shared-global')).closest(
		'[data-testid="connector-row"]',
	) as HTMLElement;
	// A "Global" badge + a link to the global connectors page, and NO mutating actions.
	expect(within(row).getByTestId('connector-global-badge')).toBeTruthy();
	const manage = within(row).getByTestId('connector-global-manage-link');
	expect(manage.getAttribute('href')).toBe('/settings/connectors');
	expect(within(row).queryByTestId('connector-connect')).toBeNull();
	expect(within(row).queryByTestId('connector-revoke')).toBeNull();
	expect(within(row).queryByTestId('connector-api-key-toggle')).toBeNull();
	expect(within(row).queryByTestId('connector-remove')).toBeNull();
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

	// Disconnect opens the shared confirm dialog; confirming calls DELETE
	// /oauth-connections/:id then invalidates the list.
	const disconnect = (await findByTestId('connector-revoke')) as HTMLButtonElement;
	disconnect.click();
	(await screen.findByTestId('confirm-dialog-confirm')).click();

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
	(await screen.findByTestId('confirm-dialog-confirm')).click();

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

test('an active connector still surfaces a recorded auth error', async () => {
	// A token whose refresh keeps failing (the resolver records it on the connector)
	// leaves the row activated but unusable. The error used to be gated on a
	// non-active status, so exactly the case worth seeing was the one hidden.
	let slug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const connector = await seedSaasConnector(ws, {
				name: 'linear',
				url: 'https://mcp.linear.example/mcp',
			});
			const oauth = await seedGithubOAuth(['repo']);
			await markConnectorActive(connector.id, oauth.id);
			const { db } = getTestContext();
			await db.query(`UPDATE mcp_connections SET auth_error = $2 WHERE id = $1`, [
				connector.id,
				'token refresh: generic refresh needs token_url + client_id in connection metadata',
			]);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('linear');
	await findByText(/token refresh: generic refresh needs token_url/);
});

test('a degraded connector flips to Connected when the OAuth popup reports success', async () => {
	// Reconnect opens the authorize popup, so the write that clears `auth_error`
	// happens outside this tab entirely - no mutation here ever settles. Without
	// the postMessage listener the row kept its amber "Needs reconnect" badge
	// until a page reload, which is exactly the moment the operator is watching.
	let slug = '';
	let connectorId = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const connector = await seedSaasConnector(ws, {
				name: 'linear',
				url: 'https://mcp.linear.example/mcp',
			});
			connectorId = connector.id;
			const oauth = await seedGithubOAuth(['repo']);
			await markConnectorActive(connector.id, oauth.id);
			// Activated + auth_error = the `degraded` rung: it worked, its grant died.
			const { db } = getTestContext();
			await db.query(`UPDATE mcp_connections SET auth_error = $2 WHERE id = $1`, [
				connector.id,
				'token refresh: token endpoint error: invalid_grant',
			]);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('linear');
	const degradedRow = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id') === connectorId);
	if (!degradedRow) throw new Error('degraded connector row not found');
	expect(degradedRow.getAttribute('data-status')).toBe('degraded');
	within(degradedRow).getByTestId('connector-reconnect');
	within(degradedRow).getByText(/token refresh: token endpoint error/);

	// The popup completed the re-authorization server-side (simulated directly in
	// the DB, as the callback's markActive does) …
	const { db } = getTestContext();
	await db.query(
		`UPDATE mcp_connections SET auth_error = NULL, activated_at = now() WHERE id = $1`,
		[connectorId],
	);

	// … then posts hezo-oauth-success to its opener, which refetches the list.
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'hezo-oauth-success' } }));

	await waitFor(() => {
		const row = within(getByTestId('connectors-list'))
			.getAllByTestId('connector-row')
			.find((li) => li.getAttribute('data-connector-id') === connectorId);
		expect(row?.getAttribute('data-status')).toBe('active');
	});
	const reconnected = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id') === connectorId);
	if (!reconnected) throw new Error('reconnected connector row not found');
	within(reconnected).getByText('Connected');
	expect(within(reconnected).queryByTestId('connector-reconnect')).toBeNull();
	expect(within(reconnected).queryByText(/token refresh: token endpoint error/)).toBeNull();
});

test('a pending connector offers Remove, which deletes it from the project', async () => {
	let slug = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			// A freshly-created saas connector has no oauth/api-key/activated_at, so
			// connectorStatus → 'pending' ("Pending connect").
			await seedSaasConnector(ws, { name: 'linear', url: 'https://mcp.linear.example/mcp' });
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('linear');
	const row = within(getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!row) throw new Error('pending connector row not found');
	expect(row.getAttribute('data-status')).toBe('pending');

	// Remove opens the shared confirm dialog; confirming calls DELETE
	// /api/projects/:projectId/connectors/:id and drops the row from the list.
	within(row).getByTestId('connector-remove').click();
	(await screen.findByTestId('confirm-dialog-confirm')).click();

	await waitFor(() => {
		const remaining = within(getByTestId('connectors-list'))
			.queryAllByTestId('connector-row')
			.filter((li) => li.getAttribute('data-connector-id'));
		expect(remaining.length).toBe(0);
	});
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

/**
 * Put a connector into the "connected, methods listed" state without a live MCP
 * server: mark it active and write the catalog the discovery probe would have
 * cached.
 */
async function seedListedMethods(
	connectorId: string,
	methods: { name: string; readOnly: boolean; inferred?: boolean; description?: string }[],
	enabled: string[] | null = null,
): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE mcp_connections
		 SET api_key_secret_id = COALESCE(api_key_secret_id, (
		       SELECT id FROM secrets WHERE name = 'TEST_METHODS_KEY'
		     )),
		     activated_at = now(),
		     discovered_methods = $1::jsonb,
		     enabled_methods = $2::jsonb,
		     methods_listed_at = now()
		 WHERE id = $3`,
		[
			JSON.stringify(methods.map((m) => ({ inferred: false, ...m }))),
			enabled === null ? null : JSON.stringify(enabled),
			connectorId,
		],
	);
}

const CATALOG = [
	{ name: 'get_issue', readOnly: true, description: 'Fetch an issue' },
	{ name: 'list_issues', readOnly: true, description: 'List issues' },
	{ name: 'save_issue', readOnly: false, description: 'Create or update an issue' },
	{ name: 'delete_comment', readOnly: false, description: 'Delete a comment' },
];

/** Seed a connected saas connector with a catalog and open its Settings section. */
async function renderWithMethods(enabled: string[] | null = null) {
	let slug = '';
	const app = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const { db } = getTestContext();
			await db.query(
				`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
				 VALUES ('TEST_METHODS_KEY', 'enc', 'api_token'::secret_category, '{mcp.linear.example}')`,
			);
			const connector = await seedSaasConnector(ws, {
				name: 'linear',
				url: 'https://mcp.linear.example/mcp',
			});
			await seedListedMethods(connector.id, CATALOG, enabled);
		},
	});
	await app.router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });
	await app.findByText('linear');
	const row = (await app.findByText('linear')).closest(
		'[data-testid="connector-row"]',
	) as HTMLElement;
	await app.user.click(within(row).getByTestId('connector-settings-toggle'));
	return { ...app, row };
}

test('the Settings section is collapsed by default and holds the credentials', async () => {
	let slug = '';
	const { findByText, getByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedSaasConnector(ws, { name: 'linear', url: 'https://mcp.linear.example/mcp' });
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });
	await findByText('linear');

	// Collapsed: the body is absent and the row recaps what is configured.
	expect(queryByTestId('connector-settings-body')).toBeNull();
	const row = (await findByText('linear')).closest('[data-testid="connector-row"]') as HTMLElement;
	expect(within(row).getByTestId('connector-settings-summary').textContent).toContain(
		'all methods',
	);

	await user.click(within(row).getByTestId('connector-settings-toggle'));
	getByTestId('connector-settings-body');
	within(row).getByTestId('connector-api-key-toggle');
});

test('an unrestricted connector reports every method as enabled', async () => {
	const { row } = await renderWithMethods(null);
	expect(within(row).getByText('All 4')).toBeTruthy();
	expect(within(row).queryByTestId('connector-read-only-badge')).toBeNull();
});

test('a read-only connector shows the restricted counts and badges the card', async () => {
	const { row } = await renderWithMethods(['get_issue', 'list_issues']);
	expect(within(row).getByText('2 of 4')).toBeTruthy();
	expect(within(row).getByText(/2 read-only · 0 write/)).toBeTruthy();
	// Every write method is off, so the card itself says read-only.
	expect(within(row).getByTestId('connector-read-only-badge')).toBeTruthy();
});

test('the methods dialog opens with both categories collapsed and their counts', async () => {
	const { row, user, findByTestId } = await renderWithMethods(null);
	await user.click(within(row).getByTestId('connector-methods-edit'));

	const dialog = await findByTestId('connector-methods-dialog');
	expect(within(dialog).getByTestId('connector-methods-count').textContent).toBe('4 of 4 enabled');
	// Collapsed: the headers carry the counts, no method rows are mounted.
	const read = within(dialog).getByTestId('connector-methods-category-read');
	const write = within(dialog).getByTestId('connector-methods-category-write');
	expect(read.getAttribute('data-enabled-count')).toBe('2');
	expect(write.getAttribute('data-enabled-count')).toBe('2');
	expect(within(read).getByText(/2 of 2/)).toBeTruthy();
	expect(within(dialog).queryByTestId('connector-method-get_issue')).toBeNull();

	await user.click(within(dialog).getByTestId('connector-methods-toggle-read'));
	within(dialog).getByTestId('connector-method-get_issue');
});

test('the Write category checkbox deselects every write method in one click', async () => {
	const { row, user, findByTestId } = await renderWithMethods(null);
	await user.click(within(row).getByTestId('connector-methods-edit'));
	const dialog = await findByTestId('connector-methods-dialog');

	// Works while the category is collapsed — no need to expand and tick rows.
	await user.click(within(dialog).getByTestId('connector-methods-category-checkbox-write'));

	expect(within(dialog).getByTestId('connector-methods-count').textContent).toBe('2 of 4 enabled');
	expect(
		within(dialog)
			.getByTestId('connector-methods-category-write')
			.getAttribute('data-enabled-count'),
	).toBe('0');
	// Read-only is untouched.
	expect(
		within(dialog)
			.getByTestId('connector-methods-category-read')
			.getAttribute('data-enabled-count'),
	).toBe('2');

	await user.click(within(dialog).getByTestId('connector-methods-save'));
	await waitFor(() => expect(within(row).getByText('2 of 4')).toBeTruthy());
});

test('the category checkbox re-selects everything from a mixed state', async () => {
	// Starting with one of two write methods on, one click must select all rather
	// than clear the category — otherwise a partial selection is a trap.
	const { row, user, findByTestId } = await renderWithMethods(['get_issue', 'save_issue']);
	await user.click(within(row).getByTestId('connector-methods-edit'));
	const dialog = await findByTestId('connector-methods-dialog');
	expect(
		within(dialog)
			.getByTestId('connector-methods-category-write')
			.getAttribute('data-enabled-count'),
	).toBe('1');

	await user.click(within(dialog).getByTestId('connector-methods-category-checkbox-write'));
	expect(
		within(dialog)
			.getByTestId('connector-methods-category-write')
			.getAttribute('data-enabled-count'),
	).toBe('2');

	// A second click now clears it.
	await user.click(within(dialog).getByTestId('connector-methods-category-checkbox-write'));
	expect(
		within(dialog)
			.getByTestId('connector-methods-category-write')
			.getAttribute('data-enabled-count'),
	).toBe('0');
});

test('a search term does not narrow what the category checkbox affects', async () => {
	const { row, user, findByTestId } = await renderWithMethods(null);
	await user.click(within(row).getByTestId('connector-methods-edit'));
	const dialog = await findByTestId('connector-methods-dialog');

	await user.type(within(dialog).getByTestId('connector-methods-search'), 'save');
	await user.click(within(dialog).getByTestId('connector-methods-category-checkbox-write'));

	// `delete_comment` is filtered out of view but must still be disabled — a
	// hidden method surviving "deselect all" is exactly the surprise to avoid.
	expect(
		within(dialog)
			.getByTestId('connector-methods-category-write')
			.getAttribute('data-enabled-count'),
	).toBe('0');
});

test('Reset to all clears the restriction', async () => {
	const { row, user, findByTestId } = await renderWithMethods(['get_issue']);
	expect(within(row).getByText('1 of 4')).toBeTruthy();

	await user.click(within(row).getByTestId('connector-methods-edit'));
	const dialog = await findByTestId('connector-methods-dialog');
	await user.click(within(dialog).getByTestId('connector-methods-reset'));

	await waitFor(() => expect(within(row).getByText('All 4')).toBeTruthy());
});
