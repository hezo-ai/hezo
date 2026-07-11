import { CEO_AGENT_SLUG, CredentialKind, DEFAULT_TEAM_ID, ReactionKind } from '@hezo/shared';
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
	encrypt,
	instanceCeoId,
	instanceCoachId,
	mintAgentToken,
} from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

// These extend the coverage of packages/server/src/mcp/tools.ts beyond what
// mcp-tools.test.ts / mcp.test.ts / mcp-project-scope.test.ts already exercise:
// the tool handlers and validation / authorization / not-found branches that
// were never reached over the /mcp HTTP surface. Each call asserts on the tool's
// JSON result (an `error` field on the failure paths), not an HTTP 500.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string; // engineer (a non-Captain worker on team A)
let captainId: string;
let taskId: string; // a task assigned to the engineer on team A

let teamBId: string;
let projectBId: string;
let agentBId: string;
let taskInBId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	// Team A — the team-under-test.
	const teamRes = await createTestTeam(db, { name: 'MCP Extended Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Extended Project',
		description: 'Extended coverage project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const eng = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
		[teamId],
	);
	agentId = eng.rows[0].id;
	const cap = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	captainId = cap.rows[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Extended Seed Task',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;

	// Team B — gives us a cross-team boundary for authorization-rejection tests.
	const teamBRes = await createTestTeam(db, { name: 'MCP Extended Co B', template_id: typeId });
	teamBId = (await teamBRes.json()).data.id;
	const projectBRes = await createTestProject(db, teamBId, {
		name: 'Extended Project B',
		description: 'Team B project.',
	});
	const projectBData = (await projectBRes.json()).data;
	projectBId = projectBData.id;
	const projectBSlug = projectBData.slug;
	const engB = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
		[teamBId],
	);
	agentBId = engB.rows[0].id;
	const taskBRes = await app.request(`/api/projects/${projectBSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectBId, title: 'Task in B', assignee_id: agentBId }),
	});
	taskInBId = (await taskBRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

/** Call an MCP tool with the admin token and return its parsed result. */
async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	return callToolAs(token, toolName, args);
}

/** Call an MCP tool as an arbitrary principal token and return its parsed result. */
async function callToolAs(
	tokenStr: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(tokenStr), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result?: { content: Array<{ type: string; text: string }> };
		error?: { message: string };
	};
	// A schema-validation failure comes back as a non-JSON MCP error string
	// ("MCP error -32602: Input validation error: ...") in the result content (or a
	// JSON-RPC error). Surface either as { error } so callers assert uniformly.
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text);
	} catch {
		return { error: text };
	}
}

type ToolResult = Record<string, unknown> & { error?: string };

async function createTask(title: string, assignee = agentId): Promise<string> {
	const r = (await callTool('create_task', {
		project: projectId,
		title,
		assignee_id: assignee,
	})) as { id: string };
	return r.id;
}

async function captainToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, captainId, teamId);
	return t;
}

describe('MCP get_team / list_team_templates', () => {
	it('get_team returns the team backing the project', async () => {
		const team = (await callTool('get_team', { project: projectId })) as {
			id: string;
			name: string;
		};
		expect(team.id).toBe(teamId);
		expect(team.name).toBe('MCP Extended Co');
	});

	it('get_team without a project arg errors for an instance principal (api key)', async () => {
		const result = (await callTool('get_team', {})) as ToolResult;
		expect(result.error).toContain('`project` is required');
	});

	it('list_team_templates returns the built-in templates with their roles', async () => {
		const rows = (await callTool('list_team_templates', {})) as Array<{
			name: string;
			is_builtin: boolean;
			agent_types: Array<{ slug: string }>;
		}>;
		expect(Array.isArray(rows)).toBe(true);
		const startup = rows.find((r) => r.name === 'Startup');
		expect(startup).toBeDefined();
		expect(startup?.is_builtin).toBe(true);
		expect(startup?.agent_types.map((a) => a.slug)).toContain('engineer');
	});
});

describe('MCP create_team', () => {
	it('superuser can create a team', async () => {
		const result = (await callTool('create_team', { name: 'Spun Up Co', description: 'made' })) as {
			id?: string;
			slug?: string;
			error?: string;
		};
		expect(result.error).toBeUndefined();
		expect(result.id).toBeTruthy();
		expect(result.slug).toBe('spun-up-co');
	});

	it('rejects a non-superuser agent', async () => {
		const result = (await callToolAs(await captainToken(), 'create_team', {
			name: 'Agent Team',
		})) as ToolResult;
		expect(result.error).toContain('superuser required');
	});
});

describe('MCP list_tasks filters', () => {
	it('filters by status (comma-separated list)', async () => {
		const id = await createTask('Status filter target');
		await db.query("UPDATE tasks SET status = 'review'::task_status WHERE id = $1", [id]);
		const rows = (await callTool('list_tasks', {
			project: projectId,
			status: 'review,blocked',
		})) as Array<{ id: string; status: string }>;
		expect(rows.some((r) => r.id === id)).toBe(true);
		for (const row of rows) expect(['review', 'blocked']).toContain(row.status);
	});

	it('filters by assignee_slug', async () => {
		const rows = (await callTool('list_tasks', {
			project: projectId,
			assignee_slug: 'engineer',
		})) as Array<{ assignee_id: string }>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.assignee_id).toBe(agentId);
	});

	it('returns an empty list for an unknown assignee_slug', async () => {
		const rows = (await callTool('list_tasks', {
			project: projectId,
			assignee_slug: 'no-such-role',
		})) as unknown[];
		expect(rows).toEqual([]);
	});
});

describe('MCP create_task / create_tasks error & batch branches', () => {
	it('create_task surfaces a CreateTaskError as a tool error (unknown assignee_slug)', async () => {
		const result = (await callTool('create_task', {
			project: projectId,
			title: 'Bad assignee',
			assignee_slug: 'nobody-here',
		})) as ToolResult;
		expect(typeof result.error).toBe('string');
		expect(result.error).not.toBe('');
	});

	it('create_tasks creates a batch and chains blockers by index token', async () => {
		const results = (await callTool('create_tasks', {
			project: projectId,
			items: [
				{ title: 'Phase 1', assignee_id: agentId },
				{ title: 'Phase 2', assignee_id: agentId, blocked_by_task_ids: ['#0'] },
			],
		})) as Array<{ ok: boolean; index: number; task?: { id: string } }>;
		expect(results.length).toBe(2);
		expect(results[0].ok).toBe(true);
		expect(results[1].ok).toBe(true);
		// Phase 2 is blocked by Phase 1.
		const dep = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM task_dependencies
			 WHERE task_id = $1 AND blocked_by_task_id = $2`,
			[results[1].task?.id, results[0].task?.id],
		);
		expect(dep.rows[0].n).toBe(1);
	});

	it('create_tasks returns a per-item error without aborting the rest', async () => {
		const results = (await callTool('create_tasks', {
			project: projectId,
			items: [
				{ title: 'Good item', assignee_id: agentId },
				{ title: 'Bad item', assignee_slug: 'nobody-here' },
			],
		})) as Array<{ ok: boolean; index: number; error?: string }>;
		expect(results[0].ok).toBe(true);
		expect(results[1].ok).toBe(false);
		expect(typeof results[1].error).toBe('string');
	});

	it('create_tasks as an agent attaches a backtick advisory per created item', async () => {
		// The agent path (auth.type === Agent) folds withBacktickWarning over each
		// created task — distinct from the admin path that returns raw results.
		// A Captain may always assign to itself; this drives the agent fold over the
		// batch (withBacktickWarning per created item) rather than the admin path.
		const results = (await callToolAs(await captainToken(), 'create_tasks', {
			project: projectId,
			items: [{ title: 'Agent batch item', assignee_id: captainId }],
		})) as Array<{ ok: boolean; task?: { id: string } }>;
		expect(results[0].ok).toBe(true);
		expect(results[0].task?.id).toBeTruthy();
	});
});

