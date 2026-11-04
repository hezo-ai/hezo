/**
 * What happens to a container after its run hands it back, and what the uptime
 * ledger bills for it.
 *
 * Two rules, both measured against production: a container is retired a few
 * seconds after its run ends unless a job is about to use it, and the ledger
 * bills a container for the whole time the backend does - from the create or
 * start request until the stop or removal has finished. Every case here would
 * mis-bill or strand a run quietly rather than fail loudly.
 */

import { randomUUID } from 'node:crypto';
import { CHAT_IDLE_TIMEOUT_MIN, ContainerUptimeEndReason } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import { setMaxContainerMemoryGb } from '../src/lib/system-meta';
import { ContainerLogStreamer } from '../src/services/container-logs';
import {
	acquireRunContainer,
	type ContainerDeps,
	executeRetirementPlan,
	reconcilePoolMembers,
} from '../src/services/containers';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import {
	beginPoolMemberStop,
	setPoolMemberState,
	setPoolMemberUnpushedFlag,
	settleReapedContainerUptime,
	upsertPoolMember,
} from '../src/services/sandbox/pool-db';
import type { ContainerEngine, ContainerInfo } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let dataDir: string;
let masterKeyManager: MasterKeyManager;

/** Short enough to keep the suite fast, long enough to order a claim inside it. */
const TEST_GRACE_MS = 150;
const GB = 2 ** 30;

interface Engine {
	docker: ContainerEngine;
	/** Every lifecycle call, in order. */
	calls: Array<{ op: 'create' | 'start' | 'stop' | 'remove'; id: string }>;
	running: Set<string>;
}

/**
 * A complete stub engine that remembers which containers are up, so a test can
 * ask whether the container a run was handed is actually running.
 */
function engine(
	opts: {
		createDelayMs?: number;
		stopDelayMs?: number;
		createError?: Error;
		onCreate?: (name: string) => void;
		findByName?: (name: string) => Promise<ContainerInfo | null>;
	} = {},
): Engine {
	const calls: Engine['calls'] = [];
	const running = new Set<string>();
	let seq = 0;
	const info = (id: string): ContainerInfo => ({
		Id: id,
		State: {
			Status: running.has(id) ? 'running' : 'exited',
			Running: running.has(id),
			Pid: 1,
			ExitCode: 0,
		},
		Config: { Image: 'stub' },
	});
	const docker = createStubDocker({
		createContainer: vi.fn(async (name: string) => {
			opts.onCreate?.(name);
			if (opts.createDelayMs) await new Promise((r) => setTimeout(r, opts.createDelayMs));
			if (opts.createError) throw opts.createError;
			const id = `rel-${randomUUID().slice(0, 8)}-${seq++}`;
			calls.push({ op: 'create', id });
			return { Id: id, Warnings: [] };
		}),
		startContainer: vi.fn(async (id: string) => {
			calls.push({ op: 'start', id });
			running.add(id);
		}),
		stopContainer: vi.fn(async (id: string) => {
			calls.push({ op: 'stop', id });
			if (opts.stopDelayMs) await new Promise((r) => setTimeout(r, opts.stopDelayMs));
			running.delete(id);
		}),
		removeContainer: vi.fn(async (id: string) => {
			calls.push({ op: 'remove', id });
			running.delete(id);
		}),
		inspectContainer: vi.fn(async (id: string) => info(id)),
		findContainerByNamePrefix: vi.fn(async (name: string) =>
			opts.findByName ? opts.findByName(name) : null,
		),
		execCreate: vi.fn(async () => 'exec-x'),
		execStart: vi.fn(async () => ({ stdout: '', stderr: '' })),
		execInspect: vi.fn(async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
	});
	return { docker, calls, running };
}

function deps(docker: ContainerEngine): ContainerDeps {
	return { db, docker, dataDir, poolLivenessIntervalMs: 0 };
}

function manager(docker: ContainerEngine, graceMs = TEST_GRACE_MS): JobManager {
	return new JobManager({
		db,
		docker,
		masterKeyManager,
		serverPort: 3100,
		dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		releaseGraceMs: graceMs,
	});
}

/** What the job manager does once a run's completion bookkeeping has finished. */
function runEnded(jm: JobManager, projectId: string): void {
	(jm as unknown as { scheduleReleaseRetirement(id: string): void }).scheduleReleaseRetirement(
		projectId,
	);
}

async function sweep(jm: JobManager): Promise<void> {
	await (jm as unknown as { stopIdleContainers(): Promise<void> }).stopIdleContainers();
	await waitForBackground();
}

/** A project of its own, with the task its runs and wakeups are keyed to. */
async function freshProject(
	name: string,
): Promise<{ projectId: string; taskId: string; teamId: string }> {
	const team = (await (await createTestTeam(db, { name: `${name} Co` })).json()).data;
	const project = (await (await createTestProject(db, team.id, { name })).json()).data;
	return { projectId: project.id, taskId: project.planning_task_id as string, teamId: team.id };
}

async function memberState(containerId: string): Promise<string | null> {
	const res = await db.query<{ state: string }>(
		'SELECT state::text AS state FROM container_pool_members WHERE container_id = $1',
		[containerId],
	);
	return res.rows[0]?.state ?? null;
}

interface Interval {
	container_id: string;
	started_at: Date;
	ended_at: Date | null;
	end_reason: string | null;
}

async function intervals(containerId: string): Promise<Interval[]> {
	const res = await db.query<Interval>(
		`SELECT container_id, started_at, ended_at, end_reason
		   FROM container_uptime_entries WHERE container_id = $1 ORDER BY started_at`,
		[containerId],
	);
	return res.rows.map((r) => ({
		...r,
		started_at: new Date(r.started_at),
		ended_at: r.ended_at === null ? null : new Date(r.ended_at),
	}));
}

async function queueWakeup(teamId: string, taskId: string): Promise<void> {
	const member = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id WHERE m.team_id = $1 LIMIT 1`,
		[teamId],
	);
	await db.query(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
		 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status,
		         jsonb_build_object('task_id', $3::text))`,
		[member.rows[0].id, teamId, taskId],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = ctx.dataDir;
	masterKeyManager = ctx.masterKeyManager;
	await setMaxContainerMemoryGb(db, 40);
});

