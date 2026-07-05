// Archive filter + archived-document treatment on the Documents page: the
// Active/Archived/All pills in the list rail (with live counts), the archived
// chip on rows, the archived banner with Restore in the viewer, and Edit
// hidden while archived (read-only). Component tier — render-driven, no
// layout/browser dependency.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import {
	archiveSeededDocument,
	type SeededWorkspace,
	seedDocument,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

async function setupDocsPage() {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archive Docs Project' });
			ref.slug = project.slug;
			await seedDocument(ws, project, { filename: 'active-spec.md', content: '# Active spec' });
			await seedDocument(ws, project, { filename: 'old-plan.md', content: '# Old plan' });
			await archiveSeededDocument(ws, project, 'old-plan.md');
		},
	});
	return { ...helpers, ref };
}

test('the rail pills filter docs by archive state and carry live counts', async () => {
	const r = await setupDocsPage();
	await r.router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: r.ref.slug },
	});

	// Default view is Active: the archived doc is hidden.
	await r.findByText('active-spec.md', undefined, { timeout: 15_000 });
	expect(r.queryByText('old-plan.md')).toBeNull();

	// Counts are live and consistent. The project template seeds docs of its
	// own, so assert the relationship rather than absolute Active/All numbers:
	// exactly one archived doc, and All = Active + Archived.
	const active = await r.findByRole('button', { name: /^Active/ });
	const archived = await r.findByRole('button', { name: /Archived\s*1$/ });
	const all = await r.findByRole('button', { name: /^All/ });
	const countOf = (el: HTMLElement) => Number(el.textContent?.replace(/\D/g, ''));
	expect(countOf(all as HTMLElement)).toBe(
		countOf(active as HTMLElement) + countOf(archived as HTMLElement),
	);

	// Archived view shows only the archived doc, with its chip.
	await r.user.click(archived);
	await r.findByText('old-plan.md');
	await waitFor(() => expect(r.queryByText('active-spec.md')).toBeNull());
	expect(r.getAllByTestId('archived-badge').length).toBeGreaterThan(0);

	// All shows both; the archived row keeps the chip.
	await r.user.click(all);
	await r.findByText('active-spec.md');
	await r.findByText('old-plan.md');

	// Back to Active.
	await r.user.click(active);
	await waitFor(() => expect(r.queryByText('old-plan.md')).toBeNull());
});

test('an archived doc shows the banner, hides Edit, and Restore reactivates it', async () => {
	const r = await setupDocsPage();
	await r.router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: r.ref.slug },
		search: { file: 'old-plan.md', filter: 'archived' } as never,
	});

	await r.findByText('Old plan', undefined, { timeout: 15_000 });

	// Banner names the state; the doc is read-only (no Edit) and the hard
	// delete is available; the reversible Archive action is not offered again.
	await r.findByTestId('doc-archived-banner');
	expect(r.queryByRole('button', { name: 'Edit' })).toBeNull();
	expect(r.queryByRole('button', { name: 'Archive document' })).toBeNull();
	await r.findByRole('button', { name: 'Delete document' });

	// Restore flips it back to active: banner gone, Edit back.
	await r.user.click(await r.findByTestId('doc-restore'));
	await waitFor(() => expect(r.queryByTestId('doc-archived-banner')).toBeNull(), {
		timeout: 15_000,
	});
	await r.findByRole('button', { name: 'Edit' });
});

test('archiving from the toolbar drops the doc from the Active list', async () => {
	const r = await setupDocsPage();
	await r.router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: r.ref.slug },
		search: { file: 'active-spec.md' } as never,
	});

	await r.findByText('Active spec', undefined, { timeout: 15_000 });
	await r.user.click(await r.findByRole('button', { name: 'Archive document' }));

	// The viewer flips to the archived state and the Active list loses the row
	// (counts move to Active 0 / Archived 2).
	await r.findByTestId('doc-archived-banner');
	await r.findByRole('button', { name: /Archived\s*2/ });
	await waitFor(() => {
		// Only the viewer heading remains; the list row is filtered out.
		expect(r.queryAllByText('active-spec.md').length).toBeLessThanOrEqual(1);
	});
});
