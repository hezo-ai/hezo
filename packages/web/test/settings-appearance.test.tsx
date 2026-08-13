import { TaskView } from '@hezo/shared';
import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

async function storedDefaultView(): Promise<string> {
	const { db } = getTestContext();
	const res = await db.query<{ value: string }>(
		"SELECT value FROM system_meta WHERE key = 'default_task_view'",
	);
	return res.rows[0]?.value ?? '(unset)';
}

test('shows theme and task view, each labelled with who it applies to', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings/appearance' });

	const theme = await findByTestId('appearance-theme');
	expect(theme.textContent).toContain('Theme');
	expect(theme.textContent).toContain('This browser');

	const taskView = await findByTestId('appearance-task-view');
	expect(taskView.textContent).toContain('Task view');
	// An admin sees that the setting reaches everyone *and* that only they can move it.
	expect(taskView.textContent).toContain('Everyone, admin only');
});

test('an admin can switch the instance default, and the server keeps it', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/settings/appearance' });

	const control = await findByTestId('default-task-view-control');
	const conversation = within(control).getByRole('button', { name: 'Conversation' });
	const detailed = within(control).getByRole('button', { name: 'Detailed' });
	// Conversation is what a fresh instance ships with.
	expect(conversation.getAttribute('aria-pressed')).toBe('true');
	expect(detailed.getAttribute('aria-pressed')).toBe('false');

	await user.click(detailed);

	// Response-driven: the control follows the server's echo, not the click.
	await waitFor(async () => {
		expect(await storedDefaultView()).toBe(TaskView.Detailed);
	});
	await waitFor(() => {
		expect(
			within(control).getByRole('button', { name: 'Detailed' }).getAttribute('aria-pressed'),
		).toBe('true');
	});
});

test('a non-superuser sees the value but cannot change it', async () => {
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/settings/appearance',
		seed: async (ctx) => {
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	const readonly = await findByTestId('default-task-view-readonly');
	expect(readonly.textContent).toContain('Conversation');
	expect(readonly.textContent).toContain('set by the Admin');
	expect(queryByTestId('default-task-view-control')).toBeNull();

	// Theme is theirs, so it stays editable.
	await findByTestId('appearance-theme-control');
});

test('labels stay visible when the width cannot be measured', async () => {
	// happy-dom reports 0 for every box. The fallback must not collapse a
	// control on the strength of a measurement it never took.
	const { findByTestId } = await renderApp({ initialPath: '/settings/appearance' });
	const control = await findByTestId('default-task-view-control');
	expect(control.getAttribute('data-icons-only')).toBeNull();
	expect(control.textContent).toContain('Conversation');
	expect(control.textContent).toContain('Detailed');
});
