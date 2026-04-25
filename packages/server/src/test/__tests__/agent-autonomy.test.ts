import { ApprovalType, IssueStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';

let ctx: ServerTestContext;
let companyId: string;
let projectId: string;
let engineerAgentId: string;
let architectAgentId: string;
let _qaAgentId: string;
let coachAgentId: string;

beforeAll(async () => {
	ctx = await createTestContext();

	// Get the builtin company type
	const typesRes = await ctx.app.request('/api/company-types', {
		method: 'GET',
		headers: authHeader(ctx.token),
	});
	const types = (await typesRes.json()) as any;
	const softDevType = types.data.find((t: any) => t.name === 'Startup');

	// Create a company with auto-created agents
	const companyRes = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Autonomy Test Co',

			description: 'Testing agent autonomy',
			template_id: softDevType.id,
		}),
	});
	companyId = ((await companyRes.json()) as any).data.id;

	// Get agents
	const agentsRes = await ctx.app.request(`/api/companies/${companyId}/agents`, {
		method: 'GET',
		headers: authHeader(ctx.token),
	});
	const agents = ((await agentsRes.json()) as any).data;
	engineerAgentId = agents.find((a: any) => a.slug === 'engineer').id;
	architectAgentId = agents.find((a: any) => a.slug === 'architect').id;
	_qaAgentId = agents.find((a: any) => a.slug === 'qa-engineer').id;
	coachAgentId = agents.find((a: any) => a.slug === 'coach').id;

	// Create a project
	const projRes = await ctx.app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Autonomy Project', description: 'Test project.' }),
	});
	projectId = ((await projRes.json()) as any).data.id;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('issue schema: approved status', () => {
	it('creates an issue with backlog status by default', async () => {
		const res = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Test issue',
				assignee_id: engineerAgentId,
			}),
		});
		const data = (await res.json()) as any;
		expect(data.data.status).toBe('backlog');
	});

	it('can set status to approved', async () => {
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Approval test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Approved }),
		});
		expect(patchRes.status).toBe(200);
		const updated = ((await patchRes.json()) as any).data;
		expect(updated.status).toBe('approved');
	});

	it('approved is not a terminal status (agent can still work on it)', async () => {
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Non-terminal test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		// Set to approved
		await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Approved }),
		});

		// Can transition from approved to done
		const doneRes = await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});
		expect(doneRes.status).toBe(200);
		expect(((await doneRes.json()) as any).data.status).toBe('done');
	});
});

describe('issue schema: branch_name', () => {
	it('can set and retrieve branch_name', async () => {
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Branch test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ branch_name: 'feat/AUT-1-test-feature' }),
		});
		expect(patchRes.status).toBe(200);
		const updated = ((await patchRes.json()) as any).data;
		expect(updated.branch_name).toBe('feat/AUT-1-test-feature');
	});
});

describe('issue automation: Coach wakeup on Done', () => {
	it('creates a wakeup for Coach when status changes to done', async () => {
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Coach trigger test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		// Clear any existing wakeups for coach
		await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [coachAgentId]);

		// Set status to done
		await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
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
		expect(payload.trigger).toBe('issue_done');
		expect(payload.issue_id).toBe(issueId);
	});

	it('does not create wakeup for non-done status changes', async () => {
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'No coach trigger test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [coachAgentId]);

		// Set status to review — should NOT trigger Coach
		await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Review }),
		});

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await ctx.db.query(
			"SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'automation'",
			[coachAgentId],
		);
		expect(wakeups.rows.length).toBe(0);
	});
});

describe('issue: progress_summary and rules', () => {
	it('can update progress_summary with tracking fields', async () => {
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Progress test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
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
		const createRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Rules test',
				assignee_id: engineerAgentId,
			}),
		});
		const issueId = ((await createRes.json()) as any).data.id;

		const patchRes = await ctx.app.request(`/api/companies/${companyId}/issues/${issueId}`, {
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

describe('issue: sub-issues with parent_issue_id', () => {
	it('can create a sub-issue', async () => {
		const parentRes = await ctx.app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent issue',
				assignee_id: engineerAgentId,
			}),
		});
		const parentId = ((await parentRes.json()) as any).data.id;

		// Create sub-issue via the existing sub-issues endpoint
		const subRes = await ctx.app.request(
			`/api/companies/${companyId}/issues/${parentId}/sub-issues`,
			{
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					project_id: projectId,
					title: 'Plan this work',
					assignee_id: architectAgentId,
				}),
			},
		);
		expect(subRes.status).toBe(201);
		const subIssue = ((await subRes.json()) as any).data;
		expect(subIssue.parent_issue_id).toBe(parentId);
	});
});

