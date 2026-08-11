// Branch-coverage focus for agent-runner.ts. These tests exercise the pure
// prompt/env builders, formatting helpers, and DB-backed context loaders
// DIRECTLY — none requires a live container, LLM, git, or network. The full
// `runAgent` integration path is already covered by agent-runner.test.ts and
// agent-runner-extended.test.ts; this file fills the reachable per-branch gaps
// in the building blocks those tests only touch on the happy path.

import { AiAuthMethod, AiProvider, KIMI_DEFAULT_MODEL } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	type AgentAttachment,
	acquireCredentialLock,
	buildCoachReviewPrompt,
	buildProgressUpdatePrompt,
	buildProviderEnv,
	buildTaskPrompt,
	formatReactionLine,
	loadAgentAttachmentsForComments,
	loadMentionContext,
	loadOpenSubTasks,
	loadReplyContext,
	loadSpawnedFromTask,
	type MentionContext,
	type ReplyContext,
	shellQuoteArg,
	type TaskInfo,
} from '../src/services/agent-runner';
import type { ReactionGroup } from '../src/services/reactions';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string; id: string }) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Branch Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Branch Project',
		description: 'Branch test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	const agentRow = (await agentsRes.json()).data[0];
	agentId = agentRow.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Branch Task',
			description: 'Branch description',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		id: taskId,
		identifier: 'BR-1',
		title: 'Branch Task',
		description: 'Branch description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
		...overrides,
	};
}

