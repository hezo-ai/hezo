import { fireEvent } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('can hire an agent with minimal fields', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	const role = uniqueName('Data Scientist');
	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await user.type(titleInput, role);
	const form = titleInput.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await findByText(`Onboard new agent: ${role}`, undefined, { timeout: 20_000 });
}, 60_000);

test('template variable chips insert into system prompt', async () => {
	let ws!: SeededWorkspace;
	const { findByRole, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	await user.click(await findByRole('button', { name: '{{team_name}}' }));
	await user.click(await findByRole('button', { name: '{{agent_role}}' }));

	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	expect(textarea.value).toContain('{{team_name}}');
	expect(textarea.value).toContain('{{agent_role}}');
});

test('can hire agent with full fields', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, findByText, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	const role = uniqueName('Security Auditor');
	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await user.type(titleInput, role);
	await user.type(
		await findByLabelText('Role description'),
		'Audits code for security vulnerabilities',
	);

	const heartbeatSelect = container.querySelector('select') as HTMLSelectElement;
	fireEvent.change(heartbeatSelect, { target: { value: '120' } });

	const budgetInput = (await findByLabelText('Monthly budget')) as HTMLInputElement;
	await user.clear(budgetInput);
	await user.type(budgetInput, '50');

	const touchesCode = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
	await user.click(touchesCode);

	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, 'You are the Security Auditor.');

	const form = titleInput.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await findByText(`Onboard new agent: ${role}`, undefined, { timeout: 20_000 });
}, 60_000);
