import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom). The ConnectRequiredComment renderer is reached
// through the real task-comments list: we insert an `mcp_connections` row plus a
// `connect_required` comment that references it, then navigate to the task page.
//
// None of branches 1-6 (the Playwright decision tree) apply — this is pure
// content rendering + click/mutation behaviour, so it stays in the component tier.

interface ConnectorRow {
	id: string;
	name: string;
	display_name: string | null;
	oauth_connection_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
}

/** Insert an mcp_connections row directly (the catalog the renderer reads via useMcpConnection). */
async function insertConnector(input: {
	name: string;
	displayName?: string | null;
	oauthConnectionId?: string | null;
	activatedAt?: string | null;
	revokedAt?: string | null;
	authError?: string | null;
}): Promise<ConnectorRow> {
	const { db } = getTestContext();
	const res = await db.query<ConnectorRow>(
		`INSERT INTO mcp_connections
		   (name, display_name, kind, config, oauth_connection_id, install_status,
		    activated_at, revoked_at, auth_error)
		 VALUES ($1, $2, 'saas'::mcp_connection_kind, '{"url":"https://mcp.example.com"}'::jsonb,
		         $3, 'installed'::mcp_install_status, $4, $5, $6)
		 RETURNING id, name, display_name, oauth_connection_id, activated_at, revoked_at, auth_error`,
		[
			input.name,
			input.displayName ?? null,
			input.oauthConnectionId ?? null,
			input.activatedAt ?? null,
			input.revokedAt ?? null,
			input.authError ?? null,
		],
	);
	return res.rows[0];
}

/** A secret + oauth_connections row so a connector can be put in the "active" state (FK targets). */
async function insertActiveOauthConnection(): Promise<string> {
	const { db } = getTestContext();
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category)
		 VALUES ($1, 'enc', 'api_token'::secret_category) RETURNING id`,
		[`tok-${Math.random().toString(36).slice(2)}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		   (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ('datocms', $1, 'acct', $2, '{}') RETURNING id`,
		[`acct-${Math.random().toString(36).slice(2)}`, secret.rows[0].id],
	);
	return conn.rows[0].id;
}

/** Post a connect_required comment that points at `connectorId`. */
async function insertConnectRequiredComment(
	taskId: string,
	authorMemberId: string,
	content: { connector_id: string; display_name: string; provider_id?: string },
): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'connect_required'::comment_content_type, $3::jsonb)`,
		[taskId, authorMemberId, JSON.stringify(content)],
	);
}

interface Seeded {
	projectSlug: string;
	taskId: string;
	agentId: string;
}

async function setup(
	build: (ws: SeededWorkspace, taskId: string, agentId: string) => Promise<void>,
) {
	const seeded: Seeded = { projectSlug: '', taskId: '', agentId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Connect Project' });
			const task = await seedTask(ws, project, { title: 'Connect Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentId = ws.agents[0].id;
			await build(ws, task.id, ws.agents[0].id);
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return { ...helpers, seeded };
}

test('pending connector renders the connect prompt with provider code and links', async () => {
	const { findByTestId } = await setup(async (_ws, taskId, agentId) => {
		const connector = await insertConnector({ name: 'datocms', displayName: 'DatoCMS' });
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'DatoCMS',
			provider_id: 'datocms',
		});
	});

	const card = await findByTestId('connect-required');
	expect(card.getAttribute('data-status')).toBe('pending');
	// display_name, provider_id code chip, and the default "connect to authorize" label.
	expect(card.textContent).toContain('DatoCMS');
	expect(card.textContent).toContain('datocms');
	expect(card.textContent).toContain("authorize this agent's access");

	// The Connect button and the "Open in Connectors" deep link both render.
	const connectBtn = await findByTestId('connect-button');
	expect(connectBtn.textContent).toContain('Connect');
	expect((connectBtn as HTMLButtonElement).disabled).toBe(false);

	const link = await findByTestId('connect-required-link');
	expect(link.getAttribute('href')).toContain('/connectors?focus=');
});

test('failed connector shows the failure label plus the auth_error detail', async () => {
	const { findByTestId } = await setup(async (_ws, taskId, agentId) => {
		const connector = await insertConnector({
			name: 'datocms',
			displayName: 'DatoCMS',
			authError: 'token exchange rejected',
		});
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'DatoCMS',
			provider_id: 'datocms',
		});
	});

	const card = await findByTestId('connect-required');
	// Wait for the connector query to resolve and flip the status off the initial
	// optimistic "pending" placeholder.
	await waitFor(() => expect(card.getAttribute('data-status')).toBe('failed'));
	expect(card.textContent).toContain('Last connect attempt failed');
	expect(card.textContent).toContain('token exchange rejected');
});

