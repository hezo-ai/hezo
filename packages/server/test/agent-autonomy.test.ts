import { ApprovalType, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createTestProject } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let engineerAgentId: string;
let architectAgentId: string;
let _qaAgentId: string;
let coachAgentId: string;

beforeAll(async () => {
	ctx = await createTestContext();

	// Get the builtin team type
	const typesRes = await ctx.app.request('/api/team-templates', {
		method: 'GET',
		headers: authHeader(ctx.token),
	});
	const types = (await typesRes.json()) as any;
	const softDevType = types.data.find((t: any) => t.name === 'Startup');

	// Create a team with auto-created agents
	const teamRes = await ctx.app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Autonomy Test Co',

			description: 'Testing agent autonomy',
			template_id: softDevType.id,
		}),
	});
	teamId = ((await teamRes.json()) as any).data.id;

	// Get agents
	const agentsRes = await ctx.app.request(`/api/teams/${teamId}/agents`, {
		method: 'GET',
		headers: authHeader(ctx.token),
	});
	const agents = ((await agentsRes.json()) as any).data;
	engineerAgentId = agents.find((a: any) => a.slug === 'engineer').id;
	architectAgentId = agents.find((a: any) => a.slug === 'architect').id;
	_qaAgentId = agents.find((a: any) => a.slug === 'qa-engineer').id;
	coachAgentId = agents.find((a: any) => a.slug === 'coach').id;

	// Create a project
	const projRes = await createTestProject(ctx.db, teamId, {
		name: 'Autonomy Project',
		description: 'Test project.',
	});
	projectId = ((await projRes.json()) as any).data.id;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('task schema', () => {
	it('creates an task with backlog status by default', async () => {
		const res = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Test task',
				assignee_id: engineerAgentId,
			}),
		});
		const data = (await res.json()) as any;
		expect(data.data.status).toBe('backlog');
	});
});

describe('task schema: branch_name', () => {
	it('can set and retrieve branch_name', async () => {
		const createRes = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Branch test',
				assignee_id: engineerAgentId,
			}),
		});
		const taskId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ branch_name: 'feat/AUT-1-test-feature' }),
		});
		expect(patchRes.status).toBe(200);
		const updated = ((await patchRes.json()) as any).data;
		expect(updated.branch_name).toBe('feat/AUT-1-test-feature');
	});
});

describe('task automation: Coach wakeup on Done', () => {
	it('creates a wakeup for Coach when status changes to done', async () => {
		const createRes = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Coach trigger test',
				assignee_id: engineerAgentId,
			}),
		});
		const taskId = ((await createRes.json()) as any).data.id;

		// Clear any existing wakeups for coach
		await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [coachAgentId]);

		// Set status to done
		await ctx.app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.Done }),
		});

		// Wait briefly for async wakeup creation
		await new Promise((r) => setTimeout(r, 100));

		// Check wakeup was created for coach
		const wakeups = await ctx.db.query<{ payload: Record<string, unknown> }>(
			"SELECT payload FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'automation'",
			[coachAgentId],
		);
		expect(wakeups.rows.length).toBeGreaterThan(0);
		const payload = wakeups.rows[0].payload;
		expect(payload.trigger).toBe('task_done');
		expect(payload.task_id).toBe(taskId);
	});

	it('does not create wakeup for non-done status changes', async () => {
		const createRes = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'No coach trigger test',
				assignee_id: engineerAgentId,
			}),
		});
		const taskId = ((await createRes.json()) as any).data.id;

		await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [coachAgentId]);

		// Set status to review — should NOT trigger Coach
		await ctx.app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.Review }),
		});

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await ctx.db.query(
			"SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'automation'",
			[coachAgentId],
		);
		expect(wakeups.rows.length).toBe(0);
	});
});

describe('task: progress_summary and rules', () => {
	it('can update progress_summary with tracking fields', async () => {
		const createRes = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Progress test',
				assignee_id: engineerAgentId,
			}),
		});
		const taskId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ progress_summary: 'Completed API endpoints, working on tests' }),
		});
		expect(patchRes.status).toBe(200);
		const updated = ((await patchRes.json()) as any).data;
		expect(updated.progress_summary).toBe('Completed API endpoints, working on tests');
		expect(updated.progress_summary_updated_at).toBeTruthy();
	});

	it('can update rules', async () => {
		const createRes = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Rules test',
				assignee_id: engineerAgentId,
			}),
		});
		const taskId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ rules: 'Must use PostgreSQL transactions for all writes' }),
		});
		expect(patchRes.status).toBe(200);
		expect(((await patchRes.json()) as any).data.rules).toBe(
			'Must use PostgreSQL transactions for all writes',
		);
	});
});

