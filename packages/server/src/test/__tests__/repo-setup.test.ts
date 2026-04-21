import type { PGlite } from '@electric-sql/pglite';
import {
	ActionCommentKind,
	ApprovalStatus,
	ApprovalType,
	CommentContentType,
	OAuthRequestReason,
	PlatformType,
	WakeupStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import type { DockerClient } from '../../services/docker';
import { JobManager, type JobManagerDeps } from '../../services/job-manager';
import { LogStreamBroker } from '../../services/log-stream-broker';
import { ensureRepoSetupAction, finalizePendingRepoSetup } from '../../services/repo-setup';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';
import { createGitHubSim, type GitHubSim } from '../helpers/github-sim';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let sim: GitHubSim;
let originalApiBase: string | undefined;
let originalOauthBase: string | undefined;

function createMockDocker(): DockerClient {
	return {
		ping: async () => true,
		imageExists: async () => true,
		pullImage: async () => {},
		createContainer: async () => ({ Id: 'container-id', Warnings: [] }),
		startContainer: async () => {},
		stopContainer: async () => {},
		removeContainer: async () => {},
		inspectContainer: async () => ({
			Id: 'container-id',
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'test' },
		}),
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => 'exec',
		execStart: async () => ({ stdout: '', stderr: '' }),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	} as unknown as DockerClient;
}

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db,
		docker: createMockDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir: '/tmp/repo-setup-test',
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		...overrides,
	});
}

async function getEngineerAgentId(): Promise<string> {
	const res = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await res.json()).data as Array<{ id: string; slug: string }>;
	const engineer = agents.find((a) => a.slug === 'engineer');
	if (!engineer) throw new Error('engineer agent missing');
	return engineer.id;
}

async function createIssue(assigneeId: string, title = 'Gate test issue'): Promise<string> {
	const res = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			description: 'Test issue',
			assignee_id: assigneeId,
		}),
	});
	return (await res.json()).data.id;
}

async function connectGitHub(): Promise<void> {
	// Store an OAuth token directly — skip the full OAuth callback because it
	// requires the Connect service's /auth/exchange endpoint, which we don't
	// simulate. Token-store handles encryption and the connected_platforms row.
	const { storeOAuthToken } = await import('../../services/token-store');
	await storeOAuthToken(
		db,
		masterKeyManager,
		companyId,
		PlatformType.GitHub,
		sim.state.token,
		'repo,read:org',
		{
			username: sim.state.user.login,
		},
	);
}

