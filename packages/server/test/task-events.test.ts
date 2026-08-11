import { CommentContentType, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { extractTaskIdentifiers } from '../src/services/task-events';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
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
		// Parent-change events also carry where the parent lives, so a reader can
		// tell a re-parent inside one project from a move across two.
		from_identifier?: string;
		to_identifier?: string;
		from_project_slug?: string;
		to_project_slug?: string;
		from_name?: string;
		to_name?: string;
		actor_id?: string | null;
		source_task_id?: string;
		source_identifier?: string;
		source_kind?: string;
		source_comment_public_id?: string | null;
		from_preview?: string;
		to_preview?: string;
		from_truncated?: boolean;
		to_truncated?: boolean;
		from_length?: number;
		to_length?: number;
	};
	public_id?: string;
	author_member_id: string | null;
	created_at: string;
}

async function createTask(
	title: string,
	description = '',
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, description, assignee_id: agentId }),
	});
	const body = await res.json();
	return { id: body.data.id, identifier: body.data.identifier };
}

async function listComments(taskId: string): Promise<CommentRow[]> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
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

	const teamRes = await createTestTeam(db, { name: 'Events Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Widget',
		description: 'Widget project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
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
	it('records a admin-authored PATCH status change with from/to and "Admin" actor', async () => {
		const task = await createTask('PATCH by admin');
		const before = (await systemComments(task.id, 'status_change')).length;

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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
	it('records a admin-authored title rename with from/to and "Test Admin" actor', async () => {
		const task = await createTask('Original title');
		const before = (await systemComments(task.id, 'title_change')).length;

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: '  Trim me  ' }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'title_change');
		expect(after.length).toBe(before);
	});
});

describe('description change system events', () => {
	async function patchDescription(taskId: string, description: string, authToken = token) {
		return app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description }),
		});
	}

	it('records an added description with bounded previews and full lengths', async () => {
		const task = await createTask('Describe me');

		const res = await patchDescription(task.id, 'The first body.');
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'description_change');
		expect(events.length).toBe(1);
		const ev = events[0];
		expect(ev.content.text).toContain('Test Admin');
		expect(ev.content.text).toContain('added a description');
		expect(ev.content.from_preview).toBe('');
		expect(ev.content.to_preview).toBe('The first body.');
		expect(ev.content.from_length).toBe(0);
		expect(ev.content.to_length).toBe('The first body.'.length);
		expect(ev.content.from_truncated).toBe(false);
		expect(ev.content.to_truncated).toBe(false);
		expect(ev.author_member_id).not.toBeNull();
	});

	it('records an edit with both ends and says "updated"', async () => {
		const task = await createTask('Edit me', 'Original body.');

		const res = await patchDescription(task.id, 'Replacement body.');
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'description_change');
		const ev = events[events.length - 1];
		expect(ev.content.text).toContain('updated the description');
		expect(ev.content.from_preview).toBe('Original body.');
		expect(ev.content.to_preview).toBe('Replacement body.');
	});

	it('says "cleared" when the description is emptied', async () => {
		const task = await createTask('Clear me', 'Something to remove.');

		const res = await patchDescription(task.id, '');
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'description_change');
		const ev = events[events.length - 1];
		expect(ev.content.text).toContain('cleared the description');
		expect(ev.content.to_preview).toBe('');
		expect(ev.content.to_length).toBe(0);
	});

	it('caps each preview and flags it as truncated, without carrying the body', async () => {
		const long = 'x'.repeat(500);
		const task = await createTask('Long body');

		const res = await patchDescription(task.id, long);
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'description_change');
		const ev = events[events.length - 1];
		expect(ev.content.to_preview?.length).toBe(200);
		expect(ev.content.to_truncated).toBe(true);
		expect(ev.content.to_length).toBe(500);
		// The whole payload stays small — the body must never ride along.
		expect(JSON.stringify(ev.content).length).toBeLessThan(long.length);
	});

	it('does not record an event when the description is unchanged', async () => {
		const task = await createTask('Untouched', 'Stable body.');
		const before = (await systemComments(task.id, 'description_change')).length;

		const res = await patchDescription(task.id, 'Stable body.');
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'description_change');
		expect(after.length).toBe(before);
	});

	it('treats an empty description on a task created without one as unchanged', async () => {
		const task = await createTask('Never described');

		const res = await patchDescription(task.id, '');
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'description_change');
		expect(events.length).toBe(0);
	});

	it('records an agent-authored description edit attributed to the agent', async () => {
		const task = await createTask('Agent edits', 'Before the agent.');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			task.id,
		);

		const res = await patchDescription(task.id, 'After the agent.', agentToken);
		expect(res.status).toBe(200);

		const events = await systemComments(task.id, 'description_change');
		const ev = events[events.length - 1];
		expect(ev.content.text).toContain('Status Bot');
		expect(ev.content.actor_id).toBe(agentId);
		expect(ev.author_member_id).toBe(agentId);
	});
});

describe('assignee change system events', () => {
	it('records a admin-authored reassignment with from/to ids and names', async () => {
		const secondAgentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Second Bot' }),
		});
		const secondAgentId = (await secondAgentRes.json()).data.id;

		const task = await createTask('Reassign me');
		const before = (await systemComments(task.id, 'assignee_change')).length;

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
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

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(task.id, 'assignee_change');
		expect(after.length).toBe(before);
	});
});