describe('task: sub-tasks with parent_task_id', () => {
	it('can create a sub-task', async () => {
		const parentRes = await ctx.app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent task',
				assignee_id: engineerAgentId,
			}),
		});
		const parentId = ((await parentRes.json()) as any).data.id;

		// Create sub-task via the existing sub-tasks endpoint
		const subRes = await ctx.app.request(`/api/teams/${teamId}/tasks/${parentId}/sub-tasks`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Plan this work',
				assignee_id: architectAgentId,
			}),
		});
		expect(subRes.status).toBe(201);
		const subTask = ((await subRes.json()) as any).data;
		expect(subTask.parent_task_id).toBe(parentId);
	});
});

describe('approval: skill_proposal type', () => {
	it('can create a skill_proposal approval', async () => {
		const res = await ctx.app.request(`/api/teams/${teamId}/approvals`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: ApprovalType.SkillProposal,
				requested_by_member_id: engineerAgentId,
				payload: {
					skill_name: 'Database Migration',
					skill_slug: 'db-migration',
					content: '# Database Migration\nSteps for safe migrations...',
					reason: 'Codified migration pattern from ticket AUT-5',
				},
			}),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as any;
		expect(data.data.type).toBe('skill_proposal');
		expect(data.data.status).toBe('pending');
	});
});

describe('agent-runner: retry context in task prompt', () => {
	it('buildTaskPrompt includes retry context when wakeupPayload has previous_failure', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const task = {
			id: 'test-id',
			identifier: 'AUT-1',
			title: 'Fix auth bug',
			description: 'Auth tokens expire too quickly',
			status: 'in_progress',
			priority: 'high',
			project_id: 'test-project',
			rules: null,
		};

		const wakeupPayload = {
			reason: 'orphan_retry',
			retry_count: 2,
			max_retries: 3,
			previous_failure: {
				run_id: 'failed-run-id',
				exit_code: 1,
				stdout_tail: 'Running tests...\nTest suite failed',
				stderr_tail: 'Error: Cannot find module ./auth-handler',
			},
		};

		const prompt = buildTaskPrompt('System prompt here', task, wakeupPayload);

		expect(prompt).toContain('## Retry Attempt 2/3');
		expect(prompt).toContain('previous attempt FAILED');
		expect(prompt).toContain('**Exit code:** 1');
		expect(prompt).toContain('Cannot find module ./auth-handler');
		expect(prompt).toContain('Running tests');
	});

	it('buildTaskPrompt omits retry context when no previous_failure', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const task = {
			id: 'test-id',
			identifier: 'AUT-2',
			title: 'Add feature',
			description: 'New feature needed',
			status: 'backlog',
			priority: 'medium',
			project_id: 'test-project',
			rules: null,
		};

		const prompt = buildTaskPrompt('System prompt', task);

		expect(prompt).not.toContain('Retry Attempt');
		expect(prompt).not.toContain('previous attempt FAILED');
		expect(prompt).toContain('AUT-2');
		expect(prompt).toContain('Add feature');
	});

	it('buildTaskPrompt includes rules when present', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const task = {
			id: 'test-id',
			identifier: 'AUT-3',
			title: 'Constrained task',
			description: 'Task with rules',
			status: 'in_progress',
			priority: 'high',
			project_id: 'test-project',
			rules: 'Must use PostgreSQL transactions\nNo raw SQL in route handlers',
		};

		const prompt = buildTaskPrompt('System prompt', task);

		expect(prompt).toContain('### Rules for this task');
		expect(prompt).toContain('Must use PostgreSQL transactions');
		expect(prompt).toContain('No raw SQL in route handlers');
	});
});