async function insertRepo(shortName: string, identifier: string): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
		 VALUES ($1, $2, $3, 'github'::repo_host_type) RETURNING id`,
		[projectId, shortName, identifier],
	);
	return res.rows[0].id;
}

beforeAll(async () => {
	originalApiBase = process.env.GITHUB_API_BASE_URL;
	originalOauthBase = process.env.GITHUB_OAUTH_BASE_URL;

	sim = await createGitHubSim();
	process.env.GITHUB_API_BASE_URL = sim.baseUrl;
	process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Setup Test', template_id: typeId, issue_prefix: 'RS' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Setup Project', description: 'testing repo setup' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await sim.destroy();
	await safeClose(db);
	if (originalApiBase === undefined) delete process.env.GITHUB_API_BASE_URL;
	else process.env.GITHUB_API_BASE_URL = originalApiBase;
	if (originalOauthBase === undefined) delete process.env.GITHUB_OAUTH_BASE_URL;
	else process.env.GITHUB_OAUTH_BASE_URL = originalOauthBase;
});

describe('agent_types.touches_code seed', () => {
	it('marks every builder role as touching code', async () => {
		const builders = [
			'engineer',
			'architect',
			'qa-engineer',
			'devops-engineer',
			'security-engineer',
			'ui-designer',
		];
		const res = await db.query<{ slug: string; touches_code: boolean }>(
			`SELECT slug, touches_code FROM agent_types WHERE slug = ANY($1)`,
			[builders],
		);
		expect(res.rows).toHaveLength(builders.length);
		for (const row of res.rows) {
			expect(row.touches_code).toBe(true);
		}
	});

	it('leaves non-code roles with touches_code=false', async () => {
		const nonBuilders = ['ceo', 'product-lead', 'coach', 'researcher', 'marketing-lead'];
		const res = await db.query<{ slug: string; touches_code: boolean }>(
			`SELECT slug, touches_code FROM agent_types WHERE slug = ANY($1)`,
			[nonBuilders],
		);
		expect(res.rows).toHaveLength(nonBuilders.length);
		for (const row of res.rows) {
			expect(row.touches_code).toBe(false);
		}
	});

	it('propagates touches_code from agent_types onto seeded member_agents', async () => {
		const res = await db.query<{ slug: string; touches_code: boolean }>(
			`SELECT ma.slug, ma.touches_code
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1`,
			[companyId],
		);
		const bySlug = new Map(res.rows.map((r) => [r.slug, r.touches_code]));
		expect(bySlug.get('engineer')).toBe(true);
		expect(bySlug.get('architect')).toBe(true);
		expect(bySlug.get('ceo')).toBe(false);
		expect(bySlug.get('product-lead')).toBe(false);
	});
});

describe('ensureRepoSetupAction', () => {
	it('inserts one approval and one action comment, is idempotent across duplicate calls', async () => {
		const engineerId = await getEngineerAgentId();
		const issueId = await createIssue(engineerId, 'Ensure idempotent');

		const first = await ensureRepoSetupAction(db, { companyId, projectId, issueId });
		expect(first.approvalCreated).toBe(true);
		expect(first.commentCreated).toBe(true);

		const second = await ensureRepoSetupAction(db, { companyId, projectId, issueId });
		expect(second.approvalCreated).toBe(false);
		expect(second.commentCreated).toBe(false);
		expect(second.approvalId).toBe(first.approvalId);
		expect(second.commentId).toBe(first.commentId);

		const approvals = await db.query(
			`SELECT COUNT(*)::int AS c FROM approvals
			 WHERE company_id = $1 AND type = $2::approval_type AND status = $3::approval_status
			   AND payload->>'project_id' = $4 AND payload->>'reason' = $5`,
			[
				companyId,
				ApprovalType.OauthRequest,
				ApprovalStatus.Pending,
				projectId,
				OAuthRequestReason.DesignatedRepo,
			],
		);
		expect((approvals.rows[0] as { c: number }).c).toBe(1);
	});

	it('shares one approval across two issues but posts its own comment on each', async () => {
		// Clean pending approvals from prior tests
		await db.query(
			`DELETE FROM approvals WHERE company_id = $1 AND status = $2::approval_status
			   AND payload->>'project_id' = $3 AND payload->>'reason' = $4`,
			[companyId, ApprovalStatus.Pending, projectId, OAuthRequestReason.DesignatedRepo],
		);

		const engineerId = await getEngineerAgentId();
		const issueA = await createIssue(engineerId, 'issue A');
		const issueB = await createIssue(engineerId, 'issue B');

		const resA = await ensureRepoSetupAction(db, { companyId, projectId, issueId: issueA });
		const resB = await ensureRepoSetupAction(db, { companyId, projectId, issueId: issueB });

		expect(resB.approvalCreated).toBe(false);
		expect(resA.approvalId).toBe(resB.approvalId);
		expect(resA.commentId).not.toBe(resB.commentId);
	});
});

describe('JobManager repo-setup gate', () => {
	it('defers wakeup and creates approval + comment for engineer on repo-less project', async () => {
		await db.query(
			`DELETE FROM approvals WHERE company_id = $1 AND status = $2::approval_status
			   AND payload->>'project_id' = $3 AND payload->>'reason' = $4`,
			[companyId, ApprovalStatus.Pending, projectId, OAuthRequestReason.DesignatedRepo],
		);
		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);

		const engineerId = await getEngineerAgentId();
		const issueId = await createIssue(engineerId, 'gate test');
		await db.query(
			"UPDATE projects SET container_id = NULL, container_status = 'stopped' WHERE id = $1",
			[projectId],
		);

		const manager = createJobManager();
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
			 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
			 RETURNING id`,
			[engineerId, companyId, JSON.stringify({ issue_id: issueId })],
		);
		const wakeupId = wakeupRes.rows[0].id;

		await (
			manager as unknown as {
				activateAgent: (
					id: string,
					cid: string,
					wid: string,
					p: Record<string, unknown>,
				) => Promise<void>;
			}
		).activateAgent(engineerId, companyId, wakeupId, { issue_id: issueId });

		const wakeup = await db.query<{ status: string; payload: Record<string, unknown> }>(
			'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Deferred);
		expect(wakeup.rows[0].payload.reason).toBe('awaiting_repo_setup');

		const locks = await db.query(
			'SELECT id FROM execution_locks WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
			[issueId, engineerId],
		);
		expect(locks.rows.length).toBe(0);

		const approvals = await db.query(
			`SELECT id FROM approvals
			 WHERE company_id = $1 AND type = $2::approval_type AND status = $3::approval_status
			   AND payload->>'project_id' = $4 AND payload->>'reason' = $5`,
			[
				companyId,
				ApprovalType.OauthRequest,
				ApprovalStatus.Pending,
				projectId,
				OAuthRequestReason.DesignatedRepo,
			],
		);
		expect(approvals.rows.length).toBe(1);

		const comments = await db.query<{ id: string; content: Record<string, unknown> }>(
			`SELECT id, content FROM issue_comments
			 WHERE issue_id = $1 AND content_type = $2::comment_content_type`,
			[issueId, CommentContentType.Action],
		);
		expect(comments.rows.length).toBe(1);
		expect(comments.rows[0].content.kind).toBe(ActionCommentKind.SetupRepo);

		manager.shutdown();
	});

	it('does not gate non-code-touching agents', async () => {
		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{
			id: string;
			slug: string;
			touches_code: boolean;
		}>;
		const nonCoder = agents.find((a) => !a.touches_code);
		if (!nonCoder) return; // Only if a non-coder agent exists in the seed

		const issueId = await createIssue(nonCoder.id, 'non-coder');
		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
		await db.query(
			"UPDATE projects SET container_id = NULL, container_status = 'stopped' WHERE id = $1",
			[projectId],
		);

		const manager = createJobManager();
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
			 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
			 RETURNING id`,
			[nonCoder.id, companyId, JSON.stringify({ issue_id: issueId })],
		);

		await (
			manager as unknown as {
				activateAgent: (
					id: string,
					cid: string,
					wid: string,
					p: Record<string, unknown>,
				) => Promise<void>;
			}
		).activateAgent(nonCoder.id, companyId, wakeupRes.rows[0].id, { issue_id: issueId });

		const wakeup = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeupRes.rows[0].id],
		);
		// For non-coders, the gate is bypassed. Since project has no container,
		// the existing logic marks it Failed.
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Failed);

		manager.shutdown();
	});

	it('gates a custom agent when touches_code=true, even though its slug is not builtin', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Custom Coder',
				role_description: 'Writes code',
				touches_code: true,
			}),
		});
		const customAgent = (await createRes.json()).data as { id: string; slug: string };

		const issueId = await createIssue(customAgent.id, 'custom coder gate');
		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);

		const manager = createJobManager();
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
			 VALUES ($1, $2, 'mention', 'claimed', now() - interval '30 seconds', $3::jsonb)
			 RETURNING id`,
			[customAgent.id, companyId, JSON.stringify({ issue_id: issueId })],
		);

		await (
			manager as unknown as {
				activateAgent: (
					id: string,
					cid: string,
					wid: string,
					p: Record<string, unknown>,
				) => Promise<void>;
			}
		).activateAgent(customAgent.id, companyId, wakeupRes.rows[0].id, { issue_id: issueId });

		const wakeup = await db.query<{ status: string; payload: Record<string, unknown> }>(
			'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
			[wakeupRes.rows[0].id],
		);
		expect(wakeup.rows[0].status).toBe(WakeupStatus.Deferred);
		expect(wakeup.rows[0].payload.reason).toBe('awaiting_repo_setup');

		manager.shutdown();
	});
});

