import { createTestProject } from '@hezo/server/test/helpers/app';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface CreatedTeam {
	id: string;
	slug: string;
	name: string;
	/**
	 * The team's single project slug — under the 1:1 teams↔projects model a team
	 * has no per-team "internal" project, so team-settings/agents pages resolve
	 * through the team's own project.
	 */
	projectSlug: string;
}

async function createTeam(): Promise<CreatedTeam> {
	const { apiBase, token, db } = getTestContext();
	const name = `Settings Corp ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const res = await apiBase('/api/teams', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name,
			description: 'Build great things',
			template_id: await startupTemplateId(),
		}),
	});
	const data = (await res.json()) as { data: Omit<CreatedTeam, 'projectSlug'> };
	const projectRes = await createTestProject(db, data.data.id, { name: 'Work Project' });
	const projectSlug = (await projectRes.json()).data.slug;
	return { ...data.data, projectSlug };
}

async function startupTemplateId(): Promise<string> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/team-templates', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const startup = ((await res.json()) as { data: Array<{ id: string; name: string }> }).data.find(
		(t) => t.name === 'Startup',
	);
	if (!startup) throw new Error('createTeam: Startup template missing');
	return startup.id;
}

test('general section displays team info', async () => {
	let team!: CreatedTeam;
	const { container, findByRole, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const general = await waitFor(
		() => {
			const el = container.querySelector('#settings-general') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);
	await within(general).findByRole('heading', { name: 'General' });
	await within(general).findByText(team.name);
	await within(general).findByText('Build great things');
});

test('automations section exposes the wake-mentioner toggle and persists the change', async () => {
	let team!: CreatedTeam;
	const { container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const automations = await waitFor(
		() => {
			const el = container.querySelector('#settings-automations') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);

	await within(automations).findByRole('heading', { name: 'Automations' });

	const toggle = within(automations).getByRole('checkbox', {
		name: /wake mentioner on reply/i,
	}) as HTMLInputElement;
	// Wait for the team data to load before interacting — the checkbox is
	// disabled until then and the optimistic update needs a populated cache.
	await waitFor(() => expect(toggle.disabled).toBe(false), { timeout: 15_000 });
	expect(toggle.checked).toBe(true);

	fireEvent.click(toggle);
	await waitFor(() => expect(toggle.checked).toBe(false), { timeout: 15_000 });

	const { apiBase, token } = getTestContext();
	await waitFor(
		async () => {
			const res = await apiBase(`/api/projects/${team.projectSlug}/team`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const body = (await res.json()) as { data: { settings: Record<string, unknown> } };
			expect(body.data.settings.wake_mentioner_on_reply).toBe(false);
		},
		{ timeout: 15_000 },
	);

	fireEvent.click(toggle);
	await waitFor(() => expect(toggle.checked).toBe(true), { timeout: 15_000 });
});

test('can add and delete a secret', async () => {
	let team!: CreatedTeam;
	const { container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const secrets = await waitFor(
		() => {
			const el = container.querySelector('#settings-secrets') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);

	await within(secrets).findByText('Secrets vault');

	const addToggle = within(secrets).getByRole('button', { name: 'Add' });
	await user.click(addToggle);

	const nameInput = within(secrets).getByPlaceholderText(/^Name/) as HTMLInputElement;
	const valueInput = within(secrets).getByPlaceholderText('Value') as HTMLInputElement;
	const hostsInput = within(secrets).getByPlaceholderText(/Allowed hosts/) as HTMLInputElement;
	fireEvent.change(nameInput, { target: { value: 'MY_SECRET' } });
	fireEvent.change(valueInput, { target: { value: 'supersecret' } });
	fireEvent.change(hostsInput, { target: { value: 'example.com' } });

	const form = nameInput.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await within(secrets).findByText('MY_SECRET', undefined, { timeout: 15_000 });

	// The trash button is the only <button> with a child <svg> in each secret row
	// at this point. Pick the last svg-button inside the secrets section.
	const svgButtons = secrets.querySelectorAll('button');
	const trashBtn = Array.from(svgButtons).find((b) => b.querySelector('svg.lucide-trash-2'));
	expect(trashBtn).toBeTruthy();
	fireEvent.click(trashBtn!);

	await within(secrets).findByText('No secrets stored.', undefined, { timeout: 15_000 });
});

test('can create and delete an api key', async () => {
	let team!: CreatedTeam;
	const { container, user, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const apiKeys = await waitFor(
		() => {
			const el = container.querySelector('#settings-api-keys') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);

	await within(apiKeys).findByRole('heading', { name: 'API keys' });

	await user.click(within(apiKeys).getByRole('button', { name: 'Create' }));

	const nameInput = within(apiKeys).getByPlaceholderText('Key name') as HTMLInputElement;
	fireEvent.change(nameInput, { target: { value: 'Test Key' } });

	const form = nameInput.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await findByText("New API key created — copy it now, it won't be shown again:", undefined, {
		timeout: 15_000,
	});

	const code = container.querySelector('code');
	expect(code?.textContent ?? '').toMatch(/hezo_/);

	await user.click(within(apiKeys).getByRole('button', { name: 'Dismiss' }));
	await within(apiKeys).findByText('Test Key', undefined, { timeout: 15_000 });

	const trashBtn = Array.from(apiKeys.querySelectorAll('button')).find((b) =>
		b.querySelector('svg.lucide-trash-2'),
	);
	expect(trashBtn).toBeTruthy();
	fireEvent.click(trashBtn!);

	await within(apiKeys).findByText('No API keys.', undefined, { timeout: 15_000 });
});

test('can edit and save preferences', async () => {
	let team!: CreatedTeam;
	const { container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const prefs = await waitFor(
		() => {
			const el = container.querySelector('#settings-preferences') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);

	await within(prefs).findByRole('heading', { name: 'Preferences' });
	await within(prefs).findByText('No preferences set.');

	await user.click(within(prefs).getByRole('button', { name: 'Edit' }));
	const textarea = prefs.querySelector('textarea') as HTMLTextAreaElement;
	fireEvent.change(textarea, { target: { value: 'Always be concise.' } });

	await user.click(within(prefs).getByRole('button', { name: 'Save' }));

	await within(prefs).findByRole('button', { name: 'Edit' });
	await within(prefs).findByText('Always be concise.', undefined, { timeout: 15_000 });

	// Reload by re-navigating away and back.
	await router.navigate({ to: '/' });
	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});
	await waitFor(
		() => {
			const el = container.querySelector('#settings-preferences') as HTMLElement;
			expect(el?.textContent ?? '').toContain('Always be concise.');
		},
		{ timeout: 20_000 },
	);
});

test('can restore a previous preferences revision', async () => {
	let team!: CreatedTeam;
	const { container, user, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			team = await createTeam();
			const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
			await apiBase(`/api/projects/${team.projectSlug}/preferences`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify({ content: 'Original preferences body' }),
			});
			await apiBase(`/api/projects/${team.projectSlug}/preferences`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify({
					content: 'Updated preferences body',
					change_summary: 'second pass',
				}),
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const prefs = await waitFor(
		() => {
			const el = container.querySelector('#settings-preferences') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);

	await within(prefs).findByText('Updated preferences body', undefined, { timeout: 15_000 });

	await user.click(within(prefs).getByRole('button', { name: /show revision history/i }));
	await within(prefs).findByText(/Rev 1/, undefined, { timeout: 15_000 });

	const restoreButtons = within(prefs).getAllByRole('button', { name: /restore/i });
	fireEvent.click(restoreButtons[0]);

	const confirmBtn = await findByTestId('confirm-dialog-confirm');
	fireEvent.click(confirmBtn);

	await within(prefs).findByText('Original preferences body', undefined, { timeout: 30_000 });
});

test('can add and delete an mcp server', async () => {
	let team!: CreatedTeam;
	const { container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: team.projectSlug },
	});

	const mcp = await waitFor(
		() => {
			const el = container.querySelector('#settings-mcp') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);

	await within(mcp).findByRole('heading', { name: 'MCP servers' });
	await within(mcp).findByText('No MCP servers configured.');

	await user.click(within(mcp).getByRole('button', { name: 'Add MCP Server' }));

	const nameInput = within(mcp).getByPlaceholderText('Server name (e.g. exa)') as HTMLInputElement;
	const urlInput = within(mcp).getByPlaceholderText(/^URL/) as HTMLInputElement;
	fireEvent.change(nameInput, { target: { value: 'Test MCP' } });
	fireEvent.change(urlInput, { target: { value: 'http://localhost:9999/mcp' } });

	const addBtn = within(mcp).getByRole('button', { name: 'Add' });
	const form = addBtn.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await within(mcp).findByText('Test MCP', undefined, { timeout: 30_000 });
	await within(mcp).findByText(/localhost:9999/, undefined, { timeout: 30_000 });

	const trashBtn = Array.from(mcp.querySelectorAll('button')).find((b) =>
		b.querySelector('svg.lucide-trash-2'),
	);
	expect(trashBtn).toBeTruthy();
	fireEvent.click(trashBtn!);

	await within(mcp).findByText('No MCP servers configured.', undefined, { timeout: 30_000 });
});
