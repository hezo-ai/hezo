import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// Component tier (happy-dom). Drives AutomationsSection's sub-task page-size
// input on the real team-settings/general page. Covers commitPageSize's
// validation branches: an out-of-range high value clamps to 500 and persists,
// an invalid (<1 / non-numeric) value reverts to the saved value without a
// write, and a valid mid-range value persists. The wake-on-reply toggle is
// already covered by settings-crud.test.tsx.

async function startupTemplateId(): Promise<string> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/team-templates', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const startup = ((await res.json()) as { data: Array<{ id: string; name: string }> }).data.find(
		(t) => t.name === 'Startup',
	);
	if (!startup) throw new Error('startup template missing');
	return startup.id;
}

async function createTeamProject(): Promise<string> {
	const { db } = getTestContext();
	const teamRes = await createTestTeam(db, {
		name: `Auto Corp ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		template_id: await startupTemplateId(),
	});
	const team = (await teamRes.json()).data;
	const projectRes = await createTestProject(db, team.id, { name: 'Work' });
	return (await projectRes.json()).data.slug;
}

async function openAutomations() {
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ref.slug = await createTeamProject();
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/team-settings/general',
		params: { projectId: ref.slug },
	});
	const automations = await waitFor(
		() => {
			const el = helpers.container.querySelector('#settings-automations') as HTMLElement;
			expect(el).toBeTruthy();
			return el;
		},
		{ timeout: 15_000 },
	);
	const input = (await within(automations).findByTestId('subtask-page-size-input', undefined, {
		timeout: 15_000,
	})) as HTMLInputElement;
	// Wait for the team to load so the input is enabled.
	await waitFor(() => expect(input.disabled).toBe(false), { timeout: 15_000 });
	return { ...helpers, ref, input };
}

async function readPageSize(slug: string): Promise<number | undefined> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase(`/api/projects/${slug}/team`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = (await res.json()) as { data: { settings: { subtask_page_size?: number } } };
	return body.data.settings.subtask_page_size;
}

test('clamps an over-max page size to 500 and persists it', async () => {
	const { input, ref } = await openAutomations();

	fireEvent.change(input, { target: { value: '9000' } });
	fireEvent.blur(input);

	// Input is rewritten to the clamped value.
	await waitFor(() => expect(input.value).toBe('500'), { timeout: 15_000 });
	await waitFor(async () => expect(await readPageSize(ref.slug)).toBe(500), { timeout: 15_000 });
});

test('reverts an invalid (<1) page size to the saved value without writing', async () => {
	const { input, ref } = await openAutomations();
	const original = input.value;

	fireEvent.change(input, { target: { value: '0' } });
	fireEvent.blur(input);

	// Falls back to the saved value, no persistence.
	await waitFor(() => expect(input.value).toBe(original), { timeout: 15_000 });
	expect(await readPageSize(ref.slug)).toBeUndefined();
});

test('reverts a non-numeric page size to the saved value', async () => {
	const { input } = await openAutomations();
	const original = input.value;

	fireEvent.change(input, { target: { value: 'abc' } });
	fireEvent.blur(input);

	await waitFor(() => expect(input.value).toBe(original), { timeout: 15_000 });
});

test('persists a valid in-range page size', async () => {
	const { input, ref } = await openAutomations();

	fireEvent.change(input, { target: { value: '25' } });
	fireEvent.blur(input);

	await waitFor(() => expect(input.value).toBe('25'), { timeout: 15_000 });
	await waitFor(async () => expect(await readPageSize(ref.slug)).toBe(25), { timeout: 15_000 });
});
