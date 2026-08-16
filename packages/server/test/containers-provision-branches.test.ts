import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStatus, TEST_CONTAINERS_ENV, WakeupStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { ContainerLogStreamer } from '../src/services/container-logs';
import {
	CONTAINER_BASE_CAPABILITIES,
	CONTAINER_CA_PATH,
	type ContainerDeps,
	type ProjectRow,
	provisionContainer,
} from '../src/services/containers';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { planIdleShutdown } from '../src/services/sandbox/pool';
import {
	type ContainerListing,
	listAllContainers,
	loadPoolMembers,
} from '../src/services/sandbox/pool-db';
import { getProjectDir } from '../src/services/workspace';
import type { WebSocketManager } from '../src/services/ws';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let planningTaskId: string;
let agentId: string;

interface CreateContainerCall {
	name: string;
	config: {
		Image: string;
		Labels?: Record<string, string>;
		HostConfig: {
			Binds?: string[];
			PortBindings?: Record<string, Array<{ HostPort: string }>>;
			ExtraHosts?: string[];
			CapAdd?: string[];
			CapDrop?: string[];
			Init?: boolean;
			Memory?: number;
			MemorySwap?: number;
			PidsLimit?: number;
		};
		ExposedPorts?: Record<string, object>;
	};
}

/**
 * A stub docker that records createContainer calls and answers every exec with
 * a scripted result — enough for a full provision (run-user probes fall back to
 * root on non-zero exits, chown becomes a no-op).
 */
function recordingDocker(
	opts: {
		execStdout?: string;
		execStderr?: string;
		execExitCode?: number;
		execCreateError?: Error;
		/**
		 * Runs in place of `startContainer`, which is the first thing to happen
		 * after the engine hands back an id - the earliest point a test can observe
		 * the half-provisioned state.
		 *
		 * It is *not* a vantage point on the expensive tail, which is what it used
		 * to claim: the CA install, the chown, the repo clone and the MCP installs
		 * all come later still. Use `onExec` for those.
		 */
		onStart?: (containerId: string) => Promise<void>;
		/**
		 * Runs on every exec the provision issues. The first of those is the CA
		 * install, so this lands *inside* the setup tail - the window where the
		 * member used to read `idle` while the container was still being built, and
		 * the only place a test can observe it.
		 */
		onExec?: () => Promise<void>;
	} = {},
) {
	const created: CreateContainerCall[] = [];
	let seq = 0;
	const docker = createStubDocker({
		createContainer: vi.fn(async (name: string, config: CreateContainerCall['config']) => {
			created.push({ name, config });
			return { Id: `prov-cid-${Date.now().toString(16)}-${seq++}`, Warnings: [] };
		}),
		startContainer: vi.fn(async (id: string) => {
			if (opts.onStart) await opts.onStart(id);
		}),
		execCreate: vi.fn(async () => {
			if (opts.execCreateError) throw opts.execCreateError;
			if (opts.onExec) await opts.onExec();
			return 'exec-y';
		}),
		execStart: vi.fn(async () => ({
			stdout: opts.execStdout ?? '',
			stderr: opts.execStderr ?? '',
		})),
		execInspect: vi.fn(async () => ({
			ExitCode: opts.execExitCode ?? 1,
			Running: false,
			Pid: 0,
		})),
	});
	return { docker, created };
}

function baseDeps(
	docker: ContainerDeps['docker'],
	extra: Partial<ContainerDeps> = {},
): ContainerDeps {
	return { db, docker, dataDir: mkdtempSync(join(tmpdir(), 'hezo-prov-test-')), ...extra };
}

async function resetContainerRow(): Promise<void> {
	await db.query(
		`UPDATE projects SET container_id = NULL, container_status = NULL,
		 container_error = NULL, container_last_logs = NULL WHERE id = $1`,
		[projectId],
	);
	// The members too: every provision in this file leaves one behind, and a test
	// that looks the project's container up by project id would otherwise find an
	// earlier test's - which reads `idle` and hides exactly what is under test.
	await db.query('DELETE FROM container_pool_members WHERE project_id = $1', [projectId]);
}

