import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

/** Insert an unread @admin mention on a task — one outstanding inbox item for the team. */
async function seedUnreadAdminMention(
	workspace: SeededWorkspace,
	task: SeededTask,
	text: string,
): Promise<void> {
	const { db } = getTestContext();
	const architect = workspace.agents.find((a) => a.slug === 'architect');
	if (!architect) throw new Error('seedUnreadAdminMention: architect agent missing');

	const userRow = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin'
		 LIMIT 1`,
		[workspace.team.id],
	);
	const userId = userRow.rows[0]?.user_id;
	if (!userId) throw new Error('seedUnreadAdminMention: no admin on team');

	const commentRow = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[task.id, architect.id, JSON.stringify({ text })],
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)`,
		[workspace.team.id, task.id, commentRow.rows[0].id, userId],
	);
}

/** Insert a pending approval on the HQ (internal) team — one outstanding HQ inbox item. */
async function seedHqPendingApproval(): Promise<void> {
	const { db } = getTestContext();
	const hqRow = await db.query<{ team_id: string }>(
		`SELECT team_id FROM projects WHERE is_internal = true LIMIT 1`,
	);
	const teamId = hqRow.rows[0]?.team_id;
	if (!teamId) throw new Error('seedHqPendingApproval: HQ project missing');
	await db.query(
		`INSERT INTO approvals (team_id, type, status, payload)
		 VALUES ($1, 'hire'::approval_type, 'pending'::approval_status, '{}'::jsonb)`,
		[teamId],
	);
}

test('the project rail lists an avatar for every visible project across teams', async () => {
	let alphaSlug = '';
	let betaSlug = '';
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const a = await seedWorkspace();
			const b = await seedWorkspace();
			const alpha = await seedProject(a, { name: 'Alpha' });
			const beta = await seedProject(b, { name: 'Beta' });
			alphaSlug = alpha.slug;
			betaSlug = beta.slug;
		},
	});

	await findByTestId(`project-rail-avatar-${alphaSlug}`, undefined, { timeout: 15_000 });
	await findByTestId(`project-rail-avatar-${betaSlug}`, undefined, { timeout: 15_000 });
});

test('the HQ project is pinned at the bottom of the rail and opens on click', async () => {
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Alpha' });
		},
	});

	const hq = await findByTestId('project-rail-hq', undefined, { timeout: 15_000 });
	expect(hq.getAttribute('href')).toBe('/projects/hq');
	await user.click(hq);
	await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/hq(\/|$)/));
});

test('the create-project button follows the avatar list, with HQ pinned below it', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Alpha' });
		},
	});

	// Wait for both controls to render before asserting structure.
	const newBtn = await findByTestId('project-rail-new', undefined, { timeout: 15_000 });
	const hq = await findByTestId('project-rail-hq', undefined, { timeout: 15_000 });

	// The create button lives INSIDE the scroll container as its last item, so
	// it flows directly after the last avatar while the list fits the rail (and
	// sticks to the visible bottom once the list overflows — a real-layout
	// behaviour covered by the project-rail-create-button browser specs).
	const scroll = await findByTestId('project-rail-scroll');
	expect(scroll.contains(newBtn)).toBe(true);
	const scrollItems = Array.from(
		scroll.querySelectorAll(
			'[data-testid^="project-rail-avatar-"], [data-testid="project-rail-new"]',
		),
	).map((el) => el.getAttribute('data-testid'));
	expect(scrollItems.length).toBeGreaterThan(1);
	expect(scrollItems[scrollItems.length - 1]).toBe('project-rail-new');

	// HQ stays pinned outside (below) the scroll area, after the create button.
	expect(scroll.contains(hq)).toBe(false);
	const rail = await findByTestId('project-rail');
	// querySelectorAll yields document order, so create-project must come first.
	const order = Array.from(
		rail.querySelectorAll('[data-testid="project-rail-new"], [data-testid="project-rail-hq"]'),
	).map((el) => el.getAttribute('data-testid'));
	expect(order).toEqual(['project-rail-new', 'project-rail-hq']);
});