describe('approval: skill_proposal type', () => {
	it('can create a skill_proposal approval', async () => {
		const res = await ctx.app.request(`/api/companies/${companyId}/approvals`, {
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
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const issue = {
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

		const prompt = buildTaskPrompt('System prompt here', issue, wakeupPayload);

		expect(prompt).toContain('## Retry Attempt 2/3');
		expect(prompt).toContain('previous attempt FAILED');
		expect(prompt).toContain('**Exit code:** 1');
		expect(prompt).toContain('Cannot find module ./auth-handler');
		expect(prompt).toContain('Running tests');
	});

	it('buildTaskPrompt omits retry context when no previous_failure', async () => {
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const issue = {
			id: 'test-id',
			identifier: 'AUT-2',
			title: 'Add feature',
			description: 'New feature needed',
			status: 'backlog',
			priority: 'medium',
			project_id: 'test-project',
			rules: null,
		};

		const prompt = buildTaskPrompt('System prompt', issue);

		expect(prompt).not.toContain('Retry Attempt');
		expect(prompt).not.toContain('previous attempt FAILED');
		expect(prompt).toContain('AUT-2');
		expect(prompt).toContain('Add feature');
	});

	it('buildTaskPrompt includes rules when present', async () => {
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const issue = {
			id: 'test-id',
			identifier: 'AUT-3',
			title: 'Constrained task',
			description: 'Task with rules',
			status: 'in_progress',
			priority: 'high',
			project_id: 'test-project',
			rules: 'Must use PostgreSQL transactions\nNo raw SQL in route handlers',
		};

		const prompt = buildTaskPrompt('System prompt', issue);

		expect(prompt).toContain('### Rules for this issue');
		expect(prompt).toContain('Must use PostgreSQL transactions');
		expect(prompt).toContain('No raw SQL in route handlers');
	});
});

describe('agent-runner: mention handoff prompt', () => {
	const mentionIssue = {
		id: 'trig-uuid',
		identifier: 'AUT-42',
		title: "CEO's roadmap",
		description: 'Roadmap planning.',
		status: 'in_progress',
		priority: 'high',
		project_id: 'proj-uuid',
		rules: null,
	};

	const mentionPayload = {
		source: 'mention',
		issue_id: 'trig-uuid',
		comment_id: 'comment-uuid',
	};

	it('prepends Mention Handoff when payload source is mention and ctx is provided', async () => {
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const ctx = {
			authorName: 'CEO',
			excerpt: 'Please update the spec to cover §6 and §11.',
			openTickets: [
				{ identifier: 'AUT-10', title: 'Draft spec', status: 'backlog', priority: 'high' },
				{ identifier: 'AUT-12', title: 'Review PRD', status: 'in_progress', priority: 'medium' },
				{ identifier: 'AUT-15', title: 'ADR: runtime', status: 'review', priority: 'low' },
			],
		};

		const prompt = buildTaskPrompt('System prompt', mentionIssue, mentionPayload, {
			mentionContext: ctx,
		});

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain('You were mentioned by CEO in AUT-42');
		expect(prompt).toContain('> Please update the spec to cover §6 and §11.');
		expect(prompt).toContain('AUT-10 — Draft spec (backlog, high)');
		expect(prompt).toContain('AUT-12 — Review PRD (in_progress, medium)');
		expect(prompt).toContain('AUT-15 — ADR: runtime (review, low)');
		expect(prompt).toContain('parent_issue_id = trig-uuid');
		expect(prompt).toContain('## Handling @-mentions');
		// Ensure the normal Current Task block still follows.
		expect(prompt).toContain('## Current Task: AUT-42');
		// Handoff appears before the Current Task block.
		expect(prompt.indexOf('## Mention Handoff')).toBeLessThan(prompt.indexOf('## Current Task'));
	});

	it('renders "none" in open tickets when agent has no assigned work', async () => {
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const ctx = {
			authorName: 'CEO',
			excerpt: 'Take a look at this.',
			openTickets: [],
		};

		const prompt = buildTaskPrompt('System prompt', mentionIssue, mentionPayload, {
			mentionContext: ctx,
		});

		expect(prompt).toContain('### Your open tickets\nnone');
		expect(prompt).toContain('## Handling @-mentions');
	});

	it('omits Mention Handoff when payload source is not mention', async () => {
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const ctx = {
			authorName: 'CEO',
			excerpt: 'hi',
			openTickets: [],
		};

		const prompt = buildTaskPrompt(
			'System prompt',
			mentionIssue,
			{ source: 'assignment', issue_id: 'trig-uuid' },
			{ mentionContext: ctx },
		);

		expect(prompt).not.toContain('## Mention Handoff');
		expect(prompt).toContain('## Current Task');
	});

	it('combines Mention Handoff with retry context when both are present', async () => {
		const { buildTaskPrompt } = await import('../../services/agent-runner');

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

		const prompt = buildTaskPrompt('System prompt', mentionIssue, payload, {
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
		const { buildTaskPrompt } = await import('../../services/agent-runner');

		const longCode = `Here is the plan\n\`\`\`\n${'x'.repeat(1200)}\n\`\`\`\nend`;
		const ctx = {
			authorName: 'CEO',
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
			{ source: 'mention', comment_id: 'c', issue_id: 'i' },
			{ mentionContext: ctx },
		);

		expect(prompt).toContain('[code omitted]');
		expect(prompt).not.toContain('x'.repeat(600));
	});
});

describe('shared types', () => {
	it('IssueStatus includes Approved', () => {
		expect(IssueStatus.Approved).toBe('approved');
	});

	it('ApprovalType includes SkillProposal', () => {
		expect(ApprovalType.SkillProposal).toBe('skill_proposal');
	});

	it('Approved is not in terminal statuses', async () => {
		const { TERMINAL_ISSUE_STATUSES } = await import('@hezo/shared');
		expect(TERMINAL_ISSUE_STATUSES).not.toContain(IssueStatus.Approved);
	});
});
