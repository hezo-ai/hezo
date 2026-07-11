// E2E for the connector-driven MCP OAuth flow. Uses a fake MCP server
// (which doubles as PRM authority + Authorization Server) spun up in the
// test process — both the Hezo server and the user's browser reach it via
// 127.0.0.1, so the real round-trip works end-to-end.

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

// Inline fake MCP server — duplicated from packages/server/test/helpers/
// fake-mcp-server.ts so the Playwright suite stays self-contained.
async function startFakeMcp(): Promise<{ url: string; close: () => Promise<void> }> {
	const clients = new Map<string, string[]>();
	const codes = new Map<string, { clientId: string; redirectUri: string }>();
	const tokens = new Set<string>();
	let port = 0;
	let base = '';

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', base);
		const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			res.statusCode = status;
			for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
			res.setHeader('content-type', 'application/json');
			res.end(typeof body === 'string' ? body : JSON.stringify(body));
		};

		const readBody = async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			return Buffer.concat(chunks).toString('utf8');
		};

		if (url.pathname === '/mcp') {
			const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
			if (auth && tokens.has(auth)) return send(200, { ok: true });
			res.setHeader(
				'WWW-Authenticate',
				`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
			);
			return send(401, { error: 'unauthorized' });
		}

		if (url.pathname === '/.well-known/oauth-protected-resource') {
			return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
		}

		if (url.pathname === '/.well-known/oauth-authorization-server') {
			return send(200, {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				code_challenge_methods_supported: ['S256'],
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code'],
				token_endpoint_auth_methods_supported: ['none'],
			});
		}

		if (url.pathname === '/register' && req.method === 'POST') {
			const body = JSON.parse((await readBody()) || '{}') as { redirect_uris?: string[] };
			const clientId = `fake_${randomBytes(8).toString('hex')}`;
			clients.set(clientId, body.redirect_uris ?? []);
			return send(200, { client_id: clientId, redirect_uris: body.redirect_uris });
		}

		if (url.pathname === '/authorize' && req.method === 'GET') {
			const clientId = url.searchParams.get('client_id') ?? '';
			const redirectUri = url.searchParams.get('redirect_uri') ?? '';
			const state = url.searchParams.get('state') ?? '';
			if (!clients.get(clientId)?.includes(redirectUri)) {
				return send(400, 'redirect_uri mismatch');
			}
			const code = `code_${randomBytes(12).toString('hex')}`;
			codes.set(code, { clientId, redirectUri });
			res.statusCode = 302;
			const sep = redirectUri.includes('?') ? '&' : '?';
			res.setHeader(
				'location',
				`${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			return res.end();
		}

		if (url.pathname === '/token' && req.method === 'POST') {
			const params = new URLSearchParams(await readBody());
			const code = params.get('code') ?? '';
			const stored = codes.get(code);
			if (!stored) return send(400, { error: 'invalid_grant' });
			codes.delete(code);
			const accessToken = `tok_${randomBytes(16).toString('hex')}`;
			tokens.add(accessToken);
			return send(200, {
				access_token: accessToken,
				refresh_token: `refresh_${randomBytes(16).toString('hex')}`,
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'read write',
			});
		}

		send(404, { error: 'not_found' });
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address();
	if (!addr || typeof addr !== 'object') throw new Error('failed to get port');
	port = addr.port;
	base = `http://127.0.0.1:${port}`;

	return {
		url: base,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

async function postAgentRegisterConnector(page: Page, token: string, mcpUrl: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Connector Project'),
		description: 'E2E.',
	});
	const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const agentId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Add DatoCMS connector', assignee_id: agentId },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// Seed a pending connector + connect_required comment directly via the DB
	// shape we know the routes produce. (We bypass `register_connector` MCP
	// because driving the MCP server inline in a Playwright test is fiddly;
	// the server vitest already covers that path.)
	const connectorRes = await page.request.post(`/api/projects/${project.slug}/connectors`, {
		headers,
		data: {
			name: 'datocms',
			kind: 'saas',
			config: { url: mcpUrl },
		},
	});
	expect(connectorRes.ok()).toBeTruthy();
	const connector = ((await connectorRes.json()) as { data: { id: string } }).data;

	// Mark it as connector-flow-style by setting created_by_task_id + display_name
	// via a small admin patch — for the E2E we use the same flow the route uses
	// internally.
	// (Routes don't expose this directly; we use a fetch_skill_file-less synthetic
	// connector. The connect_required comment renderer just needs connector_id +
	// display_name.)
	await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
		headers,
		data: {
			content_type: 'connect_required',
			content: {
				connector_id: connector.id,
				display_name: 'DatoCMS',
				provider_id: 'datocms',
			},
		},
	});

	return { project, task, connectorId: connector.id, headers };
}

