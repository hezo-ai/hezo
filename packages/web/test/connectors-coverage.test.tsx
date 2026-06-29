import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

const CONNECTORS_ROUTE = '/projects/$projectId/connectors';

async function seedSaasConnector(
	ws: SeededWorkspace,
	input: { name: string; url: string },
): Promise<{ id: string; name: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/mcp-connections`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ name: input.name, kind: 'saas', config: { url: input.url } }),
	});
	if (res.status !== 201) throw new Error(`seedSaasConnector failed: ${res.status}`);
	return (await res.json()).data;
}

function connectorRowById(container: HTMLElement, id: string): HTMLElement {
	const row = within(container)
		.getAllByTestId('connector-row')
		.find((li) => li.getAttribute('data-connector-id') === id);
	if (!row) throw new Error(`connector row ${id} not found`);
	return row;
}

// Branch: connector.skill_id set → "Skill file imported" line renders.
test('a connector with an imported skill file renders the skill line', async () => {
	let slug = '';
	let connectorId = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const conn = await seedSaasConnector(ws, {
				name: 'skilled',
				url: 'https://mcp.skilled.example/mcp',
			});
			connectorId = conn.id;
			const { db } = getTestContext();
			// Attach a skill file id so the skill_id branch renders.
			const skill = await db.query<{ id: string }>(
				`INSERT INTO skills (slug, name, content)
				 VALUES ('skilled-skill', 'Skilled', 'body')
				 RETURNING id`,
			);
			await db.query(`UPDATE mcp_connections SET skill_id = $1 WHERE id = $2`, [
				skill.rows[0].id,
				connectorId,
			]);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('skilled');
	await findByText('Skill file imported');
});

// Branch: connector.auth_error set AND status !== 'active' → the auth-error line
// renders, and a 'failed' status shows the "Retry" button label.
test('a failed connector renders its auth error and a Retry button', async () => {
	let slug = '';
	let connectorId = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const conn = await seedSaasConnector(ws, {
				name: 'broken',
				url: 'https://mcp.broken.example/mcp',
			});
			connectorId = conn.id;
			const { db } = getTestContext();
			// status === 'failed' when auth_error is set and activated_at is null.
			await db.query(
				`UPDATE mcp_connections SET auth_error = 'token exchange failed' WHERE id = $1`,
				[connectorId],
			);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('broken');
	const row = connectorRowById(getByTestId('connectors-list'), connectorId);
	expect(row.getAttribute('data-status')).toBe('failed');
	// auth_error line + Failed badge.
	within(row).getByText('token exchange failed');
	within(row).getByText('Failed');
	// status === 'failed' → button label is "Retry".
	const connect = within(row).getByTestId('connector-connect');
	expect(connect.textContent).toContain('Retry');
});

// Branch: connector.created_by_task_id set → the "Requested by an agent" footer
// with a View task link renders.
test('a connector requested by an agent renders the task footer link', async () => {
	let slug = '';
	let connectorId = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const conn = await seedSaasConnector(ws, {
				name: 'requested',
				url: 'https://mcp.requested.example/mcp',
			});
			connectorId = conn.id;
			// Create a real task and link it so the footer's typed Link resolves.
			const taskRes = await getTestContext().apiBase(`/api/projects/${slug}/tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Connector request', assignee_id: ws.agents[0].id }),
			});
			const task = (await taskRes.json()).data as { id: string };
			await getTestContext().db.query(
				`UPDATE mcp_connections SET created_by_task_id = $1 WHERE id = $2`,
				[task.id, connectorId],
			);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('requested');
	const row = connectorRowById(getByTestId('connectors-list'), connectorId);
	within(row).getByText(/Requested by an agent/);
	const link = within(row).getByText('View task') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toContain('/tasks/');
});

// Branch: a connector whose config has no url string → the url line is omitted
// (the url === null branch).
test('a connector with no config url omits the url line', async () => {
	let slug = '';
	let connectorId = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
			const conn = await seedSaasConnector(ws, {
				name: 'nourl',
				url: 'https://mcp.nourl.example/mcp',
			});
			connectorId = conn.id;
			// Blank the config so the url-extraction branch returns null.
			await getTestContext().db.query(
				`UPDATE mcp_connections SET config = '{}'::jsonb WHERE id = $1`,
				[connectorId],
			);
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('nourl');
	const row = connectorRowById(getByTestId('connectors-list'), connectorId);
	// No monospace url paragraph in this row.
	expect(within(row).queryByText(/mcp\.nourl\.example/)).toBeNull();
});

// Branch: GitHub row Connect failure (ensure.mutateAsync rejects) surfaces the
// inline error from the startConnect catch. Force the failure by deleting the
// only AI provider so the ensure precondition route 4xxs — instead drive it via
// a connector-name that ensureConnector rejects.
test('GitHub Connect error surfaces an inline message', async () => {
	let slug = '';
	const { findByText, getByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			slug = ws.internalSlug;
		},
	});
	await router.navigate({ to: CONNECTORS_ROUTE, params: { projectId: slug } });

	await findByText('GitHub');
	// Stub fetch so the ensure-connector POST fails; the row's catch sets `error`.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
		if (url.includes('/connectors/ensure') || url.includes('/mcp-connections/ensure')) {
			return new Response(JSON.stringify({ error: 'ensure failed' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return realFetch(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	try {
		const githubRow = getByTestId('connectors-list').querySelector(
			'[data-connector-name="github"]',
		) as HTMLElement;
		const connectBtn = within(githubRow).getByTestId('connector-connect');
		connectBtn.click();
		await findByText(/ensure failed|Failed to start GitHub OAuth/);
	} finally {
		globalThis.fetch = realFetch;
	}
});