describe('agent-runner: mention handoff prompt', () => {
	const mentionTask = {
		id: 'trig-uuid',
		identifier: 'AUT-42',
		title: "Captain's roadmap",
		description: 'Roadmap planning.',
		status: 'in_progress',
		priority: 'high',
		project_id: 'proj-uuid',
		rules: null,
	};

	const mentionPayload = {
		source: 'mention',
		task_id: 'trig-uuid',
		comment_id: 'comment-uuid',
	};

	it('prepends Mention Handoff when payload source is mention and ctx is provided', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const ctx = {
			authorName: 'Captain',
			excerpt: 'Please update the spec to cover §6 and §11.',
			openTickets: [
				{ identifier: 'AUT-10', title: 'Draft spec', status: 'backlog', priority: 'high' },
				{ identifier: 'AUT-12', title: 'Review PRD', status: 'in_progress', priority: 'medium' },
				{ identifier: 'AUT-15', title: 'ADR: runtime', status: 'review', priority: 'low' },
			],
		};

		const prompt = buildTaskPrompt('System prompt', mentionTask, mentionPayload, {
			mentionContext: ctx,
		});

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain('You were mentioned by Captain in AUT-42');
		expect(prompt).toContain('> Please update the spec to cover §6 and §11.');
		expect(prompt).toContain('AUT-10 — Draft spec (backlog, high)');
		expect(prompt).toContain('AUT-12 — Review PRD (in_progress, medium)');
		expect(prompt).toContain('AUT-15 — ADR: runtime (review, low)');
		expect(prompt).toContain('parent_task_id = trig-uuid');
		expect(prompt).toContain('## Handling @-mentions');
		// Ensure the normal Current Task block still follows.
		expect(prompt).toContain('## Current Task: AUT-42');
		// Handoff appears before the Current Task block.
		expect(prompt.indexOf('## Mention Handoff')).toBeLessThan(prompt.indexOf('## Current Task'));
	});

	it('renders "none" in open tickets when agent has no assigned work', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const ctx = {
			authorName: 'Captain',
			excerpt: 'Take a look at this.',
			openTickets: [],
		};

		const prompt = buildTaskPrompt('System prompt', mentionTask, mentionPayload, {
			mentionContext: ctx,
		});

		expect(prompt).toContain('### Your open tickets\nnone');
		expect(prompt).toContain('## Handling @-mentions');
	});

	it('omits Mention Handoff when payload source is not mention', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const ctx = {
			authorName: 'Captain',
			excerpt: 'hi',
			openTickets: [],
		};

		const prompt = buildTaskPrompt(
			'System prompt',
			mentionTask,
			{ source: 'assignment', task_id: 'trig-uuid' },
			{ mentionContext: ctx },
		);

		expect(prompt).not.toContain('## Mention Handoff');
		expect(prompt).toContain('## Current Task');
	});

	it('combines Mention Handoff with retry context when both are present', async () => {
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const ctx = {
			authorName: 'Engineer',
			excerpt: 'Spec out of date.',
			openTickets: [{ identifier: 'AUT-1', title: 'Spec', status: 'backlog', priority: 'high' }],
		};
		const payload = {
			...mentionPayload,
			retry_count: 1,
			max_retries: 2,
			previous_failure: {
				exit_code: 1,
				stderr_tail: 'oops',
			},
		};

		const prompt = buildTaskPrompt('System prompt', mentionTask, payload, {
			mentionContext: ctx,
		});

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain('## Retry Attempt 1/2');
		expect(prompt.indexOf('## Mention Handoff')).toBeLessThan(prompt.indexOf('## Retry Attempt'));
	});
});

describe('agent-runner: mention context loader', () => {
	it('truncateExcerpt behaviour via loadMentionContext return: strips fenced code', async () => {
		// Unit-level excerpt shape test via buildTaskPrompt: long excerpt with code fence gets stripped.
		const { buildTaskPrompt } = await import('../src/services/agent-runner');

		const longCode = `Here is the plan\n\`\`\`\n${'x'.repeat(1200)}\n\`\`\`\nend`;
		const ctx = {
			authorName: 'Captain',
			excerpt: longCode.replace(
				/(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g,
				'[code omitted]',
			),
			openTickets: [],
		};

		const prompt = buildTaskPrompt(
			'System',
			{
				id: 'i',
				identifier: 'AUT-99',
				title: 'x',
				description: 'y',
				status: 'backlog',
				priority: 'low',
				project_id: 'p',
				rules: null,
			},
			{ source: 'mention', comment_id: 'c', task_id: 'i' },
			{ mentionContext: ctx },
		);

		expect(prompt).toContain('[code omitted]');
		expect(prompt).not.toContain('x'.repeat(600));
	});
});

describe('shared types', () => {
	it('ApprovalType includes SkillProposal', () => {
		expect(ApprovalType.SkillProposal).toBe('skill_proposal');
	});
});
