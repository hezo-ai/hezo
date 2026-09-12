import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { reconcilePoolMembers } from '../src/services/containers';
import {
	claimPoolMember,
	failInterruptedProvisions,
	INTERRUPTED_PROVISION_ERROR,
	projectHasStrandedCommits,
	releaseClaimIfRunGone,
	setPoolMemberUnpushedFlag,
} from '../src/services/sandbox/pool-db';
import { createTestDbWithMigrations } from './helpers/db';

/**
 * The unpushed-commit pin, written at every run end.
 *
 * The flag is what keeps `planIdleShutdown` off a container holding the only copy
 * of committed work, so the interesting behaviour is not that it can be set - it is
 * that an *unanswerable* check leaves it exactly as it was. Clearing a pin on "we
 * could not tell" would destroy the container the pin exists to protect.
 */
describe('setPoolMemberUnpushedFlag', () => {
	let db: PgliteDb;
	let projectId: string;
	let otherProjectId: string;

	const flagOf = async (containerId: string): Promise<boolean> => {
		const r = await db.query<{ has_unpushed_commits: boolean }>(
			'SELECT has_unpushed_commits FROM container_pool_members WHERE container_id = $1',
			[containerId],
		);
		return r.rows[0].has_unpushed_commits;
	};

	const seedProject = async (slug: string): Promise<string> => {
		// A team backs exactly one project (UNIQUE(projects.team_id)).
		const team = await db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			[`team-${slug}`],
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, slug, slug.slice(0, 3).toUpperCase()],
		);
		return project.rows[0].id;
	};

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		projectId = await seedProject('pool');
		otherProjectId = await seedProject('other');
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state)
			 VALUES ($1, 'ctr-a', 'idle'), ($1, 'ctr-b', 'idle'), ($2, 'ctr-c', 'idle')`,
			[projectId, otherProjectId],
		);
	});
	afterAll(() => db.close());

	it('pins a container that is holding stranded commits', async () => {
		await setPoolMemberUnpushedFlag(db, 'ctr-a', true);
		expect(await flagOf('ctr-a')).toBe(true);
	});

	it('leaves the pin alone when the check could not answer', async () => {
		// Null is not false. A git failure or a missing clone proves nothing, and
		// treating it as an all-clear would release a container that an earlier run
		// pinned for real.
		await setPoolMemberUnpushedFlag(db, 'ctr-a', null);
		expect(await flagOf('ctr-a')).toBe(true);
	});

	it('releases the pin on a definite all-clear', async () => {
		// The next run on the same container gets the commits out, so the pin must
		// clear - otherwise a single denied push pins a container forever.
		await setPoolMemberUnpushedFlag(db, 'ctr-a', false);
		expect(await flagOf('ctr-a')).toBe(false);
	});

	it('touches only the named container', async () => {
		await setPoolMemberUnpushedFlag(db, 'ctr-b', true);
		expect(await flagOf('ctr-a')).toBe(false);
		expect(await flagOf('ctr-c')).toBe(false);
	});

	it('writes nothing when the flag already holds that value', async () => {
		// Under MVCC a no-op UPDATE still leaves a dead tuple, and this runs at the
		// end of every run; the embedded backend has no autovacuum to reclaim it.
		const before = await db.query<{ updated_at: Date }>(
			'SELECT updated_at FROM container_pool_members WHERE container_id = $1',
			['ctr-b'],
		);
		await setPoolMemberUnpushedFlag(db, 'ctr-b', true);
		const after = await db.query<{ updated_at: Date }>(
			'SELECT updated_at FROM container_pool_members WHERE container_id = $1',
			['ctr-b'],
		);
		expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
	});

	it('is a no-op for a container with no pool member yet', async () => {
		// The pool table is populated as call sites move over; a run on a container
		// that has no member row must not throw at finalize.
		await expect(setPoolMemberUnpushedFlag(db, 'ctr-unknown', true)).resolves.toBeUndefined();
	});

	it('reports a project whose commits are stranded', async () => {
		expect(await projectHasStrandedCommits(db, projectId)).toBe(true);
		expect(await projectHasStrandedCommits(db, otherProjectId)).toBe(false);
	});

	it('stops reporting a project once its last pin clears', async () => {
		await setPoolMemberUnpushedFlag(db, 'ctr-b', false);
		expect(await projectHasStrandedCommits(db, projectId)).toBe(false);
	});
});

/**
 * Reconciling pool members against the engine.
 *
 * The acquire path repairs a stale member only on the rungs it picks - and it
 * never picks a `busy` one, so a run that died without releasing its row leaves
 * a member nothing revisits. Because `getActiveContainers` counts `busy` towards
 * the instance memory budget, each orphan permanently consumes capacity until
 * every run in the project fails admission.
 */
describe('reconcilePoolMembers', () => {
	let db: PgliteDb;
	let projectId: string;

	const seed = async (containerId: string, state: string, ageSeconds: number) => {
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, updated_at)
			 VALUES ($1, $2, $3::container_pool_state, now() - ($4 * interval '1 second'))`,
			[projectId, containerId, state, ageSeconds],
		);
	};
	const remaining = async (): Promise<string[]> => {
		const r = await db.query<{ container_id: string }>(
			'SELECT container_id FROM container_pool_members ORDER BY container_id',
		);
		return r.rows.map((x) => x.container_id);
	};
	/**
	 * Engine that knows only `known`, 404s the rest, throws for `unanswerable`,
	 * and reports anything in `stopped` as present but not running.
	 */
	const engine = (
		known: string[],
		unanswerable: string[] = [],
		stopped: Record<string, number> = {},
	) =>
		({
			inspectContainer: async (id: string) => {
				if (unanswerable.includes(id)) throw new Error('API unreachable');
				if (id in stopped) {
					return {
						Id: id,
						State: {
							Status: 'exited',
							Running: false,
							Pid: 0,
							ExitCode: stopped[id],
						},
						Config: { Image: 'x' },
					};
				}
				return known.includes(id)
					? {
							Id: id,
							State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
							Config: { Image: 'x' },
						}
					: null;
			},
		}) as unknown as Parameters<typeof reconcilePoolMembers>[0]['docker'];

	/** Always check: the real interval would skip a member a sibling case just looked at. */
	const reconcile = (docker: Parameters<typeof reconcilePoolMembers>[0]['docker']) =>
		reconcilePoolMembers({ db, docker, poolLivenessIntervalMs: 0 } as unknown as Parameters<
			typeof reconcilePoolMembers
		>[0]);

	const openIntervals = async (): Promise<string[]> => {
		const r = await db.query<{ container_id: string }>(
			'SELECT container_id FROM container_uptime_entries WHERE ended_at IS NULL ORDER BY container_id',
		);
		return r.rows.map((x) => x.container_id);
	};

	const stateOf = async (containerId: string): Promise<string | undefined> =>
		(
			await db.query<{ state: string }>(
				'SELECT state::text AS state FROM container_pool_members WHERE container_id = $1',
				[containerId],
			)
		).rows[0]?.state;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const team = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('rec', 'rec') RETURNING id",
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'rec', 'rec', 'REC') RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;
	});
	afterAll(() => db.close());
	// Each case owns the whole table: a member left behind by a previous case
	// would be judged missing by the next one's engine and inflate its count.
	beforeEach(async () => {
		await db.query('DELETE FROM container_pool_members');
		await db.query('DELETE FROM container_uptime_entries');
	});

	it('drops a busy member whose container is gone — the case nothing else repairs', async () => {
		await seed('gone-busy', 'busy', 300);
		await seed('live-busy', 'busy', 300);
		const result = await reconcile(engine(['live-busy']));
		expect(result.dropped).toBe(1);
		expect(await remaining()).toEqual(['live-busy']);
	});

	it('fails a provision that has been coming up for longer than any cold start takes', async () => {
		// Boot catches a provision the restart interrupted. This is the case boot
		// cannot see: the process stays up and the provisioning call wedges anyway.
		// Nothing else in the tree revisits `creating` - the ladder skips it, both
		// idle passes filter on `idle`, and every branch of this pass used to
		// `continue` past it - so it stayed charged against the budget for good.
		await seed('ctr-wedged', 'creating', 3600);
		const result = await reconcile(engine(['ctr-wedged']));
		expect(result.wedged).toBe(1);
		expect(await stateOf('ctr-wedged')).toBe('error');
		// The budget is the point: `error` is not charged, and the interval the
		// `creating` upsert opened stops billing container-hours around the clock.
		expect(await openIntervals()).toEqual([]);
	});

	it('fails a wedged provision even when the backend will not answer for it', async () => {
		// The verdict is taken ahead of the engine round trip on purpose. An
		// unreachable backend throws, and every throw ends this loop early - so
		// asked in the other order, the one shape most likely to strand a provision
		// is also the one that could never be cleaned up.
		await seed('ctr-unanswerable', 'creating', 3600);
		const result = await reconcile(engine([], ['ctr-unanswerable']));
		expect(result.wedged).toBe(1);
		expect(await stateOf('ctr-unanswerable')).toBe('error');
	});

	it('leaves a provision that is still plausibly running alone', async () => {
		// A cold start resolves an image, creates and starts a sandbox, installs the
		// CA and clones the repository. Judging one dead early fails a run that was
		// working, which is the worse direction to be wrong in.
		await seed('ctr-coming-up', 'creating', 120);
		const result = await reconcile(engine(['ctr-coming-up']));
		expect(result.wedged).toBe(0);
		expect(await stateOf('ctr-coming-up')).toBe('creating');
	});

	it('opens a missing interval for a container it finds running', async () => {
		// The repair for the fault that read as "0 containers up now" on a live
		// container. A member can reach a running state with no interval - older
		// than the ledger, or closed while the container stayed up - and the warm
		// paths only open on a row that moves, which a container nobody claims
		// never does. This pass used to `continue` straight past exactly those.
		await seed('running-unbilled', 'idle', 300);
		await seed('running-busy', 'busy', 300);
		await seed('broken', 'error', 300);
		expect(await openIntervals()).toEqual([]);

		await reconcile(engine(['running-unbilled', 'running-busy', 'broken']));

		// `error` stays unbilled: the pool has stopped believing that one is up.
		expect(await openIntervals()).toEqual(['running-busy', 'running-unbilled']);
	});

	it('does not bill the same minutes twice when it sweeps again', async () => {
		await seed('swept-twice', 'idle', 300);
		await reconcile(engine(['swept-twice']));
		await reconcile(engine(['swept-twice']));
		const all = await db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM container_uptime_entries WHERE container_id = $1',
			['swept-twice'],
		);
		expect(all.rows[0].n).toBe(1);
	});

	it('leaves a member alone when the engine could not answer', async () => {
		// A timeout or an unreachable API proves nothing. Deleting the row on an
		// unanswerable check would lose the record of a live container and orphan
		// it on the backend, which is the strictly worse failure.
		await seed('unanswerable', 'idle', 300);
		const result = await reconcile(engine([], ['unanswerable']));
		expect(result.dropped).toBe(0);
		expect(await remaining()).toContain('unanswerable');
	});

	it('does not judge a member that was only just touched', async () => {
		// A container created moments ago may not be answerable for yet, and a
		// member mid-transition would be racing whatever moved it.
		await seed('fresh', 'creating', 1);
		const result = await reconcile(engine([]));
		expect(result.dropped).toBe(0);
		expect(await remaining()).toContain('fresh');
	});

	it('suspends a member that is stopped but still there, and reports the transition', async () => {
		// The case a managed backend produces routinely: it reclaims a sandbox no
		// run is using. The container is intact and resumable, so the row must
		// survive - and the member must stop advertising itself as warm, or the
		// ladder hands it to a run as "nothing to start".
		await seed('auto-stopped', 'idle', 300);
		const result = await reconcile(engine([], [], { 'auto-stopped': 0 }));

		expect(result.dropped).toBe(0);
		expect(await remaining()).toEqual(['auto-stopped']);
		expect(await stateOf('auto-stopped')).toBe('suspended');
		expect(result.transitions).toHaveLength(1);
		expect(result.transitions[0]).toMatchObject({
			containerId: 'auto-stopped',
			projectId,
			oldStatus: 'running',
			newStatus: 'stopped',
		});
	});

	it('reports a nonzero exit as an error transition, not a clean stop', async () => {
		// The two are not interchangeable downstream: only a container_error run is
		// eligible to be requeued once the container is back.
		await seed('crashed', 'busy', 300);
		const result = await reconcile(engine([], [], { crashed: 137 }));
		expect(result.transitions[0]).toMatchObject({
			containerId: 'crashed',
			newStatus: 'error',
		});
	});

	// The container-side half of the credential-wedge cascade. A run holding a
	// container long enough for a managed backend's idle timer to stop it had its
	// claim released here, so the container was handed to whoever asked next - or
	// destroyed by the reclaim pass - while the run was still going to use it.
	it('leaves a stopped busy member claimed for the run still holding it', async () => {
		await seed('busy-stopped', 'busy', 300);
		const result = await reconcile(engine([], [], { 'busy-stopped': 0 }));

		expect(await stateOf('busy-stopped')).toBe('busy');
		// Still reported, so the pass that fails the runs on a dead container
		// still gets to do it - the claim is what must not move, not the news.
		expect(result.transitions).toHaveLength(1);
		expect(result.transitions[0]).toMatchObject({
			containerId: 'busy-stopped',
			newStatus: 'stopped',
		});
		const err = await db.query<{ last_error: string | null }>(
			'SELECT last_error FROM container_pool_members WHERE container_id = $1',
			['busy-stopped'],
		);
		expect(err.rows[0].last_error).toContain('Container stopped');
	});

	it('leaves an already-suspended member untouched', async () => {
		// Nothing changed, so there is nothing to report - and re-emitting would
		// fail runs for a container that stopped long ago.
		await seed('parked', 'suspended', 300);
		const result = await reconcile(engine([], [], { parked: 0 }));
		expect(result.transitions).toEqual([]);
		expect(await stateOf('parked')).toBe('suspended');
	});

	it('never judges a creating member as stopped', async () => {
		// A container still coming up legitimately reads not-running. Suspending it
		// here would strand the provision that is building it.
		await seed('coming-up', 'creating', 300);
		const result = await reconcile(engine([], [], { 'coming-up': 0 }));
		expect(result.transitions).toEqual([]);
		expect(await stateOf('coming-up')).toBe('creating');
	});

	it('checks a member at most once per interval', async () => {
		// Without this the 1 Hz sync tick inspects every member every second - a
		// control-plane round trip per container per second on a managed backend.
		await seed('throttled', 'idle', 300);
		let inspections = 0;
		const counting = {
			inspectContainer: async (id: string) => {
				inspections++;
				return {
					Id: id,
					State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
					Config: { Image: 'x' },
				};
			},
		} as unknown as Parameters<typeof reconcilePoolMembers>[0]['docker'];

		const deps = { db, docker: counting } as unknown as Parameters<typeof reconcilePoolMembers>[0];
		await reconcilePoolMembers(deps);
		await reconcilePoolMembers(deps);
		expect(inspections).toBe(1);
	});

	/**
	 * A container from before the allocation was recorded, or one adopted from
	 * outside the pool, has no `memory_bytes` - and the migration deliberately did
	 * not guess one from the setting. The backend still knows, so the reconcile
	 * pass asks it on a round trip it was making anyway.
	 */
	describe('backfilling an unrecorded allocation', () => {
		/** Engine reporting `memoryBytes` as its provisioned ceiling for every container. */
		const reporting = (memoryBytes: number | null) =>
			({
				inspectContainer: async (id: string) => ({
					Id: id,
					State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
					Config: { Image: 'x' },
					HostConfig: { MemoryBytes: memoryBytes },
				}),
			}) as unknown as Parameters<typeof reconcilePoolMembers>[0]['docker'];

		const memoryOf = async (containerId: string): Promise<number | null> => {
			const r = await db.query<{ memory_bytes: string | number | null }>(
				'SELECT memory_bytes FROM container_pool_members WHERE container_id = $1',
				[containerId],
			);
			const value = r.rows[0]?.memory_bytes;
			return value === null || value === undefined ? null : Number(value);
		};

		it('records what the backend says for a member that had no allocation', async () => {
			await seed('unrecorded', 'idle', 300);
			expect(await memoryOf('unrecorded')).toBeNull();

			await reconcile(reporting(4 * 1024 ** 3));
			expect(await memoryOf('unrecorded')).toBe(4 * 1024 ** 3);
		});

		it('leaves a recorded allocation alone', async () => {
			// The recorded figure is the guarantee that was asked for; a backend whose
			// unit is coarser reports the larger amount it rounded up to. Overwriting
			// would tell the ladder the container was built to a cap nobody set.
			await seed('recorded', 'idle', 300);
			await db.query(
				'UPDATE container_pool_members SET memory_bytes = $2 WHERE container_id = $1',
				['recorded', 1.5 * 1024 ** 3],
			);

			await reconcile(reporting(2 * 1024 ** 3));
			expect(await memoryOf('recorded')).toBe(1.5 * 1024 ** 3);
		});

		it('writes nothing when the backend cannot say', async () => {
			// Still unknown, so the ladder keeps recycling it on the next acquire -
			// which is the right answer for a container we cannot size.
			await seed('unanswered', 'idle', 300);

			await reconcile(reporting(null));
			expect(await memoryOf('unanswered')).toBeNull();
		});
	});
});