// --------------------------------------------------------------------------
// buildProviderEnv — one env-list shape per provider/auth-method combination.
// --------------------------------------------------------------------------
describe('buildProviderEnv', () => {
	it('emits the Claude Code quiet env + API key var for an Anthropic api-key credential', () => {
		const env = buildProviderEnv(AiProvider.Anthropic, {
			value: 'sk-ant-123',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		// Claude Code quiet flags are prepended for ClaudeCode-runtime providers.
		expect(env).toContain('DISABLE_TELEMETRY=1');
		expect(env).toContain('DISABLE_AUTOUPDATER=1');
		// Headless `-p` background-task wait ceiling is removed so long background
		// work isn't terminated at 600s.
		expect(env).toContain('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0');
		// API-key auth → the ANTHROPIC_API_KEY var carries the secret.
		expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-123');
		// No subscription var leaks in.
		expect(env.some((e) => e.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(false);
	});

	it('routes an Anthropic subscription credential to CLAUDE_CODE_OAUTH_TOKEN', () => {
		const env = buildProviderEnv(AiProvider.Anthropic, {
			value: 'oauth-token-abc',
			authMethod: AiAuthMethod.Subscription,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=oauth-token-abc');
		expect(env.some((e) => e.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
	});

	it('returns ONLY static entries when the auth method has no credential var (Anthropic subscription has one, OpenAI subscription has none)', () => {
		// OpenAI's adapter maps only ApiKey → OPENAI_API_KEY. A subscription credential
		// therefore yields no credential var (delivered via file mount instead), and
		// OpenAI is not a Claude Code runtime so no quiet env either: an empty list.
		const env = buildProviderEnv(AiProvider.OpenAI, {
			value: 'whatever',
			authMethod: AiAuthMethod.Subscription,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toEqual([]);
	});

	it('includes provider staticEnv (base URL + model defaults) for DeepSeek', () => {
		const env = buildProviderEnv(AiProvider.DeepSeek, {
			value: 'ds-key',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		// DeepSeek runs on Claude Code → quiet env present.
		expect(env).toContain('DISABLE_TELEMETRY=1');
		// staticEnv block contributes the base URL + model defaults.
		expect(env).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
		expect(env).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro');
		// DeepSeek's api-key var is ANTHROPIC_AUTH_TOKEN.
		expect(env).toContain('ANTHROPIC_AUTH_TOKEN=ds-key');
	});

	it('emits the Moonshot staticEnv + quiet env for Kimi (Claude Code runtime)', () => {
		const env = buildProviderEnv(AiProvider.Kimi, {
			value: 'kimi-key',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		// Kimi now runs on Claude Code against Moonshot's Anthropic-compatible endpoint
		// → quiet env present, plus the Moonshot base URL + model defaults.
		expect(env).toContain('DISABLE_TELEMETRY=1');
		expect(env).toContain('ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
		expect(env).toContain(`ANTHROPIC_DEFAULT_SONNET_MODEL=${KIMI_DEFAULT_MODEL}`);
		expect(env).toContain('ENABLE_TOOL_SEARCH=false');
		expect(env).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144');
		// Kimi's api-key var is ANTHROPIC_AUTH_TOKEN (Moonshot endpoint).
		expect(env).toContain('ANTHROPIC_AUTH_TOKEN=kimi-key');
	});

	it('emits staticEnv with NO quiet env for a non-Claude-Code provider (OpenRouter)', () => {
		const env = buildProviderEnv(AiProvider.OpenRouter, {
			value: 'or-key',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		// OpenRouter runs on the OpenCode runtime, not Claude Code → no DISABLE_* flags.
		expect(env.some((e) => e.startsWith('DISABLE_TELEMETRY='))).toBe(false);
		expect(env).toContain('OPENROUTER_API_KEY=or-key');
	});

	it('emits just the credential var for a provider with neither quiet env nor staticEnv (OpenAI api-key)', () => {
		const env = buildProviderEnv(AiProvider.OpenAI, {
			value: 'sk-openai',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toEqual(['OPENAI_API_KEY=sk-openai']);
	});

	it('stamps the Gemini workspace-trust env + GEMINI_API_KEY for a Google api-key credential', () => {
		const env = buildProviderEnv(AiProvider.Google, {
			value: 'AIza-google',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		// Gemini runs headless in /workspace, which the CLI treats as untrusted unless
		// told otherwise; the runtime env trusts it so --yolo keeps auto-approving.
		expect(env).toEqual(['GEMINI_CLI_TRUST_WORKSPACE=true', 'GEMINI_API_KEY=AIza-google']);
	});
});

// --------------------------------------------------------------------------
// shellQuoteArg — three branches: empty, safe-charset, needs-quoting.
// --------------------------------------------------------------------------
describe('shellQuoteArg', () => {
	it("quotes an empty string as ''", () => {
		expect(shellQuoteArg('')).toBe("''");
	});

	it('leaves a fully-safe token unquoted', () => {
		expect(shellQuoteArg('--model')).toBe('--model');
		expect(shellQuoteArg('a-b_c.d/e=f:g@h%i+j,k')).toBe('a-b_c.d/e=f:g@h%i+j,k');
	});

	it('single-quotes a token containing a space', () => {
		expect(shellQuoteArg('hello world')).toBe("'hello world'");
	});

	it("escapes embedded single-quotes with the '\\'' idiom", () => {
		// foo'bar → 'foo'\''bar'
		expect(shellQuoteArg("foo'bar")).toBe("'foo'\\''bar'");
	});
});

// --------------------------------------------------------------------------
// formatReactionLine — empty/undefined, glyph mapping, fallback kind, and the
// reactorLabel slug-vs-display-name-vs-fallback branches.
// --------------------------------------------------------------------------
describe('formatReactionLine', () => {
	function group(
		kind: string,
		members: Array<{ slug: string | null; display_name: string | null }>,
	): ReactionGroup {
		return {
			kind: kind as ReactionGroup['kind'],
			members: members.map((m, i) => ({ id: `m${i}`, slug: m.slug, display_name: m.display_name })),
			you_reacted: false,
		};
	}

	it('returns null for undefined groups', () => {
		expect(formatReactionLine(undefined)).toBeNull();
	});

	it('returns null for an empty group list', () => {
		expect(formatReactionLine([])).toBeNull();
	});

	it('maps the ack kind to its glyph and labels a slugged reactor with @slug', () => {
		const line = formatReactionLine([group('ack', [{ slug: 'qa', display_name: 'QA Bot' }])]);
		expect(line).toBe('Reactions: ✓ @qa');
	});

	it('falls back to the raw kind string when no glyph is registered', () => {
		const line = formatReactionLine([group('thumbsup', [{ slug: 'eng', display_name: null }])]);
		expect(line).toBe('Reactions: thumbsup @eng');
	});

	it('labels a reactor with no slug by display_name, and an empty reactor as "someone"', () => {
		const line = formatReactionLine([
			group('ack', [
				{ slug: null, display_name: 'Alice' },
				{ slug: null, display_name: null },
			]),
		]);
		expect(line).toBe('Reactions: ✓ Alice, someone');
	});

	it('joins multiple kinds with a middle dot', () => {
		const line = formatReactionLine([
			group('ack', [{ slug: 'a', display_name: null }]),
			group('eyes', [{ slug: 'b', display_name: null }]),
		]);
		expect(line).toBe('Reactions: ✓ @a · eyes @b');
	});
});

// --------------------------------------------------------------------------
// buildProgressUpdatePrompt — singular/plural, optional target_date / status_blurb /
// actions, and the measurement-empty fallback.
// --------------------------------------------------------------------------
describe('buildProgressUpdatePrompt', () => {
	function goal(overrides: Record<string, unknown> = {}) {
		return {
			id: 'g1',
			title: 'Ship v2',
			measurement: 'All P0 tasks closed',
			actions: 'Close the parser bug',
			progress_percent: 40,
			health: 'on_track',
			status_blurb: 'Halfway there',
			check_frequency: 'weekly',
			target_date: '2026-12-31',
			...overrides,
		};
	}

	it('uses singular phrasing and renders all optional fields for one goal', () => {
		const out = buildProgressUpdatePrompt('SYS', { goals: [goal()] });
		expect(out.startsWith('SYS')).toBe(true);
		expect(out).toContain('1 goal is also due for a progress check');
		// The status_blurb guidance tells the Captain it renders as markdown and to link PRs.
		expect(out).toContain('The blurb renders as markdown');
		expect(out).toContain('[PR #502](https://github.com/owner/repo/pull/502)');
		// 100% is not terminal — goals can regress or be never-ending.
		expect(out).toContain('A goal at 100% is not finished for tracking');
		expect(out).toContain('never-ending');
		expect(out).toContain('### Ship v2  `g1`');
		expect(out).toContain('deadline 2026-12-31');
		expect(out).toContain('- Last status: Halfway there');
		expect(out).toContain('- Achieved when: All P0 tasks closed');
		expect(out).toContain('- Suggested actions: Close the parser bug');
	});

	it('uses plural phrasing and omits optional lines when fields are empty/null', () => {
		const out = buildProgressUpdatePrompt('SYS', {
			goals: [
				goal({ target_date: null, status_blurb: '', actions: '', measurement: '' }),
				goal({ id: 'g2', title: 'Second', target_date: null, status_blurb: '', actions: '' }),
			],
		});
		expect(out).toContain('2 goals are also due for a progress check');
		// No deadline / last-status / suggested-actions lines on any goal.
		expect(out).not.toContain('deadline');
		expect(out).not.toContain('- Last status: ');
		expect(out).not.toContain('- Suggested actions: ');
		// measurement empty → the explicit "Not specified." fallback.
		expect(out).toContain('- Achieved when: Not specified.');
		expect(out).toContain('### Second  `g2`');
	});
});

// --------------------------------------------------------------------------
// buildTaskPrompt — handoff precedence (reply > mention), spawned-from lines,
// rules / progress-summary presence, description fallback, and retry partials.
// --------------------------------------------------------------------------
describe('buildTaskPrompt', () => {
	const mention: MentionContext = {
		authorName: 'Alice',
		excerpt: 'please fix it',
		openTickets: [
			{ identifier: 'BR-9', title: 'Open one', status: 'in_progress', priority: 'high' },
		],
		triggeringCommentId: 'cmt-1',
	};
	const reply: ReplyContext = {
		responderName: 'Bob',
		responderSlug: 'bob',
		replyExcerpt: 'here is my reply',
		originalExcerpt: 'my original',
		referencedTasks: [{ identifier: 'BR-2', title: 'Ref', status: 'done' }],
	};

	it('renders the reply handoff (and NOT the mention) when source=reply even if both contexts are present', async () => {
		const { WakeupSource } = await import('@hezo/shared');
		const out = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Reply },
			{
				mentionContext: mention,
				replyContext: reply,
			},
		);
		expect(out).toContain('## Reply Received');
		expect(out).not.toContain('## Mention Handoff');
		expect(out).toContain('> here is my reply');
		expect(out).toContain('> my original');
		expect(out).toContain('BR-2 — Ref (done)');
	});

	it('reply handoff makes an announced plan due — execute it or explicitly revise it', async () => {
		const { WakeupSource } = await import('@hezo/shared');
		const out = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Reply },
			{ replyContext: reply },
		);
		expect(out).toContain('that announced plan is now due');
		expect(out).toContain('explicitly revising or retracting it');
		expect(out).toContain('Do not merely acknowledge the answer');
	});

	it('renders the mention handoff when source=mention', async () => {
		const { WakeupSource } = await import('@hezo/shared');
		const out = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Mention },
			{
				mentionContext: mention,
			},
		);
		expect(out).toContain('## Mention Handoff');
		expect(out).toContain('> please fix it');
		expect(out).toContain('- BR-9 — Open one (in_progress, high)');
		expect(out).toContain("add_reaction(comment_id='cmt-1', kind='ack')");
	});

	it('renders neither handoff block when the source is not a mention/reply', () => {
		const out = buildTaskPrompt('SYS', makeTask(), undefined, {
			mentionContext: mention,
			replyContext: reply,
		});
		expect(out).not.toContain('## Mention Handoff');
		expect(out).not.toContain('## Reply Received');
		expect(out).toContain('## Current Task: BR-1 — Branch Task');
	});

	it('renders an empty-mention excerpt and an empty open-task list as their fallbacks', async () => {
		const { WakeupSource } = await import('@hezo/shared');
		const out = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Mention },
			{ mentionContext: { ...mention, excerpt: '', openTickets: [] } },
		);
		expect(out).toContain('> (empty)');
		// open-ticket list collapses to the literal "none".
		expect(out).toMatch(/### Your open tasks\nnone/);
	});

	it('renders an empty-reply / empty-original excerpt and "none" referenced tasks, with a bare responder name (no slug)', async () => {
		const { WakeupSource } = await import('@hezo/shared');
		const out = buildTaskPrompt(
			'SYS',
			makeTask(),
			{ source: WakeupSource.Reply },
			{
				replyContext: {
					responderName: 'NoSlug',
					responderSlug: null,
					replyExcerpt: '',
					originalExcerpt: '',
					referencedTasks: [],
				},
			},
		);
		// Both excerpt blocks fall back to "> (empty)".
		expect(out.match(/> \(empty\)/g)?.length).toBe(2);
		expect(out).toContain('### Tasks referenced by the reply\nnone');
		// responderLabel without a slug is the bare name.
		expect(out).toContain('NoSlug replied on BR-1');
	});

	it('includes rules + progress summary + spawned-from lines when present', () => {
		const out = buildTaskPrompt(
			'SYS',
			makeTask({ rules: 'Write tests', progress_summary: 'Half done' }),
			undefined,
			{
				spawnedFrom: {
					parentLine: '**Parent task:** BR-0 — Parent',
					spawnLine: '**Spawned from:** BR-7 — Spawner (provenance only)',
				},
			},
		);
		expect(out).toContain('### Rules for this task');
		expect(out).toContain('Write tests');
		expect(out).toContain('### Progress Summary');
		expect(out).toContain('Half done');
		expect(out).toContain('**Parent task:** BR-0 — Parent');
		expect(out).toContain('**Spawned from:** BR-7 — Spawner');
	});

	it('falls back to "No description provided." when the task has no description', () => {
		const out = buildTaskPrompt('SYS', makeTask({ description: '' }));
		expect(out).toContain('No description provided.');
		expect(out).not.toContain('### Progress Summary');
	});

	it('renders a retry block with only the exit code (no stderr/stdout tails)', () => {
		const out = buildTaskPrompt('SYS', makeTask(), {
			retry_count: 1,
			max_retries: 2,
			previous_failure: { exit_code: 0 },
		});
		expect(out).toContain('## Retry Attempt 1/2');
		expect(out).toContain('**Exit code:** 0');
		expect(out).not.toContain('**Error output:**');
		expect(out).not.toContain('**Last output:**');
	});

	it('omits the exit-code line when previous_failure carries a null exit code, but renders the tails', () => {
		const out = buildTaskPrompt('SYS', makeTask(), {
			retry_count: 3,
			max_retries: 3,
			previous_failure: { exit_code: null, stderr_tail: 'boom', stdout_tail: 'tail' },
		});
		expect(out).toContain('## Retry Attempt 3/3');
		expect(out).not.toContain('**Exit code:**');
		expect(out).toContain('**Error output:**');
		expect(out).toContain('boom');
		expect(out).toContain('**Last output:**');
		expect(out).toContain('tail');
	});
});

// --------------------------------------------------------------------------
// loadAgentAttachmentsForComments — empty fast-path + real grouping by comment.
// --------------------------------------------------------------------------
describe('loadAgentAttachmentsForComments', () => {
	it('returns an empty map for no comment ids without querying', async () => {
		const out = await loadAgentAttachmentsForComments(
			db,
			[],
			masterKeyManager,
			'http://127.0.0.1:47081',
		);
		expect(out.size).toBe(0);
	});

	it('groups attachments by comment id with a signed download url', async () => {
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'with attachment' })],
		);
		const commentId = comment.rows[0].id;
		const asset = await db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, original_filename, content_type, byte_size, sha256, uploaded_by_member_id)
			 VALUES ($1, $2, 'diagram.png', 'image/png', 2048, $3, NULL) RETURNING id`,
			[teamId, projectId, `sha-${taskId}-diagram`],
		);
		const assetId = asset.rows[0].id;
		await db.query(`INSERT INTO comment_attachments (comment_id, asset_id) VALUES ($1, $2)`, [
			commentId,
			assetId,
		]);

		const out = await loadAgentAttachmentsForComments(
			db,
			[commentId],
			masterKeyManager,
			'http://127.0.0.1:47081',
		);
		const list = out.get(commentId) as AgentAttachment[];
		expect(list).toBeDefined();
		expect(list.length).toBe(1);
		expect(list[0].original_filename).toBe('diagram.png');
		expect(list[0].content_type).toBe('image/png');
		expect(list[0].byte_size).toBe(2048);
		expect(list[0].url).toMatch(
			new RegExp(`^http://127\\.0\\.0\\.1:47081/api/assets/${assetId}\\?exp=\\d+&sig=`),
		);

		await db.query('DELETE FROM comment_attachments WHERE comment_id = $1', [commentId]);
		await db.query('DELETE FROM assets WHERE id = $1', [assetId]);
		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
	});
});

// --------------------------------------------------------------------------
// loadMentionContext — agent author resolution (member_agents.title) and the
// empty-open-tickets path (all of the agent's tasks terminal).
// --------------------------------------------------------------------------
describe('loadMentionContext', () => {
	it('resolves the author from member_agents.title when the comment was authored by an agent', async () => {
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: 'agent-authored mention' })],
		);
		const commentId = comment.rows[0].id;

		const ctx = await loadMentionContext(db, agentId, teamId, { comment_id: commentId });
		expect(ctx).not.toBeNull();
		// The agent's title (member_agents.title) wins over display_name/'Admin'.
		expect(ctx!.authorName).toBeTruthy();
		expect(ctx!.excerpt).toBe('agent-authored mention');

		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
	});

	it('returns null when the comment id does not resolve to a row', async () => {
		const ctx = await loadMentionContext(db, agentId, teamId, {
			comment_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(ctx).toBeNull();
	});

	it('returns an empty openTickets list when the mentionee has no non-terminal assigned tasks', async () => {
		// Use a fresh agent with nothing assigned so the open-ticket query is empty,
		// exercising the [] branch in renderMentionHandoff's caller.
		const otherAgent = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Lonely Agent') RETURNING id`,
			[teamId],
		);
		const otherId = otherAgent.rows[0].id;
		await db.query(
			`INSERT INTO member_agents (id, title, slug)
			 VALUES ($1, 'Lonely Agent', 'lonely')`,
			[otherId],
		);
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'mention for lonely agent' })],
		);
		const commentId = comment.rows[0].id;

		const ctx = await loadMentionContext(db, otherId, teamId, { comment_id: commentId });
		expect(ctx).not.toBeNull();
		expect(ctx!.openTickets).toEqual([]);
		// No member_agents.title joined for a NULL author → falls back to 'Admin'.
		expect(ctx!.authorName).toBe('Admin');

		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
		await db.query('DELETE FROM member_agents WHERE id = $1', [otherId]);
		await db.query('DELETE FROM members WHERE id = $1', [otherId]);
	});
});

// --------------------------------------------------------------------------
// loadReplyContext — missing ids, missing reply row, missing original row, and
// the no-referenced-tasks branch (reply text has no IDENT-\d pattern).
// --------------------------------------------------------------------------
describe('loadReplyContext', () => {
	it('returns null when the reply comment id is missing', async () => {
		const ctx = await loadReplyContext(db, { triggering_comment_id: 'x' });
		expect(ctx).toBeNull();
	});

	it('returns null when the reply comment row does not exist', async () => {
		const ctx = await loadReplyContext(db, {
			comment_id: '00000000-0000-0000-0000-000000000000',
			triggering_comment_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(ctx).toBeNull();
	});

	it('returns null when the triggering (original) comment row does not exist', async () => {
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'a reply' })],
		);
		const replyId = reply.rows[0].id;

		const ctx = await loadReplyContext(db, {
			comment_id: replyId,
			triggering_comment_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(ctx).toBeNull();

		await db.query('DELETE FROM task_comments WHERE id = $1', [replyId]);
	});

	it('returns referencedTasks=[] when the reply text mentions no task identifiers', async () => {
		const original = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ text: 'original with no idents' })],
		);
		const originalId = original.rows[0].id;
		const reply = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, 'text', $2::jsonb) RETURNING id`,
			[taskId, JSON.stringify({ text: 'plain reply, nothing referenced' })],
		);
		const replyId = reply.rows[0].id;

		const ctx = await loadReplyContext(db, {
			comment_id: replyId,
			triggering_comment_id: originalId,
		});
		expect(ctx).not.toBeNull();
		expect(ctx!.referencedTasks).toEqual([]);
		expect(ctx!.replyExcerpt).toBe('plain reply, nothing referenced');
		expect(ctx!.originalExcerpt).toBe('original with no idents');
		// NULL author on the reply → author_name fallback 'Admin', author_slug null.
		expect(ctx!.responderName).toBe('Admin');
		expect(ctx!.responderSlug).toBeNull();

		await db.query('DELETE FROM task_comments WHERE id = ANY($1::uuid[])', [[originalId, replyId]]);
	});
});

// --------------------------------------------------------------------------
// loadSpawnedFromTask — self-referential spawning run (run lives on the same
// task) is skipped, and parent-only / spawn-only branches.
// --------------------------------------------------------------------------
describe('loadSpawnedFromTask', () => {
	it('returns null when the spawning run is the task itself (self-reference)', async () => {
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId],
		);
		// Run lives on the SAME task we ask about → loadSpawnedFromTask must skip it
		// (row.id === task.id) and, with no parent, return null.
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[agentId, teamId, taskId, wakeup.rows[0].id],
		);

		const out = await loadSpawnedFromTask(
			db,
			makeTask({ created_by_run_id: run.rows[0].id, parent_task_id: null }),
		);
		expect(out).toBeNull();

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [run.rows[0].id]);
		await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeup.rows[0].id]);
	});

	it('returns a parent-only result when the task has a parent but no spawning run', async () => {
		const parentRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent Only',
				description: 'p',
				assignee_id: agentId,
			}),
		});
		const parent = (await parentRes.json()).data;

		const out = await loadSpawnedFromTask(db, makeTask({ parent_task_id: parent.id }));
		expect(out).not.toBeNull();
		expect(out!.parentLine).toContain('Parent Only');
		expect(out!.spawnLine).toBeNull();

		await db.query('DELETE FROM tasks WHERE id = $1', [parent.id]);
	});

	it('returns a spawn-only result when created_by_run_id resolves but the run lacks a task row link to a real task title', async () => {
		// Spawn from a run on a DIFFERENT task; no parent set → spawnLine only.
		const spawnTaskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Spawner Only',
				description: 's',
				assignee_id: agentId,
			}),
		});
		const spawnTask = (await spawnTaskRes.json()).data;
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
			 VALUES ($1, $2, 'on_demand'::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
			 RETURNING id`,
			[agentId, teamId],
		);
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[agentId, teamId, spawnTask.id, wakeup.rows[0].id],
		);

		const out = await loadSpawnedFromTask(
			db,
			makeTask({ created_by_run_id: run.rows[0].id, parent_task_id: null }),
		);
		expect(out).not.toBeNull();
		expect(out!.parentLine).toBeNull();
		expect(out!.spawnLine).toContain('Spawner Only');

		await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [run.rows[0].id]);
		await db.query('DELETE FROM agent_wakeup_requests WHERE id = $1', [wakeup.rows[0].id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [spawnTask.id]);
	});
});

