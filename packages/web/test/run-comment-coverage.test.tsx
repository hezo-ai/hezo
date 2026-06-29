import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom). Covers the RunComment / RunCommentBody branches
// that run-comment-retry.test.tsx and run-comment-formatted-log.test.tsx don't
// reach: the created-tasks / created-docs / created-skills / proposed-skills
// link lists, the actor-name attribution, and the cost + duration summary on a
// completed run. The comments + heartbeat-run endpoints are stubbed so the run
// payload is deterministic.

const RUN_ID = 'dddd0000-0000-0000-0000-000000000aaa';

type Agent = { id: string; slug: string };

function runComment(taskRowId: string, agent: Agent): Record<string, unknown> {
	return {
		id: 'rc1',
		task_id: taskRowId,
		content_type: 'run',
		content: {
			run_id: RUN_ID,
			agent_id: agent.id,
			agent_title: 'Captain',
			agent_slug: agent.slug,
			actor_name: 'Ada Operator',
		},
		chosen_option: null,
		created_at: '2026-05-20T11:30:00Z',
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: agent.id,
	};
}

function runResponse(
	agent: Agent,
	teamId: string,
	taskRowId: string,
	projectSlug: string,
): Record<string, unknown> {
	return {
		id: RUN_ID,
		member_id: agent.id,
		team_id: teamId,
		task_id: taskRowId,
		task_identifier: null,
		task_title: null,
		project_id: null,
		project_slug: projectSlug,
		status: 'succeeded',
		queued_reason: null,
		started_at: '2026-05-20T11:30:00Z',
		finished_at: '2026-05-20T11:30:45Z',
		exit_code: 0,
		error: null,
		input_tokens: 100,
		output_tokens: 50,
		cost_cents: 137,
		usage_partial: false,
		log_text: 'all done',
		created_tasks: [
			{ id: 'ct1', identifier: 'OPS-22', title: 'Follow-up task', project_slug: projectSlug },
		],
		created_docs: [{ filename: 'design.md', project_slug: projectSlug }],
		created_skills: [
			{
				name: 'Deploy Skill',
				slug: 'deploy-skill',
				created: true,
				source_url: 'https://skills.sh/x',
			},
		],
		proposed_skills: [{ name: 'Proposed Skill', slug: 'proposed-skill' }],
	};
}

test('a completed run renders cost, duration, actor, and the created/proposed artifact links', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Cov Project' });
			const task = await seedTask(ws, project, { title: 'Run Cov Task', assignee_id: captain.id });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
					return new Response(JSON.stringify({ data: [runComment(task.id, captain)] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (
					method === 'GET' &&
					/\/api\/projects\/[^/]+\/agents\/[^/]+\/heartbeat-runs\/[^/?]+/.test(url)
				) {
					return new Response(
						JSON.stringify({ data: runResponse(captain, ws.team.id, task.id, project.slug) }),
						{ status: 200, headers: { 'Content-Type': 'application/json' } },
					);
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The completed-run summary row carries the duration and cost.
	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	const duration = await findByTestId('run-comment-duration');
	expect(duration.textContent).toBeTruthy();
	const cost = await findByTestId('run-comment-cost');
	expect(cost.textContent).toContain('$1.37');

	// Actor attribution.
	const actor = await findByTestId('run-comment-actor');
	expect(actor.textContent).toContain('Ada Operator');

	// Artifact link blocks all render.
	const createdTasks = await findByTestId('run-comment-created-tasks');
	expect(createdTasks.textContent).toContain('OPS-22');
	const createdDocs = await findByTestId('run-comment-created-docs');
	expect(createdDocs.textContent).toContain('design.md');
	const createdSkills = await findByTestId('run-comment-created-skills');
	expect(createdSkills.textContent).toContain('Deploy Skill');
	// Skill source label is the source URL's hostname.
	expect(createdSkills.textContent).toContain('skills.sh');
	const proposedSkills = await findByTestId('run-comment-proposed-skills');
	expect(proposedSkills.textContent).toContain('Proposed Skill');
});

test('a run comment missing its run_id renders the "Run reference missing" fallback', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Missing Project' });
			const task = await seedTask(ws, project, {
				title: 'Run Missing Task',
				assignee_id: captain.id,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const brokenComment = {
				id: 'rc-broken',
				task_id: task.id,
				content_type: 'run',
				// No run_id / agent_id → the renderer short-circuits to the fallback.
				content: { agent_title: 'Captain' },
				chosen_option: null,
				created_at: '2026-05-20T11:30:00Z',
				author_type: 'agent',
				author_name: 'Captain',
				author_member_id: captain.id,
			};

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
					return new Response(JSON.stringify({ data: [brokenComment] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByText('Run reference missing.', undefined, { timeout: 20_000 });
});