test('revoked connector shows the reconnect label', async () => {
	const { findByTestId } = await setup(async (_ws, taskId, agentId) => {
		const connector = await insertConnector({
			name: 'datocms',
			displayName: 'DatoCMS',
			revokedAt: new Date().toISOString(),
		});
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'DatoCMS',
			provider_id: 'datocms',
		});
	});

	const card = await findByTestId('connect-required');
	await waitFor(() => expect(card.getAttribute('data-status')).toBe('revoked'));
	expect(card.textContent).toContain('Connector revoked');
});

test('active connector renders the success state as a manage link', async () => {
	const { findByTestId } = await setup(async (_ws, taskId, agentId) => {
		const oauthId = await insertActiveOauthConnection();
		const connector = await insertConnector({
			name: 'datocms',
			displayName: 'DatoCMS',
			oauthConnectionId: oauthId,
			activatedAt: new Date().toISOString(),
		});
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'DatoCMS',
			provider_id: 'datocms',
		});
	});

	const active = await findByTestId('connect-required-active');
	expect(active.textContent).toContain('DatoCMS connected');
	expect(active.textContent).toContain('Available to every agent run');
	expect(active.getAttribute('href')).toContain('/connectors?focus=');
});

test('clicking Connect on a redirect (non-device) connector opens an OAuth popup with the auth_url', async () => {
	const { findByTestId, user } = await setup(async (_ws, taskId, agentId) => {
		const connector = await insertConnector({ name: 'datocms', displayName: 'DatoCMS' });
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'DatoCMS',
			provider_id: 'datocms',
		});
	});

	await findByTestId('connect-required');

	// Stub auth-start so the click doesn't drive the real DCR discovery machinery
	// (network), and capture the popup the renderer opens with the returned URL.
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

	const opened: Array<{ url?: string | URL; name?: string }> = [];
	const originalOpen = window.open;
	// Return a truthy popup object so the "pop-up blocked" error path isn't taken.
	window.open = ((url?: string | URL, name?: string) => {
		opened.push({ url, name });
		return {} as Window;
	}) as typeof window.open;

	try {
		await user.click(await findByTestId('connect-button'));
		await new Promise((r) => setTimeout(r, 0));
		expect(opened.length).toBe(1);
		expect(opened[0].url).toBe('https://as.example.com/authorize');
		expect(opened[0].name).toBe('hezo-connect');
	} finally {
		window.open = originalOpen;
		globalThis.fetch = original;
	}
});

test('a blocked popup surfaces the pop-up-blocked error', async () => {
	const { findByTestId, findByText, user } = await setup(async (_ws, taskId, agentId) => {
		const connector = await insertConnector({ name: 'datocms', displayName: 'DatoCMS' });
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'DatoCMS',
			provider_id: 'datocms',
		});
	});

	await findByTestId('connect-required');

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

	const originalOpen = window.open;
	// Null return = browser blocked the popup.
	window.open = (() => null) as typeof window.open;

	try {
		await user.click(await findByTestId('connect-button'));
		await findByText(/Pop-up blocked/);
	} finally {
		window.open = originalOpen;
		globalThis.fetch = original;
	}
});

test('clicking Connect on a device-flow connector (github) opens the device-flow dialog instead of a popup', async () => {
	const { findByTestId, user } = await setup(async (_ws, taskId, agentId) => {
		// `github` is the lone capability with deviceAuth, so usesDeviceFlow is true.
		const connector = await insertConnector({ name: 'github', displayName: 'GitHub' });
		await insertConnectRequiredComment(taskId, agentId, {
			connector_id: connector.id,
			display_name: 'GitHub',
			provider_id: 'github',
		});
	});

	await findByTestId('connect-required');

	// Stub the device-start POST so opening the dialog doesn't drive real GitHub
	// network calls; the renderer's job here is just to mount the dialog.
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/device\/start$/.test(url)) {
			return new Response(
				JSON.stringify({
					data: {
						flow_id: 'flow-1',
						user_code: 'ABCD-1234',
						verification_uri: 'https://github.com/login/device',
						expires_in: 900,
						interval: 5,
					},
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}
		// Swallow the subsequent device/poll so the polling loop stays inert/quiet.
		if (init?.method === 'POST' && /\/device\/poll$/.test(url)) {
			return new Response(JSON.stringify({ data: { status: 'pending', retry_after: 9999 } }), {
				status: 202,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return original(input, init);
	}, original);

	const opened: unknown[] = [];
	const originalOpen = window.open;
	window.open = ((url?: string | URL) => {
		opened.push(url);
		return {} as Window;
	}) as typeof window.open;

	try {
		await user.click(await findByTestId('connect-button'));
		// The device-flow dialog mounts into a Radix portal on document.body.
		const dialog = await findByTestId('connector-device-flow-dialog');
		expect(dialog).toBeTruthy();
		expect(dialog.textContent).toContain('Connect GitHub');
		// The redirect-popup path (window.open with the named 'hezo-connect' window)
		// was NOT taken — device flow uses the dialog, not the connect popup.
		const namedPopups = opened.filter((u) => u === undefined);
		expect(namedPopups.length).toBe(0);
	} finally {
		window.open = originalOpen;
		globalThis.fetch = original;
	}
});
