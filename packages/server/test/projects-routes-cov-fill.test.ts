import { ContainerStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalAssetStore } from '../src/assets/drivers/local';
import { signProjectIconUrl } from '../src/lib/project-icon-urls';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const DESCRIPTION = 'A backend API that serves authenticated requests for the main app.';

/** Minimal structurally-valid PNG (signature + IHDR carrying the dimensions). */
function pngWithDimensions(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

function iconForm(bytes: Buffer, type = 'image/png'): FormData {
	const fd = new FormData();
	fd.set('file', new Blob([bytes], { type }), 'icon.png');
	return fd;
}

let ctx: ServerTestContext;
let token: string;
let projectId: string;
let projectSlug: string;
let teamId: string;

beforeAll(async () => {
	ctx = await createTestContext();
	token = ctx.token;

	// Provision through the real route so the full create path is exercised.
	const res = await ctx.app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Coverage Fill Project', description: DESCRIPTION }),
	});
	expect(res.status).toBe(201);
	const data = (await res.json()).data;
	projectId = data.id;
	projectSlug = data.slug;
	teamId = data.team_id;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('GET /api/projects (index)', () => {
	it('lists projects for a superuser with team slug/name and counts', async () => {
		const res = await ctx.app.request('/api/projects', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		const row = rows.find((r) => r.id === projectId);
		expect(row).toBeDefined();
		expect(row?.team_slug).toBeTruthy();
		expect(row?.team_name).toBeTruthy();
		expect(row?.agent_count).toBeGreaterThanOrEqual(1);
		expect(row?.repo_count).toBe(0);
		// Planning + coherence tasks are open.
		expect(row?.open_task_count).toBeGreaterThanOrEqual(1);
		expect(row?.open_goal_count).toBe(0);
		expect(row?.running_agents_count).toBe(0);
		expect(row?.today_spend_cents).toBe(0);
		expect(row?.last_activity_at).toBeTruthy();
		// No icon uploaded yet: both icon fields are nulled by withIconUrl.
		expect(row?.icon_url).toBeNull();
		expect(row?.icon_updated_at).toBeNull();
	});

	it('scopes the index to team membership for a non-superuser admin', async () => {
		const userRes = await ctx.db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Plain Admin', false) RETURNING id",
		);
		const plainUserId = userRes.rows[0].id;
		const plainToken = await signAdminJwt(ctx.masterKeyManager, plainUserId);

		// The plain admin is a member only of this new team (creator membership).
		const teamRes = await createTestTeam(ctx.db, {
			name: 'Plain Admin Co',
			creatorUserId: plainUserId,
		});
		const plainTeamId = (await teamRes.json()).data.id;
		const projRes = await createTestProject(ctx.db, plainTeamId, { name: 'Plain Admin Project' });
		const plainProjectId = (await projRes.json()).data.id;

		const res = await ctx.app.request('/api/projects', { headers: authHeader(plainToken) });
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<Record<string, unknown>>;
		expect(rows.some((r) => r.id === plainProjectId)).toBe(true);
		// The superuser's project belongs to a team the plain admin is not in.
		expect(rows.some((r) => r.id === projectId)).toBe(false);
	});
});

describe('POST /api/projects validation', () => {
	it('rejects a missing name', async () => {
		const res = await ctx.app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: DESCRIPTION }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('name is required');
	});

	it('maps a service-level failure (bad task_prefix) to its error status', async () => {
		const res = await ctx.app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Bad Prefix Project',
				description: DESCRIPTION,
				task_prefix: '1BAD!',
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('task_prefix');
	});
});