/**
 * The claim is the one-run-per-container rule being enforced, so what it refuses
 * matters as much as what it allows.
 */
describe('claimPoolMember', () => {
	let db: PgliteDb;
	let projectId: string;

	const seed = async (containerId: string, state: string) => {
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state)
			 VALUES ($1, $2, $3::container_pool_state)`,
			[projectId, containerId, state],
		);
	};

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const team = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('clm', 'clm') RETURNING id",
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'clm', 'clm', 'CLM') RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;
	});
	afterAll(() => db.close());
	beforeEach(() => db.query('DELETE FROM container_pool_members'));

	it('claims an idle member', async () => {
		await seed('free', 'idle');
		expect(await claimPoolMember(db, 'free', null)).toBe(true);
	});

	it('refuses a member another run already holds', async () => {
		await seed('taken', 'busy');
		expect(await claimPoolMember(db, 'taken', null)).toBe(false);
	});

	// `<> 'busy'` used to let these through, so a container the backend had just
	// stopped was handed straight to a run, which died on its first call against
	// a sandbox that was not up.
	it('refuses a suspended member rather than handing a run a stopped container', async () => {
		await seed('parked', 'suspended');
		expect(await claimPoolMember(db, 'parked', null)).toBe(false);
	});

	it('refuses a member whose provisioning failed', async () => {
		await seed('broken', 'error');
		expect(await claimPoolMember(db, 'broken', null)).toBe(false);
	});

	it('refuses a member that is still coming up', async () => {
		await seed('coming-up', 'creating');
		expect(await claimPoolMember(db, 'coming-up', null)).toBe(false);
	});
});

/**
 * The two leaks that used to cost a container until the next restart, or past it.
 *
 * Both are the same shape: a member left in a state that charges the instance
 * memory budget, describing work that has already ended, with nothing in the tree
 * that revisits it. What is asserted here is the budget consequence - that the
 * row stops being charged - not merely that a column changed.
 */
describe('reclaiming budget from members whose work has ended', () => {
	let db: PgliteDb;
	let projectId: string;

	const chargedContainers = async (): Promise<string[]> => {
		const r = await db.query<{ container_id: string }>(
			`SELECT container_id FROM container_pool_members
			  WHERE state IN ('creating', 'idle', 'busy')
			  ORDER BY container_id`,
		);
		return r.rows.map((x) => x.container_id);
	};

	const stateOf = async (containerId: string): Promise<string> => {
		const r = await db.query<{ state: string }>(
			'SELECT state::text AS state FROM container_pool_members WHERE container_id = $1',
			[containerId],
		);
		return r.rows[0].state;
	};

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const team = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('leak', 'leak') RETURNING id",
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'leak', 'leak', 'LK') RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;
	});
	afterAll(() => db.close());
	beforeEach(async () => {
		await db.query('DELETE FROM heartbeat_runs');
		await db.query('DELETE FROM container_pool_members');
	});

	describe('failInterruptedProvisions', () => {
		it('stops charging for a provision the restart interrupted', async () => {
			// A `creating` member is written the moment the engine returns an id and
			// promoted minutes later by the same call. That call cannot outlive the
			// process, so at boot the state describes a provision nobody is running -
			// and it was charged the full allocation for the life of the instance,
			// because nothing else in the tree looks at `creating` at all.
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, 'ctr-wedged', 'creating'), ($1, 'ctr-live', 'idle')`,
				[projectId],
			);
			expect(await chargedContainers()).toEqual(['ctr-live', 'ctr-wedged']);

			expect(await failInterruptedProvisions(db)).toEqual(['ctr-wedged']);

			expect(await chargedContainers()).toEqual(['ctr-live']);
			expect(await stateOf('ctr-wedged')).toBe('error');
		});

		it('records why, so the operator is not left reading an empty Failed row', async () => {
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, 'ctr-x', 'creating')`,
				[projectId],
			);
			await failInterruptedProvisions(db);
			const r = await db.query<{ last_error: string | null }>(
				'SELECT last_error FROM container_pool_members WHERE container_id = $1',
				['ctr-x'],
			);
			expect(r.rows[0].last_error).toBe(INTERRUPTED_PROVISION_ERROR);
		});

		it('leaves every other state alone', async () => {
			// Boot has its own pass for `busy`, and `suspended`/`error`/`idle` all
			// describe a container the pool has an accurate view of.
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, 'ctr-i', 'idle'), ($1, 'ctr-b', 'busy'),
				        ($1, 'ctr-s', 'suspended'), ($1, 'ctr-e', 'error')`,
				[projectId],
			);
			expect(await failInterruptedProvisions(db)).toEqual([]);
			expect(await stateOf('ctr-i')).toBe('idle');
			expect(await stateOf('ctr-b')).toBe('busy');
			expect(await stateOf('ctr-s')).toBe('suspended');
			expect(await stateOf('ctr-e')).toBe('error');
		});
	});

	describe('releaseClaimIfRunGone', () => {
		const seedRun = async (containerId: string, status: string): Promise<void> => {
			const member = await db.query<{ id: string; team_id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 SELECT team_id, 'agent'::member_type, 'a' FROM projects WHERE id = $1
				 RETURNING id, team_id`,
				[projectId],
			);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, status, container_id)
				 VALUES ($1, $2, $3::heartbeat_run_status, $4)`,
				[member.rows[0].team_id, member.rows[0].id, status, containerId],
			);
		};

		it('gives back a claim whose run has already ended', async () => {
			// The reconcile pass finds the container stopped and deliberately leaves
			// the claim for the run to return; `runAgent`'s teardown is the only other
			// thing that returns one, and it never fires for a run this process is no
			// longer executing. The member then read `busy` - and stayed charged -
			// until the next restart.
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, 'ctr-orphan', 'busy')`,
				[projectId],
			);
			await seedRun('ctr-orphan', 'failed');

			expect(await releaseClaimIfRunGone(db, 'ctr-orphan')).toBe(true);
			expect(await stateOf('ctr-orphan')).toBe('suspended');
			expect(await chargedContainers()).toEqual([]);
		});

		it('keeps the claim while a run is still running on it', async () => {
			// The whole reason the reconcile pass declines to release: doing it under
			// a live run hands its container to whoever asks next, and the run dies on
			// its next call against a sandbox that is gone.
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, 'ctr-live-run', 'busy')`,
				[projectId],
			);
			await seedRun('ctr-live-run', 'running');

			expect(await releaseClaimIfRunGone(db, 'ctr-live-run')).toBe(false);
			expect(await stateOf('ctr-live-run')).toBe('busy');
		});

		it('does not disturb a member that is not claimed', async () => {
			await db.query(
				`INSERT INTO container_pool_members (project_id, container_id, state)
				 VALUES ($1, 'ctr-idle', 'idle')`,
				[projectId],
			);
			expect(await releaseClaimIfRunGone(db, 'ctr-idle')).toBe(false);
			expect(await stateOf('ctr-idle')).toBe('idle');
		});
	});
});