async function projectRow(): Promise<ProjectRow> {
	const r = await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId]);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Provision Coverage Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;
	teamSlug = team.slug;

	const projRes = await createTestProject(db, teamId, {
		name: 'Provision Coverage Project',
		description: 'Provisioning branch coverage.',
	});
	const project = (await projRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;
	planningTaskId = project.planning_task_id as string;

	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.admin_status = 'enabled' LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;
	// A non-terminal task assigned to an enabled agent, so the post-provision
	// pending-work wakeup path has work to find.
	await db.query('UPDATE tasks SET assignee_id = $1, status = $2::task_status WHERE id = $3', [
		agentId,
		TaskStatus.Backlog,
		planningTaskId,
	]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('provisionContainer', () => {
	it('allocates host ports around other projects, persists them, and wires port bindings', async () => {
		await resetContainerRow();

		// Another project already holds host port 10000.
		const otherTeam = (await (await createTestTeam(db, { name: 'Port Holder Co' })).json()).data;
		const otherProject = (
			await (
				await createTestProject(db, otherTeam.id, {
					name: 'Port Holder Project',
					description: 'Holds port 10000.',
				})
			).json()
		).data;
		await db.query('UPDATE projects SET dev_ports = $1::jsonb WHERE id = $2', [
			JSON.stringify([{ container: 3000, host: 10000 }]),
			otherProject.id,
		]);

		// This project asks for a conflicting port, an available preferred port,
		// and an unassigned one.
		await db.query('UPDATE projects SET dev_ports = $1::jsonb WHERE id = $2', [
			JSON.stringify([
				{ container: 8080, host: 10000 },
				{ container: 7000, host: 12345 },
				{ container: 9090 },
			]),
			projectId,
		]);

		const { docker, created } = recordingDocker();
		const deps = baseDeps(docker);

		const id = await provisionContainer(deps, await projectRow(), teamSlug);

		expect(created).toHaveLength(1);
		const { name, config } = created[0];
		expect(name).toMatch(new RegExp(`^hezo-${projectSlug}-${projectId.slice(0, 8)}-[0-9a-f]{8}$`));
		expect(config.HostConfig.PortBindings).toEqual({
			'8080/tcp': [{ HostPort: '10001' }],
			'7000/tcp': [{ HostPort: '12345' }],
			'9090/tcp': [{ HostPort: '10002' }],
		});
		expect(Object.keys(config.ExposedPorts ?? {})).toEqual(['8080/tcp', '7000/tcp', '9090/tcp']);
		expect(config.HostConfig.ExtraHosts).toEqual(['host.docker.internal:host-gateway']);
		expect(config.Labels?.['hezo.team']).toBe(teamSlug);
		expect(config.Labels?.['hezo.project']).toBe(projectSlug);

		// Bind mounts key on the immutable project id.
		const projectDir = getProjectDir(deps.dataDir, teamId, projectId);
		expect(config.HostConfig.Binds).toEqual([
			`${join(projectDir, 'workspace')}:/workspace:rw`,
			`${join(projectDir, 'worktrees')}:/worktrees:rw`,
			`${join(projectDir, '.previews')}:/workspace/.previews:rw`,
		]);

		// The resolved allocation was written back to the project row.
		const row = await db.query<{ dev_ports: Array<{ container: number; host: number }> }>(
			'SELECT dev_ports FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].dev_ports).toEqual([
			{ container: 8080, host: 10001 },
			{ container: 7000, host: 12345 },
			{ container: 9090, host: 10002 },
		]);

		const stored = await db.query<{ container_id: string; container_status: string }>(
			'SELECT container_id, container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(stored.rows[0].container_id).toBe(id);
		expect(stored.rows[0].container_status).toBe('running');
	});

	it('requeues container-killed runs, and does not double-queue the fan-out behind them', async () => {
		await resetContainerRow();
		await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
		const killed = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, 'failed'::heartbeat_run_status, now() - interval '10 minutes', now() - interval '9 minutes', 'container_error')
			 RETURNING id`,
			[teamId, agentId, planningTaskId],
		);

		const { docker } = recordingDocker();
		await provisionContainer(baseDeps(docker), await projectRow(), teamSlug);
		await waitForBackground();

		const wakeups = await db.query<{ payload: Record<string, unknown>; source: string }>(
			`SELECT payload, source FROM agent_wakeup_requests
			 WHERE member_id = $1 AND status = $2::wakeup_status ORDER BY created_at ASC`,
			[agentId, WakeupStatus.Queued],
		);
		// One wakeup, not two. The recovery wakeup already names this agent and this
		// task, so the pending-work fan-out that follows it in the same provision
		// has nothing to add and stands down. It must not queue a second row: both
		// now carry a task_id, so createWakeup would coalesce them and mergePayloads
		// would overwrite `container_recovery` - losing the specific reason, and the
		// recovery label with it - to say `container_start` instead.
		expect(wakeups.rows.length).toBe(1);
		const recovery = wakeups.rows[0];
		expect((recovery.payload as Record<string, unknown>).reason).toBe('container_recovery');
		expect((recovery.payload as Record<string, unknown>).previous_run_id).toBe(killed.rows[0].id);
		expect((recovery.payload as Record<string, unknown>).task_id).toBe(planningTaskId);

		await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	});

	it('wakes nobody when the caller provisioned this container to run on it', async () => {
		await resetContainerRow();
		await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
		await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);

		const { docker } = recordingDocker();
		await provisionContainer(
			baseDeps(docker),
			await projectRow(),
			teamSlug,
			'caller-runs-the-work',
		);
		await waitForBackground();

		const wakeups = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND status = $2::wakeup_status`,
			[agentId, WakeupStatus.Queued],
		);
		// The pool ladder reaches provisionContainer from acquireRunContainer, so a
		// run is already starting on this project. Fanning out here woke that same
		// agent for the work its own run was about to do; the extra run provisioned
		// again on a cold pool, woke again, and the loop sustained itself at
		// container-start cadence regardless of the agent's heartbeat interval.
		expect(wakeups.rows.some((w) => w.payload.reason === 'container_start')).toBe(false);
	});

	it('streams provisioning lines and serves a replace-snapshot through the log broker', async () => {
		await resetContainerRow();
		const { docker } = recordingDocker();
		const logs = new LogStreamBroker();
		const wsManager = { broadcast: vi.fn() } as unknown as WebSocketManager;
		logs.setWsManager(wsManager);
		const subscribe = vi.fn();

		const id = await provisionContainer(
			baseDeps(docker, {
				logs,
				wsManager,
				containerLogStreamer: { subscribe } as unknown as ContainerLogStreamer,
			}),
			await projectRow(),
			teamSlug,
		);

		expect(subscribe).toHaveBeenCalledWith(projectId, id, logs, docker);

		const text = logs.getLogText(`container:${id}`);
		expect(text).toContain('→ Preparing workspace');
		expect(text).toContain('→ Starting container');
		expect(text).toContain('✓ Container ready');

		// A late subscriber replay gets the buildSnapshot message with replace: true.
		const snapshots: Array<Record<string, unknown>> = [];
		logs.replay(`container-logs:${id}`, (payload) =>
			snapshots.push(payload as Record<string, unknown>),
		);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].replace).toBe(true);
		expect(snapshots[0].projectId).toBe(projectId);
		expect(snapshots[0].stream).toBe('stdout');
		expect(String(snapshots[0].text)).toContain('✓ Container ready');
	});

	it('joins the pool as `creating` the moment the container exists, then becomes idle', async () => {
		// The regression this pins: the member row and `projects.container_id` were
		// both written at the *end* of provisioning, and they are the only two things
		// the global Containers page reads - so a container that was starting was
		// listed nowhere, and its log stream (already open, keyed on its id) had no
		// row to be reached from. On a fresh instance that is the whole of what an
		// operator sees: "Starting the HQ container..." beside an empty list.
		await resetContainerRow();
		// Read it back through `listAllContainers` - what GET /api/containers calls -
		// rather than off the member row directly, so this asserts the page would
		// actually show it rather than that a row exists somewhere.
		let inFlight: ContainerListing | undefined;
		const { docker } = recordingDocker({
			onStart: async (id) => {
				const rows = await listAllContainers(db);
				inFlight = rows.find((r) => r.container_id === id);
			},
		});

		const id = await provisionContainer(baseDeps(docker), await projectRow(), teamSlug);

		expect(inFlight?.state).toBe('creating');
		expect(inFlight?.project_id).toBe(projectId);

		// And it is allocatable only once provisioning finished - `creating` is
		// dropped by the ladder, so registering early cannot hand a half-built
		// container to a run.
		const after = await db.query<{ state: string }>(
			`SELECT state::text AS state FROM container_pool_members WHERE container_id = $1`,
			[id],
		);
		expect(after.rows[0].state).toBe('idle');
	});

	it('stays `creating` through the setup tail, so it is neither shown nor used as ready', async () => {
		// The window the screenshot caught: the member was flipped to `idle` right
		// after `startContainer`, above the CA install, the chown, the repo clone and
		// the MCP installs. The page showed "Idle" for the slowest minutes of the
		// container's life while its own log said it was cloning.
		//
		// Observed from an exec, because that is what the setup tail is made of -
		// `onStart` fires above the old write and so could never have caught this.
		await resetContainerRow();
		const seen: Array<{ state: string; usable: number; suspendable: number }> = [];
		const { docker } = recordingDocker({
			onExec: async () => {
				const rows = await listAllContainers(db);
				const listed = rows.find((r) => r.project_id === projectId);
				const members = await loadPoolMembers(db, projectId);
				seen.push({
					state: listed?.state ?? 'missing',
					// The half the label hides: `idle` is what makes a member
					// allocatable and suspendable. A container with no CA trusted and
					// no repos must be neither.
					usable: members.length,
					suspendable: planIdleShutdown(members).suspend.length,
				});
			},
		});

		const id = await provisionContainer(baseDeps(docker), await projectRow(), teamSlug);

		expect(seen.length).toBeGreaterThan(0);
		for (const at of seen) {
			expect(at.state).toBe('creating');
			expect(at.usable).toBe(0);
			expect(at.suspendable).toBe(0);
		}

		// And it does become usable once the container really is ready.
		const after = await db.query<{ state: string }>(
			`SELECT state::text AS state FROM container_pool_members WHERE container_id = $1`,
			[id],
		);
		expect(after.rows[0].state).toBe('idle');
		expect((await loadPoolMembers(db, projectId)).length).toBe(1);
	});

	it('leaves a container that failed part-way through setup in the pool, marked and explained', async () => {
		// It is a real container on the engine. Dropping the member row would leave
		// it running and referenced by nothing - invisible on a local daemon, billed
		// for on a managed backend - and an operator with no row to remove.
		await resetContainerRow();
		const { docker } = recordingDocker({
			onStart: async () => {
				throw new Error('container exited immediately');
			},
		});

		await expect(
			provisionContainer(baseDeps(docker), await projectRow(), teamSlug),
		).rejects.toThrow('container exited immediately');

		const member = await db.query<{ state: string; last_error: string | null }>(
			`SELECT state::text AS state, last_error FROM container_pool_members
			  WHERE project_id = $1 AND state = 'error'::container_pool_state`,
			[projectId],
		);
		expect(member.rows).toHaveLength(1);
		expect(member.rows[0].last_error).toContain('container exited immediately');

		await db.query(`DELETE FROM container_pool_members WHERE project_id = $1`, [projectId]);
	});

	it('labels the container as a test container only when the test-containers env is set', async () => {
		const prev = process.env[TEST_CONTAINERS_ENV];
		try {
			process.env[TEST_CONTAINERS_ENV] = '1';
			await resetContainerRow();
			const labelled = recordingDocker();
			await provisionContainer(baseDeps(labelled.docker), await projectRow(), teamSlug);
			expect(labelled.created[0].config.Labels?.['hezo.test']).toBe('1');

			delete process.env[TEST_CONTAINERS_ENV];
			await resetContainerRow();
			const unlabelled = recordingDocker();
			await provisionContainer(baseDeps(unlabelled.docker), await projectRow(), teamSlug);
			expect(unlabelled.created[0].config.Labels?.['hezo.test']).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env[TEST_CONTAINERS_ENV];
			else process.env[TEST_CONTAINERS_ENV] = prev;
		}
	});

	it('writes the egress CA through the file seam, runs update-ca-certificates, and surfaces its stderr', async () => {
		// It used to arrive as a `host:container` bind, which only Docker can
		// honour: a managed backend has no host to bind from, and Daytona's adapter
		// could render it only as "create the parent directory" - so the cert never
		// landed, `NODE_EXTRA_CA_CERTS` named a missing file, and every proxied TLS
		// call failed on an unknown issuer. Asserting the *write* is what makes the
		// delivery backend-agnostic rather than Docker-shaped.
		await resetContainerRow();
		const { docker, created } = recordingDocker({ execStderr: 'ca-store warning line' });
		const logs = new LogStreamBroker();
		const caDir = mkdtempSync(join(tmpdir(), 'hezo-ca-'));
		const egressCAPath = join(caDir, 'egress-ca.pem');
		writeFileSync(egressCAPath, '-----BEGIN CERTIFICATE-----\nprovision-test\n');

		const writes: Array<{ root: string; rel: string; contents: string }> = [];
		const realFiles = docker.files;
		docker.files = (containerId: string, root: string) => {
			const inner = realFiles(containerId, root);
			return {
				...inner,
				write: async (rel: string, contents: string) => {
					writes.push({ root, rel, contents });
				},
			};
		};

		const id = await provisionContainer(
			baseDeps(docker, { logs, egressCAPath }),
			await projectRow(),
			teamSlug,
		);

		// No bind carries it any more - that is the regression this guards.
		const binds = created[0].config.HostConfig.Binds as string[];
		expect(binds.some((b) => b.includes(CONTAINER_CA_PATH))).toBe(false);

		const caWrite = writes.find((w) => `${w.root}/${w.rel}` === CONTAINER_CA_PATH);
		expect(caWrite).toBeDefined();
		expect(caWrite?.contents).toContain('provision-test');

		const execCreate = docker.execCreate as ReturnType<typeof vi.fn>;
		const caExec = execCreate.mock.calls.find(
			(c) => (c[1] as { Cmd: string[] }).Cmd[0] === 'update-ca-certificates',
		);
		expect(caExec).toBeDefined();

		const text = logs.getLogText(`container:${id}`);
		expect(text).toContain('→ Trusting Hezo egress CA');
		expect(text).toContain('ca-store warning line');
	});

	it('pins the container MTU (with NET_ADMIN) when the host egress MTU is below the bridge', async () => {
		await resetContainerRow();
		const { docker, created } = recordingDocker();
		const logs = new LogStreamBroker();

		const id = await provisionContainer(
			baseDeps(docker, { logs, detectEgressMtu: async () => 1420 }),
			await projectRow(),
			teamSlug,
		);

		expect(created[0].config.HostConfig.CapAdd).toEqual([
			...CONTAINER_BASE_CAPABILITIES,
			'NET_ADMIN',
		]);
		const execCreate = docker.execCreate as ReturnType<typeof vi.fn>;
		const mtuExec = execCreate.mock.calls.find((c) => (c[1] as { Cmd: string[] }).Cmd[0] === 'ip');
		expect((mtuExec?.[1] as { Cmd: string[] }).Cmd).toEqual([
			'ip',
			'link',
			'set',
			'dev',
			'eth0',
			'mtu',
			'1420',
		]);
		expect(logs.getLogText(`container:${id}`)).toContain('pinning container MTU to 1420');
	});

	it('leaves MTU untouched and grants only base capabilities on a normal (>=1500) egress host', async () => {
		await resetContainerRow();
		const { docker, created } = recordingDocker();

		await provisionContainer(
			baseDeps(docker, { detectEgressMtu: async () => null }),
			await projectRow(),
			teamSlug,
		);

		expect(created[0].config.HostConfig.CapAdd).toEqual(CONTAINER_BASE_CAPABILITIES);
		const execCreate = docker.execCreate as ReturnType<typeof vi.fn>;
		const mtuExec = execCreate.mock.calls.find((c) => (c[1] as { Cmd: string[] }).Cmd[0] === 'ip');
		expect(mtuExec).toBeUndefined();
	});

	it('applies hardened HostConfig defaults: init, cgroup memory cap, pids limit, cap-drop', async () => {
		await resetContainerRow();
		const { docker, created } = recordingDocker();

		await provisionContainer(baseDeps(docker), await projectRow(), teamSlug);

		const hc = created[0].config.HostConfig;
		expect(hc.Init).toBe(true);
		expect(hc.CapDrop).toEqual(['ALL']);
		expect(hc.PidsLimit).toBe(4096);
		// The project's working-set **ceiling**, stated as itself: the instance-wide
		// ram cap (default 2 GB, no per-project override set). The 512 MiB cgroup
		// headroom is no longer added here - it is a cgroup and shared-host concern,
		// so the Docker adapter adds it (`withCgroupHeadroom`) and a managed sandbox,
		// which has neither, is allocated exactly this much. Keeping it here made
		// both backends ask for more than the project was configured for, and at the
		// boundary refused a project set to a managed provider's documented maximum.
		const ceiling = 2 * 1024 ** 3;
		expect(hc.Memory).toBe(ceiling);
		expect(hc.MemorySwap).toBe(ceiling);
	});

	it('states the ceiling from a project-specific memory_limit_gib', async () => {
		await resetContainerRow();
		await db.query('UPDATE projects SET memory_limit_gib = 8 WHERE id = $1', [projectId]);
		try {
			const { docker, created } = recordingDocker();

			await provisionContainer(baseDeps(docker), await projectRow(), teamSlug);

			const ceiling = 8 * 1024 ** 3;
			expect(created[0].config.HostConfig.Memory).toBe(ceiling);
			expect(created[0].config.HostConfig.MemorySwap).toBe(ceiling);
		} finally {
			await db.query('UPDATE projects SET memory_limit_gib = DEFAULT WHERE id = $1', [projectId]);
		}
	});

	it('reports a failed egress-CA install without failing the provision', async () => {
		await resetContainerRow();
		const { docker } = recordingDocker({ execCreateError: new Error('exec transport down') });
		const logs = new LogStreamBroker();
		const caDir = mkdtempSync(join(tmpdir(), 'hezo-ca-'));
		const egressCAPath = join(caDir, 'egress-ca.pem');
		writeFileSync(egressCAPath, '-----BEGIN CERTIFICATE-----\ninstall-failure\n');

		const id = await provisionContainer(
			baseDeps(docker, { logs, egressCAPath }),
			await projectRow(),
			teamSlug,
		);

		// The write lands and the install exec is what fails, so the step is
		// reported and the container still comes up: a container without the CA
		// works for everything that does not transit the proxy, and failing the
		// whole provision would be a worse trade than saying so here.
		expect(id).toBeTruthy();
		const text = logs.getLogText(`container:${id}`);
		expect(text).toContain('⚠ installing the egress CA failed: exec transport down');
		const row = await db.query<{ container_status: string }>(
			'SELECT container_status FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('running');
	});

	it('syncs repos when unlocked and reports clone failures without failing the provision', async () => {
		await resetContainerRow();
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type) VALUES ($1, $2, 'github')`,
			[projectId, 'acme/coverage-repo'],
		);
		try {
			const { docker } = recordingDocker({
				execStderr: 'fatal: could not read from remote repository',
				execExitCode: 128,
			});
			const logs = new LogStreamBroker();

			const id = await provisionContainer(
				baseDeps(docker, { logs, masterKeyManager }),
				await projectRow(),
				teamSlug,
			);

			expect(id).toBeTruthy();
			const text = logs.getLogText(`container:${id}`);
			expect(text).toContain('→ Syncing project repos');
			expect(text).toContain('coverage-repo');
			expect(text).toContain('⚠ 1 repo(s) failed to clone');
			const row = await db.query<{ container_status: string }>(
				'SELECT container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_status).toBe('running');
		} finally {
			await db.query('DELETE FROM repos WHERE project_id = $1', [projectId]);
		}
	});

	it('allocates a provisioning SSH bridge for repo sync when an ssh-agent server is available', async () => {
		await resetContainerRow();
		const allocateRunSocket = vi.fn(async () => ({
			tokenHex: 'aa'.repeat(16),
			tcpHostPort: 45678,
		}));
		const releaseRunSocket = vi.fn(async () => {});
		const sshAgentServer = {
			allocateRunSocket,
			releaseRunSocket,
		} as unknown as NonNullable<ContainerDeps['sshAgentServer']>;
		// The bridge allocates an egress proxy as well as an ssh socket — a
		// provisioning clone's remote carries a credential placeholder only the
		// proxy can substitute — and refuses to run without one, so a test that
		// exercises the bridge has to supply both.
		const allocateRunProxy = vi.fn(async () => ({
			proxyHost: '127.0.0.1',
			proxyPort: 29999,
			token: 'provision-token',
		}));
		const releaseRunProxy = vi.fn(async () => {});
		const egressProxy = {
			allocateRunProxy,
			releaseRunProxy,
		} as unknown as NonNullable<ContainerDeps['egressProxy']>;
		const { docker } = recordingDocker();
		const logs = new LogStreamBroker();

		const id = await provisionContainer(
			baseDeps(docker, { logs, masterKeyManager, sshAgentServer, egressProxy }),
			await projectRow(),
			teamSlug,
		);

		expect(id).toBeTruthy();
		expect(allocateRunSocket).toHaveBeenCalledTimes(1);
		const [runId, identity] = allocateRunSocket.mock.calls[0] as unknown as [
			string,
			{ teamId: string; label: string },
		];
		expect(runId).toMatch(/^provision-[0-9a-f]{16}$/);
		expect(identity).toEqual({ teamId, agentId: 'host', label: 'provision-git' });
		// The short-lived pair is always released, even with no repos to sync.
		expect(releaseRunSocket).toHaveBeenCalledWith(runId);
		expect(allocateRunProxy).toHaveBeenCalledTimes(1);
		expect(releaseRunProxy).toHaveBeenCalledWith(runId);
		expect(logs.getLogText(`container:${id}`)).toContain('→ Syncing project repos');
	});

	it('reports failed local MCP installs without failing the provision', async () => {
		await resetContainerRow();
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('coverage-bad-mcp', 'local'::mcp_connection_kind, $1::jsonb, 'pending'::mcp_install_status)`,
			[JSON.stringify({ package: 'not a valid package name !!' })],
		);
		try {
			const { docker } = recordingDocker();
			const logs = new LogStreamBroker();

			const id = await provisionContainer(baseDeps(docker, { logs }), await projectRow(), teamSlug);

			const text = logs.getLogText(`container:${id}`);
			expect(text).toContain('→ Installing pending local MCP servers');
			expect(text).toContain('⚠ 1 MCP server install(s) failed');

			const mcp = await db.query<{ install_status: string; install_error: string | null }>(
				`SELECT install_status::text AS install_status, install_error
				 FROM mcp_connections WHERE name = 'coverage-bad-mcp'`,
			);
			expect(mcp.rows[0].install_status).toBe('failed');
			expect(mcp.rows[0].install_error).toContain('unsafe package name');
		} finally {
			await db.query(`DELETE FROM mcp_connections WHERE name = 'coverage-bad-mcp'`);
		}
	});

	it('marks the project errored, emits the failure, and rethrows when container creation fails', async () => {
		await resetContainerRow();
		const docker = createStubDocker({
			createContainer: vi.fn(async () => {
				throw new Error('no space left on device');
			}),
		});
		const logs = new LogStreamBroker();
		const wsManager = { broadcast: vi.fn() } as unknown as WebSocketManager & {
			broadcast: ReturnType<typeof vi.fn>;
		};

		await expect(
			provisionContainer(baseDeps(docker, { logs, wsManager }), await projectRow(), teamSlug),
		).rejects.toThrow('no space left on device');

		const row = await db.query<{ container_status: string; container_error: string | null }>(
			'SELECT container_status, container_error FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_status).toBe('error');
		expect(row.rows[0].container_error).toContain('no space left on device');

		// No log assertion here, deliberately: the failure landed before the engine
		// returned an id, so there is no container to attach output to and the
		// provisioning stream was never opened. `projects.container_error` above is
		// what carries the reason, and it is what the banner reads.

		// creating → error transitions were both broadcast.
		const statuses = wsManager.broadcast.mock.calls.map(
			(c) => (c[1] as { row?: { container_status?: string } }).row?.container_status,
		);
		expect(statuses).toContain('creating');
		expect(statuses).toContain('error');
	});
});
