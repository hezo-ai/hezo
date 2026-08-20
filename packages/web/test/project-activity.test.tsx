import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import {
	archiveSeededAsset,
	seedAsset,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

test('project Activity page lists the project audit trail', async () => {
	const seeded = { projectSlug: '', identifier: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Activity Project' });
			const task = await seedTask(ws, project, { title: 'Audited Task' });
			seeded.projectSlug = project.slug;
			seeded.identifier = task.identifier;
			return { ws, project, task };
		},
	});

	await helpers.router.navigate({
		to: '/projects/$projectId/activity',
		params: { projectId: seeded.projectSlug },
	});

	// The page mounts (unique subtitle) and the task-created event renders as a
	// readable, linked row naming the task. The subtitle is what identifies the
	// page now: the log blurb it used to assert on belonged to a tab strip, and
	// the tab it switched to measured per-agent run time, which moved to the
	// Budget page beside each agent's spend.
	await helpers.findByText(/Everything that happened on this project/, undefined, {
		timeout: 20_000,
	});
	const row = await helpers.findByText(
		new RegExp(`Created task ${seeded.identifier}`, 'i'),
		undefined,
		{
			timeout: 20_000,
		},
	);
	const link = row.closest('a');
	expect(link?.getAttribute('href')).toContain(
		`/projects/${seeded.projectSlug}/tasks/${seeded.identifier.toLowerCase()}`,
	);
}, 30_000);

// Every asset audit row used to render "Uploaded <file>", including archives —
// so an agent restoring an asset in order to overwrite it was invisible in the
// feed. The row now names what actually happened.
test('project Activity page names an asset archive rather than calling it an upload', async () => {
	const seeded = { projectSlug: '', filename: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Archive Activity' });
			const asset = await seedAsset(ws, project, { filename: 'retired.png' });
			await archiveSeededAsset(ws, project, asset.id);
			seeded.projectSlug = project.slug;
			seeded.filename = asset.original_filename;
			return { ws, project, asset };
		},
	});

	await helpers.router.navigate({
		to: '/projects/$projectId/activity',
		params: { projectId: seeded.projectSlug },
	});

	await helpers.findByText(new RegExp(`Archived ${seeded.filename}`, 'i'), undefined, {
		timeout: 20_000,
	});
	// The upload row is still an upload — exactly one of them. Two would mean the
	// archive row had rendered as an upload too, which is the bug.
	const uploads = (document.body.textContent ?? '').split(`Uploaded ${seeded.filename}`).length - 1;
	expect(uploads).toBe(1);
}, 30_000);