describe('finalizePendingRepoSetup', () => {
	it('marks pending action comments complete, resolves the approval, and surfaces deferred wakeups', async () => {
		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
		await db.query(
			`DELETE FROM approvals WHERE company_id = $1 AND status = $2::approval_status
			   AND payload->>'project_id' = $3 AND payload->>'reason' = $4`,
			[companyId, ApprovalStatus.Pending, projectId, OAuthRequestReason.DesignatedRepo],
		);
		// Clear any leftover deferred wakeups from prior tests
		await db.query(
			`DELETE FROM agent_wakeup_requests WHERE company_id = $1 AND status = $2::wakeup_status
			   AND payload->>'reason' = 'awaiting_repo_setup'`,
			[companyId, WakeupStatus.Deferred],
		);

		const engineerId = await getEngineerAgentId();
		const issueId = await createIssue(engineerId, 'finalize');

		const ensured = await ensureRepoSetupAction(db, { companyId, projectId, issueId });

		// Simulate a deferred wakeup matching what the gate would have created
		const wakeupRes = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, created_at, payload)
			 VALUES ($1, $2, 'mention', 'deferred', now() - interval '30 seconds', $3::jsonb)
			 RETURNING id`,
			[
				engineerId,
				companyId,
				JSON.stringify({
					reason: 'awaiting_repo_setup',
					project_id: projectId,
					issue_id: issueId,
				}),
			],
		);

		const repoId = await insertRepo('api', 'acme-corp/api');
		const result = await finalizePendingRepoSetup(db, {
			companyId,
			projectId,
			repoId,
			repoIdentifier: 'acme-corp/api',
			shortName: 'api',
		});

		expect(result.resolvedApprovalId).toBe(ensured.approvalId);
		expect(result.affectedIssueIds).toContain(issueId);
		expect(result.deferredWakeups.length).toBe(1);
		expect(result.deferredWakeups[0].wakeupId).toBe(wakeupRes.rows[0].id);

		const commentCheck = await db.query<{ chosen_option: Record<string, unknown> }>(
			'SELECT chosen_option FROM issue_comments WHERE id = $1',
			[ensured.commentId],
		);
		expect(commentCheck.rows[0].chosen_option.status).toBe('complete');

		const approvalCheck = await db.query<{ status: string }>(
			'SELECT status FROM approvals WHERE id = $1',
			[ensured.approvalId],
		);
		expect(approvalCheck.rows[0].status).toBe(ApprovalStatus.Approved);

		const systemComments = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM issue_comments
			 WHERE issue_id = $1 AND content_type = 'system'::comment_content_type`,
			[issueId],
		);
		expect(
			systemComments.rows.some((r) => String(r.content.text ?? '').includes('acme-corp/api')),
		).toBe(true);
	});

	it('is a no-op when there is no pending approval for the project', async () => {
		await db.query(
			`DELETE FROM approvals WHERE company_id = $1 AND status = $2::approval_status
			   AND payload->>'project_id' = $3 AND payload->>'reason' = $4`,
			[companyId, ApprovalStatus.Pending, projectId, OAuthRequestReason.DesignatedRepo],
		);
		const result = await finalizePendingRepoSetup(db, {
			companyId,
			projectId,
			repoId: 'deadbeef',
			repoIdentifier: 'a/b',
			shortName: 'x',
		});
		expect(result.resolvedApprovalId).toBeNull();
		expect(result.affectedIssueIds).toEqual([]);
	});
});

