import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('can create, view, edit, and delete a project document', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const {
		container,
		findByRole,
		findByLabelText,
		findByTestId,
		findByText,
		queryByText,
		user,
		router,
	} = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Docs Test Project'),
				description: 'Project for testing the documents tab.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
	});

	const filename = `notes-${Math.random().toString(36).slice(2, 8)}.md`;

	await user.click(await findByRole('button', { name: 'New document' }));

	await user.type(await findByLabelText('Filename'), filename);
	const contentArea = container.querySelector('textarea') as HTMLTextAreaElement;
	expect(contentArea).toBeTruthy();
	await user.type(contentArea, '# Project Notes\n\nSome **markdown** content.');

	await user.click(await findByRole('button', { name: 'Create' }));

	// Doc title in viewer header.
	await findByRole('heading', { name: filename, level: 2 }, { timeout: 15_000 });
	await findByText('Project Notes', undefined, { timeout: 15_000 });

	// Edit content.
	await user.click(await findByRole('button', { name: 'Edit' }));
	const editArea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.clear(editArea);
	await user.type(editArea, 'Updated content for the doc');
	await user.click(await findByRole('button', { name: 'Save' }));

	await findByText('Updated content for the doc', undefined, { timeout: 15_000 });

	// Deleting is a two-step flow: archive first (the reversible soft delete
	// offered on active docs), then the hard delete appears on the archived doc.
	await user.click(await findByRole('button', { name: 'Archive document' }));
	await findByTestId('doc-archived-banner');

	await user.click(await findByRole('button', { name: 'Delete document' }));
	await user.click(await findByTestId('confirm-dialog-confirm'));

	// After deletion, the doc list entry is gone.
	await new Promise((r) => setTimeout(r, 200));
	expect(queryByText(filename)).toBeNull();
});

async function seedDoc(
	apiBase: (path: string, init: RequestInit) => Promise<Response>,
	token: string,
	projectSlug: string,
	filename: string,
	writes: { content: string; change_summary?: string }[],
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const docPath = `/api/projects/${projectSlug}/docs/${filename}`;
	for (const w of writes) {
		const res = await apiBase(docPath, { method: 'PUT', headers, body: JSON.stringify(w) });
		if (!res.ok) throw new Error(`write failed: ${res.status}`);
	}
}

test('shows revision history via the History dialog and restores a previous version', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `plan-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Revision Project'),
				description: 'Project for testing project doc revisions.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, filename, [
				{ content: 'Original plan' },
				{ content: 'Second draft', change_summary: 'polish the plan' },
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: filename } as never,
	});

	await findByText('Second draft', undefined, { timeout: 15_000 });

	// Open the revision-history dialog; the changelog renders like a comment.
	await user.click(await findByTestId('doc-history'));
	await findByTestId('revision-history-dialog', undefined, { timeout: 15_000 });
	await findByText('polish the plan', undefined, { timeout: 15_000 });
	await findByText(/Rev 1/, undefined, { timeout: 15_000 });

	// Restore the earlier version → a new current version with that content.
	await user.click(await findByTestId('revision-restore'));
	await user.click(await findByTestId('confirm-dialog-confirm'));

	await findByText('Original plan', undefined, { timeout: 15_000 });
});

test('a deep-linked ?edit=1 opens the selected doc directly in edit mode', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `edit-link-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByRole, container, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Edit Deep Link'),
				description: 'Tests the ?edit=1 deep-link from a preview surface.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, filename, [{ content: 'Deep link body' }]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: filename, edit: true } as never,
	});

	// Lands in edit mode: the Save action and the editor textarea are present
	// (rather than the read-only Edit button), seeded with the loaded content.
	await findByRole('button', { name: 'Save' }, { timeout: 15_000 });
	const editArea = container.querySelector('textarea') as HTMLTextAreaElement;
	expect(editArea).toBeTruthy();
	expect(editArea.value).toContain('Deep link body');
});

test('a deep-linked ?history=1 opens the revision-history dialog', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `history-link-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('History Deep Link'),
				description: 'Tests the ?history=1 deep-link from a preview surface.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, filename, [
				{ content: 'First' },
				{ content: 'Second', change_summary: 'revise' },
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: filename, history: true } as never,
	});

	// The revision dialog opens on load without clicking the History button.
	await findByTestId('revision-history-dialog', undefined, { timeout: 15_000 });
});

test('shows the metadata banner and hides a legacy metadata header from the rendered body', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `spec-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByText, findByTestId, queryByText, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Banner Project'),
				description: 'Tests the metadata banner and legacy-header strip.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, filename, [
				{
					content:
						'# Spec\n\n**Status:** experiment-zzz **Author:** bot **Date:** 2026-06-27\n\n## Body\n\nReal spec content.',
				},
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: filename } as never,
	});

	// Body renders, and the structured banner shows (with a Created label)…
	await findByText('Real spec content.', undefined, { timeout: 15_000 });
	const banner = await findByTestId('doc-metadata-banner');
	expect(banner.textContent).toContain('Created');
	// …while the legacy in-body metadata header is stripped from the rendered view.
	expect(queryByText(/experiment-zzz/)).toBeNull();
});