// --------------------------------------------------------------------------
// loadOpenSubTasks + its buildTaskPrompt block — the downward half of a
// ticket's lineage. A manager that cannot see what it already delegated
// re-does its report's in-flight work when fresh feedback lands on the parent
// ticket; SHARED_INSTRUCTIONS tells it to route that feedback instead, and
// this block is what makes the rule checkable from the prompt.
// --------------------------------------------------------------------------
describe('loadOpenSubTasks', () => {
	async function createSubTask(title: string): Promise<{ id: string; identifier: string }> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title,
				description: 'delegated slice',
				assignee_id: agentId,
				parent_task_id: taskId,
			}),
		});
		return (await res.json()).data;
	}

	it('returns only the non-terminal children, and renders them in the task prompt', async () => {
		const open = await createSubTask('Rewrite the openers');
		const closed = await createSubTask('Already delivered');
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [closed.id]);

		const subs = await loadOpenSubTasks(db, makeTask());
		expect(subs.map((s) => s.identifier)).toEqual([open.identifier]);
		expect(subs[0].title).toBe('Rewrite the openers');
		expect(subs[0].status).toBe('backlog');
		// The assignee is the whole point of the line — it names who to route to.
		expect(subs[0].assignee_name).toBeTruthy();

		const prompt = buildTaskPrompt('SYS', makeTask(), undefined, { openSubTasks: subs });
		expect(prompt).toContain('**Open sub-tasks**');
		expect(prompt).toContain('do not do their work yourself');
		expect(prompt).toContain(`- ${open.identifier} — Rewrite the openers (backlog, assigned to`);
		// A finished child is not in flight, so it must not appear as something to
		// route to — its work is fresh work, filed as a new sub-task.
		expect(prompt).not.toContain(closed.identifier);

		await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [[open.id, closed.id]]);
	});

	it('renders an unassigned child rather than dropping it', async () => {
		const orphan = await createSubTask('Nobody owns this yet');
		await db.query('UPDATE tasks SET assignee_id = NULL WHERE id = $1', [orphan.id]);

		const subs = await loadOpenSubTasks(db, makeTask());
		expect(subs).toHaveLength(1);
		expect(subs[0].assignee_name).toBeNull();
		expect(buildTaskPrompt('SYS', makeTask(), undefined, { openSubTasks: subs })).toContain(
			`- ${orphan.identifier} — Nobody owns this yet (backlog, assigned to unassigned)`,
		);

		await db.query('DELETE FROM tasks WHERE id = $1', [orphan.id]);
	});

	it('omits the block entirely for a task with no open children', async () => {
		expect(await loadOpenSubTasks(db, makeTask())).toEqual([]);
		expect(buildTaskPrompt('SYS', makeTask(), undefined, { openSubTasks: [] })).not.toContain(
			'Open sub-tasks',
		);
		// Callers that never pass the field at all behave the same way.
		expect(buildTaskPrompt('SYS', makeTask())).not.toContain('Open sub-tasks');
	});
});