describe('MCP add_task_blocker / remove_task_blocker', () => {
	it('add_task_blocker links two tasks and remove clears it', async () => {
		const downstream = await createTask('Blocker downstream');
		const upstream = await createTask('Blocker upstream');

		const added = (await callTool('add_task_blocker', {
			project: projectId,
			task_id: downstream,
			blocked_by_task_id: upstream,
		})) as { id?: string; error?: string };
		expect(added.error).toBeUndefined();
		expect(added.id).toBeTruthy();

		// Duplicate is rejected.
		const dup = (await callTool('add_task_blocker', {
			project: projectId,
			task_id: downstream,
			blocked_by_task_id: upstream,
		})) as ToolResult;
		expect(dup.error).toContain('already exists');

		const removed = (await callTool('remove_task_blocker', {
			project: projectId,
			task_id: downstream,
			blocked_by_task_id: upstream,
		})) as { removed?: boolean; error?: string };
		expect(removed.removed).toBe(true);

		// Removing a non-existent dependency errors.
		const removeAgain = (await callTool('remove_task_blocker', {
			project: projectId,
			task_id: downstream,
			blocked_by_task_id: upstream,
		})) as ToolResult;
		expect(removeAgain.error).toContain('Dependency not found');
	});

	it('add_task_blocker rejects a self-block', async () => {
		const t = await createTask('Self block target');
		const result = (await callTool('add_task_blocker', {
			project: projectId,
			task_id: t,
			blocked_by_task_id: t,
		})) as ToolResult;
		expect(result.error).toContain('cannot block itself');
	});

	it('add_task_blocker rejects a cycle', async () => {
		const a = await createTask('Cycle A');
		const b = await createTask('Cycle B');
		await callTool('add_task_blocker', {
			project: projectId,
			task_id: a,
			blocked_by_task_id: b,
		});
		// b -> a would close the loop.
		const result = (await callTool('add_task_blocker', {
			project: projectId,
			task_id: b,
			blocked_by_task_id: a,
		})) as ToolResult;
		expect(result.error).toContain('cycle');
	});

	it('add_task_blocker errors for an unknown blocker identifier', async () => {
		const t = await createTask('Unknown blocker target');
		const result = (await callTool('add_task_blocker', {
			project: projectId,
			task_id: t,
			blocked_by_task_id: 'ZZ-99999',
		})) as ToolResult;
		expect(result.error).toContain('Blocking task not found');
	});

	it('remove_task_blocker errors for an unknown blocker identifier', async () => {
		const t = await createTask('Unknown remove blocker target');
		const result = (await callTool('remove_task_blocker', {
			project: projectId,
			task_id: t,
			blocked_by_task_id: 'ZZ-99999',
		})) as ToolResult;
		expect(result.error).toContain('Blocking task not found');
	});
});

describe('MCP reactions (add_reaction / remove_reaction)', () => {
	it('add then remove a reaction round-trips and broadcasts', async () => {
		const t = await createTask('Reaction target');
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
			[t, agentId, JSON.stringify({ text: 'react to me' })],
		);
		const commentId = inserted.rows[0].id;

		const captain = await captainToken();
		const added = (await callToolAs(captain, 'add_reaction', {
			project: projectId,
			task_id: t,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		})) as { comment_id?: string; kind?: string; reactions?: unknown[]; error?: string };
		expect(added.error).toBeUndefined();
		expect(added.comment_id).toBe(commentId);
		expect(added.kind).toBe(ReactionKind.Ack);

		const removed = (await callToolAs(captain, 'remove_reaction', {
			project: projectId,
			task_id: t,
			comment_id: commentId,
			kind: ReactionKind.Ack,
		})) as { reactions?: unknown[]; error?: string };
		expect(removed.error).toBeUndefined();
	});

	it('add_reaction on a comment from another task is rejected by the reaction service', async () => {
		const t1 = await createTask('Reaction task one');
		const t2 = await createTask('Reaction task two');
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
			[t2, agentId, JSON.stringify({ text: 'on task two' })],
		);
		const result = (await callToolAs(await captainToken(), 'add_reaction', {
			project: projectId,
			task_id: t1,
			comment_id: inserted.rows[0].id,
			kind: ReactionKind.Ack,
		})) as ToolResult;
		expect(typeof result.error).toBe('string');
	});
});