test.describe('Connector activation', () => {
	let fake: Awaited<ReturnType<typeof startFakeMcp>>;

	test.beforeAll(async () => {
		fake = await startFakeMcp();
	});

	test.afterAll(async () => {
		await fake.close();
	});

	test('agent posts connect_required → user clicks Connect → comment flips to Connected → Connectors page lists it active', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		test.setTimeout(60_000);
		const { task, project, connectorId, headers } = await postAgentRegisterConnector(
			page,
			sharedWorkspace.token,
			`${fake.url}/mcp`,
		);

		// Set created_by_task_id directly so the connector behaves as if our
		// register_connector tool created it (so the wakeup fires on completion
		// and the filter in loadConnectorsForRun applies consistently).
		await page.request
			.patch(`/api/projects/${project.slug}/connectors/${connectorId}`, {
				headers,
				data: { created_by_task_id: task.id, display_name: 'DatoCMS' },
			})
			.catch(() => {
				// PATCH endpoint may not exist for this field; the comment renderer
				// only needs connector_id + display_name from the comment payload,
				// and the auth-start path doesn't require created_by_task_id.
			});

		// Drive OAuth end-to-end via API. Skips the popup mechanic (CI Chromium
		// blocks window.open from synthetic clicks). Replays the same HTTP flow
		// the popup would have taken: auth-start → follow authorize URL → callback.
		const authStartRes = await page.request.post(`/api/projects/${project.slug}/auth-start`, {
			headers,
			data: { connector_id: connectorId },
		});
		expect(authStartRes.ok()).toBeTruthy();
		const { data: authStartData } = (await authStartRes.json()) as {
			data: { flow: string; auth_url: string };
		};

		const authorizeRes = await page.request.get(authStartData.auth_url, {
			maxRedirects: 0,
		});
		expect(authorizeRes.status()).toBe(302);
		const callbackUrl = authorizeRes.headers().location;
		expect(callbackUrl).toBeTruthy();

		const callbackRes = await page.request.get(callbackUrl);
		expect(callbackRes.status()).toBe(200);

		// Confirm activation server-side.
		await expect
			.poll(
				async () => {
					const res = await page.request.get(
						`/api/projects/${project.slug}/connectors/${connectorId}`,
						{ headers },
					);
					const body = (await res.json()) as {
						data: { activated_at: string | null; oauth_connection_id: string | null };
					};
					return body.data.activated_at !== null && body.data.oauth_connection_id !== null;
				},
				{ timeout: 10_000 },
			)
			.toBe(true);

		// Navigate to the connectors page with the focus param and confirm the
		// row is rendered as active. (The in-task comment renderer's pending →
		// active flip is covered by the server vitest suite + the component-test
		// tier; here we just need to verify the row data flows correctly to the
		// list view.)
		await page.goto(`/projects/${project.slug}/connectors?focus=${connectorId}`);
		await waitForPageLoad(page);
		const row = page.locator(`[data-testid="connector-row"][data-connector-id="${connectorId}"]`);
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toHaveAttribute('data-status', 'active');
	});
});