describe('project intakes', () => {
	it('rejects missing name and missing description', async () => {
		const noName = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: DESCRIPTION }),
		});
		expect(noName.status).toBe(400);

		const noDesc = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Intake Without Description' }),
		});
		expect(noDesc.status).toBe(400);
	});

	it('rejects providing both template_id and source_team_id', async () => {
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Both Baselines',
				description: DESCRIPTION,
				template_id: '00000000-0000-0000-0000-000000000001',
				source_team_id: '00000000-0000-0000-0000-000000000002',
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('not both');
	});

	it('404s on an unknown template_id', async () => {
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Unknown Template Intake',
				description: DESCRIPTION,
				template_id: '00000000-0000-0000-0000-000000000000',
			}),
		});
		expect(res.status).toBe(404);
	});

	it('404s on an unknown source_team_id', async () => {
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Unknown Source Intake',
				description: DESCRIPTION,
				source_team_id: '00000000-0000-0000-0000-000000000000',
			}),
		});
		expect(res.status).toBe(404);
	});

	it('rejects the HQ team as a source team', async () => {
		const hq = await ctx.db.query<{ team_id: string }>(
			'SELECT team_id FROM projects WHERE is_internal = true LIMIT 1',
		);
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'HQ Source Intake',
				description: DESCRIPTION,
				source_team_id: hq.rows[0].team_id,
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('HQ');
	});

	it('opens an intake with the Blank baseline when nothing is chosen', async () => {
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Default Baseline Intake', description: DESCRIPTION }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.intake_task_id).toBeTruthy();
		expect(data.intake_task_identifier).toBeTruthy();
		expect(data.project_slug).toBeTruthy();

		// The intake task lives in HQ and records the Blank baseline.
		const task = await ctx.db.query<{ description: string; project_id: string }>(
			'SELECT description, project_id FROM tasks WHERE id = $1',
			[data.intake_task_id],
		);
		expect(task.rows.length).toBe(1);
		expect(task.rows[0].description).toContain('Blank');
	});

	it('opens an intake with a template baseline', async () => {
		const tpl = await ctx.db.query<{ id: string; name: string }>(
			"SELECT id, name FROM team_templates WHERE name = 'Startup' LIMIT 1",
		);
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Template Baseline Intake',
				description: DESCRIPTION,
				template_id: tpl.rows[0].id,
			}),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		const task = await ctx.db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE id = $1',
			[data.intake_task_id],
		);
		expect(task.rows[0].description).toContain('Startup');
	});

	it('opens an intake from a source team baseline', async () => {
		const res = await ctx.app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Source Team Baseline Intake',
				description: DESCRIPTION,
				source_team_id: teamId,
			}),
		});
		expect(res.status).toBe(201);
	});

	it('GET /project-intakes returns the open intake conversation', async () => {
		const res = await ctx.app.request('/api/project-intakes', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data).not.toBeNull();
		expect(data.task_id).toBeTruthy();
		expect(data.task_identifier).toBeTruthy();
		expect(data.project_slug).toBeTruthy();
		expect(data.ceo_title).toBeTruthy();
	});

	it('500s when the HQ coordination context is unavailable (CEO disabled)', async () => {
		await ctx.db.query(
			"UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE slug = 'ceo'",
		);
		try {
			const res = await ctx.app.request('/api/project-intakes', {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'No CEO Intake', description: DESCRIPTION }),
			});
			expect(res.status).toBe(500);
			expect((await res.json()).error.message).toContain('HQ coordination project');
		} finally {
			await ctx.db.query(
				"UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE slug = 'ceo'",
			);
		}
	});
});

