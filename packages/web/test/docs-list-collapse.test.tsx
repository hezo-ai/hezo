import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

const LIST_COLLAPSED_KEY = 'hezo:doc-list-collapsed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

async function seedDoc(
	apiBase: (path: string, init: RequestInit) => Promise<Response>,
	token: string,
	projectSlug: string,
	filename: string,
	content: string,
): Promise<void> {
	const res = await apiBase(`/api/projects/${projectSlug}/docs/${filename}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ content }),
	});
	if (!res.ok) throw new Error(`doc write failed: ${res.status}`);
}

test('toggle collapses the doc list, persists the choice, and expands it again', async () => {
	localStorage.removeItem(LIST_COLLAPSED_KEY);
	let projectSlug = '';
	const filename = `guide-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Collapse Project'),
				description: 'Tests the doc-list collapse toggle.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, filename, 'Collapse me');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: filename } as never,
	});
	await findByText('Collapse me', undefined, { timeout: 15_000 });

	const toggle = await findByTestId('doc-list-toggle');
	const listPane = await findByTestId('doc-list-pane');

	// Expanded by default: the list is interactive and the control offers to hide it.
	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	expect(toggle.getAttribute('aria-label')).toBe('Hide document list');
	expect(listPane.hasAttribute('inert')).toBe(false);

	// Collapse: the list leaves the accessibility tree and the choice is stored.
	await user.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	expect(toggle.getAttribute('aria-label')).toBe('Show document list');
	expect(listPane.hasAttribute('inert')).toBe(true);
	expect(localStorage.getItem(LIST_COLLAPSED_KEY)).toBe('1');

	// Expand again.
	await user.click(toggle);
	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	expect(listPane.hasAttribute('inert')).toBe(false);
	expect(localStorage.getItem(LIST_COLLAPSED_KEY)).toBe('0');

	localStorage.removeItem(LIST_COLLAPSED_KEY);
});

test('a stored collapse choice applies on load, but only while a document is open', async () => {
	localStorage.setItem(LIST_COLLAPSED_KEY, '1');
	let projectSlug = '';
	const filename = `sticky-${Math.random().toString(36).slice(2, 8)}.md`;

	try {
		const { findByTestId, findByText, findByRole, queryByTestId, router } = await renderApp({
			initialPath: '/',
			seed: async ({ apiBase, token }) => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, {
					name: uniqueName('Persisted Collapse'),
					description: 'Tests the persisted doc-list collapse state.',
				});
				projectSlug = project.slug;
				await seedDoc(apiBase, token, projectSlug, filename, 'Persisted body');
			},
		});

		await router.navigate({
			to: '/projects/$projectId/documents',
			params: { projectId: projectSlug },
			search: { file: filename } as never,
		});
		await findByText('Persisted body', undefined, { timeout: 15_000 });

		// The remembered choice applies: collapsed from the first render.
		const toggle = await findByTestId('doc-list-toggle');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect((await findByTestId('doc-list-pane')).hasAttribute('inert')).toBe(true);

		// With no document open there is no toggle, so the collapse must not
		// apply — otherwise nothing could ever be selected.
		await router.navigate({
			to: '/projects/$projectId/documents',
			params: { projectId: projectSlug },
			search: {} as never,
		});
		await findByText('Select a document', undefined, { timeout: 15_000 });
		expect(queryByTestId('doc-list-toggle')).toBeNull();
		expect((await findByTestId('doc-list-pane')).hasAttribute('inert')).toBe(false);
		// The list is genuinely usable: its entries are reachable.
		await findByRole('button', { name: 'New document' });
	} finally {
		localStorage.removeItem(LIST_COLLAPSED_KEY);
	}
});