test('viewing an older revision shows the banner, hides Edit, and can return to latest', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const filename = `hist-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByText, findByTestId, findByRole, queryByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Viewing Project'),
				description: 'Tests past-revision viewing + review gating.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, filename, [
				{ content: 'Original plan' },
				{ content: 'Second draft' },
			]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: filename } as never,
	});

	await findByText('Second draft', undefined, { timeout: 15_000 });
	await findByRole('button', { name: 'Edit' }); // editable on the latest version

	// Open history and view the earlier version.
	await user.click(await findByTestId('doc-history'));
	await findByTestId('revision-history-dialog', undefined, { timeout: 15_000 });
	await user.click(await findByTestId('revision-view'));

	// Viewing an older revision: banner shows, old content renders, Edit is gone.
	await findByTestId('viewing-revision-banner', undefined, { timeout: 15_000 });
	await findByText('Original plan', undefined, { timeout: 15_000 });
	expect(queryByRole('button', { name: 'Edit' })).toBeNull();

	// Return to the latest version — editing is available again.
	await user.click(await findByTestId('view-latest'));
	await findByText('Second draft', undefined, { timeout: 15_000 });
	await findByRole('button', { name: 'Edit' });
});

test('search input filters the document list as you type', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { findByText, findByLabelText, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Search Project'),
				description: 'Tests filtering the doc list from the sidebar search input.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, 'analytics-workflow.md', [
				{ content: 'Analytics' },
			]);
			await seedDoc(apiBase, token, projectSlug, 'brand-style-guide.md', [{ content: 'Brand' }]);
			await seedDoc(apiBase, token, projectSlug, 'content-calendar.md', [{ content: 'Calendar' }]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
	});

	// All three docs are listed before any filtering.
	await findByText('analytics-workflow.md', undefined, { timeout: 15_000 });
	await findByText('brand-style-guide.md');
	await findByText('content-calendar.md');

	const search = await findByLabelText('Filter documents');
	await user.type(search, 'brand');

	await findByText('brand-style-guide.md');
	expect(queryByText('analytics-workflow.md')).toBeNull();
	expect(queryByText('content-calendar.md')).toBeNull();

	// A query matching nothing shows the empty-filter message…
	await user.clear(search);
	await user.type(search, 'zzz-no-match');
	await findByText('No matching documents');

	// …and clearing the query restores the full list.
	await user.clear(search);
	await findByText('analytics-workflow.md');
	await findByText('brand-style-guide.md');
	await findByText('content-calendar.md');
});

test('switches the viewed document via the header name search, hidden while editing', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const fileA = `alpha-${Math.random().toString(36).slice(2, 8)}.md`;
	const fileB = `bravo-${Math.random().toString(36).slice(2, 8)}.md`;

	const { findByRole, findByTestId, findByText, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Switcher Project'),
				description: 'Tests the in-viewer document switcher.',
			});
			projectSlug = project.slug;
			await seedDoc(apiBase, token, projectSlug, fileA, [{ content: 'Alpha body' }]);
			await seedDoc(apiBase, token, projectSlug, fileB, [{ content: 'Bravo body' }]);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
		search: { file: fileA } as never,
	});

	await findByText('Alpha body', undefined, { timeout: 15_000 });

	// Open the header switcher and jump to the other doc by name.
	await user.click(await findByTestId('doc-switch-button'));
	await user.type(await findByTestId('doc-switch-search'), 'bravo');
	await user.click(await findByTestId(`doc-switch-option-${fileB}`));

	// The viewer switched to the other document.
	await findByRole('heading', { name: fileB, level: 2 }, { timeout: 15_000 });
	await findByText('Bravo body', undefined, { timeout: 15_000 });

	// Entering edit mode hides the switcher button.
	await user.click(await findByRole('button', { name: 'Edit' }));
	await findByRole('button', { name: 'Save' }, { timeout: 15_000 });
	expect(queryByTestId('doc-switch-button')).toBeNull();
});

test('rejects invalid filename when creating a document', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';

	const { container, findByRole, findByLabelText, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, {
				name: uniqueName('Filename Test'),
				description: 'Tests filename validation.',
			});
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
	});

	await user.click(await findByRole('button', { name: 'New document' }));
	await user.type(await findByLabelText('Filename'), 'not-markdown');
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, 'content');
	await user.click(await findByRole('button', { name: 'Create' }));

	await findByText(/Filename must end with \.md/, undefined, { timeout: 10_000 });
});