describe('DESIGNATED_REPO_IMMUTABLE', () => {
	it('returns 409 when deleting the designated repo', async () => {
		const repoId = await insertRepo('designated-test', 'acme/designated-test');
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			repoId,
			projectId,
		]);

		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/repos/${repoId}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error.code).toBe('DESIGNATED_REPO_IMMUTABLE');

		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
		await db.query('DELETE FROM repos WHERE id = $1', [repoId]);
	});

	it('allows deleting a non-designated repo when another is designated', async () => {
		const designatedId = await insertRepo('designated-keep', 'acme/designated-keep');
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			designatedId,
			projectId,
		]);
		const extraId = await insertRepo('extra', 'acme/extra');

		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/repos/${extraId}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(200);

		await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
		await db.query('DELETE FROM repos WHERE id = $1', [designatedId]);
	});
});

describe('GitHub orgs and repos endpoints', () => {
	beforeAll(async () => {
		sim.seed({
			user: { login: 'test-user', avatar_url: '', email: 'u@hezo.test' },
			orgs: [{ login: 'acme-corp', avatar_url: '' }],
			repos: [
				{
					id: 1,
					name: 'thing',
					full_name: 'acme-corp/thing',
					owner: { login: 'acme-corp' },
					private: false,
					default_branch: 'main',
					clone_url: '',
					ssh_url: '',
				},
			],
		});
		await connectGitHub();
	});

	it('lists orgs including personal', async () => {
		const res = await app.request(`/api/companies/${companyId}/github/orgs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.some((o: { login: string }) => o.login === 'test-user')).toBe(true);
		expect(body.data.some((o: { login: string }) => o.login === 'acme-corp')).toBe(true);
	});

	it('lists org repos with query filter', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/github/repos?owner=acme-corp&query=thi`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].full_name).toBe('acme-corp/thing');
	});

	it('requires owner query param', async () => {
		const res = await app.request(`/api/companies/${companyId}/github/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('rejects unauthenticated access', async () => {
		const res = await app.request(`/api/companies/${companyId}/github/orgs`);
		expect(res.status).toBe(401);
	});
});

describe('POST /repos mode=create', () => {
	beforeAll(async () => {
		sim.seed({
			user: { login: 'test-user', avatar_url: '', email: 'u@hezo.test' },
			orgs: [{ login: 'acme-corp', avatar_url: '' }],
			repos: [],
		});
	});

	it('rejects create with owner not in user accessible orgs', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				short_name: 'denied',
				mode: 'create',
				owner: 'not-my-org',
				name: 'app',
				private: true,
			}),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.code).toBe('OWNER_NOT_ACCESSIBLE');
	});
});
