import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * The global containers surface.
 *
 * It exists because a project stopped having "a" container: migration 050 gave
 * it as many as it has concurrent runs, while `projects.container_id` still
 * names only the most recently provisioned one. Every assertion here is about
 * that gap - a listing that reads either representation alone reports a fleet
 * that is not the one running.
 */

interface ContainerRow {
	container_id: string;
	project_id: string;
	project_slug: string;
	project_name: string;
	state: string;
	has_unpushed_commits: boolean;
	disk_used_bytes: number;
	memory_bytes: number | null;
	run_id: string | null;
	last_logs: string | null;
}

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: Awaited<ReturnType<typeof createTestApp>>['masterKeyManager'];
let projectA: { id: string; slug: string };
let projectB: { id: string; slug: string };
let teamAId: string;

async function list(as = token): Promise<{ status: number; rows: ContainerRow[] }> {
	const res = await app.request('/api/containers', { headers: authHeader(as) });
	if (res.status !== 200) return { status: res.status, rows: [] };
	return { status: res.status, rows: (await res.json()).data as ContainerRow[] };
}

async function addMember(
	projectId: string,
	containerId: string,
	state = 'idle',
	memoryBytes: number | null = 2 * 1024 ** 3,
): Promise<void> {
	await db.query(
		`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes, memory_bytes)
		 VALUES ($1, $2, $3::container_pool_state, 1000000, $4)`,
		[projectId, containerId, state, memoryBytes],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamA = await createTestTeam(db, { name: 'Containers Co A' });
	teamAId = (await teamA.json()).data.id;
	const pa = await createTestProject(db, teamAId, { name: 'Alpha' });
	const paData = (await pa.json()).data;
	projectA = { id: paData.id, slug: paData.slug };

	const teamB = await createTestTeam(db, { name: 'Containers Co B' });
	const teamBId = (await teamB.json()).data.id;
	const pb = await createTestProject(db, teamBId, { name: 'Beta' });
	const pbData = (await pb.json()).data;
	projectB = { id: pbData.id, slug: pbData.slug };
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /api/containers', () => {
	it('lists containers from every project, not one', async () => {
		// The assertion the old one-container-per-project model could not make, and
		// the whole reason this page exists.
		await addMember(projectA.id, 'a-one');
		await addMember(projectA.id, 'a-two', 'busy');
		await addMember(projectB.id, 'b-one');

		const { rows } = await list();
		const mine = rows.filter((r) => r.container_id.startsWith('a-') || r.container_id === 'b-one');
		expect(mine.map((r) => r.container_id).sort()).toEqual(['a-one', 'a-two', 'b-one']);
		// Each carries the project it belongs to, which is the only thing that makes
		// a cross-project list readable.
		expect(mine.find((r) => r.container_id === 'b-one')?.project_slug).toBe(projectB.slug);
		expect(mine.find((r) => r.container_id === 'a-two')?.state).toBe('busy');
	});

	it('surfaces a container the pool row alone would miss', async () => {
		// `container_pool_members` is additive and `projects.container_*` is still
		// written, so during provisioning a container can be recorded in either
		// place or both. A list built from the pool alone silently omits one that
		// exists - on a page whose entire purpose is "what is running right now",
		// that is the one failure that matters.
		await db.query(
			`UPDATE projects SET container_id = 'legacy-only',
			        container_status = 'running'::container_status WHERE id = $1`,
			[projectA.id],
		);

		const { rows } = await list();
		const legacy = rows.find((r) => r.container_id === 'legacy-only');
		expect(legacy).toBeDefined();
		expect(legacy?.project_slug).toBe(projectA.slug);
		// A row with no pool member cannot say whether a run holds it, so it reads as
		// idle rather than busy - never claiming a container is in use when we do
		// not know, because that is what would stop an operator removing it.
		expect(legacy?.state).toBe('idle');
	});

	it('lists a container that is still coming up', async () => {
		// The state the page most needs to show, and the one it used to miss: while a
		// container is provisioning it is neither `projects.container_id` (set at the
		// end) nor an allocatable member, so a listing that only wanted runnable
		// containers would answer "nothing is running" to someone watching one start.
		await addMember(projectA.id, 'a-starting', 'creating');

		const { rows } = await list();
		const starting = rows.find((r) => r.container_id === 'a-starting');
		expect(starting?.state).toBe('creating');
		expect(starting?.project_slug).toBe(projectA.slug);

		// And it is reachable as itself, which is what makes its log readable while
		// it is still being written.
		const res = await app.request('/api/containers/a-starting', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect(((await res.json()).data as ContainerRow).state).toBe('creating');
	});

	it('lists a provision that has not been given an engine id yet', async () => {
		// The window before `createContainer` returns - workspace prep, image
		// resolution, and on a managed backend the sandbox build, which is the
		// longest part of a cold start. Neither keyed representation exists yet, so
		// the page an operator reaches from "View container" was simply empty.
		await db.query(
			`UPDATE projects SET container_id = NULL,
			        container_status = 'creating'::container_status WHERE id = $1`,
			[projectB.id],
		);

		const { rows } = await list();
		const placeholder = rows.find((r) => r.container_id === `provisioning:${projectB.id}`);
		expect(placeholder?.state).toBe('creating');
		expect(placeholder?.project_slug).toBe(projectB.slug);
	});

	it('drops the placeholder as soon as the real container exists', async () => {
		// Otherwise the operator watches one provision as two rows.
		await db.query(
			`UPDATE projects SET container_id = NULL,
			        container_status = 'creating'::container_status WHERE id = $1`,
			[projectB.id],
		);
		await addMember(projectB.id, 'b-just-created', 'creating');

		const { rows } = await list();
		expect(rows.some((r) => r.container_id === `provisioning:${projectB.id}`)).toBe(false);
		expect(rows.some((r) => r.container_id === 'b-just-created')).toBe(true);
	});

	it('counts a container recorded in both representations once', async () => {
		await addMember(projectB.id, 'both-ways');
		await db.query(
			`UPDATE projects SET container_id = 'both-ways',
			        container_status = 'running'::container_status WHERE id = $1`,
			[projectB.id],
		);

		const { rows } = await list();
		expect(rows.filter((r) => r.container_id === 'both-ways')).toHaveLength(1);
	});

	it('reports the memory the container was built with, not the project’s current cap', async () => {
		// The two diverge the moment the cap is changed, and until the pool replaces
		// the container the setting describes a container that does not exist - which
		// is how a page came to show 6 GB beside a sandbox holding 2.
		await addMember(projectA.id, 'a-sized', 'idle', 2 * 1024 ** 3);
		await db.query('UPDATE projects SET memory_limit_gib = 6 WHERE id = $1', [projectA.id]);
		const { rows } = await list();
		expect(rows.find((r) => r.container_id === 'a-sized')?.memory_bytes).toBe(2 * 1024 ** 3);
	});

	it('reports null for a container whose allocation was never recorded', async () => {
		// A legacy or adopted container. Null is what the page renders as "-", rather
		// than borrowing a figure from the setting and stating it as fact.
		await addMember(projectA.id, 'a-unrecorded', 'idle', null);
		const { rows } = await list();
		expect(rows.find((r) => r.container_id === 'a-unrecorded')?.memory_bytes).toBeNull();
	});

	it('is superuser-only, because it crosses every project', async () => {
		// The per-team gate that protects `/api/projects/:projectId/...` has nothing
		// to check on an instance-wide list, so the gate has to be the role.
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
		);
		const boardToken = await signAdminJwt(masterKeyManager, user.rows[0].id);
		expect((await list(boardToken)).status).toBe(403);
	});
});

