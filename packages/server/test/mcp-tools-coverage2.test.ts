import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';

// Second branch-coverage file for packages/server/src/mcp/tools.ts. Covers the
// reaction / credential / connector / approval / agent-management / docs / asset
// / skill / mcp-connection tools — validation, authorization, and not-found
// branches driven through the real /mcp request path.

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let engineerId: string;
let captainId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let commentId: string;

let teamBId: string;
let projectBSlug: string;

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

	const teamRes = await createTestTeam(db, { name: 'Cov2 Co A', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Cov2 Project A',
		description: 'A.',
	});
	const pData = (await projectRes.json()).data;
	projectId = pData.id;
	projectSlug = pData.slug;

	engineerId = (
		await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		)
	).rows[0].id;
	captainId = (
		await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		)
	).rows[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Seed Task', assignee_id: engineerId }),
	});
	taskId = (await taskRes.json()).data.id;

	// A comment to react to.
	const c = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[taskId, engineerId, JSON.stringify({ text: 'hello' })],
	);
	commentId = c.rows[0].id;

	const teamBRes = await createTestTeam(db, { name: 'Cov2 Co B', template_id: typeId });
	teamBId = (await teamBRes.json()).data.id;
	const projectBRes = await createTestProject(db, teamBId, {
		name: 'Cov2 Project B',
		description: 'B.',
	});
	projectBSlug = (await projectBRes.json()).data.slug;
});

afterAll(async () => {
	await safeClose(db);
});

async function call(
	tokenStr: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
	const body = (await res.json()) as {
		result?: { content: Array<{ text: string }> };
		error?: { message: string };
	};
	// A schema-validation failure comes back not as JSON but as an MCP error string
	// ("MCP error -32602: Input validation error: ...") in the result content (or, in
	// some transports, a JSON-RPC error). Surface either as { error } so callers
	// assert on it uniformly alongside the handlers' own in-band { error } results.
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { error: text };
	}
}

const admin = (toolName: string, args: Record<string, unknown> = {}) => call(token, toolName, args);

async function agentToken(memberId: string, tId: string, tkId?: string | null): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, memberId, tId, tkId);
	return t;
}

describe('reactions', () => {
	it('add_reaction succeeds then dedups via remove_reaction', async () => {
		const added = await admin('add_reaction', {
			project: projectSlug,
			task_id: taskId,
			comment_id: commentId,
			kind: 'ack',
		});
		expect(added.error).toBeUndefined();
		expect(added.comment_id).toBe(commentId);

		const removed = await admin('remove_reaction', {
			project: projectSlug,
			task_id: taskId,
			comment_id: commentId,
			kind: 'ack',
		});
		expect(removed.error).toBeUndefined();
	});

	it('add_reaction on a comment not on the task errors', async () => {
		const r = await admin('add_reaction', {
			project: projectSlug,
			task_id: taskId,
			comment_id: '00000000-0000-0000-0000-000000000000',
			kind: 'ack',
		});
		expect(typeof r.error).toBe('string');
	});

	it('remove_reaction on a comment not on this task errors', async () => {
		const r = await admin('remove_reaction', {
			project: projectSlug,
			task_id: taskId,
			comment_id: '00000000-0000-0000-0000-000000000000',
			kind: 'ack',
		});
		expect(typeof r.error).toBe('string');
	});
});

