import { extractBacktickedMentionCandidates } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

describe('extractBacktickedMentionCandidates', () => {
	it('extracts a task identifier wrapped in inline code', () => {
		expect(extractBacktickedMentionCandidates('blocked by `IN-42`').tasks).toEqual(['in-42']);
	});

	it('extracts a project-doc filename wrapped in inline code', () => {
		expect(extractBacktickedMentionCandidates('read `prd.md` first').filenames).toEqual(['prd.md']);
	});

	it('extracts an asset reference wrapped in inline code', () => {
		expect(extractBacktickedMentionCandidates('open `assets/login.png`').assets).toEqual([
			'login.png',
		]);
	});

	it('extracts an @-mention wrapped in inline code', () => {
		expect(extractBacktickedMentionCandidates('ping `@architect`').agents).toEqual(['architect']);
		expect(extractBacktickedMentionCandidates('per `@@architect`').agents).toEqual(['architect']);
	});

	it('ignores a bare name inside inline code (not a mention without @)', () => {
		expect(extractBacktickedMentionCandidates('`architect`').agents).toEqual([]);
	});

	it('excludes @admin to match the candidate contract', () => {
		expect(extractBacktickedMentionCandidates('`@admin`').agents).toEqual([]);
	});

	it('ignores references that are NOT wrapped in backticks', () => {
		expect(extractBacktickedMentionCandidates('see prd.md, IN-42 and assets/login.png')).toEqual({
			tasks: [],
			filenames: [],
			assets: [],
			agents: [],
		});
	});

	it('ignores references inside fenced code blocks', () => {
		expect(extractBacktickedMentionCandidates('```\nsee `prd.md` and IN-42\n```')).toEqual({
			tasks: [],
			filenames: [],
			assets: [],
			agents: [],
		});
	});

	it('collects multiple distinct references in one pass', () => {
		const c = extractBacktickedMentionCandidates(
			'`prd.md`, `assets/x.png`, `IN-1`, `@qa-engineer`',
		);
		expect(c.filenames).toEqual(['prd.md']);
		expect(c.assets).toEqual(['x.png']);
		expect(c.tasks).toEqual(['in-1']);
		expect(c.agents).toEqual(['qa-engineer']);
	});
});

describe('MCP tools warn when a Hezo reference is wrapped in backticks', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let captainId: string;
	let architectId: string;
	let existingTaskIdentifier: string;

	async function insertTask(
		assigneeId: string,
		title: string,
	): Promise<{ id: string; identifier: string }> {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const n = meta.rows[0].number;
		const identifier = `${meta.rows[0].task_prefix}-${n}`;
		const res = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, assigneeId, n, identifier, title],
		);
		return { id: res.rows[0].id, identifier };
	}

	async function callTool(
		agentId: string,
		name: string,
		args: Record<string, unknown>,
		taskId?: string,
	): Promise<{ warning?: string; id?: string; error?: string }> {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId ?? null,
			{ projectId },
		);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name, arguments: args },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text);
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;

		const teamRes = await createTestTeam(db, { name: 'Backtick Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Backtick' })).json())
			.data;
		projectId = projectData.id;

		const agentsRes = await app.request(`/api/projects/${projectData.slug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
		architectId = agents.find((a) => a.slug === 'architect')!.id;

		// Seed the real entities the descriptions will reference.
		await db.query(
			`INSERT INTO documents (team_id, project_id, type, slug, title, content)
			 VALUES ($1, $2, 'project_doc'::document_type, 'prd.md', 'prd.md', 'body')`,
			[teamId, projectId],
		);
		await db.query(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'image/png', 4, 'deadbeef', 'login.png')`,
			[teamId, projectId],
		);
		existingTaskIdentifier = (await insertTask(captainId, 'An existing ticket')).identifier;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('warns on create_task when real docs/assets/tickets/teammates are backticked', async () => {
		const description =
			`Read \`prd.md\` and the mockup \`assets/login.png\`. Depends on ` +
			`\`${existingTaskIdentifier}\`. Ask \`@architect\` if blocked.`;
		const result = await callTool(captainId, 'create_task', {
			project: projectId,
			title: 'New work',
			description,
			assignee_slug: 'architect',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('prd.md');
		expect(result.warning).toContain('assets/login.png');
		expect(result.warning).toContain(existingTaskIdentifier);
		expect(result.warning).toContain('@architect');
	});

	it('does not warn on create_task when references are written bare', async () => {
		const description =
			`Read prd.md and the mockup assets/login.png. Depends on ` +
			`${existingTaskIdentifier}. Ask @architect if blocked.`;
		const result = await callTool(captainId, 'create_task', {
			project: projectId,
			title: 'Bare refs',
			description,
			assignee_slug: 'architect',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it('does not warn on backticked strings that are not real Hezo entities', async () => {
		const description =
			'Run `npm install`, edit `package.json`, encode as `UTF-8`, see `src/index.ts` and `README.md`.';
		const result = await callTool(captainId, 'create_task', {
			project: projectId,
			title: 'Legit code spans',
			description,
			assignee_slug: 'architect',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it('does not warn when a backticked project-doc does not exist in the project yet', async () => {
		// design.md is a project doc this task will *create* — not in the project yet.
		// A bare filename could equally be a repo file (README.md), so the doc branch
		// stays resolve-gated and must not flag a non-existent one.
		const result = await callTool(captainId, 'create_task', {
			project: projectId,
			title: 'Produce the design doc',
			description: 'Deliverable: `design.md`.',
			assignee_slug: 'architect',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it('warns on a backticked asset even when it does not exist in the project yet', async () => {
		// assets/wireframe.png is a deliverable this task will *create*. Unlike a bare
		// doc filename, the `assets/` prefix is unambiguously a Hezo asset handle (never
		// a repo path), so backticking it is always wrong — flag it before the asset row
		// exists so the habit doesn't persist past creation.
		const result = await callTool(captainId, 'create_task', {
			project: projectId,
			title: 'Produce the wireframe',
			description: 'Deliverable: `assets/wireframe.png`.',
			assignee_slug: 'architect',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('assets/wireframe.png');
	});

	it('warns on create_comment for a not-yet-created backticked asset, and still persists the comment', async () => {
		// The reported failure: an agent describes a tracker it is about to produce and
		// backticks the (non-existent) asset path. The warning must fire, but the write
		// is advisory/non-blocking — the comment is committed regardless.
		const task = await insertTask(architectId, 'Tracker ticket');
		const result = await callTool(
			architectId,
			'create_comment',
			{
				project: projectId,
				task_id: task.id,
				content: 'Will produce a tracker at `assets/startup-directories/submission-tracker.md`.',
			},
			task.id,
		);
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('assets/startup-directories/submission-tracker.md');
		// The comment persisted despite the advisory warning.
		expect(result.id).toBeDefined();
		const persisted = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM task_comments WHERE task_id = $1`,
			[task.id],
		);
		expect(persisted.rows[0].c).toBe(1);
	});

	it('warns on update_task when a backticked doc is added to the description', async () => {
		const task = await insertTask(architectId, 'Architect ticket');
		const result = await callTool(
			architectId,
			'update_task',
			{ project: projectId, task_id: task.id, description: 'Now read `prd.md` for context.' },
			task.id,
		);
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('prd.md');
	});

	it('warns on create_comment when a backticked asset is referenced', async () => {
		const task = await insertTask(architectId, 'Comment ticket');
		const result = await callTool(
			architectId,
			'create_comment',
			{ project: projectId, task_id: task.id, content: 'Shipped `assets/login.png`.' },
			task.id,
		);
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('assets/login.png');
	});
});
