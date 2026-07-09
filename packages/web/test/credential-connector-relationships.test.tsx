import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// Insert a global credential straight into the vault (value never decrypted by
// the list views under test).
async function seedSecret(name: string): Promise<string> {
	const { db } = getTestContext();
	const r = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, 'enc', 'api_token', ARRAY['mcp.rel.example']) RETURNING id`,
		[name],
	);
	return r.rows[0].id;
}

// Insert a project-scoped connector whose api_key_secret_id points at `secretId`.
async function seedProjectConnectorUsing(
	secretId: string,
): Promise<{ connectorId: string; projectSlug: string }> {
	const { db } = getTestContext();
	const suffix = Math.random().toString(36).slice(2, 8);
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
		[`Rel ${suffix}`, `rel-${suffix}`],
	);
	const proj = await db.query<{ id: string; slug: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image, container_status)
		 VALUES ($1, $2, $3, 'RP', 'hezo/agent-base:latest', NULL) RETURNING id, slug`,
		[team.rows[0].id, `Rel Proj ${suffix}`, `rel-proj-${suffix}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, display_name, kind, config, install_status, project_id, api_key_secret_id, activated_at)
		 VALUES ($1, 'Rel Connector', 'saas', '{"url":"https://mcp.rel.example/mcp"}'::jsonb, 'installed', $2, $3, now())
		 RETURNING id`,
		[`rel-conn-${suffix}`, proj.rows[0].id, secretId],
	);
	return { connectorId: conn.rows[0].id, projectSlug: proj.rows[0].slug };
}

test('credentials page lists the connectors using a credential and deep-links to them', async () => {
	let connectorId = '';
	const { findByText, findByTestId } = await renderApp({
		initialPath: '/settings/credentials',
		seed: async () => {
			const secretId = await seedSecret('MCP_LINKED_ABCDE');
			({ connectorId } = await seedProjectConnectorUsing(secretId));
		},
	});

	await findByText('MCP_LINKED_ABCDE');
	const link = (await findByTestId(
		`credential-connector-link-${connectorId}`,
	)) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/settings/connectors?focus=${connectorId}#${connectorId}`,
	);
});

test('a credential in use cannot be revoked; a free one revokes via the confirm dialog', async () => {
	let inUseId = '';
	let freeId = '';
	const { findByText, getByTestId, queryByText, user } = await renderApp({
		initialPath: '/settings/credentials',
		seed: async () => {
			inUseId = await seedSecret('MCP_INUSE_KEY');
			await seedProjectConnectorUsing(inUseId);
			freeId = await seedSecret('MCP_FREE_KEY');
		},
	});

	await findByText('MCP_INUSE_KEY');
	await findByText('MCP_FREE_KEY');

	// In use → the revoke control is disabled (the tooltip explains why).
	const disabled = getByTestId(`credential-revoke-${inUseId}`) as HTMLButtonElement;
	expect(disabled.disabled).toBe(true);

	// Free → revoke opens the shared confirm dialog; confirming deletes the row.
	const enabled = getByTestId(`credential-revoke-${freeId}`) as HTMLButtonElement;
	expect(enabled.disabled).toBe(false);
	await user.click(enabled);
	// The dialog renders into a Radix portal on document.body — query via screen.
	await screen.findByTestId('confirm-dialog');
	await user.click(screen.getByTestId('confirm-dialog-confirm'));
	await waitFor(() => expect(queryByText('MCP_FREE_KEY')).toBeNull());
});

test('instance connectors page lists the credential a connector uses and links to it', async () => {
	let secretId = '';
	const { findByTestId } = await renderApp({
		initialPath: '/settings/connectors',
		seed: async () => {
			secretId = await seedSecret('MCP_CONNCRED_ABCDE');
			await seedProjectConnectorUsing(secretId);
		},
	});

	const link = (await findByTestId(`connector-credential-link-${secretId}`)) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(`/settings/credentials?focus=${secretId}#${secretId}`);
});

test('project connectors page links a connector to the credential it uses', async () => {
	let slug = '';
	let secretId = '';
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const created = await ctx.apiBase(`/api/projects/${ws.internalSlug}/mcp-connections`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					name: 'projcred',
					kind: 'saas',
					config: { url: 'https://mcp.p.example/mcp' },
				}),
			});
			const conn = (await created.json()).data as { id: string };
			const keyed = await ctx.apiBase(
				`/api/projects/${ws.internalSlug}/mcp-connections/${conn.id}/api-key`,
				{ method: 'POST', headers: ws.headers, body: JSON.stringify({ value: 'k' }) },
			);
			secretId = (await keyed.json()).data.api_key_secret_id as string;
		},
	});

	await router.navigate({ to: '/projects/$projectId/connectors', params: { projectId: slug } });
	await findByText('projcred');
	const link = (await findByTestId(`connector-credential-link-${secretId}`)) as HTMLAnchorElement;
	// The admin (superuser) sees a link to the global credentials page.
	expect(link.getAttribute('href')).toBe(`/settings/credentials?focus=${secretId}#${secretId}`);
});