// The three text variants and the no-op case are covered end to end in
// task-reparenting.test.ts; what matters here is actor attribution and the
// payload the web renderer reads to build its links.
describe('parent change system events', () => {
	it('names the actor and carries both ends with their project slugs', async () => {
		const first = await createTask('Parent change from');
		const second = await createTask('Parent change to');
		const mover = await createTask('Parent change mover');

		await app.request(`/api/projects/${projectSlug}/tasks/${mover.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ parent_task_id: first.id }),
		});
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${mover.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ parent_task_id: second.id }),
		});
		expect(res.status).toBe(200);

		const events = await systemComments(mover.id, 'parent_change');
		expect(events.length).toBe(2);
		const ev = events[events.length - 1];
		expect(ev.content.from_id).toBe(first.id);
		expect(ev.content.to_id).toBe(second.id);
		expect(ev.content.from_identifier).toBe(first.identifier);
		expect(ev.content.to_identifier).toBe(second.identifier);
		expect(ev.content.from_project_slug).toBe(projectSlug);
		expect(ev.content.to_project_slug).toBe(projectSlug);
		expect(ev.content.text).toContain('Test Admin');
	});

	it('leaves the to end null on a promotion', async () => {
		const parent = await createTask('Promotion source');
		const child = await createTask('Promotion subject');

		await app.request(`/api/projects/${projectSlug}/tasks/${child.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ parent_task_id: parent.id }),
		});
		await app.request(`/api/projects/${projectSlug}/tasks/${child.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ parent_task_id: null }),
		});

		const events = await systemComments(child.id, 'parent_change');
		const ev = events[events.length - 1];
		expect(ev.content.to_id).toBeNull();
		expect(ev.content.to_identifier).toBeNull();
		expect(ev.content.to_project_slug).toBeNull();
		expect(ev.content.from_identifier).toBe(parent.identifier);
	});
});

describe('task link system events', () => {
	it('creates a link comment on the target the first time another task mentions it', async () => {
		const target = await createTask('Target task');
		const source = await createTask('Source task');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${source.id}/comments`, {
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
		// The mention came from a comment, so the sentence names that origin.
		expect(links[0].content.text).toContain(`Linked from a comment on ${source.identifier}`);
	});

	it('does not create a second link comment for repeat mentions from the same source', async () => {
		const target = await createTask('Target repeat');
		const source = await createTask('Source repeat');

		for (const text of [`first mention ${target.identifier}`, `another ${target.identifier}`]) {
			await app.request(`/api/projects/${projectSlug}/tasks/${source.id}/comments`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content_type: 'text', content: { text } }),
			});
		}

		const links = await systemComments(target.id, 'task_link');
		expect(links).toHaveLength(1);
	});

	it('records which comment the mention was written in, by its anchor', async () => {
		const target = await createTask('Target with origin');
		const source = await createTask('Source with origin');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `root cause tracked in ${target.identifier}` },
			}),
		});
		expect(res.status).toBe(201);

		// The recorded anchor has to be the real public_id of the comment that
		// carried the mention, since that is what the timeline scrolls to.
		const sourceComments = await listComments(source.id);
		const mentioning = sourceComments.find((c) =>
			(c.content?.text ?? '').includes(target.identifier),
		);
		expect(mentioning).toBeTruthy();

		const links = await systemComments(target.id, 'task_link');
		expect(links).toHaveLength(1);
		expect(links[0].content.source_kind).toBe('comment');
		expect(links[0].content.source_comment_public_id).toBe(mentioning?.public_id);
		expect(links[0].content.text).toContain(`Linked from a comment on ${source.identifier}`);
	});

	it('marks a description-sourced link as such, with no comment anchor', async () => {
		const target = await createTask('Target desc origin');
		const source = await createTask('Source desc origin', `tracked in ${target.identifier}`);

		const links = await systemComments(target.id, 'task_link');
		const fromSource = links.find((l) => l.content.source_task_id === source.id);
		expect(fromSource?.content.source_kind).toBe('description');
		expect(fromSource?.content.source_comment_public_id).toBeNull();
		// The sentence stays exactly as it always was when there is no sub-location.
		expect(fromSource?.content.text).toContain(`Linked from ${source.identifier}`);
		expect(fromSource?.content.text).not.toContain('a comment on');
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
		await app.request(`/api/projects/${projectSlug}/tasks/${task.id}/comments`, {
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
		await app.request(`/api/projects/${projectSlug}/tasks/${source.id}/comments`, {
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
		await app.request(`/api/projects/${projectSlug}/tasks/${source.id}/comments`, {
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

		const otherTeamRes = await createTestTeam(db, { name: 'Other Co' });
		const otherTeamData = (await otherTeamRes.json()).data;
		const otherTeamId = otherTeamData.id;
		const otherInternalSlug = `${await projectSlugFor(db, otherTeamData.id)}`;
		const otherProjectRes = await createTestProject(db, otherTeamId, {
			name: 'Foreign',
			description: 'Other.',
		});
		const otherProjectData = (await otherProjectRes.json()).data;
		const otherProjectId = otherProjectData.id;
		const otherProjectSlug = otherProjectData.slug;
		const otherAgentRes = await app.request(`/api/projects/${otherInternalSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Other Bot' }),
		});
		const otherAgentId = (await otherAgentRes.json()).data.id;

		const otherTaskRes = await app.request(`/api/projects/${otherProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: otherProjectId,
				title: 'Foreign source',
				assignee_id: otherAgentId,
			}),
		});
		const otherTask = (await otherTaskRes.json()).data;

		await app.request(`/api/projects/${otherProjectSlug}/tasks/${otherTask.id}/comments`, {
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

		await app.request(`/api/projects/${projectSlug}/tasks/${source.id}/comments`, {
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