beforeEach(async () => {
	await db.query('DELETE FROM agent_wakeup_requests');
});

afterAll(async () => {
	await safeClose(db);
});

describe('release-time retirement', () => {
	it('retires a released container once the grace passes and no job is waiting', async () => {
		const { projectId, taskId } = await freshProject('Release Quiet');
		const e = engine();
		const jm = manager(e.docker);
		const acquired = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await acquired.release();
		runEnded(jm, projectId);
		await waitForBackground();
		jm.shutdown();

		// The project's last member, so the warm-start floor suspends rather than
		// destroys it - and its billed stretch has ended.
		expect(e.calls.filter((c) => c.op === 'stop').map((c) => c.id)).toEqual([acquired.containerId]);
		expect(await memberState(acquired.containerId)).toBe('suspended');
		const rows = await intervals(acquired.containerId);
		expect(rows).toHaveLength(1);
		expect(rows[0].ended_at).not.toBeNull();
	});

	it('hands a released container to the follow-up its run caused, with no stop or start between', async () => {
		// The common chain: a run's handoff fires a wakeup for the next agent. The
		// wakeup is queued by the time the grace runs out, so the container stays
		// up and the next run takes it straight off the warm rung.
		const { projectId, taskId, teamId } = await freshProject('Release Followup');
		const e = engine();
		const jm = manager(e.docker);
		const first = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await first.release();
		await queueWakeup(teamId, taskId);
		runEnded(jm, projectId);
		await waitForBackground();
		jm.shutdown();

		expect(await memberState(first.containerId)).toBe('idle');
		const callsBefore = e.calls.length;
		const next = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await next.release();

		expect(next.containerId).toBe(first.containerId);
		expect(e.calls.slice(callsBefore)).toEqual([]);
		expect(e.calls.filter((c) => c.op === 'stop')).toEqual([]);
		// One continuous billed stretch: never suspended, never resumed.
		const rows = await intervals(first.containerId);
		expect(rows).toHaveLength(1);
		expect(rows[0].ended_at).toBeNull();
	});

	it('cancels the retirement when the container is claimed inside the grace', async () => {
		const { projectId, taskId } = await freshProject('Release Claimed');
		const e = engine();
		const jm = manager(e.docker);
		const first = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await first.release();
		runEnded(jm, projectId);
		// Claimed before the grace runs out - the claim's compare-and-set on `idle`
		// is what decides the race.
		const second = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await waitForBackground();
		jm.shutdown();

		expect(second.containerId).toBe(first.containerId);
		expect(await memberState(first.containerId)).toBe('busy');
		expect(e.calls.filter((c) => c.op === 'stop' || c.op === 'remove')).toEqual([]);
		await second.release();
	});

	it('never strands a run that races the retirement', async () => {
		// Grace zero, and a dispatch arriving at the same moment. Whichever wins the
		// project's lifecycle lock, the run must end up on a container that is up:
		// either the same one, never stopped, or one resumed after its stop finished.
		const { projectId, taskId } = await freshProject('Release Race');
		const e = engine({ stopDelayMs: 50 });
		const jm = manager(e.docker, 0);
		const first = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await first.release();
		runEnded(jm, projectId);
		const raced = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await waitForBackground();
		jm.shutdown();

		expect(await memberState(raced.containerId)).toBe('busy');
		expect(e.running.has(raced.containerId)).toBe(true);
		await raced.release();
	});

	it('keeps at most one member suspended per project and destroys the rest', async () => {
		const { projectId, taskId } = await freshProject('Release Pool');
		const e = engine();
		const jm = manager(e.docker);
		const a = await acquireRunContainer(deps(e.docker), projectId, taskId);
		const b = await acquireRunContainer(deps(e.docker), projectId, taskId);
		const c = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await a.release();
		await b.release();
		await c.release();
		runEnded(jm, projectId);
		await waitForBackground();
		jm.shutdown();

		expect(e.calls.filter((x) => x.op === 'stop')).toHaveLength(1);
		expect(e.calls.filter((x) => x.op === 'remove')).toHaveLength(2);
		const left = await db.query<{ state: string }>(
			'SELECT state::text AS state FROM container_pool_members WHERE project_id = $1',
			[projectId],
		);
		expect(left.rows.map((r) => r.state)).toEqual(['suspended']);
		// Every stretch closed: the suspended one at its stop, the others at removal.
		for (const id of [a, b, c].map((x) => x.containerId)) {
			const rows = await intervals(id);
			expect(rows).toHaveLength(1);
			expect(rows[0].ended_at).not.toBeNull();
		}
	});

	it('suspends a member holding unpushed commits and never destroys it', async () => {
		const { projectId, taskId } = await freshProject('Release Unpushed');
		const e = engine();
		const jm = manager(e.docker);
		const a = await acquireRunContainer(deps(e.docker), projectId, taskId);
		const b = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await setPoolMemberUnpushedFlag(db, a.containerId, true);
		await setPoolMemberUnpushedFlag(db, b.containerId, true);
		await a.release();
		await b.release();
		runEnded(jm, projectId);
		await waitForBackground();
		jm.shutdown();

		expect(e.calls.filter((x) => x.op === 'remove')).toEqual([]);
		expect(
			e.calls
				.filter((x) => x.op === 'stop')
				.map((x) => x.id)
				.sort(),
		).toEqual([a.containerId, b.containerId].sort());
	});

	it('lets a chat keep one idle member warm, and only for the chat pause', async () => {
		const { projectId } = await freshProject('Release Chat');
		const e = engine();
		const jm = manager(e.docker);
		const older = await acquireRunContainer(deps(e.docker), projectId, null, 'chat-turn');
		const newer = await acquireRunContainer(deps(e.docker), projectId, null, 'chat-turn');
		await older.release();
		await newer.release();
		// Both past the release grace and inside the chat pause, stamped apart so
		// which one the chat released last is not left to the clock's resolution.
		const stamp = (id: string, secondsAgo: number) =>
			db.query(
				`UPDATE container_pool_members
				    SET last_released_at = now() - ($2 * interval '1 second'),
				        chat_released_at = now() - ($2 * interval '1 second')
				  WHERE container_id = $1`,
				[id, secondsAgo],
			);
		await stamp(older.containerId, 40);
		await stamp(newer.containerId, 20);
		await sweep(jm);

		// Only the member the chat released last is held; it is the project's warm
		// start, so the other is destroyed rather than suspended.
		expect(await memberState(newer.containerId)).toBe('idle');
		expect(await memberState(older.containerId)).toBeNull();
		expect(e.calls.filter((x) => x.op === 'remove').map((x) => x.id)).toEqual([older.containerId]);

		await db.query(
			`UPDATE container_pool_members
			    SET chat_released_at = now() - ($2 * interval '1 minute'),
			        last_released_at = now() - ($2 * interval '1 minute')
			  WHERE project_id = $1`,
			[projectId, CHAT_IDLE_TIMEOUT_MIN + 1],
		);
		await sweep(jm);
		jm.shutdown();
		expect(await memberState(newer.containerId)).toBe('suspended');
	});

	it('does not keep a container warm for a wakeup the dispatcher already refused', async () => {
		const { projectId, taskId, teamId } = await freshProject('Release Refused');
		const e = engine();
		const jm = manager(e.docker);
		const acquired = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await acquired.release();
		await queueWakeup(teamId, taskId);
		await db.query(
			`UPDATE agent_wakeup_requests SET last_skipped_at = now(), last_skipped_reason = 'parked_on_admin'
			  WHERE team_id = $1`,
			[teamId],
		);
		runEnded(jm, projectId);
		await waitForBackground();
		jm.shutdown();
		expect(await memberState(acquired.containerId)).toBe('suspended');
	});
});