test('clicking a project avatar opens that project menu', async () => {
	let ws!: SeededWorkspace;
	let slug = '';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			ws = await seedWorkspace();
			const p = await seedProject(ws, { name: 'Operations' });
			slug = p.slug;
		},
	});

	const avatar = await findByTestId(`project-rail-avatar-${slug}`, undefined, { timeout: 15_000 });
	await user.click(avatar);

	await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\//));
	await findByTestId('project-sidebar-name', undefined, { timeout: 15_000 });
});

test('superuser creates a new project from the rail create button', async () => {
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await user.click(await findByTestId('project-rail-new'));

	// Dialog renders into a Radix portal on document.body — query via screen.
	await user.type(screen.getByPlaceholderText('e.g. Marketing Site'), 'Research Squad');
	await user.type(
		screen.getByPlaceholderText(/What is this project/),
		'A research project for the launch.',
	);
	await user.click(await screen.findByTestId('view-all-teams'));
	// A card in the catalog opens that team's detail; "Select team" confirms it.
	await user.click(await screen.findByTestId('team-type-card-Blank'));
	await user.click(await screen.findByTestId('team-detail-select'));
	await user.click(await screen.findByTestId('create-project-submit'));

	// "Create now" provisions the team + project directly and navigates to the
	// new project's Captain planning task (project slug derived from the name).
	await waitFor(() =>
		expect(router.state.location.pathname).toMatch(/^\/projects\/research-squad\/tasks\//),
	);
});

test('rail avatars badge each project with its outstanding inbox count', async () => {
	let alphaSlug = '';
	let betaSlug = '';
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			// Alpha has one unread @admin mention — an outstanding inbox item.
			const a = await seedWorkspace();
			const alpha = await seedProject(a, { name: 'Alpha' });
			const task = await seedTask(a, alpha, { title: 'Decide on the rollout' });
			await seedUnreadAdminMention(a, task, '@admin please weigh in on shipping.');
			alphaSlug = alpha.slug;

			// Beta (a separate team/project) has nothing outstanding.
			const b = await seedWorkspace();
			const beta = await seedProject(b, { name: 'Beta' });
			betaSlug = beta.slug;
		},
	});

	// Alpha's avatar carries a pink overlay badge with its unread count.
	const badge = await findByTestId(`project-rail-inbox-badge-${alphaSlug}`, undefined, {
		timeout: 15_000,
	});
	expect(badge.textContent).toContain('1');

	// Beta renders an avatar but no badge — a count of 0 never shows.
	await findByTestId(`project-rail-avatar-${betaSlug}`, undefined, { timeout: 15_000 });
	expect(queryByTestId(`project-rail-inbox-badge-${betaSlug}`)).toBeNull();
});

test('the mobile drawer rail exposes a Home button that the desktop rail omits', async () => {
	const { findByTestId, queryByTestId, getByTestId, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	// The persistent (desktop) rail has no Home button — the header logo links home there.
	await findByTestId('project-rail', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-rail-home')).toBeNull();

	// Opening the side drawer (the logo doubles as the toggle below lg) surfaces it.
	await user.click(getByTestId('mobile-nav-toggle'));
	const drawer = await findByTestId('mobile-nav-drawer');
	const home = await findByTestId('project-rail-home', undefined, { timeout: 15_000 });
	expect(drawer.contains(home)).toBe(true);
	expect(home.getAttribute('href')).toBe('/home');

	await user.click(home);
	await waitFor(() => expect(router.state.location.pathname).toBe('/home'));
});

test('the pinned HQ entry badges HQ outstanding inbox items', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
			await seedHqPendingApproval();
		},
	});

	const badge = await findByTestId('project-rail-hq-inbox-badge', undefined, { timeout: 15_000 });
	expect(Number(badge.textContent)).toBeGreaterThanOrEqual(1);
});
