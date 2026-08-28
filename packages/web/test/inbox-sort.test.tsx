// The inbox's Newest/Oldest sort: the comparator itself, the pill group
// reordering the list, the `sort` URL param tracking the selection (absent for
// the default), and both scopes picking it up.
// Component tier - no layout/scroll/viewport dependency. happy-dom reports a
// 1024px viewport, so these exercise the desktop toolbar; the mobile filter
// dialog is covered by test/browser/inbox-filters.mobile.spec.ts.

import { waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
	compareInboxRowsForSort,
	InboxSortOrder,
	isInboxSortOrder,
	validateInboxSearch,
} from '../src/lib/inbox-sort';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function seedAdminMention(
	workspace: SeededWorkspace,
	task: SeededTask,
	text: string,
	createdAt: string,
): Promise<void> {
	const { db } = getTestContext();
	const architect = workspace.agents.find((a) => a.slug === 'architect');
	if (!architect) throw new Error('seedAdminMention: architect agent missing');

	const userRow = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin'
		 LIMIT 1`,
		[workspace.team.id],
	);
	const userId = userRow.rows[0]?.user_id;
	if (!userId) throw new Error('seedAdminMention: no admin on team');

	const commentRow = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[task.id, architect.id, JSON.stringify({ text })],
	);

	// Pin created_at: the three mentions are inserted inside one test and would
	// otherwise share now() to the millisecond.
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, created_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		[workspace.team.id, task.id, commentRow.rows[0].id, userId, createdAt],
	);
}

const OLD = '2026-01-01T00:00:00.000Z';
const MID = '2026-01-02T00:00:00.000Z';
const NEW = '2026-01-03T00:00:00.000Z';

async function setup() {
	let ws!: SeededWorkspace;
	let project!: SeededProject;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			project = await seedProject(ws, { name: 'Sortable Inbox' });
			ref.slug = project.slug;
			const task = await seedTask(ws, project, { title: 'A admin-decision task' });
			// Seeded out of date order so a pass-through of the insert order cannot
			// be mistaken for a working sort.
			await seedAdminMention(ws, task, '@admin middle question', MID);
			await seedAdminMention(ws, task, '@admin newest question', NEW);
			await seedAdminMention(ws, task, '@admin oldest question', OLD);
		},
	});
	return { ...helpers, ref };
}

/** Each card carries a <time datetime> of its own created_at - the sort key. */
function cardOrder(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[data-testid="mention-card"] time')).map(
		(el) => el.getAttribute('datetime') ?? '',
	);
}

function currentSort(router: { state: { location: { search: unknown } } }): string | undefined {
	return (router.state.location.search as { sort?: string }).sort;
}

describe('compareInboxRowsForSort', () => {
	const a = { created_at: OLD, key: 'approval:a' };
	const b = { created_at: NEW, key: 'mention:b' };

	test('orders by date in each direction', () => {
		expect(compareInboxRowsForSort(a, b, InboxSortOrder.Newest)).toBeGreaterThan(0);
		expect(compareInboxRowsForSort(a, b, InboxSortOrder.Oldest)).toBeLessThan(0);
	});

	test('breaks a tie on the row key, in both directions', () => {
		const tieA = { created_at: MID, key: 'approval:1' };
		const tieB = { created_at: MID, key: 'mention:1' };
		// The tiebreak, not the date, decides - and it decides the same way either
		// way round, so the pair cannot swap between renders.
		expect(compareInboxRowsForSort(tieA, tieB, InboxSortOrder.Newest)).toBeLessThan(0);
		expect(compareInboxRowsForSort(tieA, tieB, InboxSortOrder.Oldest)).toBeLessThan(0);
	});

	test('is antisymmetric, so the order is total', () => {
		for (const order of [InboxSortOrder.Newest, InboxSortOrder.Oldest]) {
			expect(Math.sign(compareInboxRowsForSort(a, b, order))).toBe(
				-Math.sign(compareInboxRowsForSort(b, a, order)),
			);
			expect(compareInboxRowsForSort(a, a, order)).toBe(0);
		}
	});
});

describe('validateInboxSearch', () => {
	test('keeps a non-default order and drops everything else', () => {
		expect(validateInboxSearch({ sort: 'oldest' })).toEqual({ sort: InboxSortOrder.Oldest });
		// The default carries no URL noise, and a hand-typed value never reaches
		// the comparator.
		expect(validateInboxSearch({ sort: 'newest' })).toEqual({ sort: undefined });
		expect(validateInboxSearch({ sort: 'bogus' })).toEqual({ sort: undefined });
		expect(validateInboxSearch({})).toEqual({ sort: undefined });
	});

	test('isInboxSortOrder rejects a non-order', () => {
		expect(isInboxSortOrder('oldest')).toBe(true);
		expect(isInboxSortOrder('alphabetical')).toBe(false);
		expect(isInboxSortOrder(undefined)).toBe(false);
	});
});

test('the project inbox sort pills reorder the list and track the URL', async () => {
	const r = await setup();
	await r.router.navigate({ to: '/projects/$projectId/inbox', params: { projectId: r.ref.slug } });

	// Default is newest first, and the default leaves no param behind.
	await waitFor(() => expect(cardOrder(r.container)).toEqual([NEW, MID, OLD]), {
		timeout: 15_000,
	});
	expect(currentSort(r.router)).toBeUndefined();

	const sortGroup = await r.findByRole('group', { name: 'Sort' });
	await r.user.click(within(sortGroup).getByText('Oldest'));

	await waitFor(() => expect(cardOrder(r.container)).toEqual([OLD, MID, NEW]));
	expect(currentSort(r.router)).toBe('oldest');

	await r.user.click(within(sortGroup).getByText('Newest'));
	await waitFor(() => expect(cardOrder(r.container)).toEqual([NEW, MID, OLD]));
	expect(currentSort(r.router)).toBeUndefined();
});

test('an invalid sort search param falls back to newest first', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: r.ref.slug },
		// Cast simulates a hand-typed URL carrying an invalid ?sort= value, which
		// validateSearch must drop back to the default.
		search: { sort: 'bogus' as InboxSortOrder },
	});

	await waitFor(() => expect(cardOrder(r.container)).toEqual([NEW, MID, OLD]), {
		timeout: 15_000,
	});
	expect(currentSort(r.router)).toBeUndefined();
});

test('the sort pills reach the global inbox too', async () => {
	const r = await setup();
	await r.router.navigate({ to: '/home/inbox' });

	await waitFor(() => expect(cardOrder(r.container)).toEqual([NEW, MID, OLD]), {
		timeout: 15_000,
	});

	const sortGroup = await r.findByRole('group', { name: 'Sort' });
	await r.user.click(within(sortGroup).getByText('Oldest'));

	await waitFor(() => expect(cardOrder(r.container)).toEqual([OLD, MID, NEW]));
	expect(currentSort(r.router)).toBe('oldest');
});

test('the sort survives a reload of the same URL', async () => {
	const r = await setup();
	await r.router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: r.ref.slug },
		search: { sort: InboxSortOrder.Oldest },
	});

	await waitFor(() => expect(cardOrder(r.container)).toEqual([OLD, MID, NEW]), {
		timeout: 15_000,
	});
	const sortGroup = await r.findByRole('group', { name: 'Sort' });
	expect(within(sortGroup).getByText('Oldest').getAttribute('aria-pressed')).toBe('true');
});
