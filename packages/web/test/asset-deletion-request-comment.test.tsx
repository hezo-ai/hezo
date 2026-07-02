import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededAsset,
	type SeededTask,
	type SeededWorkspace,
	seedAsset,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// asset_deletion_request comments are created by the request_asset_deletion MCP
// tool, not the comments API, so seed them with a direct insert (same approach
// the credential-request card test uses).
async function seedDeletionRequest(
	ws: SeededWorkspace,
	task: SeededTask,
	assets: SeededAsset[],
	opts?: { reason?: string; chosen?: Record<string, unknown> },
): Promise<string> {
	const { db } = getTestContext();
	const snapshot = assets.map((a) => ({ id: a.id, path: a.original_filename }));
	const reason = opts?.reason ?? 'Superseded by the v2 set';
	const content = {
		assets: snapshot,
		reason,
		text: `Requested deletion of ${snapshot.length} asset(s): ${snapshot
			.map((a) => `assets/${a.path}`)
			.join(', ')} — ${reason}`,
	};
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content, chosen_option)
		 VALUES ($1, $2, 'asset_deletion_request'::comment_content_type, $3::jsonb, $4::jsonb)
		 RETURNING id`,
		[
			task.id,
			ws.agents[0].id,
			JSON.stringify(content),
			opts?.chosen ? JSON.stringify(opts.chosen) : null,
		],
	);
	return inserted.rows[0].id;
}

test('a pending deletion request renders paths, reason, and admin actions', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Del UI' });
			const task = await seedTask(ws, project, { title: 'Tidy assets' });
			const a = await seedAsset(ws, project, { filename: 'old-hero.png', folder: 'drafts' });
			const b = await seedAsset(ws, project, { filename: 'old-logo.png' });
			await seedDeletionRequest(ws, task, [a, b]);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const card = await findByTestId('asset-deletion-request', undefined, { timeout: 15_000 });
	expect(card.textContent).toContain('deletion of 2 assets');
	const links = await findAllByTestId('asset-deletion-asset-link');
	expect(links.map((l) => l.textContent)).toEqual([
		'assets/drafts/old-hero.png',
		'assets/old-logo.png',
	]);
	// Each path deep-links into the assets library (?file= carries the full path).
	expect(links[0].getAttribute('href')).toContain('file=drafts%2Fold-hero.png');
	const reason = await findByTestId('asset-deletion-reason');
	expect(reason.textContent).toContain('Superseded by the v2 set');
	await findByTestId('asset-deletion-approve');
	await findByTestId('asset-deletion-deny');
});

test('approving deletes the asset server-side and flips the card', async () => {
	const seeded = { projectSlug: '', taskId: '', assetId: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Del Approve' });
			const task = await seedTask(ws, project, { title: 'Approve me' });
			const a = await seedAsset(ws, project, { filename: 'doomed.png' });
			await seedDeletionRequest(ws, task, [a]);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.assetId = a.id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('asset-deletion-request', undefined, { timeout: 15_000 });
	await user.click(await findByTestId('asset-deletion-approve'));
	// The destructive step sits behind a ConfirmDialog (portal on document.body).
	const confirm = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="confirm-dialog-confirm"]');
		expect(el).not.toBeNull();
		return el as HTMLElement;
	});
	await user.click(confirm);

	// Response-driven: the card flips only after the server confirms.
	await findByTestId('asset-deletion-approved', undefined, { timeout: 15_000 });

	const { db } = getTestContext();
	const gone = await db.query('SELECT id FROM assets WHERE id = $1', [seeded.assetId]);
	expect(gone.rows).toHaveLength(0);
});

test('denying keeps the asset and shows the denied state', async () => {
	const seeded = { projectSlug: '', taskId: '', assetId: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Del Deny' });
			const task = await seedTask(ws, project, { title: 'Deny me' });
			const a = await seedAsset(ws, project, { filename: 'spared.png' });
			await seedDeletionRequest(ws, task, [a]);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.assetId = a.id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('asset-deletion-request', undefined, { timeout: 15_000 });
	await user.click(await findByTestId('asset-deletion-deny'));

	await findByTestId('asset-deletion-denied', undefined, { timeout: 15_000 });

	const { db } = getTestContext();
	const kept = await db.query('SELECT id FROM assets WHERE id = $1', [seeded.assetId]);
	expect(kept.rows).toHaveLength(1);
});

test('a resolved card renders its outcome with no action buttons', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Del Done' });
			const task = await seedTask(ws, project, { title: 'Already resolved' });
			const a = await seedAsset(ws, project, { filename: 'long-gone.png' });
			await seedDeletionRequest(ws, task, [a], {
				chosen: {
					status: 'approved',
					resolved_at: new Date().toISOString(),
					deleted_asset_ids: [a.id],
				},
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const resolved = await findByTestId('asset-deletion-approved', undefined, { timeout: 15_000 });
	expect(resolved.textContent).toContain('1 asset deleted');
	expect(queryByTestId('asset-deletion-approve')).toBeNull();
	expect(queryByTestId('asset-deletion-deny')).toBeNull();
});
