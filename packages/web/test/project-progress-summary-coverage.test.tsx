import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	seedGoal,
	seedProject,
	seedProjectProgress,
	seedWorkspace,
} from './helpers/seed';

// Component tier (happy-dom). ProjectProgressSummary on the real Progress page.
// The rendered-with-timestamp path is covered by goals.test.tsx; this adds the
// null-render branch (whitespace-only summary → component returns null) and the
// no-timestamp branch (summary set but progress_summary_updated_at NULL → the
// "Updated …" span is omitted). The overflow / Show-more toggle depends on real
// layout (scrollHeight) that happy-dom can't measure and is left to Playwright.

async function openProgress(seed: (project: SeededProject) => Promise<void>) {
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Progress Cov' });
			ref.slug = project.slug;
			// A goal guarantees the Progress page has content to render around.
			await seedGoal(ws, project, { title: 'A goal', measurement: 'm' });
			await seed(project);
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/goals',
		params: { projectId: ref.slug },
	});
	return helpers;
}

test('renders nothing when the summary is whitespace-only', async () => {
	const { findByText, queryByTestId } = await openProgress(async (project) => {
		await seedProjectProgress(project, '   \n\t  ');
	});

	// Page is up (the goal renders) but the progress-summary section is absent.
	await findByText('A goal', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-progress-summary')).toBeNull();
});

test('renders the summary without an "Updated" stamp when the timestamp is null', async () => {
	const { findByTestId } = await openProgress(async (project) => {
		const { db } = getTestContext();
		// Set the summary but leave progress_summary_updated_at NULL.
		await db.query(
			`UPDATE projects SET progress_summary = $1, progress_summary_updated_at = NULL WHERE id = $2`,
			['**Lead point.** Detail follows.', project.id],
		);
	});

	const section = await findByTestId('project-progress-summary', undefined, { timeout: 15_000 });
	await waitFor(() => expect(section.textContent).toContain('Lead point.'), { timeout: 15_000 });
	// The `data?.updated_at && …` branch is false → no "Updated" label.
	expect(section.textContent).not.toContain('Updated');
});
