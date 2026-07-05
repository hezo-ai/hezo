import { waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';

async function seedInstanceConnector(
	ctx: { token: string; apiBase: (p: string, i?: RequestInit) => Promise<Response> },
	body: Record<string, unknown>,
) {
	const res = await ctx.apiBase('/api/mcp-connections', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed connector failed: ${res.status}`);
}

test('lists seeded instance connectors and creates a new one via the form', async () => {
	// The create flow now auto-probes the new connector for OAuth; stub that
	// call so this test doesn't reach for the (nonexistent) example host.
	const intercept = interceptAuthStart({ auth_url: null, reason: 'no PRM' });
	try {
		const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
			initialPath: '/settings/connectors',
			seed: async (ctx) => {
				await seedInstanceConnector(ctx, {
					name: 'seeded-docs',
					display_name: 'Seeded Docs',
					kind: 'saas',
					config: { url: 'https://mcp.seeded.example/mcp' },
				});
			},
		});

		await findByText('Connectors', { selector: 'h1' });
		await findByText('Seeded Docs');

		await user.click(getByRole('button', { name: 'Add' }));
		await user.type(getByPlaceholderText('Name (e.g. shared-docs)'), 'new-conn');
		await user.type(getByPlaceholderText(/MCP server URL/), 'https://mcp.new.example/mcp');
		await user.click(getByRole('button', { name: 'Add connector' }));

		await findByText('new-conn');
	} finally {
		intercept.restore();
	}
});

test('the blurb is a single sentence and the add form is a dismissible standout panel', async () => {
	const {
		findByText,
		getByRole,
		getByTestId,
		queryByTestId,
		queryByText,
		queryByPlaceholderText,
		user,
	} = await renderApp({ initialPath: '/settings/connectors' });

	await findByText('Connectors', { selector: 'h1' });
	// The blurb is just the first sentence; the OAuth/placeholder detail moved
	// into the info tooltip (unmounted until hover).
	await findByText("Remote (SaaS) MCP servers shared with every team's agent runs.");
	expect(queryByText(/Servers that advertise OAuth/)).toBeNull();

	// The form opens inside the titled panel, without a display-name field —
	// the connector name doubles as its display label.
	await user.click(getByRole('button', { name: 'Add' }));
	const panel = getByTestId('in-place-form');
	expect(panel.textContent).toContain('Add connector');
	expect(queryByPlaceholderText('Display name (optional)')).toBeNull();

	// The top-right close button hides the form.
	await user.click(getByTestId('in-place-form-close'));
	expect(queryByTestId('in-place-form')).toBeNull();
});

/**
 * Intercept the admin auth-start REST call with a canned response. A live fake
 * MCP server is unreliable under this harness — the patched fetch routes by
 * pathname and `/mcp` collides with the in-process Hezo app — so the web tier
 * asserts the UI wiring and the server suite (instance-connectors.test.ts)
 * covers real discovery/DCR.
 */
function interceptAuthStart(body: { auth_url: string | null; reason?: string }): {
	calls: () => number;
	restore: () => void;
} {
	const patched = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const urlStr =
			input instanceof Request ? input.url : typeof input === 'string' ? input : input.toString();
		const path = new URL(urlStr, 'http://localhost').pathname;
		if (/^\/api\/mcp-connections\/[^/]+\/auth-start$/.test(path)) {
			calls += 1;
			return new Response(JSON.stringify({ data: body }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return patched(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
	return {
		calls: () => calls,
		restore: () => {
			globalThis.fetch = patched;
		},
	};
}

test('adding a connector that advertises OAuth opens the authorize popup', async () => {
	const authUrl = 'https://as.example/authorize?client_id=abc&state=xyz';
	const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);
	const intercept = interceptAuthStart({ auth_url: authUrl });
	try {
		const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
			initialPath: '/settings/connectors',
		});
		await findByText('Connectors', { selector: 'h1' });

		await user.click(getByRole('button', { name: 'Add' }));
		await user.type(getByPlaceholderText('Name (e.g. shared-docs)'), 'oauth-conn');
		await user.type(getByPlaceholderText(/MCP server URL/), 'https://mcp.oauth.example/mcp');
		await user.click(getByRole('button', { name: 'Add connector' }));

		await findByText('oauth-conn');
		await waitFor(() => {
			expect(openSpy).toHaveBeenCalledWith(authUrl, 'hezo-connect', 'width=600,height=720');
		});
	} finally {
		intercept.restore();
		openSpy.mockRestore();
	}
});

test('adding a connector without OAuth opens no popup and shows no error', async () => {
	const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);
	const intercept = interceptAuthStart({ auth_url: null, reason: 'no PRM' });
	try {
		const { findByText, getByRole, getByPlaceholderText, queryByText, user } = await renderApp({
			initialPath: '/settings/connectors',
		});
		await findByText('Connectors', { selector: 'h1' });

		await user.click(getByRole('button', { name: 'Add' }));
		await user.type(getByPlaceholderText('Name (e.g. shared-docs)'), 'plain-conn');
		await user.type(getByPlaceholderText(/MCP server URL/), 'https://mcp.plain.example/mcp');
		await user.click(getByRole('button', { name: 'Add connector' }));

		await findByText('plain-conn');
		await waitFor(() => expect(intercept.calls()).toBe(1));
		expect(openSpy).not.toHaveBeenCalled();
		expect(queryByText(/Pop-up blocked/)).toBeNull();
		expect(queryByText(/Failed to start OAuth/)).toBeNull();
	} finally {
		intercept.restore();
		openSpy.mockRestore();
	}
});

test('rows surface Connected / Failed states and a Connect button', async () => {
	const { findByText, findByRole, getByRole } = await renderApp({
		initialPath: '/settings/connectors',
		seed: async (ctx) => {
			for (const name of ['active-conn', 'failed-conn', 'plain-conn']) {
				await seedInstanceConnector(ctx, {
					name,
					kind: 'saas',
					config: { url: `https://${name}.example/mcp` },
				});
			}
			// active-conn completed OAuth: vault-backed oauth_connections row +
			// activated_at. failed-conn recorded a failed attempt.
			const secret = await ctx.db.query<{ id: string }>(
				`INSERT INTO secrets (name, encrypted_value) VALUES ('T_ACTIVE', 'enc') RETURNING id`,
			);
			const oc = await ctx.db.query<{ id: string }>(
				`INSERT INTO oauth_connections
				 (provider, provider_account_id, provider_account_label, access_token_secret_id)
				 VALUES ('mcp:test', 'acct', 'Test', $1) RETURNING id`,
				[secret.rows[0].id],
			);
			await ctx.db.query(
				`UPDATE mcp_connections SET oauth_connection_id = $1, activated_at = now()
				 WHERE name = 'active-conn'`,
				[oc.rows[0].id],
			);
			await ctx.db.query(
				`UPDATE mcp_connections SET auth_error = 'discovery: boom' WHERE name = 'failed-conn'`,
			);
		},
	});

	await findByText('Connected');
	await findByText('Failed');
	await findByText('discovery: boom');
	// The failed row offers a retry; the never-attempted row a plain Connect;
	// the active row offers neither.
	await findByRole('button', { name: 'Retry' });
	await findByRole('button', { name: 'Connect' });
	const activeRow = document.querySelector('[data-status="active"]');
	expect(activeRow).toBeTruthy();
	expect(activeRow!.querySelector('[data-testid="instance-connector-connect"]')).toBeNull();
	// Sanity: the page-level Add button still renders alongside row buttons.
	getByRole('button', { name: 'Add' });
});

