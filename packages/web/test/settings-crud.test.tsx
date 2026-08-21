import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
import { INJECTED_TEXT_CAPS } from '@hezo/shared';
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

/*
 * The ceiling is enforced on the server; these prove the editor tells you about it
 * *before* you spend an edit on it, and that its Save gate reads the same rule.
 * The one worth pinning is the third: an over-ceiling value must stay saveable
 * downwards, so the gate has to compare against the stored length, not just the
 * limit - a gate that only asked "does it fit" would freeze the page.
 */
async function openCustomPrompt(team: CreatedTeam) {
	const app = await renderApp({ initialPath: '/' });
	await app.router.navigate({
		to: '/projects/$projectId/custom-prompt',
		params: { projectId: team.projectSlug },
	});
	await app.findByRole('heading', { name: 'Custom Prompt' });
	const textarea = await waitFor(
		() => {
			const el = app.container.querySelector('textarea') as HTMLTextAreaElement | null;
			expect(el).toBeTruthy();
			return el as HTMLTextAreaElement;
		},
		{ timeout: 15_000 },
	);
	return { ...app, textarea };
}

const PREFS_LIMIT = INJECTED_TEXT_CAPS.team_preferences;

test('the Custom Prompt editor shows its size against the ceiling', async () => {
	const { findByTestId } = await openCustomPrompt(await createTeam());
	const counter = await findByTestId('injected-cap-counter');
	expect(counter.textContent).toContain(PREFS_LIMIT.toLocaleString());
});

test('going past the ceiling blocks Save and names the overage', async () => {
	const team = await createTeam();
	const { textarea, findByTestId, findByRole } = await openCustomPrompt(team);

	fireEvent.change(textarea, { target: { value: 'x'.repeat(PREFS_LIMIT + 25) } });
	expect((await findByTestId('injected-cap-message')).textContent).toContain('25');
	expect((await findByRole('button', { name: 'Save changes' })).hasAttribute('disabled')).toBe(
		true,
	);

	// Back under, and Save is live again.
	fireEvent.change(textarea, { target: { value: 'x'.repeat(PREFS_LIMIT) } });
	await waitFor(async () => {
		expect((await findByRole('button', { name: 'Save changes' })).hasAttribute('disabled')).toBe(
			false,
		);
	});
});

test('a Custom Prompt already over the ceiling can still be edited downwards', async () => {
	const team = await createTeam();
	// Written straight to the document, the way provisioning does - the API would
	// refuse this, which is exactly the state the page has to stay usable in.
	const { db } = getTestContext();
	const stored = 'y'.repeat(PREFS_LIMIT + 500);
	await db.query(
		`INSERT INTO documents (team_id, type, slug, title, content)
		 VALUES ($1, 'team_preferences', 'preferences', 'Custom Prompt', $2)`,
		[team.id, stored],
	);

	const { textarea, findByTestId, findByRole } = await openCustomPrompt(team);
	await waitFor(() => expect(textarea.value.length).toBe(stored.length), { timeout: 15_000 });

	// Shorter, still over: allowed, and the page says why it is allowed.
	fireEvent.change(textarea, { target: { value: 'y'.repeat(PREFS_LIMIT + 100) } });
	expect((await findByTestId('injected-cap-message')).textContent).toMatch(/already over/i);
	await waitFor(async () => {
		expect((await findByRole('button', { name: 'Save changes' })).hasAttribute('disabled')).toBe(
			false,
		);
	});

	// Longer than it is now: refused, so the ceiling still bounds growth.
	fireEvent.change(textarea, { target: { value: 'y'.repeat(PREFS_LIMIT + 900) } });
	await waitFor(async () => {
		expect((await findByRole('button', { name: 'Save changes' })).hasAttribute('disabled')).toBe(
			true,
		);
	});
});
