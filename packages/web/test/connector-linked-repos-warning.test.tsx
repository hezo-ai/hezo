import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

/**
 * Removing a connector leaves git working and strips the MCP tools agents were
 * using, with nothing in a run log recording it. The confirmation has to name
 * the repos before the click, or the operator learns about it from an agent's
 * wrong guess - which is exactly how this landed.
 */

const CONNECTORS_ROUTE = '/projects/$projectId/connectors';

/**
 * A hosted connector on `ws`, optionally carrying an OAuth connection that also
 * authenticates a linked repo. The connector goes in through the real route so
 * the row renders like production; the OAuth link and the repo are seeded
 * directly, since connecting one needs a live provider.
 */
async function seedConnectorWithRepo(
	ws: SeededWorkspace,
	name: string,
	opts: { withRepo: boolean; activated: boolean },
): Promise<void> {
	const { apiBase, db } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/connectors`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({
			name,
			kind: 'saas',
			config: { url: 'https://api.githubcopilot.example/mcp' },
		}),
	});
	if (res.status !== 201) throw new Error(`connector seed failed: ${res.status}`);
	const connectorId = ((await res.json()).data as { id: string }).id;

	const suffix = Math.random().toString(36).slice(2, 8);
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, 'enc', 'api_token', ARRAY['api.github.com']) RETURNING id`,
		[`OAUTH_GITHUB_${suffix.toUpperCase()}`],
	);
	const project = await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
		ws.internalSlug,
	]);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		     (provider, provider_account_id, provider_account_label, access_token_secret_id, project_id)
		 VALUES ('github', $1, 'octocat', $2, $3) RETURNING id`,
		[`acct-${suffix}`, secret.rows[0].id, project.rows[0].id],
	);
	// Which destructive control the row offers follows `connectorStatus`: active or
	// degraded shows Disconnect (which deletes the connection and breaks git),
	// anything else shows Remove (which does not). Both need the warning, and they
	// need different warnings. The create route probes the server, and the harness
	// reroutes `/mcp` into the in-process app, so an unprobed row also has to have
	// that evidence cleared or it comes back active.
	await db.query(
		`UPDATE mcp_connections
		 SET oauth_connection_id = $1,
		     activated_at = CASE WHEN $3 THEN now() ELSE NULL END,
		     probed_at = CASE WHEN $3 THEN probed_at ELSE NULL END,
		     probe_error = NULL
		 WHERE id = $2`,
		[conn.rows[0].id, connectorId, opts.activated],
	);
	if (opts.withRepo) {
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type, oauth_connection_id)
			 VALUES ($1, 'hezo-ai/website', 'github', $2)`,
			[project.rows[0].id, conn.rows[0].id],
		);
	}
}

async function openDialog(
	name: string,
	opts: { withRepo: boolean; activated: boolean; control: 'connector-remove' | 'connector-revoke' },
) {
	let slug = '';
	const rendered = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			await seedConnectorWithRepo(ws, name, opts);
		},
	});
	await rendered.router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await rendered.findByText(name);
	const row = within(rendered.getByTestId('connectors-list'))
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id'));
	if (!row) throw new Error('connector row not found');
	within(row).getByTestId(opts.control).click();
	// Radix portals the dialog onto document.body, so wait on the screen.
	await screen.findByTestId('confirm-dialog');
	return rendered;
}

test('Remove names the repo and says git survives', async () => {
	await openDialog('github-linked', {
		withRepo: true,
		activated: false,
		control: 'connector-remove',
	});

	const warning = await screen.findByTestId('linked-repos-warning');
	expect(warning.textContent).toContain('hezo-ai/website');
	// Removing the connector row leaves `repos.oauth_connection_id` alone, so git
	// is unaffected and only the agent tools go. Saying otherwise would be the
	// same conflation the old copy made.
	expect(warning.textContent).toContain('Git keeps working');
});

test('Disconnect names the repo and says git stops authenticating', async () => {
	await openDialog('github-connected', {
		withRepo: true,
		activated: true,
		control: 'connector-revoke',
	});

	const warning = await screen.findByTestId('linked-repos-warning');
	expect(warning.textContent).toContain('hezo-ai/website');
	// Revoke deletes the OAuth connection itself, which nulls the repos' own
	// reference - a strictly worse consequence than Remove.
	expect(warning.textContent).toContain('anonymous access');
});

test('no repo warning appears for a connector that backs nothing', async () => {
	await openDialog('github-bare', {
		withRepo: false,
		activated: false,
		control: 'connector-remove',
	});

	// The dialog is open (awaited above), so this absence is meaningful.
	await waitFor(() => {
		expect(screen.queryByTestId('linked-repos-warning')).toBeNull();
	});
});