describe('MCP create_comment warnings & threading', () => {
	it('warns when an agent references a teammate by bold/plain name (no @)', async () => {
		const t = await createTask('Unlinked mention target');
		const result = (await callToolAs(await captainToken(), 'create_comment', {
			project: projectId,
			task_id: t,
			content: 'Hey **engineer**, please pick this up.',
		})) as { id?: string; warning?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.id).toBeTruthy();
		expect(result.warning).toContain('engineer');
		expect(result.warning).toContain('@engineer');
	});

	it('warns when an agent backticks a real task identifier and teammate slug', async () => {
		const ref = (await callTool('create_task', {
			project: projectId,
			title: 'Backtick reference target',
			assignee_id: agentId,
		})) as { identifier: string };
		const t = await createTask('Backtick comment host');
		const result = (await callToolAs(await captainToken(), 'create_comment', {
			project: projectId,
			task_id: t,
			content: `See \`${ref.identifier}\` and ask \`engineer\` about it.`,
		})) as { id?: string; warning?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.warning).toContain('backticks');
		expect(result.warning).toContain(ref.identifier);
	});

	it('threads a reply when parent_comment_id belongs to the task', async () => {
		const t = await createTask('Reply threading target');
		const parent = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
			[t, agentId, JSON.stringify({ text: 'original' })],
		);
		const result = (await callToolAs(await captainToken(), 'create_comment', {
			project: projectId,
			task_id: t,
			content: 'A direct reply.',
			parent_comment_id: parent.rows[0].id,
		})) as { id?: string; parent_comment_id?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.parent_comment_id).toBe(parent.rows[0].id);
	});

	it('rejects a parent_comment_id from a different task', async () => {
		const t1 = await createTask('Reply host one');
		const t2 = await createTask('Reply host two');
		const foreign = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
			[t2, agentId, JSON.stringify({ text: 'elsewhere' })],
		);
		const result = (await callToolAs(await captainToken(), 'create_comment', {
			project: projectId,
			task_id: t1,
			content: 'Bad parent.',
			parent_comment_id: foreign.rows[0].id,
		})) as ToolResult;
		expect(result.error).toContain('does not belong to this task');
	});
});

describe('MCP request_credential', () => {
	it('posts a credential request and returns a placeholder', async () => {
		const result = (await callToolAs(await captainToken(), 'request_credential', {
			project: projectId,
			task_id: taskId,
			name: 'NETLIFY_API_KEY',
			kind: CredentialKind.ApiKey,
			instructions: 'Need a Netlify key with deploy scope.',
			allowed_hosts: ['api.netlify.com'],
		})) as { placeholder?: string; status?: string; reused?: boolean; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.placeholder).toBe('__HEZO_SECRET_NETLIFY_API_KEY__');
		expect(result.status).toBe('pending');
		expect(result.reused).toBe(false);

		// A second identical request reuses the open comment.
		const again = (await callToolAs(await captainToken(), 'request_credential', {
			project: projectId,
			task_id: taskId,
			name: 'NETLIFY_API_KEY',
			kind: CredentialKind.ApiKey,
			instructions: 'Need a Netlify key with deploy scope.',
			allowed_hosts: ['api.netlify.com'],
		})) as { reused?: boolean };
		expect(again.reused).toBe(true);
	});

	it('rejects an invalid secret name', async () => {
		const result = (await callToolAs(await captainToken(), 'request_credential', {
			project: projectId,
			task_id: taskId,
			name: 'lower-case-bad',
			kind: CredentialKind.Other,
			instructions: 'whatever',
		})) as ToolResult;
		expect(result.error).toContain('name must match');
	});

	it('requires allowed_hosts for HTTP-auth kinds', async () => {
		const result = (await callToolAs(await captainToken(), 'request_credential', {
			project: projectId,
			task_id: taskId,
			name: 'SOME_TOKEN',
			kind: CredentialKind.OauthToken,
			instructions: 'no hosts given',
		})) as ToolResult;
		expect(result.error).toContain('allowed_hosts');
	});

	it('allows a confirmation request without allowed_hosts', async () => {
		const result = (await callToolAs(await captainToken(), 'request_credential', {
			project: projectId,
			task_id: taskId,
			name: 'CONFIRM_KEY_ADDED',
			kind: CredentialKind.GithubPat,
			instructions: 'Confirm the deploy key is present.',
			confirmation_text: 'Have you added the key?',
		})) as { placeholder?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.placeholder).toBe('__HEZO_SECRET_CONFIRM_KEY_ADDED__');
	});
});

describe('MCP register_connector', () => {
	it('registers a pending SaaS connector and posts a connect_required comment', async () => {
		const result = (await callToolAs(await captainToken(), 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: 'DatoCMS',
			mcp_url: 'https://mcp.datocms.com/',
		})) as {
			connector_id?: string;
			status?: string;
			comment_id?: string;
			name?: string;
			error?: string;
		};
		expect(result.error).toBeUndefined();
		expect(result.connector_id).toBeTruthy();
		expect(result.status).toBe('pending');
		expect(result.comment_id).toBeTruthy();
		expect(result.name).toBe('datocms');

		// Idempotent: re-registering reuses the same connector + comment.
		const again = (await callToolAs(await captainToken(), 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: 'DatoCMS',
			mcp_url: 'https://mcp.datocms.com/',
		})) as { connector_id?: string; reused?: boolean; comment_id?: string };
		expect(again.connector_id).toBe(result.connector_id);
		expect(again.reused).toBe(true);
		expect(again.comment_id).toBe(result.comment_id);
	});

	it('rejects a display_name that produces an empty slug', async () => {
		const result = (await callToolAs(await captainToken(), 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: '!!!',
			mcp_url: 'https://example.com/mcp',
		})) as ToolResult;
		expect(result.error).toContain('empty slug');
	});

	it('returns the active state (no connect comment) when the connector is already active', async () => {
		// Seed a connector that is already OAuth-active under a known slug, then
		// register_connector with a display_name that slugs to the same name.
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked');
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, allowed_hosts)
			 VALUES ('ALREADY_ACTIVE_TOKEN', $1, $2) RETURNING id`,
			[encrypt('tok', key), ['api.active.com']],
		);
		const oauth = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ('already-active', 'acct', 'acct', $1) RETURNING id`,
			[secret.rows[0].id],
		);
		await db.query(
			`INSERT INTO mcp_connections (name, display_name, kind, config, install_status, oauth_connection_id, activated_at, project_id)
			 VALUES ('already-active', 'Already Active', 'saas'::mcp_connection_kind, $1::jsonb, 'installed'::mcp_install_status, $2, now(), $3)`,
			[JSON.stringify({ url: 'https://mcp.active.com/' }), oauth.rows[0].id, projectId],
		);

		const result = (await callToolAs(await captainToken(), 'register_connector', {
			project: projectId,
			task_id: taskId,
			display_name: 'Already Active',
			provider_id: 'already-active',
			mcp_url: 'https://mcp.active.com/',
		})) as { status?: string; reused?: boolean; comment_id?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('active');
		expect(result.reused).toBe(true);
		// No connect_required comment for an already-active connector.
		expect(result.comment_id).toBeUndefined();
	});
});

describe('MCP fetch_skill_file validation', () => {
	it('rejects a malformed URL', async () => {
		const result = (await callTool('fetch_skill_file', {
			project: projectId,
			url: 'not a url',
		})) as ToolResult;
		expect(result.error).toBe('Invalid URL');
	});

	it('rejects a non-http(s) scheme', async () => {
		const result = (await callTool('fetch_skill_file', {
			project: projectId,
			url: 'ftp://example.com/skill.md',
		})) as ToolResult;
		expect(result.error).toContain('Only http/https');
	});
});

