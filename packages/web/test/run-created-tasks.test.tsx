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

		if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
			return new Response(JSON.stringify({ data: [opts.runComment] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/[^/]+/heartbeat-runs/${opts.runId}$`).test(url)
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
		projectSlug: '',
		taskId: '',
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

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
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
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
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
	expect(linkA?.getAttribute('href')).toBe(`/projects/${seeded.projectSlug}/tasks/spawn-900`);
	expect(linkB?.getAttribute('href')).toBe(`/projects/${seeded.projectSlug}/tasks/spawn-901`);
});

test('run comment omits created tickets section when list is empty', async () => {
	const seeded = { projectSlug: '', taskId: '' };

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

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

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
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });
	// Wait for the heartbeat-run to load before asserting no created-tasks section.
	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-comment-created-tasks')).toBeNull();
});

test('run comment header shows "started by …" chip when actor_name is set', async () => {
	const seeded = { projectSlug: '', taskId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Actor Chip Project' });
			const task = await seedTask(ws, project, {
				title: 'Triggered Task',
				assignee_id: captain.id,
			});

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const runId = '99999999-9999-9999-9999-0000000000aa';
			const runComment = {
				id: 'aaaa0000-0000-0000-0000-0000000000aa',
				task_id: task.id,
				content_type: 'run',
				content: {
					run_id: runId,
					agent_id: captain.id,
					agent_title: 'Architect',
					actor_id: null,
					actor_name: 'Admin',
				},
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
				project_id: project.id,
				project_slug: project.slug,
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
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });

	const actorChip = await findByTestId('run-comment-actor', undefined, { timeout: 20_000 });
	expect(actorChip.textContent).toContain('started by Admin');
});

test('run comment links updated docs, skills, and proposed skills', async () => {
	const seeded = { projectSlug: '', taskId: '' };

	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Docs And Skills Project' });
			const task = await seedTask(ws, project, {
				title: 'Outputs Parent',
				assignee_id: captain.id,
			});

			// Seed the real doc so the preview panel renders its body when opened.
			const content = ['# Spec', '', 'An unmistakable spec body.'].join('\n');
			const docRes = await apiBase(`/api/projects/${project.slug}/docs/spec.md`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
			});
			if (!docRes.ok) throw new Error(`seed spec.md failed: ${docRes.status}`);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
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
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });

	// On the task-detail page (which hosts the preview panel) the updated-doc
	// link is a button that opens the doc in the right-rail panel — not a link to
	// the documents page.
	const docLink = (await findByTestId('run-comment-doc-link', undefined, {
		timeout: 20_000,
	})) as HTMLButtonElement;
	expect(docLink.tagName).toBe('BUTTON');
	expect(docLink.textContent).toBe('Updated spec.md');

	await user.click(docLink);

	await findByTestId('preview-panel');
	expect((await findByTestId('preview-panel-filename')).textContent).toBe('spec.md');
	await findByText(/unmistakable spec body/i);

	const skillsSection = await findByTestId('run-comment-created-skills');
	const skillLinks = Array.from(skillsSection.querySelectorAll('a')) as HTMLAnchorElement[];
	const added = skillLinks.find((a) => a.textContent === 'Added skill Deploy Flow');
	const updated = skillLinks.find((a) => a.textContent === 'Updated skill Triage');
	expect(added?.getAttribute('href')).toBe(`/settings/skills`);
	expect(updated?.getAttribute('href')).toBe(`/settings/skills`);

	const proposedSection = await findByTestId('run-comment-proposed-skills');
	const proposedLink = proposedSection.querySelector('a') as HTMLAnchorElement | null;
	expect(proposedLink?.textContent).toBe('Proposed skill Linear Triage');
	expect(proposedLink?.getAttribute('href')).toBe(`/projects/${seeded.projectSlug}/inbox`);
});
