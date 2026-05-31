import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

function buildFetchMock(opts: {
	runId: string;
	runComment: Record<string, unknown>;
	runResponse: Record<string, unknown>;
}) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

		if (method === 'GET' && /\/api\/teams\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
			return new Response(JSON.stringify({ data: [opts.runComment] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (
			method === 'GET' &&
			new RegExp(`/api/teams/[^/]+/agents/[^/]+/heartbeat-runs/${opts.runId}$`).test(url)
		) {
			return new Response(JSON.stringify({ data: opts.runResponse }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return originalFetch(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

test('run comment shows created tickets as links to their pages', async () => {
	const seeded = {
		teamSlug: '',
		taskId: '',
		projectSlug: '',
	};

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Spawned Tickets Project' });
			const task = await seedTask(ws, project, {
				title: 'Parent With Spawns',
				assignee_id: captain.id,
			});

			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.projectSlug = project.slug;

			const runId = '99999999-9999-9999-9999-999999999999';
			const spawnedA = {
				id: '11111111-1111-1111-1111-111111111111',
				identifier: 'SPAWN-900',
				title: 'Refactor auth',
				project_slug: project.slug,
			};
			const spawnedB = {
				id: '22222222-2222-2222-2222-222222222222',
				identifier: 'SPAWN-901',
				title: 'Add tests for X',
				project_slug: project.slug,
			};

			const runComment = {
				id: 'aaaa0000-0000-0000-0000-000000000001',
				task_id: task.id,
				content_type: 'run',
				content: { run_id: runId, agent_id: captain.id, agent_title: 'Captain' },
				chosen_option: null,
				created_at: new Date().toISOString(),
				author_type: 'agent',
				author_name: 'Captain',
				author_member_id: captain.id,
			};

			const runResponse = {
				id: runId,
				member_id: captain.id,
				team_id: ws.team.id,
				task_id: task.id,
				task_identifier: 'PARENT-1',
				task_title: 'Parent With Spawns',
				project_id: project.id,
				status: 'succeeded',
				started_at: new Date().toISOString(),
				finished_at: new Date().toISOString(),
				exit_code: 0,
				error: null,
				input_tokens: 0,
				output_tokens: 0,
				cost_cents: 0,
				invocation_command: null,
				log_text: 'done',
				working_dir: null,
				created_tasks: [spawnedA, spawnedB],
			};

			buildFetchMock({ runId, runComment, runResponse });
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });

	const createdSection = await findByTestId('run-comment-created-tasks', undefined, {
		timeout: 20_000,
	});

	const links = Array.from(createdSection.querySelectorAll('a')) as HTMLAnchorElement[];
	const linkA = links.find((a) => a.textContent === 'Created ticket SPAWN-900 — Refactor auth');
	const linkB = links.find((a) => a.textContent === 'Created ticket SPAWN-901 — Add tests for X');
	expect(linkA).toBeTruthy();
	expect(linkB).toBeTruthy();
	expect(linkA?.getAttribute('href')).toBe(
		`/teams/${seeded.teamSlug}/projects/${seeded.projectSlug}/tasks/spawn-900`,
	);
	expect(linkB?.getAttribute('href')).toBe(
		`/teams/${seeded.teamSlug}/projects/${seeded.projectSlug}/tasks/spawn-901`,
	);
});

test('run comment omits created tickets section when list is empty', async () => {
	const seeded = { teamSlug: '', taskId: '' };

	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Empty Project' });
			const task = await seedTask(ws, project, {
				title: 'Parent No Spawns',
				assignee_id: captain.id,
			});

			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;

			const runId = '99999999-9999-9999-9999-000000000002';
			const runComment = {
				id: 'aaaa0000-0000-0000-0000-000000000002',
				task_id: task.id,
				content_type: 'run',
				content: { run_id: runId, agent_id: captain.id, agent_title: 'Captain' },
				chosen_option: null,
				created_at: new Date().toISOString(),
				author_type: 'agent',
				author_name: 'Captain',
				author_member_id: captain.id,
			};

			const runResponse = {
				id: runId,
				member_id: captain.id,
				team_id: ws.team.id,
				task_id: task.id,
				status: 'succeeded',
				started_at: new Date().toISOString(),
				finished_at: new Date().toISOString(),
				exit_code: 0,
				error: null,
				input_tokens: 0,
				output_tokens: 0,
				cost_cents: 0,
				log_text: 'done',
				created_tasks: [],
			};

			buildFetchMock({ runId, runComment, runResponse });
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });
	// Wait for the heartbeat-run to load before asserting no created-tasks section.
	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-comment-created-tasks')).toBeNull();
});

test('run comment links updated docs, skills, and proposed skills', async () => {
	const seeded = { teamSlug: '', taskId: '', projectSlug: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Docs And Skills Project' });
			const task = await seedTask(ws, project, {
				title: 'Outputs Parent',
				assignee_id: captain.id,
			});

			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.projectSlug = project.slug;

			const runId = '99999999-9999-9999-9999-000000000003';
			const runComment = {
				id: 'aaaa0000-0000-0000-0000-000000000003',
				task_id: task.id,
				content_type: 'run',
				content: { run_id: runId, agent_id: captain.id, agent_title: 'Architect' },
				chosen_option: null,
				created_at: new Date().toISOString(),
				author_type: 'agent',
				author_name: 'Architect',
				author_member_id: captain.id,
			};

			const runResponse = {
				id: runId,
				member_id: captain.id,
				team_id: ws.team.id,
				task_id: task.id,
				status: 'succeeded',
				started_at: new Date().toISOString(),
				finished_at: new Date().toISOString(),
				exit_code: 0,
				error: null,
				input_tokens: 0,
				output_tokens: 0,
				cost_cents: 0,
				log_text: 'done',
				created_tasks: [],
				created_docs: [{ filename: 'spec.md', project_slug: project.slug }],
				created_skills: [
					{ name: 'Deploy Flow', slug: 'deploy-flow', created: true },
					{ name: 'Triage', slug: 'triage', created: false },
				],
				proposed_skills: [{ name: 'Linear Triage', slug: 'linear-triage' }],
			};

			buildFetchMock({ runId, runComment, runResponse });
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });

	const docsSection = await findByTestId('run-comment-created-docs', undefined, {
		timeout: 20_000,
	});
	const docLink = docsSection.querySelector('a') as HTMLAnchorElement | null;
	expect(docLink?.textContent).toBe('Updated spec.md');
	expect(docLink?.getAttribute('href')).toBe(
		`/teams/${seeded.teamSlug}/projects/${seeded.projectSlug}/documents?file=spec.md`,
	);

	const skillsSection = await findByTestId('run-comment-created-skills');
	const skillLinks = Array.from(skillsSection.querySelectorAll('a')) as HTMLAnchorElement[];
	const added = skillLinks.find((a) => a.textContent === 'Added skill Deploy Flow');
	const updated = skillLinks.find((a) => a.textContent === 'Updated skill Triage');
	expect(added?.getAttribute('href')).toBe(`/teams/${seeded.teamSlug}/skills?slug=deploy-flow`);
	expect(updated?.getAttribute('href')).toBe(`/teams/${seeded.teamSlug}/skills?slug=triage`);

	const proposedSection = await findByTestId('run-comment-proposed-skills');
	const proposedLink = proposedSection.querySelector('a') as HTMLAnchorElement | null;
	expect(proposedLink?.textContent).toBe('Proposed skill Linear Triage');
	expect(proposedLink?.getAttribute('href')).toBe(`/teams/${seeded.teamSlug}/inbox`);
});