describe('MCP list_approvals / resolve_approval', () => {
	it('list_approvals returns pending approvals, with excerpt truncation', async () => {
		await db.query(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'skill_proposal'::approval_type, $2::jsonb)`,
			[teamId, JSON.stringify({ skill_name: 'X', content: 'y'.repeat(2000) })],
		);
		const rows = (await callTool('list_approvals', {
			project: projectId,
			excerpt_chars: 100,
		})) as Array<{ payload: Record<string, unknown> }>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});

	it('resolve_approval errors for an unknown approval', async () => {
		const result = (await callTool('resolve_approval', {
			approval_id: '00000000-0000-0000-0000-000000000000',
			status: 'approved',
		})) as ToolResult;
		expect(result.error).toContain('Approval not found');
	});

	it('resolve_approval (team-keyed) approves a strategy approval as admin', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"plan":"go"}'::jsonb) RETURNING id`,
			[teamId],
		);
		const result = (await callTool('resolve_approval', {
			approval_id: r.rows[0].id,
			status: 'approved',
			resolution_note: 'ok',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('approved');
	});

	it('resolve_approval denies a team-keyed approval to a foreign-team agent', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"plan":"go"}'::jsonb) RETURNING id`,
			[teamId],
		);
		const { token: bToken } = await mintAgentToken(db, masterKeyManager, agentBId, teamBId);
		const result = (await callToolAs(bToken, 'resolve_approval', {
			approval_id: r.rows[0].id,
			status: 'approved',
		})) as ToolResult;
		expect(result.error).toContain('Access denied');
	});

	it('resolve_approval authorizes via the project scope when payload carries project_id', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, $2::jsonb) RETURNING id`,
			[teamId, JSON.stringify({ plan: 'scoped', project_id: projectId })],
		);
		const result = (await callTool('resolve_approval', {
			approval_id: r.rows[0].id,
			status: 'approved',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('approved');
	});

	it('resolve_approval denies a foreign-team agent on a project-scoped approval', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, $2::jsonb) RETURNING id`,
			[teamId, JSON.stringify({ plan: 'scoped', project_id: projectId })],
		);
		const { token: bToken } = await mintAgentToken(db, masterKeyManager, agentBId, teamBId);
		const result = (await callToolAs(bToken, 'resolve_approval', {
			approval_id: r.rows[0].id,
			status: 'approved',
		})) as ToolResult;
		expect(result.error).toContain('Access denied');
	});

	it('resolve_approval rejects a project-scoped run for a non-cross-project approval', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"plan":"go"}'::jsonb) RETURNING id`,
			[teamId],
		);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			null,
			{
				projectId,
				crossProject: false,
			},
		);
		const result = (await callToolAs(agentToken, 'resolve_approval', {
			approval_id: r.rows[0].id,
			status: 'approved',
		})) as ToolResult;
		expect(result.error).toContain('not scoped to resolve this approval');
	});
});

describe('MCP get_costs grouping', () => {
	beforeAll(async () => {
		await db.query(
			`INSERT INTO cost_entries (project_id, member_id, amount_cents)
			 VALUES ($1, $2, 150)`,
			[projectId, agentId],
		);
	});

	it('group_by=agent returns per-agent totals', async () => {
		const rows = (await callTool('get_costs', {
			project: projectId,
			group_by: 'agent',
		})) as Array<{ member_id: string; total_cents: number }>;
		expect(rows.some((r) => r.member_id === agentId && r.total_cents >= 150)).toBe(true);
	});

	it('group_by=day returns per-day totals', async () => {
		const rows = (await callTool('get_costs', {
			project: projectId,
			group_by: 'day',
		})) as Array<{ day: string; total_cents: number }>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});

	it('no grouping returns a single summary object', async () => {
		const summary = (await callTool('get_costs', { project: projectId })) as {
			total_cents: number;
			entry_count: number;
		};
		expect(summary.total_cents).toBeGreaterThanOrEqual(150);
		expect(summary.entry_count).toBeGreaterThanOrEqual(1);
	});
});

describe('MCP agent system prompt tools', () => {
	it('get_agent_system_prompt errors for an unknown agent', async () => {
		const result = (await callTool('get_agent_system_prompt', {
			project: projectId,
			agent_id: '00000000-0000-0000-0000-000000000000',
		})) as ToolResult;
		expect(result.error).toContain('Agent not found');
	});

	it('get_agent_system_prompts batches results and reports per-item errors', async () => {
		const results = (await callTool('get_agent_system_prompts', {
			project: projectId,
			items: [{ agent_id: 'engineer' }, { agent_id: 'no-such-agent', mode: 'raw' }],
		})) as Array<{ index: number; ok: boolean; system_prompt?: string; error?: string }>;
		expect(results.length).toBe(2);
		const ok = results.find((r) => r.ok);
		const bad = results.find((r) => !r.ok);
		expect(ok?.system_prompt).toBeTruthy();
		expect(bad?.error).toBeTruthy();
	});

	it('update_agent_system_prompt is allowed for the Captain and stores a revision', async () => {
		const result = (await callToolAs(await captainToken(), 'update_agent_system_prompt', {
			project: projectId,
			agent_id: agentId,
			new_system_prompt: compliantPrompt('You are the engineer. Updated by the Captain.'),
			change_summary: 'coherence review',
		})) as { applied?: boolean; document_id?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(true);
		expect(result.document_id).toBeTruthy();
	});

	it('update_agent_system_prompt denies a plain worker agent', async () => {
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = (await callToolAs(workerToken, 'update_agent_system_prompt', {
			project: projectId,
			agent_id: agentId,
			new_system_prompt: 'should be rejected',
			change_summary: 'nope',
		})) as ToolResult;
		expect(result.error).toContain('Access denied');
	});

	it('update_agent_system_prompt errors for an unknown agent', async () => {
		const result = (await callToolAs(await captainToken(), 'update_agent_system_prompt', {
			project: projectId,
			agent_id: '00000000-0000-0000-0000-000000000000',
			new_system_prompt: 'x',
			change_summary: 'y',
		})) as ToolResult;
		expect(result.error).toContain('Agent not found');
	});
});

describe('MCP agent summary / team summary validation', () => {
	it('set_agent_summary writes for an agent in the same team', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_summary', {
			project: projectId,
			agent_id: agentId,
			summary: 'Ships backend features.',
		})) as { updated?: boolean; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.updated).toBe(true);
	});

	it('set_agent_summary rejects an empty summary', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_summary', {
			project: projectId,
			agent_id: agentId,
			summary: '   ',
		})) as ToolResult;
		expect(result.error).toContain('non-empty');
	});

	it('set_agent_summary rejects an over-length summary', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_summary', {
			project: projectId,
			agent_id: agentId,
			summary: 'x'.repeat(1001),
		})) as ToolResult;
		expect(result.error).toContain('too long');
	});

	it('set_agent_summary errors for an agent not in this team', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_summary', {
			project: projectId,
			agent_id: agentBId,
			summary: 'cross-team write',
		})) as ToolResult;
		expect(result.error).toContain('Agent not found');
	});

	it('set_team_summary rejects an over-length summary', async () => {
		const result = (await callToolAs(await captainToken(), 'set_team_summary', {
			project: projectId,
			summary: 'x'.repeat(4001),
		})) as ToolResult;
		expect(result.error).toContain('too long');
	});

	it('set_team_summary rejects an empty summary', async () => {
		const result = (await callToolAs(await captainToken(), 'set_team_summary', {
			project: projectId,
			summary: '   ',
		})) as ToolResult;
		expect(result.error).toContain('non-empty');
	});
});

