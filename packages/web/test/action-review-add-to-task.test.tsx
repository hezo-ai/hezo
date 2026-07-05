import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { buildReviewHandoff } from '../src/components/document-review/review-handoff';
import { renderApp } from './helpers/render';
import {
	seedComment,
	seedDocument,
	seedProject,
	seedReviewComment,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// The action-review dialog's "Add to task…" picker: available on task-less
// surfaces (here the standalone /preview route), filterable via its text
// input, keyboard-navigable, and — when opened from a task view — pinning the
// hosting task as the first entry exactly once.

const DOC_CONTENT = ['# Product Requirements', '', 'An unmistakable document body.'].join('\n');

interface SeedRef {
	projectSlug: string;
	tasks: Array<{ taskId: string; identifier: string; title: string }>;
}

/** Seed a reviewed doc + `titles.length` tasks, then open the action dialog on the standalone preview route. */
async function openActionDialogFromPreview(titles: string[]) {
	const ref: SeedRef = { projectSlug: '', tasks: [] };
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Picker Project' });
			await seedDocument(ws, project, { filename: 'prd.md', content: DOC_CONTENT });
			await seedReviewComment(ws, project, 'prd.md', {
				quote: 'unmistakable document body',
				comment: 'Tighten this sentence',
			});
			for (const title of titles) {
				const task = await seedTask(ws, project, { title });
				ref.tasks.push({
					taskId: task.identifier.toLowerCase(),
					identifier: task.identifier,
					title,
				});
			}
			ref.projectSlug = project.slug;
		},
	});

	await utils.router.navigate({
		to: '/preview/$projectId/$filename',
		params: { projectId: ref.projectSlug, filename: 'prd.md' },
	});

	await utils.findByTestId('review-count-chip', undefined, { timeout: 15_000 });
	await utils.user.click(await utils.findByTestId('review-action-open'));
	const add = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="action-review-add"]');
		expect(el).toBeTruthy();
		return el as HTMLElement;
	});
	return { ...utils, ...ref, add };
}

function filterInput(): HTMLInputElement {
	return document.body.querySelector('[data-testid="add-to-task-filter"]') as HTMLInputElement;
}

function optionRows(): HTMLElement[] {
	return Array.from(
		document.body.querySelectorAll<HTMLElement>(
			'[data-testid="add-to-task-option"], [data-testid="add-to-task-current"]',
		),
	);
}

/** Wrap fetch to capture POST .../comments payloads without blocking them. */
function spyOnCommentPosts() {
	const original = globalThis.fetch;
	const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (
			init?.method === 'POST' &&
			/\/tasks\/[^/]+\/comments$/.test(url) &&
			typeof init.body === 'string'
		) {
			try {
				posts.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
			} catch {}
		}
		return original(input, init);
	}, original);
	return {
		posts,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

test('task-less surface: picker lists tasks with no pinned entry, filters, and posts to the chosen task', async () => {
	const { add, user, tasks } = await openActionDialogFromPreview([
		'Fix onboarding flow',
		'Polish dashboard',
	]);

	await user.click(add);
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="add-to-task-picker"]')).toBeTruthy();
	});

	// Both seeded tasks listed (alongside the project's auto-provisioned
	// planning task), none tagged as current.
	await waitFor(() => {
		const text = optionRows()
			.map((r) => r.textContent)
			.join('\n');
		expect(text).toContain('Fix onboarding flow');
		expect(text).toContain('Polish dashboard');
	});
	expect(document.body.querySelector('[data-testid="add-to-task-current"]')).toBeNull();

	// Typing filters the list down (150 ms debounce + server round-trip).
	await user.type(filterInput(), 'onboarding');
	await waitFor(
		() => {
			const rows = optionRows();
			expect(rows.length).toBe(1);
			expect(rows[0].textContent).toContain('Fix onboarding flow');
		},
		{ timeout: 5_000 },
	);

	const target = tasks.find((t) => t.title === 'Fix onboarding flow');
	if (!target) throw new Error('missing seeded task');
	const spy = spyOnCommentPosts();
	try {
		await user.click(optionRows()[0]);
		await waitFor(() => {
			expect(spy.posts).toHaveLength(1);
		});
	} finally {
		spy.restore();
	}
	expect(spy.posts[0].url).toContain(`/tasks/${target.taskId}/comments`);
	expect(spy.posts[0].body).toEqual({ content: buildReviewHandoff('prd.md') });

	// Success closes the whole dialog.
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="action-review-dialog"]')).toBeNull();
	});
});

