import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

test('agent settings page shows system prompt textarea, edits persist, revisions panel lists history', async () => {
	let ws!: SeededWorkspace;
	let engineerId = '';
	const { findByLabelText, findByRole, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer');
			if (!engineer) throw new Error('engineer missing from seeded workspace');
			engineerId = engineer.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: ws.internalSlug, agentId: engineerId },
	});

	const promptTextarea = (await findByLabelText('System Prompt', undefined, {
		timeout: 15_000,
	})) as HTMLTextAreaElement;
	const original = promptTextarea.value;
	// The editor holds the stored role body; the identity line is composed at
	// resolve time and shows in Preview, not here.
	expect(original).toContain('# Engineer');

	const updated = `${original}\n- New rule added by e2e test`;
	fireEvent.change(promptTextarea, { target: { value: updated } });

	const form = promptTextarea.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	const { apiBase, token } = getTestContext();
	await waitFor(
		async () => {
			const res = await apiBase(
				`/api/projects/${ws.internalSlug}/agents/${engineerId}/system-prompt`,
				{
					headers: { Authorization: `Bearer ${token}` },
				},
			);
			const body = (await res.json()) as { data: { content: string } };
			expect(body.data.content).toContain('New rule added by e2e test');
		},
		{ timeout: 15_000 },
	);

	// Toggle revision history visibility
	const showBtn = await findByRole('button', { name: /Show revision history/i });
	fireEvent.click(showBtn);
	await findByText(/Rev \d+/, undefined, { timeout: 15_000 });
});

test('agent settings preview tab resolves placeholders and edit tab keeps the raw template', async () => {
	let ws!: SeededWorkspace;
	let engineerId = '';
	const { findByLabelText, findByRole, findByTestId, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer');
			if (!engineer) throw new Error('engineer missing from seeded workspace');
			engineerId = engineer.id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: ws.internalSlug, agentId: engineerId },
	});

	const editTextarea = (await findByLabelText('System Prompt', undefined, {
		timeout: 15_000,
	})) as HTMLTextAreaElement;
	const raw = editTextarea.value;
	expect(raw.length).toBeGreaterThan(0);

	const previewTab = await findByRole('tab', { name: 'Preview' });
	fireEvent.click(previewTab);

	const preview = await findByTestId('system-prompt-preview');
	await waitFor(
		() => {
			expect(preview.textContent ?? '').not.toContain('{{');
			expect(preview.textContent ?? '').toContain('Working Guidelines');
		},
		{ timeout: 15_000 },
	);
	expect(preview.textContent ?? '').not.toContain('Run Context');

	const editTab = await findByRole('tab', { name: 'Edit' });
	fireEvent.click(editTab);

	const editAfter = (await findByLabelText('System Prompt')) as HTMLTextAreaElement;
	expect(editAfter.value).toBe(raw);
});