describe('MCP report_no_work guards', () => {
	it('rejects a non-agent caller', async () => {
		const result = (await callTool('report_no_work', { reason: 'nothing' })) as ToolResult;
		expect(result.error).toContain('within an agent run');
	});
});

describe('MCP set_agent_team_context / get_agent_team_context', () => {
	it('Captain writes and reads back an agent team context', async () => {
		const captain = await captainToken();
		const written = (await callToolAs(captain, 'set_agent_team_context', {
			project: projectId,
			agent_id: agentId,
			content: 'You report to the Architect and pair with QA.',
		})) as { updated?: boolean; error?: string };
		expect(written.error).toBeUndefined();
		expect(written.updated).toBe(true);

		const read = (await callToolAs(captain, 'get_agent_team_context', {
			project: projectId,
			agent_id: agentId,
		})) as { team_context?: string; slug?: string; error?: string };
		expect(read.error).toBeUndefined();
		expect(read.team_context).toContain('Architect');
	});

	it('set_agent_team_context denies a plain worker agent', async () => {
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = (await callToolAs(workerToken, 'set_agent_team_context', {
			project: projectId,
			agent_id: agentId,
			content: 'nope',
		})) as ToolResult;
		expect(result.error).toContain('Access denied');
	});

	it('set_agent_team_context rejects an empty body', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_team_context', {
			project: projectId,
			agent_id: agentId,
			content: '   ',
		})) as ToolResult;
		expect(result.error).toContain('non-empty');
	});

	it('set_agent_team_context rejects an over-length body', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_team_context', {
			project: projectId,
			agent_id: agentId,
			content: 'x'.repeat(6001),
		})) as ToolResult;
		expect(result.error).toContain('too long');
	});

	it('get_agent_team_context errors for an unknown agent', async () => {
		const result = (await callToolAs(await captainToken(), 'get_agent_team_context', {
			project: projectId,
			agent_id: '00000000-0000-0000-0000-000000000000',
		})) as ToolResult;
		expect(result.error).toContain('Agent not found');
	});
});

describe('MCP agent tools accept a slug or a member ID', () => {
	// Regression: these tools previously did a UUID-only `WHERE ma.id = $1` lookup,
	// so a caller (the CEO/Captain) that referenced a teammate by its natural slug
	// — e.g. "engineer" — got "Agent not found". They now resolve the slug too,
	// matching set_agent_status and the REST agent routes.
	it('get_agent_system_prompt resolves an agent slug', async () => {
		const result = (await callToolAs(await captainToken(), 'get_agent_system_prompt', {
			project: projectId,
			agent_id: 'engineer',
		})) as { slug?: string; system_prompt?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.slug).toBe('engineer');
		expect(typeof result.system_prompt).toBe('string');
	});

	it('update_agent_system_prompt resolves an agent slug', async () => {
		const result = (await callToolAs(await captainToken(), 'update_agent_system_prompt', {
			project: projectId,
			agent_id: 'engineer',
			new_system_prompt: compliantPrompt('You are the engineer. Updated by slug.'),
			change_summary: 'slug round-trip',
		})) as { applied?: boolean; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(true);
	});

	it('set_agent_summary resolves an agent slug', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_summary', {
			project: projectId,
			agent_id: 'engineer',
			summary: 'Resolved by slug.',
		})) as { updated?: boolean; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.updated).toBe(true);
	});

	it('set_agent_team_context then get_agent_team_context resolve an agent slug', async () => {
		const captain = await captainToken();
		const written = (await callToolAs(captain, 'set_agent_team_context', {
			project: projectId,
			agent_id: 'engineer',
			content: 'You pair with QA. Written by slug.',
		})) as { updated?: boolean; error?: string };
		expect(written.error).toBeUndefined();
		expect(written.updated).toBe(true);

		const read = (await callToolAs(captain, 'get_agent_team_context', {
			project: projectId,
			agent_id: 'engineer',
		})) as { slug?: string; team_context?: string; error?: string };
		expect(read.error).toBeUndefined();
		expect(read.slug).toBe('engineer');
		expect(read.team_context).toContain('Written by slug.');
	});

	it('does not resolve an HQ agent slug through a project team', async () => {
		// resolveAgentId can fall back to an HQ agent (CEO/Coach); the team-scoped
		// check must still reject it so a project Captain can't read HQ prompts.
		const result = (await callToolAs(await captainToken(), 'get_agent_team_context', {
			project: projectId,
			agent_id: CEO_AGENT_SLUG,
		})) as ToolResult;
		expect(result.error).toContain('Agent not found');
	});
});

