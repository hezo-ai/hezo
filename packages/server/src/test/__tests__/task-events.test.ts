import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { extractTaskIdentifiers } from '../../services/task-events';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let agentId: string;

interface CommentRow {
	id: string;
	task_id: string;
	content_type: string;
	content: {
		text?: string;
		kind?: string;
		from?: string;
		to?: string;
		from_id?: string | null;
		to_id?: string | null;
		from_name?: string;
		to_name?: string;
		actor_id?: string | null;
		source_task_id?: string;
		source_identifier?: string;
	};
	author_member_id: string | null;
	created_at: string;
}

async function createTask(
	title: string,
	description = '',
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, description, assignee_id: agentId }),
	});
	const body = await res.json();
	return { id: body.data.id, identifier: body.data.identifier };
}

async function listComments(taskId: string): Promise<CommentRow[]> {
	const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/comments`, {
		headers: authHeader(token),
	});
	return (await res.json()).data;
}

async function systemComments(taskId: string, kind: string): Promise<CommentRow[]> {
	const all = await listComments(taskId);
	return all.filter(
		(c) => c.content_type === CommentContentType.System && c.content?.kind === kind,
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Events Co' }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await app.request(`/api/teams/${teamId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Widget', description: 'Widget project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/teams/${teamId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Status Bot' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('extractTaskIdentifiers', () => {
	it('returns identifiers from plain prose', () => {
		expect(extractTaskIdentifiers('see IN-42 for the rest')).toEqual(['IN-42']);
	});

	it('finds multiple unique identifiers', () => {
		expect(extractTaskIdentifiers('see IN-1 and IN-2 — also IN-1 again').sort()).toEqual([
			'IN-1',
			'IN-2',
		]);
	});

	it('skips identifiers in fenced code blocks', () => {
		expect(extractTaskIdentifiers('text\n```\nIN-9\n```\nmore')).toEqual([]);
	});

	it('skips identifiers in inline code', () => {
		expect(extractTaskIdentifiers('inline `IN-9` here')).toEqual([]);
	});

	it('skips lowercase identifiers', () => {
		expect(extractTaskIdentifiers('check in-9 sometime')).toEqual([]);
	});

	it('returns [] for null/undefined/empty', () => {
		expect(extractTaskIdentifiers(null)).toEqual([]);
		expect(extractTaskIdentifiers(undefined)).toEqual([]);
		expect(extractTaskIdentifiers('')).toEqual([]);
	});
});

describe('status change system events', () => {
	it('records a board-authored PATCH status change with from/to and "Board" actor', async () => {
		const task = await createTask('PATCH by board');
		const before = (await systemComments(task.id, 'status_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.InProgress }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'status_change');
		expect(after.length).toBe(before + 1);
		const ev = after[after.length - 1];
		expect(ev.content.from).toBe(TaskStatus.Backlog);
		expect(ev.content.to).toBe(TaskStatus.InProgress);
		expect(ev.author_member_id).not.toBeNull();
	});

	it('records an agent-authored PATCH status change attributed to the agent', async () => {
		const task = await createTask('PATCH by agent');
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.InProgress }),
		});
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'status_change');
		const ev = events[events.length - 1];
		expect(ev.content.actor_id).toBe(agentId);
		expect(ev.author_member_id).toBe(agentId);
	});

	it('does not record an event when the status is unchanged', async () => {
		const task = await createTask('Unchanged status');
		const before = (await systemComments(task.id, 'status_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: TaskStatus.Backlog }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'status_change');
		expect(after.length).toBe(before);
	});
});

describe('title change system events', () => {
	it('records a board-authored title rename with from/to and "Test Admin" actor', async () => {
		const task = await createTask('Original title');
		const before = (await systemComments(task.id, 'title_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Renamed title' }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'title_change');
		expect(after.length).toBe(before + 1);
		const ev = after[after.length - 1];
		expect(ev.content.from).toBe('Original title');
		expect(ev.content.to).toBe('Renamed title');
		expect(ev.content.text).toContain('Test Admin');
		expect(ev.content.text).toContain('Original title');
		expect(ev.content.text).toContain('Renamed title');
		expect(ev.author_member_id).not.toBeNull();
	});

	it('records an agent-authored title rename attributed to the agent', async () => {
		const task = await createTask('Pre-rename');
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Bot rename' }),
		});
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'title_change');
		const ev = events[events.length - 1];
		expect(ev.content.text).toContain('Status Bot');
		expect(ev.content.actor_id).toBe(agentId);
		expect(ev.author_member_id).toBe(agentId);
	});

	it('does not record an event when the title is unchanged', async () => {
		const task = await createTask('Same title');
		const before = (await systemComments(task.id, 'title_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Same title' }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'title_change');
		expect(after.length).toBe(before);
	});

	it('does not record an event for a whitespace-only diff', async () => {
		const task = await createTask('Trim me');
		const before = (await systemComments(task.id, 'title_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: '  Trim me  ' }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'title_change');
		expect(after.length).toBe(before);
	});
});