describe('create_comment branches', () => {
	it('parent_comment_id not on this task errors', async () => {
		const r = await admin('create_comment', {
			project: projectSlug,
			task_id: taskId,
			content: 'reply',
			parent_comment_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(r.error).toContain('parent_comment_id does not belong');
	});

	it('valid comment with a parent threads correctly', async () => {
		const r = await admin('create_comment', {
			project: projectSlug,
			task_id: taskId,
			content: 'a threaded reply',
			parent_comment_id: commentId,
		});
		expect(r.error).toBeUndefined();
		expect(r.parent_comment_id).toBe(commentId);
	});

	it('agent comment referencing a teammate by bold name returns a warning', async () => {
		const t = await agentToken(captainId, teamId, taskId);
		const r = await call(t, 'create_comment', {
			project: projectSlug,
			task_id: taskId,
			content: 'Hey **engineer**, take a look.',
		});
		expect(r.error).toBeUndefined();
		expect(typeof r.warning).toBe('string');
		expect(r.warning).toContain('engineer');
	});
});

describe('request_credential branches', () => {
	it('invalid secret name is rejected', async () => {
		const r = await admin('request_credential', {
			project: projectSlug,
			task_id: taskId,
			name: 'lowercase-bad',
			kind: 'api_key',
			instructions: 'need it',
			allowed_hosts: ['api.example.com'],
		});
		expect(typeof r.error).toBe('string');
	});

	it('HTTP-auth kind without allowed_hosts is rejected', async () => {
		const r = await admin('request_credential', {
			project: projectSlug,
			task_id: taskId,
			name: 'MY_API_KEY',
			kind: 'api_key',
			instructions: 'need it',
		});
		expect(r.error).toContain('allowed_hosts');
	});

	it('a confirmation request needs no allowed_hosts', async () => {
		const r = await admin('request_credential', {
			project: projectSlug,
			task_id: taskId,
			name: 'CONFIRM_THING',
			kind: 'api_key',
			instructions: 'confirm please',
			confirmation_text: 'Did you add the key?',
		});
		expect(r.error).toBeUndefined();
		expect(r.placeholder).toContain('CONFIRM_THING');
		expect(r.reused).toBe(false);
	});

	it('a duplicate request for the same pending secret is reused', async () => {
		const first = await admin('request_credential', {
			project: projectSlug,
			task_id: taskId,
			name: 'DUP_SECRET',
			kind: 'other',
			instructions: 'need it',
		});
		expect(first.reused).toBe(false);
		const second = await admin('request_credential', {
			project: projectSlug,
			task_id: taskId,
			name: 'DUP_SECRET',
			kind: 'other',
			instructions: 'need it again',
		});
		expect(second.reused).toBe(true);
		expect(second.comment_id).toBe(first.comment_id);
	});
});

describe('resolve_approval branches', () => {
	it('approval not found errors', async () => {
		const r = await admin('resolve_approval', {
			approval_id: '00000000-0000-0000-0000-000000000000',
			status: 'approved',
		});
		expect(r.error).toContain('Approval not found');
	});

	it('an agent run not cross-project cannot resolve a team-scoped approval', async () => {
		const ap = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{}'::jsonb) RETURNING id`,
			[teamId],
		);
		const t = await agentToken(engineerId, teamId, taskId);
		const r = await call(t, 'resolve_approval', {
			approval_id: ap.rows[0].id,
			status: 'denied',
		});
		expect(r.error).toContain('not scoped to resolve');
	});

	it('admin resolves a team-scoped approval', async () => {
		const ap = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{}'::jsonb) RETURNING id`,
			[teamId],
		);
		const r = await admin('resolve_approval', {
			approval_id: ap.rows[0].id,
			status: 'approved',
			resolution_note: 'ok',
		});
		expect(r.error).toBeUndefined();
		expect(r.status).toBe('approved');
	});
});

