import { waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { buildReviewHandoff } from '../src/components/document-review/review-handoff';
import { toast } from '../src/hooks/use-toast';
import { clickUntil, renderApp } from './helpers/render';
import {
	seedComment,
	seedDocument,
	seedProject,
	seedReviewComment,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// The action-review dialog, opened from a task's document preview panel, offers
// an "Add to task…" picker whose first entry is the hosting task; selecting it
// posts the handoff as a comment on that task (payload is exactly `{ content }`
// — no wake) and closes the dialog; the copy button sits on the left. Failure
// keeps the dialog open and toasts.

const DOC_CONTENT = ['# Product Requirements', '', 'An unmistakable document body.'].join('\n');

/** Seed a task whose thread mentions a reviewed doc, open its preview panel, and open the action dialog. */
async function openActionDialogFromTask() {
	const ref = { projectSlug: '', taskId: '', identifier: '' };
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Review Handoff Project' });
			await seedDocument(ws, project, { filename: 'prd.md', content: DOC_CONTENT });
			// The action button is disabled until the doc has review comments.
			await seedReviewComment(ws, project, 'prd.md', {
				quote: 'unmistakable document body',
				comment: 'Tighten this sentence',
			});
			const task = await seedTask(ws, project, { title: 'Review the spec' });
			await seedComment(ws, task, 'Please review prd.md before we ship.');
			ref.projectSlug = project.slug;
			ref.taskId = task.identifier.toLowerCase();
			ref.identifier = task.identifier;
		},
	});

	await utils.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.taskId },
	});

	await utils.findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
	await clickUntil(
		utils.user,
		() => document.querySelector('[data-testid="doc-mention-link"]'),
		() => !!document.querySelector('[data-testid="preview-panel"]'),
		{ label: 'the doc mention' },
	);
	await utils.findByTestId('preview-panel');

	// Count chip appearing means the review-comments query resolved with count > 0,
	// so the action button is enabled.
	await utils.findByTestId('review-count-chip');
	await utils.user.click(await utils.findByTestId('review-action-open'));

	// Dialog portals onto document.body; the portal mounts asynchronously.
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="action-review-dialog"]')).toBeTruthy();
	});
	return { ...utils, ...ref };
}

test('Add to task pins the hosting task first; selecting it posts the handoff and closes the dialog', async () => {
	const { container, identifier, user } = await openActionDialogFromTask();

	// Copy sits left, the "Add to task…" trigger right, footer spread apart.
	const footer = document.body.querySelector('[data-testid="action-review-footer"]') as HTMLElement;
	expect(footer.className).toContain('justify-between');
	const add = document.body.querySelector('[data-testid="action-review-add"]') as HTMLElement;
	expect(add.textContent).toBe('Add to task…');
	expect(footer.firstElementChild?.getAttribute('data-testid')).toBe('action-review-copy');
	expect(footer.lastElementChild?.querySelector('[data-testid="action-review-add"]')).toBeTruthy();

	// Spy on POST /api/.../comments to pin the exact payload.
	const original = globalThis.fetch;
	const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(url)) {
			const body = init.body;
			if (typeof body === 'string') {
				try {
					posts.push({ url, body: JSON.parse(body) as Record<string, unknown> });
				} catch {}
			}
		}
		return original(input, init);
	}, original);
	try {
		await user.click(add);

		// The picker opens with the hosting task pinned as the FIRST row.
		const picker = await waitFor(() => {
			const el = document.body.querySelector('[data-testid="add-to-task-picker"]');
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		const current = picker.querySelector('[data-testid="add-to-task-current"]') as HTMLElement;
		expect(current).toBeTruthy();
		expect(current.textContent).toContain('Review the spec');
		expect(current.textContent).toContain('Current task');
		const listbox = picker.querySelector('[role="listbox"]') as HTMLElement;
		expect(listbox.querySelector('button')?.getAttribute('data-testid')).toBe(
			'add-to-task-current',
		);

		await user.click(current);

		// The handoff lands in the task thread (the prd.md mention splits the text
		// across nodes, so assert on the comment bodies rather than findByText).
		await waitFor(() => {
			const bodies = Array.from(container.querySelectorAll('[data-testid="text-comment-body"]'));
			expect(
				bodies.some((b) =>
					b.textContent?.includes('Review comments have been left on the document'),
				),
			).toBe(true);
		});
	} finally {
		globalThis.fetch = original;
	}

	// Exactly `{ content: <handoff> }` — toEqual proves no extra fields
	// — POSTed to the hosting task's path.
	expect(posts).toHaveLength(1);
	expect(posts[0].url).toContain(`/tasks/${identifier.toLowerCase()}/comments`);
	expect(posts[0].body).toEqual({ content: buildReviewHandoff('prd.md') });

	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="action-review-dialog"]')).toBeNull();
	});
});

test('a failed Add keeps the dialog open and toasts the error', async () => {
	const { user } = await openActionDialogFromTask();

	const original = globalThis.fetch;
	const errorSpy = vi.spyOn(toast, 'error');
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (init?.method === 'POST' && /\/tasks\/[^/]+\/comments$/.test(url)) {
			return new Response(JSON.stringify({ error: { message: 'boom' } }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return original(input, init);
	}, original);
	try {
		await user.click(
			document.body.querySelector('[data-testid="action-review-add"]') as HTMLElement,
		);
		const current = await waitFor(() => {
			const el = document.body.querySelector('[data-testid="add-to-task-current"]');
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		await user.click(current);
		await waitFor(() => {
			expect(errorSpy).toHaveBeenCalledWith('boom');
		});
		// The dialog stays open so the handoff isn't lost; the picker closes.
		expect(document.body.querySelector('[data-testid="action-review-dialog"]')).toBeTruthy();
		expect(document.body.querySelector('[data-testid="add-to-task-picker"]')).toBeNull();
	} finally {
		globalThis.fetch = original;
		errorSpy.mockRestore();
	}
});
