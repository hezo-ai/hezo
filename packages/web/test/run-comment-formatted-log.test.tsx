import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';
import { expandEventGroups } from './helpers/thread';

const LOG_TEXT = [
	'[session] model=claude-opus-4 tools=42',
	'[thinking] Considering the next step.',
	'Proceeding with the change.',
	'[tool] Bash(command=ls -la, description=list files)',
	'[tool-result] total 0',
	'[done] success turns=2 duration=900ms tokens=10/20 cost=$0.0001',
].join('\n');

test('task-page run comment exposes the formatted/raw log switcher and defaults to formatted', async () => {
	const seeded = { projectSlug: '', taskId: '' };

	const { findByTestId, findByText, getByLabelText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Formatted Log Project' });
			const task = await seedTask(ws, project, {
				title: 'Formatted Log Task',
				assignee_id: captain.id,
			});

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const runId = '99999999-9999-9999-9999-00000000abcd';
			const runComment = {
				id: 'aaaa0000-0000-0000-0000-0000000000fa',
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
				project_id: project.id,
				project_slug: project.slug,
				status: 'succeeded',
				started_at: new Date().toISOString(),
				finished_at: new Date().toISOString(),
				exit_code: 0,
				error: null,
				input_tokens: 10,
				output_tokens: 20,
				cost_cents: 0,
				invocation_command: null,
				log_text: LOG_TEXT,
				working_dir: null,
				created_tasks: [],
			};

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
					return new Response(JSON.stringify({ data: [runComment] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (
					method === 'GET' &&
					new RegExp(`/api/projects/[^/]+/agents/[^/]+/heartbeat-runs/${runId}$`).test(url)
				) {
					return new Response(JSON.stringify({ data: runResponse }), {
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

	// A completed run folds in the default Conversation view; these tests are
	// about what the run row renders once opened.
	await expandEventGroups(user);

	// Wait for the run to load as completed (the summary only renders then) so the
	// header is the collapsed expand button, then click it to reveal the log viewer.
	await findByTestId('run-comment-summary', undefined, { timeout: 10_000 });
	await user.click(await findByTestId('run-comment-header'));

	// Formatted is the default view: the tool renders without its raw `[tool]`
	// prefix and the markdown body renders as prose.
	await findByText('Bash', undefined, { timeout: 10_000 });
	expect((await findByTestId('run-comment-log')).textContent).not.toContain('[tool]');

	// The switcher is present; Raw shows the literal prefixed line, Formatted hides it.
	await user.click(getByLabelText('Raw logs'));
	expect((await findByTestId('run-comment-log')).textContent).toContain(
		'[tool] Bash(command=ls -la, description=list files)',
	);

	await user.click(getByLabelText('Formatted view'));
	await findByText('Bash');
	expect((await findByTestId('run-comment-log')).textContent).not.toContain('[tool]');
});