describe('list_approvals excerpt branch', () => {
	it('excerpt_chars truncates long payload strings', async () => {
		await db.query(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'skill_proposal'::approval_type, $2::jsonb)`,
			[teamId, JSON.stringify({ content: 'Z'.repeat(800), skill_name: 'x' })],
		);
		const r = (await admin('list_approvals', {
			project: projectSlug,
			excerpt_chars: 100,
		})) as unknown as Array<{ payload: Record<string, unknown> }>;
		const withLong = r.find((a) => 'content_excerpt' in (a.payload ?? {}));
		expect(withLong).toBeDefined();
	});
});

describe('get_agent_system_prompt branches', () => {
	it('agent not found in this team errors', async () => {
		const r = await admin('get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'no-such-agent',
		});
		expect(r.error).toContain('Agent not found');
	});

	it('resolves a real agent prompt with placeholders substituted', async () => {
		const r = await admin('get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
		});
		expect(r.error).toBeUndefined();
		expect(typeof r.system_prompt).toBe('string');
		expect(r.system_prompt).not.toContain('{{team_name}}');
	});
});

describe('get_agent_system_prompts batch branches', () => {
	it('returns ok and error items per index', async () => {
		const r = (await admin('get_agent_system_prompts', {
			project: projectSlug,
			items: [{ agent_id: 'engineer' }, { agent_id: 'no-such-agent' }],
		})) as unknown as Array<{ index: number; ok: boolean; error?: string }>;
		expect(r[0].ok).toBe(true);
		expect(r[1].ok).toBe(false);
		expect(typeof r[1].error).toBe('string');
	});
});

describe('update_agent_system_prompt authorization', () => {
	it('a non-Coach non-Captain agent is denied', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'update_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
			new_system_prompt: 'x',
			change_summary: 'y',
		});
		expect(r.error).toContain('only the Coach or the Captain');
	});

	it('Captain updating with a prompt missing required vars is rejected', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'update_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
			new_system_prompt: 'a prompt with no required vars',
			change_summary: 'y',
		});
		expect(typeof r.error).toBe('string');
	});

	it('Captain updating a non-existent agent errors', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'update_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'no-such-agent',
			new_system_prompt: 'x',
			change_summary: 'y',
		});
		expect(r.error).toContain('Agent not found');
	});
});

describe('set_agent_summary branches', () => {
	// Empty / over-long summary rejection is now schema-enforced (.trim().min(1)
	// .max(1000)) and covered by mcp-tools-extended.test.ts — not re-tested here.
	it('unknown agent errors', async () => {
		const r = await admin('set_agent_summary', {
			project: projectSlug,
			agent_id: 'no-such-agent',
			summary: 'fine',
		});
		expect(r.error).toContain('Agent not found');
	});

	it('admin writes a valid summary', async () => {
		const r = await admin('set_agent_summary', {
			project: projectSlug,
			agent_id: 'engineer',
			summary: 'A capable engineer.',
		});
		expect(r.updated).toBe(true);
	});
});

describe('set_team_summary / set_agent_team_context authorization', () => {
	it('set_team_summary denies a non-Captain agent', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'set_team_summary', { project: projectSlug, summary: 'x' });
		expect(r.error).toContain('Access denied');
	});

	// set_team_summary empty/over-long rejection is schema-enforced and covered by
	// mcp-tools-extended.test.ts; only the authorization branch is unique here.

	it('set_agent_team_context denies a non-Captain agent', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'set_agent_team_context', {
			project: projectSlug,
			agent_id: 'engineer',
			content: 'x',
		});
		expect(r.error).toContain('Access denied');
	});

	// Over-long content rejection is schema-enforced (.max(6000)) and covered by
	// mcp-tools-extended.test.ts.

	it('get_agent_team_context returns the stored context', async () => {
		const t = await agentToken(captainId, teamId);
		await call(t, 'set_agent_team_context', {
			project: projectSlug,
			agent_id: 'engineer',
			content: 'You report to the architect.',
		});
		const r = await admin('get_agent_team_context', {
			project: projectSlug,
			agent_id: 'engineer',
		});
		expect(r.team_context).toBe('You report to the architect.');
	});
});

describe('set_agent_reports_to branches', () => {
	it('denies a non-Captain agent', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'captain',
		});
		expect(r.error).toContain('Access denied');
	});

	it('unknown target agent errors', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'no-such-agent',
			reports_to: 'captain',
		});
		expect(r.error).toContain('Agent not found');
	});

	it('unknown manager errors', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'no-such-manager',
		});
		expect(r.error).toContain("no agent 'no-such-manager'");
	});

	it('cannot report to itself', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'engineer',
		});
		expect(r.error).toContain('cannot report to itself');
	});

	it('sets a valid reporting line and clears it with an empty string', async () => {
		const t = await agentToken(captainId, teamId);
		const set = await call(t, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: 'captain',
		});
		expect(set.applied).toBe(true);
		expect(set.reports_to).toBe('captain');

		const cleared = await call(t, 'set_agent_reports_to', {
			project: projectSlug,
			agent_id: 'engineer',
			reports_to: '',
		});
		expect(cleared.applied).toBe(true);
		expect(cleared.reports_to).toBeNull();
	});
});

describe('set_agent_status branches', () => {
	it('only callable by agents', async () => {
		const r = await admin('set_agent_status', {
			project: projectSlug,
			agent: 'engineer',
			status: 'disabled',
		});
		expect(r.error).toContain('only callable by agents');
	});

	it('denies a non-coordinator agent', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'set_agent_status', {
			project: projectSlug,
			agent: 'engineer',
			status: 'disabled',
		});
		expect(r.error).toContain('Access denied');
	});

	it('the Captain role cannot be retired', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'set_agent_status', {
			project: projectSlug,
			agent: 'captain',
			status: 'disabled',
		});
		expect(r.error).toContain('essential');
	});

	it('unknown agent errors', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'set_agent_status', {
			project: projectSlug,
			agent: 'no-such-agent',
			status: 'disabled',
		});
		expect(r.error).toContain('Agent not found in this team');
	});

	it('Captain disables and re-enables a worker; double-disable errors', async () => {
		const t = await agentToken(captainId, teamId);
		const disabled = await call(t, 'set_agent_status', {
			project: projectSlug,
			agent: 'qa-engineer',
			status: 'disabled',
		});
		expect(disabled.updated).toBe(true);
		const again = await call(t, 'set_agent_status', {
			project: projectSlug,
			agent: 'qa-engineer',
			status: 'disabled',
		});
		expect(again.error).toContain('already disabled');
		const enabled = await call(t, 'set_agent_status', {
			project: projectSlug,
			agent: 'qa-engineer',
			status: 'enabled',
		});
		expect(enabled.updated).toBe(true);
	});
});

describe('project docs / assets branches', () => {
	it('read_project_doc not found errors', async () => {
		const r = await admin('read_project_doc', { project: projectSlug, filename: 'missing.md' });
		expect(r.error).toContain('not found');
	});

	it('write_project_doc rejects a non-markdown filename', async () => {
		const r = await admin('write_project_doc', {
			project: projectSlug,
			filename: 'notes.txt',
			content: 'x',
		});
		expect(r.error).toContain('must be markdown');
	});

	it('write_project_doc then read it back', async () => {
		const w = await admin('write_project_doc', {
			project: projectSlug,
			filename: 'cov-spec.md',
			content: '# Spec body',
		});
		expect(w.written).toBe(true);
		const r = await admin('read_project_doc', { project: projectSlug, filename: 'cov-spec.md' });
		expect(r.content).toBe('# Spec body');
	});

	it('list_project_docs returns the written doc', async () => {
		const r = (await admin('list_project_docs', { project: projectSlug })) as {
			files: Array<{ filename: string }>;
		};
		expect(r.files.map((f) => f.filename)).toContain('cov-spec.md');
	});

	it('write_project_asset rejects a non-text extension', async () => {
		const r = await admin('write_project_asset', {
			project: projectSlug,
			filename: 'image.png',
			content: 'x',
		});
		expect(r.error).toContain('text-based file');
	});

	it('write_project_asset writes an html asset and read_project_asset returns it', async () => {
		const w = await admin('write_project_asset', {
			project: projectSlug,
			filename: 'mockup.html',
			content: '<h1>Hi</h1>',
		});
		expect(w.written).toBe(true);
		expect(w.reference).toBe('assets/mockup.html');
		const r = await admin('read_project_asset', { project: projectSlug, filename: 'mockup.html' });
		expect(r.content).toBe('<h1>Hi</h1>');
	});

	it('read_project_asset not found errors', async () => {
		const r = await admin('read_project_asset', { project: projectSlug, filename: 'nope.html' });
		expect(r.error).toContain('not found');
	});
});

describe('skills branches', () => {
	it('get_skill not found errors', async () => {
		const r = await admin('get_skill', { project: projectSlug, slug: 'no-such-skill' });
		expect(r.error).toContain('Skill not found');
	});

	it('create_skill then get_skill returns it (description backfilled)', async () => {
		const c = await admin('create_skill', {
			project: projectSlug,
			name: 'Cov Skill',
			slug: 'cov-skill',
			content: 'How to do the cov thing in detail.',
			tags: 'ops, deploy',
		});
		expect(c.created).toBe(true);
		const g = await admin('get_skill', { project: projectSlug, slug: 'cov-skill' });
		expect(g.slug).toBe('cov-skill');
		expect(typeof g.description).toBe('string');
		expect((g.description as string).length).toBeGreaterThan(0);
	});

	it('list_skills filters by tag', async () => {
		const r = (await admin('list_skills', { project: projectSlug, tags: 'ops' })) as {
			skills: Array<{ slug: string }>;
		};
		expect(r.skills.map((s) => s.slug)).toContain('cov-skill');
	});

	it('propose_skill creates an approval', async () => {
		const r = await admin('propose_skill', {
			project: projectSlug,
			skill_name: 'Proposed Cov',
			skill_slug: 'proposed-cov',
			content: 'body',
			reason: 'useful',
		});
		expect(r.approval_id).toBeDefined();
		expect(r.status).toBe('pending');
	});
});

describe('mcp connection branches', () => {
	it('add_mcp_connection saas requires config.url', async () => {
		const r = await admin('add_mcp_connection', {
			project: projectSlug,
			name: 'broken',
			kind: 'saas',
			config: {},
		});
		expect(r.error).toContain('config.url');
	});

	it('add_mcp_connection local requires config.command', async () => {
		const r = await admin('add_mcp_connection', {
			project: projectSlug,
			name: 'broken-local',
			kind: 'local',
			config: {},
		});
		expect(r.error).toContain('config.command');
	});

	it('add_mcp_connection saas succeeds', async () => {
		const r = await admin('add_mcp_connection', {
			project: projectSlug,
			name: 'cov-saas',
			kind: 'saas',
			config: { url: 'https://mcp.example.com' },
		});
		expect(r.error).toBeUndefined();
		expect(r.install_status).toBe('installed');
	});

	it('remove_mcp_connection unknown id errors', async () => {
		const r = await admin('remove_mcp_connection', {
			project: projectSlug,
			id: '00000000-0000-0000-0000-000000000000',
		});
		expect(r.error).toContain('not found');
	});

	it('remove_mcp_connection removes an existing connection', async () => {
		const added = await admin('add_mcp_connection', {
			project: projectSlug,
			name: 'cov-saas-rm',
			kind: 'saas',
			config: { url: 'https://mcp2.example.com' },
		});
		const r = await admin('remove_mcp_connection', {
			project: projectSlug,
			id: (added as { id: string }).id,
		});
		expect(r.removed).toBe(true);
	});

	it('list_mcp_connections derives oauth_status', async () => {
		const r = (await admin('list_mcp_connections', { project: projectSlug })) as unknown as Array<{
			oauth_status: string;
		}>;
		expect(Array.isArray(r)).toBe(true);
		for (const row of r) expect(typeof row.oauth_status).toBe('string');
	});

	it('test_connector unknown id errors', async () => {
		const r = await admin('test_connector', {
			project: projectSlug,
			connector_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(r.error).toContain('connector not found');
	});

	it('test_connector on a non-saas connector errors', async () => {
		const ins = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('cov-local', 'local'::mcp_connection_kind, '{"command":"x"}'::jsonb, 'pending'::mcp_install_status)
			 RETURNING id`,
		);
		const r = await admin('test_connector', {
			project: projectSlug,
			connector_id: ins.rows[0].id,
		});
		expect(r.error).toContain('only meaningful for kind=saas');
	});
});

