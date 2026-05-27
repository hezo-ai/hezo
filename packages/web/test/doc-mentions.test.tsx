import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('bare kb and project-doc references render as tooltip-ed links and navigate to the doc editor', async () => {
	let fix: {
		teamSlug: string;
		projectSlug: string;
		taskIdentifier: string;
		kbSlug: string;
		kbTitle: string;
		docFilename: string;
	};
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Doc Mention Project' });

			const kbSuffix = Math.random().toString(36).slice(2, 8);
			const kbTitle = `Onboarding Guide ${kbSuffix}`;
			const kbSlug = `onboarding-guide-${kbSuffix}.md`;
			const docFilename = `runbook-${kbSuffix}.md`;

			await apiBase(`/api/teams/${ws.team.id}/kb-docs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: kbTitle, content: 'Hello onboarding world' }),
			});
			await apiBase(`/api/teams/${ws.team.id}/projects/${project.slug}/docs/${docFilename}`, {
				method: 'PUT',
				headers: ws.headers,
				body: JSON.stringify({ content: 'Runbook step A.\nRunbook step B.' }),
			});

			const captain = ws.agents.find((a) => a.slug === 'captain');
			if (!captain) throw new Error('Captain required');
			const task = await seedTask(ws, project, {
				title: 'Doc mention host task',
				description: `See ${kbSlug} and ${docFilename} for context.`,
				assignee_id: captain.id,
			});
			fix = {
				teamSlug: ws.team.slug,
				projectSlug: project.slug,
				taskIdentifier: task.identifier.toLowerCase(),
				kbSlug,
				kbTitle,
				docFilename,
			};
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: fix!.teamSlug,
			projectId: fix!.projectSlug,
			taskId: fix!.taskIdentifier,
		},
	});

	const kbLink = await findByTestId('kb-mention-link', undefined, { timeout: 10_000 });
	expect(kbLink.textContent).toContain(fix!.kbSlug);

	const docLink = await findByTestId('doc-mention-link');
	expect(docLink.textContent).toContain(fix!.docFilename);

	await user.click(kbLink);
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(`/teams/${fix!.teamSlug}/kb`);
		expect(router.state.location.search).toEqual(
			expect.objectContaining({
				slug: `onboarding-guide-${fix!.kbSlug.replace(/^onboarding-guide-/, '')}`,
			}),
		);
	});
});

test('mention picker opens on @ and inserts the selected handle', async () => {
	let fix: {
		teamSlug: string;
		projectSlug: string;
		taskIdentifier: string;
		kbSlug: string;
		kbSuffix: string;
	};
	const { findByPlaceholderText, findByTestId, findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Picker Project' });

			const kbSuffix = Math.random().toString(36).slice(2, 8);
			const kbTitle = `Picker Doc ${kbSuffix}`;
			const kbSlug = `picker-doc-${kbSuffix}.md`;
			await apiBase(`/api/teams/${ws.team.id}/kb-docs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: kbTitle, content: 'Picker content.' }),
			});

			const captain = ws.agents.find((a) => a.slug === 'captain');
			if (!captain) throw new Error('Captain required');
			const task = await seedTask(ws, project, {
				title: 'Picker host',
				assignee_id: captain.id,
			});
			fix = {
				teamSlug: ws.team.slug,
				projectSlug: project.slug,
				taskIdentifier: task.identifier.toLowerCase(),
				kbSlug,
				kbSuffix,
			};
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: fix!.teamSlug,
			projectId: fix!.projectSlug,
			taskId: fix!.taskIdentifier,
		},
	});

	const commentBox = (await findByPlaceholderText('Add a comment...')) as HTMLTextAreaElement;
	await user.click(commentBox);
	await user.type(commentBox, `Reference @picker-doc-${fix!.kbSuffix.slice(0, 3)}`, {
		delay: null,
	});

	await findByTestId('mention-picker', undefined, { timeout: 5_000 });

	await waitFor(async () => {
		const options = await findAllByTestId('mention-option-kb');
		const match = options.find((o) => o.textContent?.includes(fix!.kbSlug));
		expect(match).toBeDefined();
	});
	const options = await findAllByTestId('mention-option-kb');
	const match = options.find((o) => o.textContent?.includes(fix!.kbSlug))!;
	await user.click(match);

	await waitFor(() => {
		expect(commentBox.value).toMatch(new RegExp(`${fix!.kbSlug.replace(/\./g, '\\.')} `));
	});
});

test('rendered markdown autolinks only real entities and leaves look-alikes as text', async () => {
	let fix: { teamSlug: string; projectSlug: string; hostIdentifier: string };
	const { findAllByTestId, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mixed Mentions' });

			const kbSuffix = Math.random().toString(36).slice(2, 8);
			const kbSlug = `coding-standards-${kbSuffix}.md`;
			const docFilename = `spec-${kbSuffix}.md`;

			await apiBase(`/api/teams/${ws.team.id}/kb-docs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					title: `Coding Standards ${kbSuffix}`,
					slug: kbSlug,
					content: 'Prefer early returns.',
				}),
			});
			await apiBase(`/api/teams/${ws.team.id}/projects/${project.slug}/docs/${docFilename}`, {
				method: 'PUT',
				headers: ws.headers,
				body: JSON.stringify({ content: 'Spec body.' }),
			});

			const captain = ws.agents.find((a) => a.slug === 'captain');
			if (!captain) throw new Error('Captain required');
			const target = await seedTask(ws, project, {
				title: 'Target for mixed mentions',
				assignee_id: captain.id,
			});

			const body = [
				`See ${target.identifier} and ${docFilename} and ${kbSlug} with @captain.`,
				`Look-alikes that must stay plain text: UTF-8, ${target.identifier}x, \`${target.identifier}\` and \`${docFilename}\`.`,
			].join('\n\n');

			const host = await seedTask(ws, project, {
				title: 'Host for mixed mentions',
				description: body,
				assignee_id: captain.id,
			});

			fix = {
				teamSlug: ws.team.slug,
				projectSlug: project.slug,
				hostIdentifier: host.identifier.toLowerCase(),
			};
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: fix!.teamSlug,
			projectId: fix!.projectSlug,
			taskId: fix!.hostIdentifier,
		},
	});

	await findByTestId('task-mention-link', undefined, { timeout: 10_000 });
	await waitFor(async () => {
		expect((await findAllByTestId('task-mention-link')).length).toBe(1);
		expect((await findAllByTestId('doc-mention-link')).length).toBe(1);
		expect((await findAllByTestId('kb-mention-link')).length).toBe(1);
		expect((await findAllByTestId('agent-mention-link')).length).toBe(1);
	});
});