describe('assignee change system events', () => {
	it('records a board-authored reassignment with from/to ids and names', async () => {
		const secondAgentRes = await app.request(`/api/teams/${teamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Second Bot' }),
		});
		const secondAgentId = (await secondAgentRes.json()).data.id;

		const task = await createTask('Reassign me');
		const before = (await systemComments(task.id, 'assignee_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: secondAgentId }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'assignee_change');
		expect(after.length).toBe(before + 1);
		const ev = after[after.length - 1];
		expect(ev.content.from_id).toBe(agentId);
		expect(ev.content.to_id).toBe(secondAgentId);
		expect(ev.content.from_name).toBe('Status Bot');
		expect(ev.content.to_name).toBe('Second Bot');
		expect(ev.content.text).toContain('Test Admin');
		expect(ev.content.text).toContain('Status Bot');
		expect(ev.content.text).toContain('Second Bot');
	});

	it('does not record an event when the assignee is unchanged', async () => {
		const task = await createTask('Same assignee');
		const before = (await systemComments(task.id, 'assignee_change')).length;

		const res = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'assignee_change');
		expect(after.length).toBe(before);
	});
});

describe('task link system events', () => {
	it('creates a link comment on the target the first time another task mentions it', async () => {
		const target = await createTask('Target ticket');
		const source = await createTask('Source ticket');

		const res = await app.request(`/api/teams/${teamId}/tasks/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `see ${target.identifier} for context` },
			}),
		});
		expect(res.status).toBe(201);

		const links = await systemComments(target.id, 'task_link');
		expect(links).toHaveLength(1);
		expect(links[0].content.source_task_id).toBe(source.id);
		expect(links[0].content.source_identifier).toBe(source.identifier);
		expect(links[0].content.text).toContain(`Linked from ${source.identifier}`);
	});

	it('does not create a second link comment for repeat mentions from the same source', async () => {
		const target = await createTask('Target repeat');
		const source = await createTask('Source repeat');

		for (const text of [`first mention ${target.identifier}`, `another ${target.identifier}`]) {
			await app.request(`/api/teams/${teamId}/tasks/${source.id}/comments`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content_type: 'text', content: { text } }),
			});
		}

		const links = await systemComments(target.id, 'task_link');
		expect(links).toHaveLength(1);
	});

	it('records a link from task creation when the description mentions another task', async () => {
		const target = await createTask('Target via desc');
		const source = await createTask('Source via desc', `pre-existing link to ${target.identifier}`);

		const links = await systemComments(target.id, 'task_link');
		const fromSource = links.find((l) => l.content.source_task_id === source.id);
		expect(fromSource).toBeTruthy();
	});

	it('ignores self-references', async () => {
		const task = await createTask('Self ref');
		await app.request(`/api/teams/${teamId}/tasks/${task.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `this is ${task.identifier} talking about itself` },
			}),
		});
		const links = await systemComments(task.id, 'task_link');
		expect(links).toHaveLength(0);
	});

	it('ignores identifiers inside fenced code blocks', async () => {
		const target = await createTask('Target codeblock');
		const source = await createTask('Source codeblock');
		await app.request(`/api/teams/${teamId}/tasks/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `inert\n\`\`\`\n${target.identifier}\n\`\`\`\n` },
			}),
		});
		const links = await systemComments(target.id, 'task_link');
		expect(links).toHaveLength(0);
	});

	it('ignores unknown identifiers', async () => {
		const source = await createTask('Source unknown');
		const before = await db.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM task_comments WHERE content_type = 'system' AND content->>'kind' = 'task_link'",
		);
		await app.request(`/api/teams/${teamId}/tasks/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'see XX-99 for nothing' } }),
		});
		const after = await db.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM task_comments WHERE content_type = 'system' AND content->>'kind' = 'task_link'",
		);
		expect(after.rows[0].count).toBe(before.rows[0].count);
	});

	it('does not cross team boundaries', async () => {
		const targetA = await createTask('Cross-team target');

		const otherTeamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Co' }),
		});
		const otherTeamId = (await otherTeamRes.json()).data.id;
		const otherProjectRes = await app.request(`/api/teams/${otherTeamId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Foreign', description: 'Other.' }),
		});
		const otherProjectId = (await otherProjectRes.json()).data.id;
		const otherAgentRes = await app.request(`/api/teams/${otherTeamId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Other Bot' }),
		});
		const otherAgentId = (await otherAgentRes.json()).data.id;

		const otherTaskRes = await app.request(`/api/teams/${otherTeamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: otherProjectId,
				title: 'Foreign source',
				assignee_id: otherAgentId,
			}),
		});
		const otherTask = (await otherTaskRes.json()).data;

		await app.request(`/api/teams/${otherTeamId}/tasks/${otherTask.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `mentions ${targetA.identifier} from another team` },
			}),
		});

		const links = await systemComments(targetA.id, 'task_link');
		expect(links).toHaveLength(0);
	});

	it('records links for multiple targets in a single comment', async () => {
		const target1 = await createTask('Multi target 1');
		const target2 = await createTask('Multi target 2');
		const source = await createTask('Multi source');

		await app.request(`/api/teams/${teamId}/tasks/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `${target1.identifier} and ${target2.identifier}` },
			}),
		});

		const links1 = await systemComments(target1.id, 'task_link');
		const links2 = await systemComments(target2.id, 'task_link');
		expect(links1.some((l) => l.content.source_task_id === source.id)).toBe(true);
		expect(links2.some((l) => l.content.source_task_id === source.id)).toBe(true);
	});
});