describe('the ledger bills the whole time the backend does', () => {
	it('starts an interval at the create request, not when the container is ready', async () => {
		const { projectId, taskId } = await freshProject('Meter Create');
		let requestedAt = 0;
		const e = engine({
			createDelayMs: 200,
			onCreate: () => {
				requestedAt = Date.now();
			},
		});
		const acquired = await acquireRunContainer(deps(e.docker), projectId, taskId);
		const readyAt = Date.now();
		await acquired.release();

		const [row] = await intervals(acquired.containerId);
		expect(row.started_at.getTime()).toBeLessThanOrEqual(requestedAt);
		expect(readyAt - row.started_at.getTime()).toBeGreaterThanOrEqual(200);
	});

	it('closes an interval when a slow stop finishes, not when it was asked for', async () => {
		const { projectId, taskId } = await freshProject('Meter Stop');
		const e = engine({ stopDelayMs: 300 });
		const jm = manager(e.docker);
		const acquired = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await acquired.release();
		const askedAt = Date.now();
		runEnded(jm, projectId);
		await waitForBackground();
		jm.shutdown();

		const [row] = await intervals(acquired.containerId);
		expect(row.ended_at).not.toBeNull();
		expect((row.ended_at as Date).getTime() - askedAt).toBeGreaterThanOrEqual(TEST_GRACE_MS + 300);
	});

	it('resumes a member still stopping only after the stop, with no overlapping stretch', async () => {
		const { projectId, taskId } = await freshProject('Meter Resume');
		const e = engine({ stopDelayMs: 200 });
		const acquired = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await acquired.release();
		const project = await db.query<{ slug: string; team_id: string }>(
			'SELECT slug, team_id FROM projects WHERE id = $1',
			[projectId],
		);
		await executeRetirementPlan(
			deps(e.docker),
			{ id: projectId, ...project.rows[0] },
			{ suspend: [acquired.containerId], destroy: [] },
			{ reason: 'idle' },
		);
		// The stop is still running; the ladder resumes the same member.
		const resumed = await acquireRunContainer(deps(e.docker), projectId, taskId);
		await waitForBackground();

		expect(resumed.containerId).toBe(acquired.containerId);
		const ops = e.calls.filter((c) => c.id === acquired.containerId).map((c) => c.op);
		expect(ops.slice(-2)).toEqual(['stop', 'start']);
		const rows = await intervals(acquired.containerId);
		expect(rows).toHaveLength(2);
		expect(rows[1].started_at.getTime()).toBeGreaterThanOrEqual(
			(rows[0].ended_at as Date).getTime(),
		);
		await resumed.release();
	});

	it('never opens a resumed stretch before the last one ended, even when told to', async () => {
		// The write path's own guard: a start request timestamp that predates the
		// previous close is clamped to it.
		const { projectId } = await freshProject('Meter Clamp');
		await upsertPoolMember(db, projectId, 'clamp-1', 'idle', { memoryBytes: GB });
		await setPoolMemberState(db, 'clamp-1', 'suspended');
		await setPoolMemberState(db, 'clamp-1', 'idle', undefined, new Date(Date.now() - 60_000));
		const rows = await intervals('clamp-1');
		expect(rows).toHaveLength(2);
		expect(rows[1].started_at.getTime()).toBeGreaterThanOrEqual(
			(rows[0].ended_at as Date).getTime(),
		);
	});

	it('bills a failed create that left a container from the request until its removal', async () => {
		const { projectId, taskId } = await freshProject('Meter Ghost');
		let requestedAt = 0;
		let name = '';
		const e = engine({
			createDelayMs: 50,
			createError: new Error('create timed out'),
			onCreate: (n) => {
				name = n;
				requestedAt = Date.now();
			},
			findByName: async (n) =>
				n === name
					? {
							Id: 'ghost-1',
							State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
							Config: { Image: 'stub' },
						}
					: null,
		});
		await expect(acquireRunContainer(deps(e.docker), projectId, taskId)).rejects.toThrow(
			/create timed out/,
		);
		await waitForBackground();

		expect(e.calls.filter((c) => c.op === 'remove').map((c) => c.id)).toEqual(['ghost-1']);
		const rows = await intervals('ghost-1');
		expect(rows).toHaveLength(1);
		expect(rows[0].started_at.getTime()).toBeLessThanOrEqual(requestedAt);
		expect(rows[0].end_reason).toBe(ContainerUptimeEndReason.Destroyed);
		expect(await intervals(`provisioning:${name}`)).toEqual([]);
	});

	it('bills nothing for a failed create that left no container', async () => {
		const { projectId, taskId } = await freshProject('Meter Nothing');
		let name = '';
		const e = engine({
			createError: new Error('quota exceeded'),
			onCreate: (n) => {
				name = n;
			},
		});
		await expect(acquireRunContainer(deps(e.docker), projectId, taskId)).rejects.toThrow(
			/quota exceeded/,
		);
		await waitForBackground();
		const rows = await db.query('SELECT 1 FROM container_uptime_entries WHERE project_id = $1', [
			projectId,
		]);
		expect(rows.rows).toEqual([]);
		expect(name).not.toBe('');
	});
});