test('refetches the list when the OAuth popup reports success', async () => {
	const { findByText, queryByText, ctx } = await renderApp({
		initialPath: '/settings/connectors',
		seed: async (c) => {
			await seedInstanceConnector(c, {
				name: 'msg-conn',
				kind: 'saas',
				config: { url: 'https://msg.example/mcp' },
			});
		},
	});
	await findByText('msg-conn');
	expect(queryByText('Connected')).toBeNull();

	// The popup completed the flow server-side (simulated directly in the DB)…
	const secret = await ctx.db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value) VALUES ('T_MSG', 'enc') RETURNING id`,
	);
	const oc = await ctx.db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		 (provider, provider_account_id, provider_account_label, access_token_secret_id)
		 VALUES ('mcp:msg', 'acct', 'Msg', $1) RETURNING id`,
		[secret.rows[0].id],
	);
	await ctx.db.query(
		`UPDATE mcp_connections SET oauth_connection_id = $1, activated_at = now()
		 WHERE name = 'msg-conn'`,
		[oc.rows[0].id],
	);

	// …and posts hezo-oauth-success to the opener, which refetches the list.
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'hezo-oauth-success' } }));
	await findByText('Connected');
});

test('?focus=<id> highlights the connector row and scrolls it into view', async () => {
	// happy-dom's scrollIntoView is a no-op with no layout, so assert the wiring:
	// the focused row is the element the scroll fires on.
	const scrolled: Element[] = [];
	const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
		this: Element,
	) {
		scrolled.push(this);
	});
	try {
		const { findByText, ctx, router } = await renderApp({
			initialPath: '/settings/connectors',
			seed: async (c) => {
				await seedInstanceConnector(c, {
					name: 'other-conn',
					kind: 'saas',
					config: { url: 'https://other.example/mcp' },
				});
				await seedInstanceConnector(c, {
					name: 'focus-conn',
					kind: 'saas',
					config: { url: 'https://focus.example/mcp' },
				});
			},
		});
		await findByText('focus-conn');
		const r = await ctx.db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'focus-conn'`,
		);
		const focusId = r.rows[0].id;

		// The connect_required comment card links here with ?focus=<connector_id>.
		await router.navigate({ to: '/settings/connectors', search: { focus: focusId } });

		await waitFor(() => {
			const row = document.querySelector(`[data-connector-id="${focusId}"]`);
			expect(row).toBeTruthy();
			expect(row?.className).toContain('border-info');
		});
		expect(scrolled.some((el) => el.getAttribute('data-connector-id') === focusId)).toBe(true);
		// The sibling row is not highlighted.
		const other = Array.from(
			document.querySelectorAll('[data-testid="instance-connector-row"]'),
		).find((el) => el.getAttribute('data-connector-id') !== focusId);
		expect(other).toBeTruthy();
		expect(other?.className).not.toContain('border-info');
	} finally {
		spy.mockRestore();
	}
});

test('settings page sidebar links to connectors', async () => {
	const { findByRole, getAllByRole, user, router } = await renderApp({ initialPath: '/settings' });

	await findByRole('heading', { name: 'Settings' });
	const sidebarLink = await waitFor(() => {
		const link = getAllByRole('link', { name: 'Connectors' }).find(
			(l) => l.getAttribute('href') === '/settings/connectors',
		);
		expect(link).toBeTruthy();
		return link as HTMLElement;
	});
	await user.click(sidebarLink);

	expect(router.state.location.pathname).toBe('/settings/connectors');
	await findByRole('heading', { name: 'Connectors' });
});