test('keyboard: arrows move the highlight, Enter posts to the highlighted task, Escape closes only the picker', async () => {
	const { add, user } = await openActionDialogFromPreview([
		'Fix onboarding flow',
		'Polish dashboard',
	]);

	await user.click(add);
	await waitFor(() => {
		expect(optionRows().length).toBeGreaterThanOrEqual(2);
	});

	// Escape closes the picker but leaves the dialog up.
	await user.keyboard('{Escape}');
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="add-to-task-picker"]')).toBeNull();
	});
	expect(document.body.querySelector('[data-testid="action-review-dialog"]')).toBeTruthy();

	// Reopen, arrow to the second row, Enter posts to it.
	await user.click(document.body.querySelector('[data-testid="action-review-add"]') as HTMLElement);
	await waitFor(() => {
		expect(optionRows().length).toBeGreaterThanOrEqual(2);
	});
	const secondTaskId = optionRows()[1].getAttribute('data-task-id');
	expect(secondTaskId).toBeTruthy();

	const spy = spyOnCommentPosts();
	try {
		await user.keyboard('{ArrowDown}');
		await waitFor(() => {
			expect(optionRows()[1].getAttribute('aria-selected')).toBe('true');
		});
		await user.keyboard('{Enter}');
		await waitFor(() => {
			expect(spy.posts).toHaveLength(1);
		});
	} finally {
		spy.restore();
	}
	expect(spy.posts[0].url).toContain(`/tasks/${secondTaskId}/comments`);
	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="action-review-dialog"]')).toBeNull();
	});
});

test('empty states: no tasks in the project, and no matches for a filter', async () => {
	const { add, user, ctx } = await openActionDialogFromPreview([]);
	// The project is provisioned with a planning task; remove it so the
	// zero-task empty state is reachable.
	await ctx.db.query('DELETE FROM tasks');

	await user.click(add);
	await waitFor(() => {
		const picker = document.body.querySelector('[data-testid="add-to-task-picker"]');
		expect(picker?.textContent).toContain('No tasks in this project');
	});
	expect(optionRows().length).toBe(0);

	await user.type(filterInput(), 'zzz-no-such-task');
	await waitFor(
		() => {
			const picker = document.body.querySelector('[data-testid="add-to-task-picker"]');
			expect(picker?.textContent).toContain('No tasks matching "zzz-no-such-task"');
		},
		{ timeout: 5_000 },
	);
});

test('task context: current task pinned first exactly once; a filter excluding it drops it', async () => {
	const ref = { projectSlug: '', taskId: '', identifier: '', otherTitle: 'Polish dashboard' };
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Pinning Project' });
			await seedDocument(ws, project, { filename: 'prd.md', content: DOC_CONTENT });
			await seedReviewComment(ws, project, 'prd.md', {
				quote: 'unmistakable document body',
				comment: 'Tighten this sentence',
			});
			const task = await seedTask(ws, project, { title: 'Review the spec' });
			await seedComment(ws, task, 'Please review prd.md before we ship.');
			await seedTask(ws, project, { title: ref.otherTitle });
			ref.projectSlug = project.slug;
			ref.taskId = task.identifier.toLowerCase();
			ref.identifier = task.identifier;
		},
	});
	await utils.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.taskId },
	});
	const mention = await utils.findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
	await utils.user.click(mention);
	await utils.findByTestId('preview-panel');
	await utils.findByTestId('review-count-chip');
	await utils.user.click(await utils.findByTestId('review-action-open'));
	const add = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="action-review-add"]');
		expect(el).toBeTruthy();
		return el as HTMLElement;
	});

	await utils.user.click(add);

	// Empty filter: current task first (tagged), both tasks present, and the
	// current task's identifier appears exactly once (the fetched duplicate is
	// deduped against the synthesized pinned row).
	await waitFor(() => {
		expect(optionRows().length).toBeGreaterThanOrEqual(2);
	});
	const rows = optionRows();
	expect(rows[0].getAttribute('data-testid')).toBe('add-to-task-current');
	expect(rows[0].textContent).toContain('Review the spec');
	expect(rows[0].textContent).toContain('Current task');
	expect(rows.filter((r) => r.getAttribute('data-task-id') === ref.taskId).length).toBe(1);

	// A filter matching only the other task drops the pinned entry.
	await utils.user.type(filterInput(), 'dashboard');
	await waitFor(
		() => {
			const filtered = optionRows();
			expect(filtered.length).toBe(1);
			expect(filtered[0].textContent).toContain(ref.otherTitle);
		},
		{ timeout: 5_000 },
	);
	expect(document.body.querySelector('[data-testid="add-to-task-current"]')).toBeNull();

	// Clearing the filter brings the pinned entry back.
	await utils.user.clear(filterInput());
	await waitFor(
		() => {
			expect(optionRows()[0]?.getAttribute('data-testid')).toBe('add-to-task-current');
		},
		{ timeout: 5_000 },
	);
});