describe('a restart in the middle of a lifecycle call', () => {
	const backdate = async (containerId: string) => {
		await db.query(
			`UPDATE container_pool_members SET updated_at = now() - interval '10 minutes'
			  WHERE container_id = $1`,
			[containerId],
		);
		await db.query(
			`UPDATE container_uptime_entries SET started_at = now() - interval '10 minutes'
			  WHERE container_id = $1`,
			[containerId],
		);
	};

	it('closes a stop the restart cut short once the engine reports it at rest, not before', async () => {
		const { projectId } = await freshProject('Restart Stop');
		const id = 'restart-stop-1';
		await upsertPoolMember(db, projectId, id, 'idle', { memoryBytes: GB });
		expect(await beginPoolMemberStop(db, id)).toBe(true);
		await backdate(id);

		let state: 'stopping' | 'stopped' = 'stopping';
		const docker = createStubDocker({
			inspectContainer: vi.fn(async (cid: string) => ({
				Id: cid,
				State: {
					Status: state === 'stopping' ? 'created' : 'exited',
					Running: false,
					Pid: 0,
					ExitCode: 0,
					Transitioning: state === 'stopping',
				},
				Config: { Image: 'stub' },
			})),
		});
		await reconcilePoolMembers(deps(docker));
		expect((await intervals(id))[0].ended_at).toBeNull();

		state = 'stopped';
		await reconcilePoolMembers(deps(docker));
		const [row] = await intervals(id);
		expect(row.ended_at).not.toBeNull();
		expect(row.end_reason).toBe(ContainerUptimeEndReason.Reconciled);
	});

	it('hands back a container recorded stopped that is in fact still running', async () => {
		const { projectId } = await freshProject('Restart Running');
		const id = 'restart-run-1';
		await upsertPoolMember(db, projectId, id, 'idle', { memoryBytes: GB });
		await beginPoolMemberStop(db, id);
		await backdate(id);
		const docker = createStubDocker({
			inspectContainer: vi.fn(async (cid: string) => ({
				Id: cid,
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
		});
		await reconcilePoolMembers(deps(docker));
		expect(await memberState(id)).toBe('idle');
		const rows = await intervals(id);
		expect(rows).toHaveLength(1);
		expect(rows[0].ended_at).toBeNull();
	});

	it('closes a removal the restart cut short once the engine reports the container gone', async () => {
		const { projectId } = await freshProject('Restart Remove');
		const id = 'restart-rm-1';
		await upsertPoolMember(db, projectId, id, 'idle', { memoryBytes: GB });
		await db.query('DELETE FROM container_pool_members WHERE container_id = $1', [id]);
		await backdate(id);
		const docker = createStubDocker({ inspectContainer: vi.fn(async () => null) });
		await reconcilePoolMembers(deps(docker));
		const [row] = await intervals(id);
		expect(row.end_reason).toBe(ContainerUptimeEndReason.Destroyed);
	});

	it('settles a create the restart cut short by looking its name up', async () => {
		const { projectId } = await freshProject('Restart Create');
		const insert = async (name: string) =>
			db.query(
				`INSERT INTO container_uptime_entries (project_id, container_id, backend, started_at)
				 VALUES ($1, $2, 'docker', now() - interval '10 minutes')`,
				[projectId, `provisioning:${name}`],
			);
		await insert('never-made');
		await insert('was-made');
		const docker = createStubDocker({
			findContainerByNamePrefix: vi.fn(async (name: string) =>
				name === 'was-made'
					? {
							Id: 'made-1',
							State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
							Config: { Image: 'stub' },
						}
					: null,
			),
		});
		await reconcilePoolMembers(deps(docker));

		// Nothing was created: nothing is billed.
		expect(await intervals('provisioning:never-made')).toEqual([]);
		// Something was: the interval moves to it and stays open until removal,
		// which the orphan sweep does and settles.
		const [made] = await intervals('made-1');
		expect(made.ended_at).toBeNull();
		await settleReapedContainerUptime(db, 'made-1', ['/was-made']);
		const [closed] = await intervals('made-1');
		expect(closed.end_reason).toBe(ContainerUptimeEndReason.Destroyed);
	});

	it('keeps billing an errored container until the engine reports it at rest', async () => {
		const { projectId } = await freshProject('Restart Error');
		const id = 'restart-err-1';
		await upsertPoolMember(db, projectId, id, 'creating', { memoryBytes: GB });
		await setPoolMemberState(db, id, 'error');
		expect((await intervals(id))[0].ended_at).toBeNull();
		await backdate(id);
		const docker = createStubDocker({
			inspectContainer: vi.fn(async (cid: string) => ({
				Id: cid,
				State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 1 },
				Config: { Image: 'stub' },
			})),
		});
		await reconcilePoolMembers(deps(docker));
		expect((await intervals(id))[0].ended_at).not.toBeNull();
	});
});