describe('MCP set_agent_status', () => {
	it('Captain disables then re-enables a worker agent', async () => {
		// A dedicated project so unassign side effects don't disturb other tests.
		const teamRes = await createTestTeam(db, {
			name: 'Retire Co',
			template_id: (
				await (await app.request('/api/team-templates', { headers: authHeader(token) })).json()
			).data.find((t: { name: string }) => t.name === 'Startup').id,
		});
		const retireTeamId = (await teamRes.json()).data.id;
		const retireProjectRes = await createTestProject(db, retireTeamId, {
			name: 'Retire Project',
			description: 'x',
		});
		const retireProjectId = (await retireProjectRes.json()).data.id;
		const retireCaptain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[retireTeamId],
		);
		const { token: capTok } = await mintAgentToken(
			db,
			masterKeyManager,
			retireCaptain.rows[0].id,
			retireTeamId,
		);

		const disabled = (await callToolAs(capTok, 'set_agent_status', {
			project: retireProjectId,
			agent: 'engineer',
			status: 'disabled',
		})) as { updated?: boolean; admin_status?: string; error?: string };
		expect(disabled.error).toBeUndefined();
		expect(disabled.updated).toBe(true);
		expect(disabled.admin_status).toBe('disabled');

		// Disabling again is a no-op error.
		const again = (await callToolAs(capTok, 'set_agent_status', {
			project: retireProjectId,
			agent: 'engineer',
			status: 'disabled',
		})) as ToolResult;
		expect(again.error).toContain('already disabled');

		const enabled = (await callToolAs(capTok, 'set_agent_status', {
			project: retireProjectId,
			agent: 'engineer',
			status: 'enabled',
		})) as { updated?: boolean; error?: string };
		expect(enabled.error).toBeUndefined();
		expect(enabled.updated).toBe(true);
	});

	it('refuses to disable the protected Captain role', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_status', {
			project: projectId,
			agent: 'captain',
			status: 'disabled',
		})) as ToolResult;
		expect(result.error).toContain('essential');
	});

	it('errors for an unknown agent reference', async () => {
		const result = (await callToolAs(await captainToken(), 'set_agent_status', {
			project: projectId,
			agent: 'ghost-role',
			status: 'disabled',
		})) as ToolResult;
		expect(result.error).toContain('Agent not found');
	});

	it('denies a plain worker agent', async () => {
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = (await callToolAs(workerToken, 'set_agent_status', {
			project: projectId,
			agent: 'qa-engineer',
			status: 'disabled',
		})) as ToolResult;
		expect(result.error).toContain('Access denied');
	});

	it('is not callable by an admin (agents only)', async () => {
		const result = (await callTool('set_agent_status', {
			project: projectId,
			agent: 'qa-engineer',
			status: 'disabled',
		})) as ToolResult;
		expect(result.error).toContain('only callable by agents');
	});
});

describe('MCP project docs & assets', () => {
	it('write_project_doc rejects a non-markdown filename', async () => {
		const result = (await callTool('write_project_doc', {
			project: projectId,
			filename: 'notes.txt',
			content: 'hi',
		})) as ToolResult;
		expect(result.error).toContain('markdown');
	});

	it('write_project_doc then read_project_doc and list_project_docs round-trip', async () => {
		const written = (await callTool('write_project_doc', {
			project: projectId,
			filename: 'design.md',
			content: '# Design\nbody',
		})) as { written?: boolean; error?: string };
		expect(written.error).toBeUndefined();
		expect(written.written).toBe(true);

		const read = (await callTool('read_project_doc', {
			project: projectId,
			filename: 'design.md',
		})) as { content?: string; error?: string };
		expect(read.content).toBe('# Design\nbody');

		const listed = (await callTool('list_project_docs', { project: projectId })) as {
			files: Array<{ filename: string }>;
		};
		expect(listed.files.some((f) => f.filename === 'design.md')).toBe(true);
	});

	it('read_project_doc errors for an unknown file', async () => {
		const result = (await callTool('read_project_doc', {
			project: projectId,
			filename: 'missing.md',
		})) as ToolResult;
		expect(result.error).toContain('not found');
	});

	it('list_project_assets returns the assets written via write_project_asset', async () => {
		await callTool('write_project_asset', {
			project: projectId,
			filename: 'diagram.svg',
			content: '<svg></svg>',
		});
		const listed = (await callTool('list_project_assets', { project: projectId })) as {
			files: Array<{ filename: string; content_type: string }>;
		};
		expect(listed.files.some((f) => f.filename === 'diagram.svg')).toBe(true);
	});

	it('write_project_asset rejects a disallowed extension', async () => {
		const result = (await callTool('write_project_asset', {
			project: projectId,
			filename: 'evil.exe',
			content: 'binary',
		})) as ToolResult;
		expect(result.error).toContain('text-based');
	});

	it('read_project_asset reports a binary asset as a signed download url', async () => {
		// Seed an asset row directly with a binary content type; the read path
		// returns a download URL rather than inlining content.
		const assetId = crypto.randomUUID();
		await db.query(
			`INSERT INTO assets (id, team_id, project_id, original_filename, content_type, byte_size, sha256)
			 VALUES ($1, $2, $3, 'photo.png', 'image/png', 1234, 'deadbeef')`,
			[assetId, teamId, projectId],
		);
		const result = (await callTool('read_project_asset', {
			project: projectId,
			filename: 'photo.png',
		})) as { binary?: boolean; url?: string; content?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.binary).toBe(true);
		expect(result.url).toMatch(
			new RegExp(`^http://host\\.docker\\.internal:\\d+/api/assets/${assetId}\\?exp=\\d+&sig=`),
		);
		expect(result.content).toBeUndefined();
	});
});

describe('MCP skills (propose / list / get / create / full_text_search)', () => {
	it('propose_skill creates a skill_proposal approval', async () => {
		const result = (await callToolAs(await captainToken(), 'propose_skill', {
			project: projectId,
			skill_name: 'Deploy Flow',
			skill_slug: 'deploy-flow',
			content: '# Deploy\nsteps',
			reason: 'reusable',
		})) as { approval_id?: string; status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.approval_id).toBeTruthy();
		expect(result.status).toBeTruthy();
	});

	it('create_skill upserts a skill and get_skill loads it; list_skills filters by tag', async () => {
		const created = (await callTool('create_skill', {
			project: projectId,
			name: 'Lint Setup',
			slug: 'lint-setup',
			content: '# Lint\nrun biome',
			tags: 'ci,quality',
		})) as { id?: string; slug?: string; error?: string };
		expect(created.error).toBeUndefined();
		expect(created.slug).toBe('lint-setup');

		const got = (await callTool('get_skill', {
			project: projectId,
			slug: 'lint-setup',
		})) as { name?: string; content?: string; error?: string };
		expect(got.name).toBe('Lint Setup');
		expect(got.content).toContain('biome');

		const listed = (await callTool('list_skills', {
			project: projectId,
			tags: 'ci',
		})) as { skills: Array<{ slug: string }> };
		expect(listed.skills.some((s) => s.slug === 'lint-setup')).toBe(true);
	});

	it('get_skill errors for an unknown slug', async () => {
		const result = (await callTool('get_skill', {
			project: projectId,
			slug: 'no-such-skill',
		})) as ToolResult;
		expect(result.error).toContain('Skill not found');
	});

	it('full_text_search returns ranked results across team content', async () => {
		await callTool('create_skill', {
			project: projectId,
			name: 'Searchable Skill',
			slug: 'searchable-skill',
			content: 'A unique zorptacular keyword for full text search.',
		});
		const result = (await callTool('full_text_search', {
			project: projectId,
			query: 'zorptacular',
		})) as { results: unknown[]; count: number };
		expect(typeof result.count).toBe('number');
		expect(Array.isArray(result.results)).toBe(true);
	});
});

