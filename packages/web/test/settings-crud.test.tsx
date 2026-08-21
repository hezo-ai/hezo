import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
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
	const { db } = getTestContext();
	const name = `Settings Corp ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const res = await createTestTeam(db, {
		name,
		description: 'Build great things',
		template_id: await startupTemplateId(),
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
		(t) => t.name === 'App Team',
	);
	if (!startup) throw new Error('createTeam: App Team template missing');
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

	// The Budget section says how token costs are priced. No longer a
	// conservative-estimate disclosure: cache traffic has its own rates now, so
	// the figure is the figure.
	await findByText(/cache reads and writes at their own rates/);
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

test('can edit and save the Custom Prompt', async () => {
	let team!: CreatedTeam;
	const { container, user, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			team = await createTeam();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/custom-prompt',
		params: { projectId: team.projectSlug },
	});

	await findByRole('heading', { name: 'Custom Prompt' });
	const textarea = await waitFor(
		() => {
			const el = container.querySelector('textarea') as HTMLTextAreaElement | null;
			expect(el).toBeTruthy();
			return el as HTMLTextAreaElement;
		},
		{ timeout: 15_000 },
	);

	fireEvent.change(textarea, { target: { value: 'Always be concise.' } });
	await user.click(await findByRole('button', { name: 'Save changes' }));

	// Persisted — re-navigate away and back; the editor reseeds from the saved value.
	await router.navigate({ to: '/' });
	await router.navigate({
		to: '/projects/$projectId/custom-prompt',
		params: { projectId: team.projectSlug },
	});
	await waitFor(
		() => {
			const el = container.querySelector('textarea') as HTMLTextAreaElement | null;
			expect(el?.value ?? '').toContain('Always be concise.');
		},
		{ timeout: 20_000 },
	);
});

test('can restore a previous Custom Prompt revision', async () => {
	let team!: CreatedTeam;
	const { container, user, findByTestId, findByText, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			team = await createTeam();
			const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
			await apiBase(`/api/projects/${team.projectSlug}/custom-prompt`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify({ content: 'Original preferences body' }),
			});
			await apiBase(`/api/projects/${team.projectSlug}/custom-prompt`, {
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
		to: '/projects/$projectId/custom-prompt',
		params: { projectId: team.projectSlug },
	});

	await waitFor(
		() => {
			const el = container.querySelector('textarea') as HTMLTextAreaElement | null;
			expect(el?.value ?? '').toContain('Updated preferences body');
		},
		{ timeout: 15_000 },
	);

	// The dialog is a Radix portal, so its contents live on document.body.
	const body = within(document.body);

	await user.click(await findByRole('button', { name: /revision history/i }));
	await findByTestId('revision-history-dialog');
	await findByText(/Rev 1/, undefined, { timeout: 15_000 });

	// Preview the older version read-only before restoring it: the editor is
	// replaced by the revision body, so nothing can save the old text back.
	fireEvent.click(body.getAllByTestId('revision-view')[0]);
	await findByTestId('viewing-revision-banner');
	const revisionBody = await findByTestId('custom-prompt-revision-body');
	expect(revisionBody.textContent).toContain('Original preferences body');
	expect(container.querySelector('textarea')).toBeNull();

	fireEvent.click(await findByTestId('view-latest'));
	await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull(), {
		timeout: 15_000,
	});

	await user.click(await findByRole('button', { name: /revision history/i }));
	fireEvent.click(body.getAllByTestId('revision-restore')[0]);

	const confirmBtn = await findByTestId('confirm-dialog-confirm');
	fireEvent.click(confirmBtn);

	await waitFor(
		() => {
			const el = container.querySelector('textarea') as HTMLTextAreaElement | null;
			expect(el?.value ?? '').toContain('Original preferences body');
		},
		{ timeout: 30_000 },
	);
});