// --------------------------------------------------------------------------
// buildCoachReviewPrompt — rules/summary present-vs-absent, reactions +
// attachments rendered inline, non-text comment JSON, and the empty fallbacks.
// --------------------------------------------------------------------------
describe('buildCoachReviewPrompt', () => {
	it('renders the empty fallbacks when the task has no comments, no rules, no summary', async () => {
		// A fresh task with nothing on it.
		const bareRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Bare',
				description: 'placeholder',
				assignee_id: agentId,
			}),
		});
		const bare = (await bareRes.json()).data;

		const out = await buildCoachReviewPrompt(
			db,
			'SYS',
			makeTask({
				id: bare.id,
				identifier: bare.identifier,
				title: 'Bare',
				description: '',
				rules: null,
				progress_summary: null,
			}),
			teamId,
			masterKeyManager,
			'http://127.0.0.1:47081',
		);
		expect(out).toContain('## Review Completed Task: ');
		expect(out).toContain('No description provided.');
		expect(out).not.toContain('### Rules');
		expect(out).not.toContain('### Progress Summary');
		expect(out).toContain('No comments on this task.');

		await db.query('DELETE FROM task_comments WHERE task_id = $1', [bare.id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [bare.id]);
	});

	it('renders rules + summary, the agent in "Agents Involved", and a comment with a reaction + attachment + a non-text comment', async () => {
		const revRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Reviewed',
				description: 'desc',
				assignee_id: agentId,
			}),
		});
		const rev = (await revRes.json()).data;

		// A text comment authored by the agent (so it shows in Agents Involved + the log).
		const textComment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
			[rev.id, agentId, JSON.stringify({ text: 'I finished the work.' })],
		);
		const textId = textComment.rows[0].id;
		// A non-text comment → rendered as JSON.stringify(content), exercising that branch.
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'system'::comment_content_type, $3::jsonb)`,
			[rev.id, agentId, JSON.stringify({ from: 'backlog', to: 'done' })],
		);
		// A reaction on the text comment so formatReactionLine is invoked from the prompt.
		await db.query(
			`INSERT INTO comment_reactions (comment_id, member_id, kind)
			 VALUES ($1, $2, 'ack')`,
			[textId, agentId],
		);
		// An attachment on the text comment so the attachment line renders.
		const asset = await db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, original_filename, content_type, byte_size, sha256, uploaded_by_member_id)
			 VALUES ($1, $2, 'log.txt', 'text/plain', 99, $3, NULL) RETURNING id`,
			[teamId, projectId, `sha-${rev.id}-log`],
		);
		await db.query(`INSERT INTO comment_attachments (comment_id, asset_id) VALUES ($1, $2)`, [
			textId,
			asset.rows[0].id,
		]);

		const out = await buildCoachReviewPrompt(
			db,
			'SYS',
			makeTask({
				id: rev.id,
				identifier: rev.identifier,
				title: 'Reviewed',
				description: 'desc',
				status: 'done',
				rules: 'Test everything',
				progress_summary: 'All done',
			}),
			teamId,
			masterKeyManager,
			'http://127.0.0.1:47081',
		);

		expect(out).toContain('### Rules');
		expect(out).toContain('Test everything');
		expect(out).toContain('### Progress Summary');
		expect(out).toContain('All done');
		// The text comment + its reaction + attachment lines.
		expect(out).toContain('I finished the work.');
		expect(out).toContain('Reactions: ✓');
		expect(out).toContain('attachment: log.txt (text/plain, 99 bytes)');
		// The non-text comment rendered as JSON.
		expect(out).toContain('"to":"done"');
		// The agent shows up in Agents Involved (assignee + author).
		expect(out).toContain('### Agents Involved');
		expect(out).toContain(`id: ${agentId}`);

		await db.query('DELETE FROM comment_attachments WHERE asset_id = $1', [asset.rows[0].id]);
		await db.query('DELETE FROM assets WHERE id = $1', [asset.rows[0].id]);
		await db.query('DELETE FROM comment_reactions WHERE comment_id = $1', [textId]);
		await db.query('DELETE FROM task_comments WHERE task_id = $1', [rev.id]);
		await db.query('DELETE FROM tasks WHERE id = $1', [rev.id]);
	});
});