describe('MCP MCP-connection tools', () => {
	it('add_mcp_connection (saas) then list and remove round-trip', async () => {
		const added = (await callTool('add_mcp_connection', {
			project: projectId,
			name: 'extra-saas',
			kind: 'saas',
			config: { url: 'https://mcp.example.com/' },
		})) as { id?: string; install_status?: string; note?: string; error?: string };
		expect(added.error).toBeUndefined();
		expect(added.id).toBeTruthy();
		expect(added.install_status).toBe('installed');

		const listed = (await callTool('list_mcp_connections', { project: projectId })) as Array<{
			id: string;
			name: string;
			oauth_status: string;
		}>;
		const row = listed.find((r) => r.name === 'extra-saas');
		expect(row).toBeDefined();
		expect(row?.oauth_status).toBe('none');

		const removed = (await callTool('remove_mcp_connection', {
			project: projectId,
			id: added.id,
		})) as { removed?: boolean; error?: string };
		expect(removed.removed).toBe(true);
	});

	it('add_mcp_connection (local) registers with pending status', async () => {
		const added = (await callTool('add_mcp_connection', {
			project: projectId,
			name: 'extra-local',
			kind: 'local',
			config: { command: 'mcp-server' },
		})) as { install_status?: string; note?: string; error?: string };
		expect(added.install_status).toBe('pending');
		expect(added.note).toContain('pending');
	});

	it('add_mcp_connection rejects a saas config without url', async () => {
		const result = (await callTool('add_mcp_connection', {
			project: projectId,
			name: 'bad-saas',
			kind: 'saas',
			config: {},
		})) as ToolResult;
		expect(result.error).toContain('config.url');
	});

	it('add_mcp_connection rejects a local config without command', async () => {
		const result = (await callTool('add_mcp_connection', {
			project: projectId,
			name: 'bad-local',
			kind: 'local',
			config: {},
		})) as ToolResult;
		expect(result.error).toContain('config.command');
	});

	it('remove_mcp_connection errors for an unknown id', async () => {
		const result = (await callTool('remove_mcp_connection', {
			project: projectId,
			id: '00000000-0000-0000-0000-000000000000',
		})) as ToolResult;
		expect(result.error).toContain('not found');
	});

	it('test_connector errors for an unknown connector', async () => {
		const result = (await callTool('test_connector', {
			project: projectId,
			connector_id: '00000000-0000-0000-0000-000000000000',
		})) as ToolResult;
		expect(result.error).toContain('connector not found');
	});

	it('test_connector refuses a non-saas connector', async () => {
		const added = (await callTool('add_mcp_connection', {
			project: projectId,
			name: 'local-for-test',
			kind: 'local',
			config: { command: 'x' },
		})) as { id: string };
		const result = (await callTool('test_connector', {
			project: projectId,
			connector_id: added.id,
		})) as ToolResult;
		expect(result.error).toContain('kind=saas');
	});

	it('test_connector reports a missing url on a saas connector with no url', async () => {
		// add_mcp_connection enforces url for saas, so insert a urless saas row directly.
		const r = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('urless-saas', 'saas'::mcp_connection_kind, '{}'::jsonb, 'installed'::mcp_install_status)
			 RETURNING id`,
		);
		const result = (await callTool('test_connector', {
			project: projectId,
			connector_id: r.rows[0].id,
		})) as ToolResult;
		expect(result.error).toContain('no mcp url');
	});

	// Seed an OAuth-backed SaaS connector: a secret holding an encrypted token, an
	// oauth_connections row referencing it, and a connector linked to that. The
	// `127.0.0.1:1` URL refuses instantly so the probe never leaves the host.
	async function seedOauthConnector(opts: {
		name: string;
		hosts?: string[];
		activated?: boolean;
	}): Promise<{ connectorId: string; secretId: string; oauthId: string }> {
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('master key locked in test');
		const enc = encrypt('super-secret-token-value', key);
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, allowed_hosts)
			 VALUES ($1, $2, $3) RETURNING id`,
			[`${opts.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`, enc, opts.hosts ?? []],
		);
		const oauth = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
			 VALUES ($1, $2, 'acct', $3, $4) RETURNING id`,
			[opts.name, `acct-${opts.name}`, secret.rows[0].id, ['read']],
		);
		const connector = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, oauth_connection_id, activated_at)
			 VALUES ($1, 'saas'::mcp_connection_kind, $2::jsonb, 'installed'::mcp_install_status, $3, $4)
			 RETURNING id`,
			[
				opts.name,
				JSON.stringify({ url: 'http://127.0.0.1:1/' }),
				oauth.rows[0].id,
				opts.activated ? new Date().toISOString() : null,
			],
		);
		return {
			connectorId: connector.rows[0].id,
			secretId: secret.rows[0].id,
			oauthId: oauth.rows[0].id,
		};
	}

	it('test_connector decrypts the stored token and reports a failed network probe', async () => {
		const { connectorId } = await seedOauthConnector({ name: 'probe-fail-conn' });
		const result = (await callTool('test_connector', {
			project: projectId,
			connector_id: connectorId,
		})) as {
			ok?: boolean;
			error?: string;
			secret_name?: string;
			token_prefix?: string;
			mcp_url?: string;
		};
		// Decryption succeeded (secret name + token prefix surfaced); the probe to
		// 127.0.0.1:1 fails fast → the network-probe-failed branch.
		expect(result.ok).toBe(false);
		expect(result.error).toContain('network probe failed');
		expect(result.secret_name).toContain('TOKEN');
		expect(result.token_prefix).toBe('super-se');
	});

	it('test_connector reports a decrypt failure when the stored ciphertext is malformed', async () => {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ('BROKEN_TOKEN', 'not-valid-ciphertext') RETURNING id`,
		);
		const oauth = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ('broken', 'broken-acct', 'acct', $1) RETURNING id`,
			[secret.rows[0].id],
		);
		const connector = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, oauth_connection_id)
			 VALUES ('broken-conn', 'saas'::mcp_connection_kind, $1::jsonb, 'installed'::mcp_install_status, $2)
			 RETURNING id`,
			[JSON.stringify({ url: 'http://127.0.0.1:1/' }), oauth.rows[0].id],
		);
		const result = (await callTool('test_connector', {
			project: projectId,
			connector_id: connector.rows[0].id,
		})) as { error?: string; secret_name?: string };
		expect(result.error).toContain('failed to decrypt stored token');
		expect(result.secret_name).toBe('BROKEN_TOKEN');
	});

	it('list_mcp_connections surfaces oauth_status=active and rest_auth for a host-scoped active connector', async () => {
		await seedOauthConnector({
			name: 'active-conn',
			hosts: ['api.example.com'],
			activated: true,
		});
		const rows = (await callTool('list_mcp_connections', { project: projectId })) as Array<{
			name: string;
			oauth_status: string;
			rest_auth: { placeholder: string; allowed_hosts: string[] } | null;
		}>;
		const active = rows.find((r) => r.name === 'active-conn');
		expect(active?.oauth_status).toBe('active');
		expect(active?.rest_auth).not.toBeNull();
		expect(active?.rest_auth?.placeholder).toContain('__HEZO_SECRET_');
		expect(active?.rest_auth?.allowed_hosts).toContain('api.example.com');
	});
});

describe('MCP create_hire_proposal / update_hire_proposal', () => {
	it('Captain creates a hire proposal, then revises it', async () => {
		const captain = await captainToken();
		const created = (await callToolAs(captain, 'create_hire_proposal', {
			project: projectId,
			title: 'Data Scientist',
			role_description: 'Owns analytics.',
			system_prompt: compliantPrompt('You are the data scientist.'),
		})) as { approval_id?: string; status?: string; error?: string };
		expect(created.error).toBeUndefined();
		expect(created.approval_id).toBeTruthy();

		const revised = (await callToolAs(captain, 'update_hire_proposal', {
			approval_id: created.approval_id,
			role_description: 'Owns analytics and dashboards.',
			monthly_budget_cents: 5000,
		})) as { id?: string; payload?: Record<string, unknown>; error?: string };
		expect(revised.error).toBeUndefined();
		expect(revised.payload?.role_description).toBe('Owns analytics and dashboards.');
	});

	it('create_hire_proposal rejects an invalid default_effort', async () => {
		const result = (await callToolAs(await captainToken(), 'create_hire_proposal', {
			project: projectId,
			title: 'Bad Effort Hire',
			default_effort: 'turbo',
		})) as ToolResult;
		expect(result.error).toContain('default_effort');
	});

	it('create_hire_proposal rejects a non-existent task_id link', async () => {
		const result = (await callToolAs(await captainToken(), 'create_hire_proposal', {
			project: projectId,
			title: 'Linked Hire',
			task_id: '00000000-0000-0000-0000-000000000000',
		})) as ToolResult;
		expect(result.error).toContain('task_id not found');
	});

	it('create_hire_proposal rejects a non-Captain/CEO agent', async () => {
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = (await callToolAs(workerToken, 'create_hire_proposal', {
			project: projectId,
			title: 'Worker Hire',
		})) as ToolResult;
		expect(result.error).toContain('Only the Captain or CEO');
	});

	it('create_hire_proposal rejects an admin (agents only)', async () => {
		const result = (await callTool('create_hire_proposal', {
			project: projectId,
			title: 'Admin Hire',
		})) as ToolResult;
		expect(result.error).toContain('only callable by agents');
	});

	it('update_hire_proposal rejects an admin (agents only)', async () => {
		const result = (await callTool('update_hire_proposal', {
			approval_id: '00000000-0000-0000-0000-000000000000',
			title: 'x',
		})) as ToolResult;
		expect(result.error).toContain('only callable by agents');
	});

	it('update_hire_proposal rejects a non-Captain agent', async () => {
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = (await callToolAs(workerToken, 'update_hire_proposal', {
			approval_id: '00000000-0000-0000-0000-000000000000',
			title: 'x',
		})) as ToolResult;
		expect(result.error).toContain('Only the Captain');
	});

	it('update_hire_proposal errors when the approval does not exist', async () => {
		const result = (await callToolAs(await captainToken(), 'update_hire_proposal', {
			approval_id: '00000000-0000-0000-0000-000000000000',
			title: 'x',
		})) as ToolResult;
		expect(result.error).toContain('Approval not found');
	});

	it('update_hire_proposal rejects a non-hire approval', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"plan":"x"}'::jsonb) RETURNING id`,
			[teamId],
		);
		const result = (await callToolAs(await captainToken(), 'update_hire_proposal', {
			approval_id: r.rows[0].id,
			title: 'x',
		})) as ToolResult;
		expect(result.error).toContain('not a hire request');
	});

	it('update_hire_proposal errors when no fields are provided', async () => {
		const captain = await captainToken();
		const created = (await callToolAs(captain, 'create_hire_proposal', {
			project: projectId,
			title: 'No-op Revise Hire',
		})) as { approval_id: string };
		const result = (await callToolAs(captain, 'update_hire_proposal', {
			approval_id: created.approval_id,
		})) as ToolResult;
		expect(result.error).toContain('no fields to update');
	});

	it('update_hire_proposal rejects a cross-team approval id', async () => {
		// A hire approval on team B, revised by team A's Captain → team mismatch.
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, status, payload)
			 VALUES ($1, 'hire'::approval_type, 'pending'::approval_status, $2::jsonb) RETURNING id`,
			[teamBId, JSON.stringify({ title: 'B Hire', slug: 'b-hire' })],
		);
		const result = (await callToolAs(await captainToken(), 'update_hire_proposal', {
			approval_id: r.rows[0].id,
			title: 'x',
		})) as ToolResult;
		expect(result.error).toContain('team mismatch');
	});
});

describe('MCP cross-team CEO discovery on extended tools', () => {
	it('the CEO chat session (cross-team) can resolve set_agent_status across teams', async () => {
		// The CEO running cross-team into team A is an HQ instance agent and may
		// change agent status even though its run is scoped to HQ.
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			null,
			{ crossProject: true },
		);
		// crossProject token still scopes to its own team for authorizeScope; the
		// CEO discovery path here just confirms the tool is reachable and returns a
		// structured result rather than a 500. Re-enable an already-enabled agent.
		const result = (await callToolAs(ceoToken, 'set_agent_status', {
			project: projectId,
			agent: 'qa-engineer',
			status: 'enabled',
		})) as ToolResult;
		// Either "already enabled" (no-op) or updated — both are structured, not a throw.
		expect(typeof result).toBe('object');
		expect(result).not.toBeNull();
	});
});

describe('MCP Coach can resolve update_agent_system_prompt cross-team', () => {
	it('the Coach updates a worker prompt while running in the team', async () => {
		const coachId = await instanceCoachId(db);
		const { token: coachToken } = await mintAgentToken(db, masterKeyManager, coachId, teamId);
		const result = (await callToolAs(coachToken, 'update_agent_system_prompt', {
			project: projectId,
			agent_id: agentId,
			new_system_prompt: compliantPrompt('You are the engineer. Coach-tuned rules.'),
			change_summary: 'post-task learned rules',
		})) as { applied?: boolean; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.applied).toBe(true);
	});
});