describe('GET project detail + progress', () => {
	it('returns the project with counts and its repos', async () => {
		await ctx.db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/covfill', 'github'::repo_host_type)`,
			[projectId],
		);
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.id).toBe(projectId);
		expect(data.repo_count).toBe(1);
		expect(Array.isArray(data.repos)).toBe(true);
		expect(data.repos[0].repo_identifier).toBe('acme/covfill');

		// Remove the repo again so the later container-rebuild test's reprovision
		// doesn't attempt a repo sync (the stub docker can't exec) and stays quiet.
		await ctx.db.query(`DELETE FROM repos WHERE project_id = $1`, [projectId]);
	});

	it('returns the Captain-maintained progress summary', async () => {
		await ctx.db.query(
			`UPDATE projects SET progress_summary = 'Halfway there', progress_summary_updated_at = now() WHERE id = $1`,
			[projectId],
		);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/progress`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.summary).toBe('Halfway there');
		expect(data.updated_at).toBeTruthy();
	});
});

describe('PATCH /api/projects/:projectId', () => {
	it('renames the project and regenerates a unique slug', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Coverage Fill Renamed' }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.name).toBe('Coverage Fill Renamed');
		expect(data.slug).toBe('coverage-fill-renamed');
		projectSlug = data.slug;
	});

	it('updates the description', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'Refreshed description.' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.description).toBe('Refreshed description.');
	});

	it('rejects a non-integer max_concurrent_runs and accepts a valid one', async () => {
		const bad = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_concurrent_runs: 0 }),
		});
		expect(bad.status).toBe(400);
		expect((await bad.json()).error.message).toContain('max_concurrent_runs');

		const good = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_concurrent_runs: 3 }),
		});
		expect(good.status).toBe(200);
		expect((await good.json()).data.max_concurrent_runs).toBe(3);
	});

	it('rejects an invalid memory_limit_gib and accepts a valid one', async () => {
		const bad = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ memory_limit_gib: 1.5 }),
		});
		expect(bad.status).toBe(400);
		expect((await bad.json()).error.message).toContain('memory_limit_gib');

		const good = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ memory_limit_gib: 4 }),
		});
		expect(good.status).toBe(200);
		expect((await good.json()).data.memory_limit_gib).toBe(4);
	});

	it('validates the merged budget trio and rejects an inconsistent window', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ daily_budget_cents: 10_000, weekly_budget_cents: 500 }),
		});
		expect(res.status).toBe(400);
	});

	it('applies a coherent budget update and persists it', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				daily_budget_cents: 100,
				weekly_budget_cents: 700,
				monthly_budget_cents: 5000,
			}),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.daily_budget_cents).toBe(100);
		expect(data.weekly_budget_cents).toBe(700);
		expect(data.monthly_budget_cents).toBe(5000);

		const stored = await ctx.db.query<{ daily_budget_cents: number }>(
			'SELECT daily_budget_cents FROM projects WHERE id = $1',
			[projectId],
		);
		expect(stored.rows[0].daily_budget_cents).toBe(100);
	});

	it('rejects a negative budget value on the per-field integer rule', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_budget_cents: -1 }),
		});
		expect(res.status).toBe(400);
	});

	it('returns the current row unchanged for an empty patch', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.id).toBe(projectId);
		expect(data.name).toBe('Coverage Fill Renamed');
	});
});

describe('project icon lifecycle', () => {
	it('rejects a multipart body the parser cannot read', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: {
				...authHeader(token),
				'Content-Type': 'multipart/form-data; boundary=deadbeef',
			},
			body: 'this is not multipart at all',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Malformed upload');
	});

	it('rejects a form without a file field', async () => {
		const fd = new FormData();
		fd.set('something_else', 'value');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: fd,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Missing file field');
	});

	it('rejects an unsupported content type', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(Buffer.from('<svg/>'), 'image/svg+xml'),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_ATTACHMENT');
	});

	it('rejects bytes that are not a parseable image', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(Buffer.from('definitely not a png, but long enough to try parsing')),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('dimensions');
	});

	it('rejects an image exceeding the pixel cap', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(513, 400)),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('512');
	});

	it('rejects an upload above the byte limit via the body limit', async () => {
		const oversized = Buffer.concat([pngWithDimensions(10, 10), Buffer.alloc(1024 * 1024, 0x61)]);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(oversized),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('TOO_LARGE');
	});

	it('404s the public serve endpoint before any icon exists', async () => {
		const url = await signProjectIconUrl(projectId, ctx.masterKeyManager, 1);
		const res = await ctx.app.request(url);
		expect(res.status).toBe(404);
	});

	it('uploads a valid icon, surfaces it in the index, and serves the signed URL', async () => {
		const bytes = pngWithDimensions(256, 256);
		const put = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(bytes),
		});
		expect(put.status).toBe(200);
		const putData = (await put.json()).data;
		expect(putData.icon_url).toMatch(/exp=\d+&sig=/);
		expect(putData.icon_updated_at).toBeTruthy();

		// withIconUrl true-branch: the index row carries a freshly-signed URL.
		const list = await ctx.app.request('/api/projects', { headers: authHeader(token) });
		const row = ((await list.json()).data as Array<Record<string, unknown>>).find(
			(p) => p.id === projectId,
		);
		expect(row?.icon_url).toBeTruthy();
		expect(row?.icon_updated_at).toBeTruthy();

		// Public serve endpoint returns the exact stored bytes with cache headers.
		const serve = await ctx.app.request(row?.icon_url as string);
		expect(serve.status).toBe(200);
		expect(serve.headers.get('Content-Type')).toBe('image/png');
		expect(serve.headers.get('Cache-Control')).toContain('max-age=3600');
		expect(serve.headers.get('ETag')).toMatch(/^"\d+"$/);
		const served = Buffer.from(await serve.arrayBuffer());
		expect(served.equals(bytes)).toBe(true);
	});

	it('401s the serve endpoint on a missing or tampered signature', async () => {
		const missing = await ctx.app.request(`/api/projects/${projectId}/icon`);
		expect(missing.status).toBe(401);

		const url = await signProjectIconUrl(projectId, ctx.masterKeyManager, 1);
		// Tampering with exp invalidates the HMAC.
		const tampered = url.replace(/exp=\d+/, 'exp=9999999999');
		const res = await ctx.app.request(tampered);
		expect(res.status).toBe(401);
	});

	it('removes the icon and nulls the icon fields', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.icon_url).toBeNull();
		expect(data.icon_updated_at).toBeNull();

		const rows = await ctx.db.query('SELECT 1 FROM project_icons WHERE project_id = $1', [
			projectId,
		]);
		expect(rows.rows.length).toBe(0);
	});
});

describe('container lifecycle routes', () => {
	it('400s container start when no container is provisioned', async () => {
		await ctx.db.query('UPDATE projects SET container_id = NULL WHERE id = $1', [projectId]);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/container/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('NO_CONTAINER');
	});

	it('starts a provisioned container and marks the project running', async () => {
		await ctx.db.query(
			`UPDATE projects SET container_id = 'stub-container-cov', container_status = 'stopped'::container_status WHERE id = $1`,
			[projectId],
		);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/container/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.container_status).toBe(ContainerStatus.Running);

		const stored = await ctx.db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(stored.rows[0].container_status).toBe(ContainerStatus.Running);
	});

	it('500s with DOCKER_ERROR when the docker daemon rejects the start', async () => {
		// A sibling app over the same DB whose docker client fails startContainer.
		// The logged start-failure warning is this test's asserted error path.
		const failingApp = buildApp(
			ctx.db,
			ctx.masterKeyManager,
			{ dataDir: ctx.dataDir, webUrl: '' },
			createStubDocker({
				startContainer: async () => {
					throw new Error('daemon unreachable');
				},
			}),
		);
		const res = await failingApp.request(`/api/projects/${projectSlug}/container/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.error.code).toBe('DOCKER_ERROR');
		expect(body.error.message).toContain('daemon unreachable');
	});

	it('stop with no container just marks the project stopped', async () => {
		await ctx.db.query('UPDATE projects SET container_id = NULL WHERE id = $1', [projectId]);
		const res = await ctx.app.request(`/api/projects/${projectSlug}/container/stop`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.container_status).toBe(ContainerStatus.Stopped);

		const stored = await ctx.db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(stored.rows[0].container_status).toBe(ContainerStatus.Stopped);
	});

	it('stop with a container cancels running agent tasks and transitions to stopping', async () => {
		await ctx.db.query(
			`UPDATE projects SET container_id = 'stub-container-cov', container_status = 'running'::container_status WHERE id = $1`,
			[projectId],
		);

		// A running agent task: an open execution lock held by the Captain.
		const captain = await ctx.db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
			[teamId],
		);
		const captainId = captain.rows[0].id;
		const task = await ctx.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, next_project_task_number($2), 'CVF-LOCK-1', 'Locked task', 'in_progress'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, captainId],
		);
		await ctx.db.query(`INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2)`, [
			task.rows[0].id,
			captainId,
		]);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/container/stop`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.container_status).toBe(ContainerStatus.Stopping);
	});

	it('rebuild flips the project to creating and reprovisions to running', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/container/rebuild`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.container_status).toBe(ContainerStatus.Creating);

		// Wait for the background rebuild job (stub docker) to finish so later tests
		// and teardown never race its DB writes.
		let status = ContainerStatus.Creating as string;
		for (let i = 0; i < 300; i++) {
			const row = await ctx.db.query<{ container_status: string }>(
				'SELECT container_status FROM projects WHERE id = $1',
				[projectId],
			);
			status = row.rows[0].container_status;
			if (status !== ContainerStatus.Creating) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(status).toBe(ContainerStatus.Running);
	});
});

describe('DELETE /api/projects/:projectId', () => {
	it('refuses to delete the internal HQ project', async () => {
		const hq = await ctx.db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE is_internal = true LIMIT 1',
		);
		const res = await ctx.app.request(`/api/projects/${hq.rows[0].slug}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
	});

	it('409s while the project still has open tasks', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
	});

	it('deletes the project even when asset blob removal fails (best-effort)', async () => {
		await ctx.db.query(`UPDATE tasks SET status = 'cancelled'::task_status WHERE project_id = $1`, [
			projectId,
		]);

		// Blob removal is explicitly best-effort: a failing asset store must not
		// block the row delete. The logged error is this test's asserted error path.
		const spy = vi
			.spyOn(LocalAssetStore.prototype, 'deleteProjectAssets')
			.mockRejectedValueOnce(new Error('blob store offline'));
		try {
			const res = await ctx.app.request(`/api/projects/${projectSlug}`, {
				method: 'DELETE',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			expect(spy).toHaveBeenCalledWith(projectId);
		} finally {
			spy.mockRestore();
		}

		const gone = await ctx.db.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
		expect(gone.rows.length).toBe(0);
	});
});