// --------------------------------------------------------------------------
// acquireCredentialLock — serialises overlapping acquisitions on one config id
// and lets a different config id proceed concurrently.
// --------------------------------------------------------------------------
describe('acquireCredentialLock', () => {
	it('serialises two acquisitions on the same config id (second waits for the first release)', async () => {
		const id = `cfg-${Math.random().toString(36).slice(2)}`;
		const release1 = await acquireCredentialLock(id);

		let secondAcquired = false;
		const secondPromise = acquireCredentialLock(id).then((release2) => {
			secondAcquired = true;
			return release2;
		});

		// While the first lock is held, the second must not have acquired yet.
		await Promise.resolve();
		await Promise.resolve();
		expect(secondAcquired).toBe(false);

		release1();
		const release2 = await secondPromise;
		expect(secondAcquired).toBe(true);
		release2();
	});

	it('lets a different config id acquire immediately (no cross-id blocking)', async () => {
		const a = `cfg-a-${Math.random().toString(36).slice(2)}`;
		const b = `cfg-b-${Math.random().toString(36).slice(2)}`;
		const releaseA = await acquireCredentialLock(a);
		// Different id → resolves without waiting on A.
		const releaseB = await acquireCredentialLock(b);
		releaseA();
		releaseB();
		expect(true).toBe(true);
	});
});
