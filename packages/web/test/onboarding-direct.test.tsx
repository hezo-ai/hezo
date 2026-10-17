import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

async function projectNames(): Promise<string[]> {
	const ctx = getTestContext();
	const res = await ctx.apiBase('/api/projects', {
		headers: { Authorization: `Bearer ${ctx.token}` },
	});
	return ((await res.json()) as { data: Array<{ name: string }> }).data.map((p) => p.name);
}

// First-run entry point: the landing's quiet "set a project up yourself" link opens the
// CreateProjectWithTeamDialog, the doorway to both creation flows. "Plan with the
// CEO" needs only a name and a description, since proposing a team is the CEO's
// job; "Create now" also waits for a team.
test('the welcome card opens the dialog; only Create now waits for a team', async () => {
	const { findByTestId, findByPlaceholderText, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	await user.click(
		await findByTestId('ceo-landing-create-project', undefined, { timeout: 15_000 }),
	);
	const plan = (await findByTestId('plan-with-ceo-submit')) as HTMLButtonElement;
	const create = screen.getByTestId('create-project-submit') as HTMLButtonElement;
	expect(plan.disabled).toBe(true);
	expect(create.disabled).toBe(true);

	await user.type(await findByPlaceholderText('e.g. Marketing Site'), uniqueName('Gate'));
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A project to check which action waits for a team.',
	);
	expect(plan.disabled).toBe(false);
	expect(create.disabled).toBe(true);
	expect(screen.getByTestId('plan-without-team-hint').textContent).toBe(
		'No team picked? Plan with the CEO and it will suggest one.',
	);

	await user.click(await findByTestId('view-all-teams'));
	// A card in the catalog opens that team's detail; "Select team" confirms it.
	await user.click(await findByTestId('team-type-card-Blank'));
	await user.click(await findByTestId('team-detail-select'));
	expect((screen.getByTestId('create-project-submit') as HTMLButtonElement).disabled).toBe(false);
});

// Direct flow: filling the dialog and clicking "Create now" stands up a brand-new
// team + its project and lands on that project's task list, where the CEO's
// auto-created team-setup task sorts first.
test('the direct flow creates a project in its own new team and opens its task list', async () => {
	const projectName = uniqueName('Direct Build');
	const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

	const { findByTestId, findByPlaceholderText, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	const create = await findByTestId('ceo-landing-create-project', undefined, { timeout: 15_000 });
	await user.click(create);

	await user.type(await findByPlaceholderText('e.g. Marketing Site'), projectName);
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A direct-flow project with its own dedicated team.',
	);
	await user.click(await findByTestId('view-all-teams'));
	// A card in the catalog opens that team's detail; "Select team" confirms it.
	await user.click(await findByTestId('team-type-card-Blank'));
	await user.click(await findByTestId('team-detail-select'));
	await user.click(await findByTestId('create-project-submit'));

	// Lands on the new project's task list.
	const expected = new RegExp(`^/projects/${projectSlug}/tasks$`);
	await waitFor(() => expect(router.state.location.pathname).toMatch(expected), {
		timeout: 30_000,
	});

	// The project landed in a fresh team named after it, distinct from HQ.
	const ctx = getTestContext();
	const allProjects = (
		(await (
			await ctx.apiBase('/api/projects', { headers: { Authorization: `Bearer ${ctx.token}` } })
		).json()) as { data: Array<{ name: string; slug: string; team_slug: string }> }
	).data;
	const created = allProjects.find((p) => p.name === projectName);
	expect(created).toBeTruthy();
	expect(created!.slug).toBe(projectSlug);
	expect(created!.team_slug).not.toBe('default');
}, 60_000);

// CEO-assisted flow: "Plan with the CEO" sends the form to the CEO chat as the
// admin's own first message and opens the dock. Nothing is created: the CEO
// creates the project only after the admin's go-ahead in that chat.
test('Plan with the CEO sends the form as a chat message and creates nothing', async () => {
	const projectName = uniqueName('Planned Build');

	const { findByTestId, findByPlaceholderText, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	await user.click(
		await findByTestId('ceo-landing-create-project', undefined, { timeout: 15_000 }),
	);
	await user.type(await findByPlaceholderText('e.g. Marketing Site'), projectName);
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A project we want the CEO to scope with us first.',
	);
	await user.click(await findByTestId('plan-with-ceo-submit'));

	const expected = [
		'I want to plan a new project with you.',
		`Project name: ${projectName}`,
		'Team: I did not pick one. Please suggest one.',
		'',
		'A project we want the CEO to scope with us first.',
	].join('\n');
	await waitFor(
		async () => {
			const rows = await getTestContext().db.query(
				`SELECT id FROM chat_messages WHERE role = 'user' AND content = $1`,
				[expected],
			);
			expect((rows as { rows: unknown[] }).rows.length).toBe(1);
		},
		{ timeout: 15_000 },
	);
	// The dialog closed and the CEO room opened in the dock.
	await waitFor(() => expect(screen.queryByTestId('create-project-dialog')).toBeNull());
	await findByTestId('chat-panel');
	expect(await projectNames()).not.toContain(projectName);
}, 60_000);

// A plan file rides along as an attachment on that same message, and the
// message says so, so the CEO can pass it to create_project.
test('Plan with the CEO attaches the project plan to the message', async () => {
	const projectName = uniqueName('Planned With Doc');

	const { findByTestId, findByPlaceholderText, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	await user.click(
		await findByTestId('ceo-landing-create-project', undefined, { timeout: 15_000 }),
	);
	await user.type(await findByPlaceholderText('e.g. Marketing Site'), projectName);
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A project with a written plan.',
	);
	const fileInput = document.querySelector('input[type="file"][accept=".md,.txt,.markdown"]');
	expect(fileInput).toBeTruthy();
	await user.upload(
		fileInput as HTMLInputElement,
		new File(['# Plan\n\nShip the watchlist first.'], 'plan.markdown', { type: 'text/markdown' }),
	);
	await user.click(await findByTestId('plan-with-ceo-submit'));

	await waitFor(
		async () => {
			const rows = await getTestContext().db.query(
				`SELECT m.content, a.original_filename AS name FROM chat_messages m
				 JOIN chat_message_attachments ca ON ca.chat_message_id = m.id
				 JOIN assets a ON a.id = ca.asset_id
				 WHERE m.role = 'user' AND m.content LIKE $1`,
				[`%Project name: ${projectName}%`],
			);
			const found = (rows as { rows: Array<{ content: string; name: string }> }).rows;
			expect(found).toHaveLength(1);
			expect(found[0].content).toContain('I attached my project plan.');
			expect(found[0].name).toMatch(/\.md$/);
		},
		{ timeout: 15_000 },
	);
}, 60_000);