describe('fetch_skill_file branches', () => {
	it('rejects a non-http scheme', async () => {
		const r = await admin('fetch_skill_file', { project: projectSlug, url: 'ftp://x/y.md' });
		expect(r.error).toContain('http/https');
	});

	it('rejects an invalid URL', async () => {
		const r = await admin('fetch_skill_file', { project: projectSlug, url: 'not a url' });
		expect(r.error).toBe('Invalid URL');
	});
});

describe('register_connector branches', () => {
	it('only resolves a task in scope (unknown task errors)', async () => {
		const r = await admin('register_connector', {
			project: projectSlug,
			task_id: 'ZZ-9999',
			display_name: 'Thing',
			mcp_url: 'https://mcp.example.com',
		});
		expect(r.error).toContain('Task not found');
	});

	it('registers a pending connector and posts a connect_required comment', async () => {
		const r = await admin('register_connector', {
			project: projectSlug,
			task_id: taskId,
			display_name: 'Cov Connector',
			mcp_url: 'https://cov-mcp.example.com',
		});
		expect(r.error).toBeUndefined();
		expect(r.status).toBe('pending');
		expect(r.connector_id).toBeDefined();
		expect(r.comment_id).toBeDefined();
	});
});

describe('semantic_search / get_costs branches', () => {
	it('semantic_search returns results+count', async () => {
		const r = (await admin('semantic_search', {
			project: projectSlug,
			query: 'seed',
		})) as { results: unknown[]; count: number };
		expect(Array.isArray(r.results)).toBe(true);
		expect(typeof r.count).toBe('number');
	});

	it('get_costs grouped by agent and by day', async () => {
		const byAgent = (await admin('get_costs', {
			project: projectSlug,
			group_by: 'agent',
		})) as unknown as unknown[];
		expect(Array.isArray(byAgent)).toBe(true);
		const byDay = (await admin('get_costs', {
			project: projectSlug,
			group_by: 'day',
		})) as unknown as unknown[];
		expect(Array.isArray(byDay)).toBe(true);
		const total = await admin('get_costs', { project: projectSlug });
		expect(total).toHaveProperty('total_cents');
	});
});

describe('cross-team CEO authorization for set_agent_status', () => {
	it('the CEO running cross-team can act in a project team', async () => {
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, teamBId, null, {
			crossProject: true,
		});
		// Disable then re-enable a worker on team B via the CEO.
		const disabled = await call(ceoToken, 'set_agent_status', {
			project: projectBSlug,
			agent: 'qa-engineer',
			status: 'disabled',
		});
		expect(disabled.error).toBeUndefined();
		expect(disabled.updated).toBe(true);
		await call(ceoToken, 'set_agent_status', {
			project: projectBSlug,
			agent: 'qa-engineer',
			status: 'enabled',
		});
	});
});
