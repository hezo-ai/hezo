import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { detectUnlinkedGitHubReferences } from '../src/lib/mentions';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

const SHA = 'a200cccd17d909907f4276618425eca91bd80f77';

describe('detectUnlinkedGitHubReferences', () => {
	it('flags the PR number and the head SHA of an unlinked merge ask', () => {
		const text =
			`@admin - please approve and merge PR #1135 only at head \`${SHA}\`. ` +
			'If the head changes, do not merge and report the new SHA here.';
		expect(detectUnlinkedGitHubReferences(text)).toEqual(['PR #1135', SHA]);
	});

	it('does not flag references that are already markdown links', () => {
		expect(
			detectUnlinkedGitHubReferences(
				'Merged [PR #1135](https://github.com/o/r/pull/1135) at ' +
					`[\`a200ccc\`](https://github.com/o/r/commit/${SHA}); see [issue #88][ref].`,
			),
		).toEqual([]);
	});

	it('does not flag bare or angle-bracket URLs, which render as links', () => {
		expect(
			detectUnlinkedGitHubReferences(
				'See https://github.com/o/r/pull/5 and <https://github.com/o/r/commit/a200ccc1>.',
			),
		).toEqual([]);
	});

	it('does not flag anything inside a fenced code block', () => {
		expect(detectUnlinkedGitHubReferences('```\nPR #9 landed at commit a200ccc1\n```')).toEqual([]);
	});

	it('flags every pull request and issue form, in text order', () => {
		expect(
			detectUnlinkedGitHubReferences(
				'Filed issue #88 and hezo-ai/hezo#12; also pull request #3, PR#4 and PRs #5.',
			),
		).toEqual(['issue #88', 'hezo-ai/hezo#12', 'pull request #3', 'PR#4', 'PRs #5']);
	});

	it('flags a PR number wrapped in inline code, since backticks make it inert', () => {
		expect(detectUnlinkedGitHubReferences('see `PR #7`')).toEqual(['PR #7']);
	});

	it('flags a SHA after each commit word, bare or through a joining word', () => {
		expect(
			detectUnlinkedGitHubReferences(
				'commit a200ccc, SHA: b300ddd4, merged in c400eee5, head is d500fff6',
			),
		).toEqual(['a200ccc', 'b300ddd4', 'c400eee5', 'd500fff6']);
	});

	it('does not flag a hex value that no commit word names', () => {
		expect(
			detectUnlinkedGitHubReferences('Container `3f2a9c1b7d4e` restarted after the deploy.'),
		).toEqual([]);
	});

	it('does not flag a UUID, a sha256 digest or an English word after a commit word', () => {
		expect(
			detectUnlinkedGitHubReferences(
				'commit 3f2a9c1b-7d4e-4a1b-9c2d-1e2f3a4b5c6d; digest sha256:abcdef0123456789; the head decade',
			),
		).toEqual([]);
	});

	it('does not flag a bare #number or a numbered finding', () => {
		expect(detectUnlinkedGitHubReferences('#1 priority. Issue 2: the header overlaps.')).toEqual(
			[],
		);
	});

	it('reports a reference repeated in one text once', () => {
		expect(detectUnlinkedGitHubReferences('PR #1 is open. PR #1 needs review.')).toEqual(['PR #1']);
	});
});

describe('MCP write tools warn on an unlinked GitHub reference', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;
	let teamId: string;
	let projectId: string;
	let projectSlug: string;
	let captainId: string;
	let architectId: string;
	let goalId: string;

	const BARE = `Merge PR #1135 only at head \`${SHA}\`.`;
	const LINKED =
		'Merge [PR #1135](https://github.com/o/r/pull/1135) only at head ' +
		`[\`a200ccc\`](https://github.com/o/r/commit/${SHA}).`;

	async function insertTask(assigneeId: string, title: string): Promise<string> {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const n = meta.rows[0].number;
		const res = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, 'in_progress'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
		);
		return res.rows[0].id;
	}

	async function agentToken(agentId: string, taskId: string | null): Promise<string> {
		return (await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId, { projectId }))
			.token;
	}

	async function call(
		bearer: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<{ id?: string; error?: string; warning?: string }> {
		return await callMcpTool(app, bearer, name, args);
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'App Team',
		).id;
		const teamRes = await createTestTeam(db, { name: 'GitHub Links Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const project = (await (await createTestProject(db, teamId, { name: 'GitHub Links' })).json())
			.data;
		projectId = project.id;
		projectSlug = project.slug;

		const agents = (
			await (
				await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(token) })
			).json()
		).data as Array<{ id: string; slug: string }>;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
		architectId = agents.find((a) => a.slug === 'architect')!.id;

		const goalRes = await app.request(`/api/projects/${projectSlug}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Ship the beta', check_frequency: 'daily' }),
		});
		goalId = (await goalRes.json()).data.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('warns on create_comment, naming each bare reference, and still saves the comment', async () => {
		const taskId = await insertTask(architectId, 'Merge ask');
		const result = await call(await agentToken(architectId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: BARE,
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toContain('"PR #1135"');
		expect(result.warning).toContain(`"${SHA}"`);
		expect(result.warning).toContain('https://github.com/<owner>/<repo>/pull/123');
		const saved = await db.query<{ c: number }>(
			'SELECT COUNT(*)::int AS c FROM task_comments WHERE task_id = $1',
			[taskId],
		);
		expect(saved.rows[0].c).toBe(1);
	});

	it('does not warn on create_comment when every reference is linked', async () => {
		const taskId = await insertTask(architectId, 'Linked merge ask');
		const result = await call(await agentToken(architectId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: LINKED,
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it('warns on update_comment for a bare reference and clears once the edit links it', async () => {
		const taskId = await insertTask(architectId, 'Edited merge ask');
		const bearer = await agentToken(architectId, taskId);
		const created = await call(bearer, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Draft.',
		});
		const bare = await call(bearer, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: BARE,
		});
		expect(bare.error).toBeUndefined();
		expect(bare.warning).toContain('"PR #1135"');
		const linked = await call(bearer, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: LINKED,
		});
		expect(linked.error).toBeUndefined();
		expect(linked.warning).toBeUndefined();
	});

	it('warns on update_task when the progress summary names a bare issue', async () => {
		const taskId = await insertTask(architectId, 'Summary task');
		const result = await call(await agentToken(architectId, taskId), 'update_task', {
			project: projectId,
			task_id: taskId,
			progress_summary: 'Blocked on issue #88 upstream.',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toContain('"issue #88"');
	});

	it('warns on update_goal_progress for a bare reference and saves the blurb', async () => {
		const result = (await call(await agentToken(captainId, null), 'update_goal_progress', {
			project: projectSlug,
			goal_id: goalId,
			progress_percent: 40,
			health: 'on_track',
			status_blurb: 'Signup flow is in review as PR #502.',
		})) as { error?: string; warning?: string; status_blurb?: string };
		expect(result.error).toBeUndefined();
		expect(result.status_blurb).toBe('Signup flow is in review as PR #502.');
		expect(result.warning).toContain('"PR #502"');
	});

	it('does not warn on update_goal_progress when the PR is linked', async () => {
		const result = await call(await agentToken(captainId, null), 'update_goal_progress', {
			project: projectSlug,
			goal_id: goalId,
			progress_percent: 45,
			health: 'on_track',
			status_blurb: 'Signup flow is in review as [PR #502](https://github.com/o/r/pull/502).',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});
});