describe('GET /api/containers/:containerId', () => {
	it('returns the one container', async () => {
		const res = await app.request('/api/containers/a-one', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect(((await res.json()).data as ContainerRow).project_slug).toBe(projectA.slug);
	});

	it('404s for a container this instance does not own', async () => {
		const res = await app.request('/api/containers/not-ours', { headers: authHeader(token) });
		expect(res.status).toBe(404);
	});
});

describe('DELETE /api/containers/:containerId', () => {
	it('removes the container and its member row', async () => {
		await addMember(projectA.id, 'to-remove');
		const res = await app.request('/api/containers/to-remove', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const left = await db.query('SELECT 1 FROM container_pool_members WHERE container_id = $1', [
			'to-remove',
		]);
		expect(left.rows).toHaveLength(0);
	});

	it('clears projects.container_id when it named the removed container', async () => {
		// Left pointing at a container that no longer exists, the 1 Hz sync reads one
		// it cannot inspect as one that died - a spurious error on a project whose
		// other containers are fine.
		await addMember(projectA.id, 'named-one');
		await db.query(
			`UPDATE projects SET container_id = 'named-one',
			        container_status = 'running'::container_status WHERE id = $1`,
			[projectA.id],
		);

		await app.request('/api/containers/named-one', {
			method: 'DELETE',
			headers: authHeader(token),
		});

		const row = await db.query<{ container_id: string | null }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[projectA.id],
		);
		expect(row.rows[0].container_id).toBeNull();
	});

	it('fails the run the container was serving, and only that run', async () => {
		// Removing a busy container is the main reason to reach for this, so it must
		// not be refused - the run dies exactly as it would have if the container had
		// crashed. A sibling run in another container of the same project keeps going,
		// which is the blast-radius property the pool exists for.
		await addMember(projectA.id, 'busy-one', 'busy');
		await addMember(projectA.id, 'busy-two', 'busy');
		const agent = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 LIMIT 1`,
			[teamAId],
		);
		const agentId = agent.rows[0].id;
		// Each run is bound to a task in this project, which is the shape a real one
		// has - the container-death path scopes by task, so a task-less run would
		// prove nothing about container scoping either way.
		let taskNo = 70_000;
		const mkRun = async (containerId: string): Promise<string> => {
			taskNo += 1;
			const task = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
				 VALUES ($1, $2, $3, $4, 'Container scope', 'backlog'::task_status,
				         'medium'::task_priority, '[]'::jsonb)
				 RETURNING id`,
				[teamAId, projectA.id, taskNo, `CTR-${taskNo}`],
			);
			const r = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, container_id)
				 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now(), $4) RETURNING id`,
				[agentId, teamAId, task.rows[0].id, containerId],
			);
			return r.rows[0].id;
		};
		const doomed = await mkRun('busy-one');
		const survivor = await mkRun('busy-two');

		const res = await app.request('/api/containers/busy-one', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const rows = await db.query<{ id: string; status: string }>(
			'SELECT id, status::text AS status FROM heartbeat_runs WHERE id = ANY($1::uuid[])',
			[[doomed, survivor]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
		expect(byId.get(doomed)).not.toBe('running');
		expect(byId.get(survivor)).toBe('running');
	});

	it('is superuser-only', async () => {
		const user = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Board User 2', false) RETURNING id",
		);
		const boardToken = await signAdminJwt(masterKeyManager, user.rows[0].id);
		const res = await app.request('/api/containers/a-one', {
			method: 'DELETE',
			headers: authHeader(boardToken),
		});
		expect(res.status).toBe(403);
	});

	it('404s rather than silently succeeding on an unknown container', async () => {
		const res = await app.request('/api/containers/never-existed', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('refuses a provisioning placeholder, which names nothing on any engine', async () => {
		// It resolves through the listing exactly like a real row, so without this
		// the teardown would ask the backend to delete an id it never issued.
		await db.query(
			`UPDATE projects SET container_id = NULL,
			        container_status = 'creating'::container_status WHERE id = $1`,
			[projectB.id],
		);
		const res = await app.request(`/api/containers/provisioning:${projectB.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONTAINER_PROVISIONING');
	});
});
