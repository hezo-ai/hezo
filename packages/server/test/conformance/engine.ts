/**
 * `ContainerEngine` conformance: the assertions every backend must satisfy,
 * run against a real one.
 *
 * Scoped to what the *interface* promises, not to what any implementation does.
 * Where a promise is deliberately optional (disk usage, memory statistics), the
 * fixture says so and the suite states the alternative rather than skipping in
 * silence - a dropped assertion nobody can see is indistinguishable from one
 * that never existed.
 */

import {
	buildAnyPortListeningScript,
	buildKillPidsScript,
	buildKillTunnelClientsScript,
	buildMemoryUsageScript,
	buildPortsListeningScript,
	parseCgroupMemory,
} from '../../src/services/sandbox/proc-scripts';
import type { ContainerEngine } from '../../src/services/sandbox/types';
import {
	CONFORMANCE_LABEL,
	type ConformanceHarness,
	conformanceRunId,
	type LiveAdapterFixture,
	sweepConformanceContainers,
} from './fixture';

/** Registers the engine conformance suite for one backend. */
export function describeEngineConformance(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	describe(`${fixture.name}: ContainerEngine conformance`, () => {
		const engine: ContainerEngine = fixture.engine;
		let containerId: string;

		beforeAll(async () => {
			// A leaked container from a crashed earlier run bills until somebody
			// notices it, so the sweep runs on the way in as well as out.
			await sweepConformanceContainers(engine);
			const created = await engine.createContainer(`hezo-conf-${conformanceRunId()}`, {
				Image: fixture.image,
				// PID 1 has to outlive the execs, exactly as production sets it
				// (`containers.ts`). Without it the container runs the image's default
				// command, exits immediately, and every assertion below fails on a dead
				// container rather than on the thing it was testing.
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);
			// The disk assertion below measures this path, and a path that does not
			// exist is unanswerable rather than empty - so it has to exist before the
			// suite can tell "the backend cannot measure" from "there is nothing here
			// yet". The distinction is the whole point of that assertion.
			await engine.files(containerId, fixture.workRoot).mkdir('.');
		}, 300_000);

		afterAll(async () => {
			await sweepConformanceContainers(engine);
		}, 120_000);

		it('reports the backend reachable', async () => {
			expect(await engine.ping()).toBe(true);
		});

		it('inspects the container as running, with an id that round-trips', async () => {
			const info = await engine.inspectContainer(containerId);
			expect(info).not.toBeNull();
			expect(info?.Id).toBe(containerId);
			expect(info?.State.Running).toBe(true);
			// A transitional state must never read as dead: the pool treats "not
			// running" as a container to replace, so a provider that reports
			// `starting` as stopped would churn a container per run.
			expect(info?.State.Status).not.toBe('exited');
		});

		it('finds the container by the label it was created with', async () => {
			const found = await engine.listContainersByLabel(CONFORMANCE_LABEL);
			expect(found.map((c) => c.Id)).toContain(containerId);
		});

		it('answers null for a container that does not exist', async () => {
			// Null rather than a throw: the orphan sweep and the pool both ask about
			// containers that may have been removed underneath them.
			expect(await engine.inspectContainer('hezo-conf-definitely-not-here')).toBeNull();
		});

		it('runs the exec triad and returns the command output', async () => {
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'echo conformance-stdout'],
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout } = await engine.execStart(execId);
			expect(stdout).toContain('conformance-stdout');
			expect((await engine.execInspect(execId)).ExitCode).toBe(0);
		});

		it('propagates a non-zero exit code rather than reporting success', async () => {
			// The whole failure-reporting chain hangs off this: a run whose command
			// failed but whose exec reads 0 completes as a success that did nothing.
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'exit 7'],
				AttachStdout: true,
				AttachStderr: true,
			});
			await engine.execStart(execId);
			expect((await engine.execInspect(execId)).ExitCode).toBe(7);
		});

		it('separates or merges the streams, but never loses stderr', async () => {
			// A provider whose exec API merges the two is conforming - what is not
			// conforming is dropping stderr, since that is where a failing command
			// says why.
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'echo to-err 1>&2'],
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout, stderr } = await engine.execStart(execId);
			expect(`${stdout}${stderr}`).toContain('to-err');
		});

		it('streams output chunk by chunk rather than only at the end', async () => {
			const chunks: string[] = [];
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'echo one; sleep 1; echo two'],
				AttachStdout: true,
				AttachStderr: true,
			});
			await engine.execStart(execId, { onChunk: (c) => void chunks.push(c.text) });
			const joined = chunks.join('');
			expect(joined).toContain('one');
			expect(joined).toContain('two');
		}, 60_000);

		it('honours the environment it was given', async () => {
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'echo "[$HEZO_CONF_VAR]"'],
				Env: ['HEZO_CONF_VAR=set-by-conformance'],
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout } = await engine.execStart(execId);
			expect(stdout).toContain('[set-by-conformance]');
		});

		it('runs as the requested user, and as root when elevated', async () => {
			if (!fixture.honoursExecUser) {
				// Stated, not skipped: a backend that cannot choose the identity means
				// every exec runs as whatever it defaults to, which the callers that
				// pass `User` are entitled to know is not happening.
				console.warn(`${fixture.name}: no per-exec user; identity assertions dropped`);
				return;
			}
			const asUser = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'id -un'],
				User: fixture.runUser,
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(asUser)).stdout).toContain(fixture.runUser);

			const asRoot = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'id -un'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(asRoot)).stdout).toContain('root');
		});

		it('reports memory statistics', async () => {
			// Unconditional, unlike the disk assertion below: `containerStats` is what
			// the memory cap is enforced on, so a backend that cannot answer has
			// turned the cap into a number nothing checks. There is deliberately no
			// fixture flag making this optional - an adapter with no usable control
			// plane runs the shared cgroup script instead.
			const stats = await engine.containerStats(containerId);
			expect(stats).not.toBeNull();
			expect(stats?.usedBytes).toBeGreaterThan(0);
			// The cap is a guarantee the rest of the system is sized against, so a
			// container over it would mean the provider ignored the request.
			expect(stats?.usedBytes).toBeLessThanOrEqual(fixture.memoryBytes * 2);
		});

		/**
		 * The shared cgroup reading, against a real container's real cgroup.
		 *
		 * `enforceContainerMemoryLimit` compares one threshold against whatever each
		 * backend answers, so the answers have to be the same *quantity* - and an
		 * engine free to source its reading differently (a daemon endpoint here, this
		 * script on a managed sandbox) is exactly where two plausible-but-different
		 * numbers come from. Running both against one container is the only place
		 * that can be shown rather than asserted in a comment.
		 *
		 * It also gives the script itself live coverage on the backend that runs in
		 * CI. Without this it is exercised only by the billable managed leg, which is
		 * manual - so a cgroup layout change or a shell portability bug would ship.
		 */
		it('measures memory from the cgroup, agreeing with the engine’s own reading', async () => {
			const exec = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', buildMemoryUsageScript()],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			const fromScript = parseCgroupMemory((await engine.execStart(exec)).stdout);

			// Not null: the container was created with a memory limit, so the guard
			// that suppresses a host-cgroup reading must not have fired.
			expect(fromScript).not.toBeNull();
			expect(fromScript?.usedBytes).toBeGreaterThan(0);

			const fromEngine = await engine.containerStats(containerId);
			// Same order of magnitude rather than equal: the two readings are taken
			// moments apart on a live container, and the working set genuinely moves
			// between them. What would fail here is a units error or a different
			// accounting (charging the host's memory, or not discounting page cache),
			// which is what this is for.
			const ratio =
				(fromScript as { usedBytes: number }).usedBytes /
				(fromEngine as { usedBytes: number }).usedBytes;
			expect(ratio).toBeGreaterThan(0.5);
			expect(ratio).toBeLessThan(2);
		});

		it('reports disk usage, or answers null rather than zero', async () => {
			const used = await engine.diskUsedBytes(containerId, fixture.workRoot);
			if (!fixture.reportsDiskUsage) {
				// Null is not zero. An unanswerable measurement must leave the last
				// known figure alone; reporting an empty disk would make the pool's
				// recycle rung assert the opposite of what it guards.
				expect(used).toBeNull();
				return;
			}
			expect(used).not.toBeNull();
			expect(used as number).toBeGreaterThan(0);
		});

		it('answers null for a path it cannot measure, never zero', async () => {
			// Null is not zero. The pool retires a member that has filled its disk, so
			// an unanswerable measurement reported as 0 would assert the opposite of
			// what the rung guards and keep handing out a full container.
			expect(await engine.diskUsedBytes(containerId, '/no/such/path/here')).toBeNull();
		});

		it('reports where its containers draw memory from', () => {
			const memory = engine.containerHostMemory();
			// Either answer is conforming; what is not is a zero, which would compute
			// a budget that fits nothing.
			if (memory !== null) {
				expect(memory.totalRamBytes).toBeGreaterThan(0);
			}
		});

		/**
		 * How many processes in `target` have `needle` in their command line.
		 *
		 * Scans `/proc` the way production's own scripts do (`proc-scripts.ts`)
		 * rather than shelling out to `ps`, and that is not a style choice: the
		 * agent image installs no `procps`, so `ps` does not exist in it. A `ps`
		 * pipeline therefore prints nothing, `grep -c` counts zero, and `|| true`
		 * swallows the "not found" - which means every assertion of the form
		 * "expect 0 processes" passed whether or not the kill did anything. CI
		 * surfaced it only when an assertion finally demanded a *positive* count.
		 *
		 * Pass the needle in `[n]eedle` form so the scan cannot count the grep
		 * process reading it, whose own cmdline contains the pattern.
		 */
		async function countProcesses(target: string, needle: string): Promise<number> {
			const exec = await engine.execCreate(target, {
				Cmd: [
					'sh',
					'-c',
					`n=0; for d in /proc/[0-9]*; do tr "\\0" " " < "$d/cmdline" 2>/dev/null | grep -q "${needle}" && n=$((n+1)); done; echo $n`,
				],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			return Number((await engine.execStart(exec)).stdout.trim());
		}

		/**
		 * The `/proc` scripts, run where they actually run.
		 *
		 * They are pure strings built on the host, so it is tempting to execute
		 * them there - and `sandbox-proc-scripts.test.ts` does, for fast feedback.
		 * But they read `/proc`, which only Linux has: on a macOS dev box the
		 * port probe's `grep` fails on a missing file and the kill loop's
		 * `/proc/[0-9]*` glob matches nothing, so both degrade to silence and the
		 * assertions that expect silence pass while asserting nothing at all.
		 *
		 * A container is Linux on every backend, so this is the version that
		 * cannot pass vacuously - and running it per backend is the point, since
		 * both engines are required to run the identical script and only this
		 * proves each one's transport carries it intact.
		 */
		it('runs the /proc port and kill scripts against a real container', async () => {
			const sh = async (script: string): Promise<string> => {
				const exec = await engine.execCreate(containerId, {
					Cmd: ['sh', '-c', script],
					User: 'root',
					AttachStdout: true,
					AttachStderr: true,
				});
				const { stdout } = await engine.execStart(exec);
				return stdout.trim();
			};

			// Ports nothing binds, so silence here is a real answer rather than the
			// absence of `/proc`.
			const free = [59991, 59992, 59993];
			expect(await sh(buildAnyPortListeningScript(free))).toBe('');
			expect(await sh(buildPortsListeningScript(free))).toBe('');

			// Bound with node rather than a networking tool, because node is the one
			// thing the agent image is guaranteed to carry - the image installs no
			// `procps` and cannot be assumed to carry `nc` either. Anything
			// conditional on a tool being present would make these assertions skip
			// themselves, which is the failure this whole test exists to correct.
			const port = 59994;
			const listenerPid = Number(
				await sh(
					`nohup node -e 'require("net").createServer().listen(${port},"127.0.0.1")' ` +
						'>/dev/null 2>&1 & echo $!',
				),
			);
			expect(listenerPid).toBeGreaterThan(1);
			await new Promise((r) => setTimeout(r, 1_000));

			try {
				// The two probes are inverses on the same set: "any taken" is not
				// "all ready".
				expect(await sh(buildAnyPortListeningScript([port]))).toBe('busy');
				expect(await sh(buildAnyPortListeningScript([59991, port, 59993]))).toBe('busy');
				expect(await sh(buildPortsListeningScript([59991, port, 59993]))).toBe('');
				expect(await sh(buildPortsListeningScript([port]))).toBe('ready');
			} finally {
				await sh(buildKillPidsScript([listenerPid]));
			}

			// The kill script must not end the shell running it: `sh -c <script>`
			// puts the script's own text - which contains the client's name - into
			// that shell's cmdline, so a whole-cmdline match dies on its first
			// iteration and sweeps nothing after it. Only argv[1] counts.
			expect(await sh(`${buildKillTunnelClientsScript()}; echo survived`)).toContain('survived');

			// A stand-in whose argv[1] basename is the client's, which is the only
			// thing the sweep matches on. The real binary would exit immediately
			// without a config and prove nothing about the kill.
			await sh(
				`printf 'setTimeout(function(){},60000);\\n' > /tmp/hezo-tunnel; ` +
					'nohup node /tmp/hezo-tunnel /tmp/cfg.json >/dev/null 2>&1 & sleep 1',
			);
			expect(await countProcesses(containerId, '[h]ezo-tunnel')).toBeGreaterThan(0);
			await sh(buildKillTunnelClientsScript());
			expect(await countProcesses(containerId, '[h]ezo-tunnel')).toBe(0);
		}, 180_000);

		it('lists and kills processes it started, by run marker', async () => {
			const runId = `conf-${conformanceRunId()}`;
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'sleep 120'],
				Env: [`HEZO_HEARTBEAT_RUN_ID=${runId}`],
				AttachStdout: true,
				AttachStderr: true,
			});
			// Not awaited: the point is that it is still running while we look for it.
			void engine.execStart(execId).catch(() => undefined);
			await new Promise((r) => setTimeout(r, 2000));

			// Asserted *before* the kill, because "no such process" and "the kill
			// worked" produce the same zero. Without this the test passes on a
			// backend whose exec never started anything at all.
			expect(await countProcesses(containerId, '[s]leep 120')).toBeGreaterThanOrEqual(1);

			await engine.killRunProcesses(containerId, runId);
			await new Promise((r) => setTimeout(r, 1000));

			expect(await countProcesses(containerId, '[s]leep 120')).toBe(0);
		}, 90_000);

		it('stops and restarts the container without losing its filesystem', async () => {
			// Suspend-and-resume is the pool's whole lifecycle: a backend that
			// discards the filesystem on stop cannot hold a suspended member, and the
			// recovery vault that depends on it becomes a promise it cannot keep.
			const marker = `${fixture.workRoot}/.hezo-conformance-survives`;
			const write = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', `mkdir -p ${fixture.workRoot} && echo kept > ${marker}`],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			await engine.execStart(write);

			await engine.stopContainer(containerId);
			await engine.startContainer(containerId);

			const read = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', `cat ${marker}`],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(read)).stdout).toContain('kept');
		}, 300_000);

		it('comes back from a stop with no processes from before it', async () => {
			// The other half of suspend, and the half a filesystem check cannot see.
			// A resumed pool member is handed to a *new* run, so a backend whose stop
			// merely pauses would return it carrying the previous run's process tree -
			// the agent CLI, its children, a dev server holding a port. Providers
			// really do offer both (Daytona has `stopped` *and* `paused`), so which
			// one `stopContainer` maps to is a per-adapter decision this pins.
			//
			// It is also why `chat-session-manager` keeps a marker reap as a backstop
			// on resume: that backstop exists because this property was assumed rather
			// than asserted.
			const spawn = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'sleep 300'],
				AttachStdout: true,
				AttachStderr: true,
			});
			void engine.execStart(spawn).catch(() => undefined);
			await new Promise((r) => setTimeout(r, 2000));
			// Same reason as the marker-kill test: a zero afterwards means nothing
			// unless there was something to clear.
			expect(await countProcesses(containerId, '[s]leep 300')).toBeGreaterThanOrEqual(1);

			await engine.stopContainer(containerId);
			await engine.startContainer(containerId);

			expect(await countProcesses(containerId, '[s]leep 300')).toBe(0);
		}, 300_000);

		it('carries a large stream incrementally and intact', async () => {
			// The run-log path in miniature. Raw stream-json from a coding CLI reaches
			// hundreds of MB, and the contract is that it is consumed incrementally
			// and *never retained* - so a transport that buffers to completion is not
			// slow, it is a memory bug that only appears on a long run.
			//
			// Asserted on volume rather than on a couple of lines because buffering is
			// invisible at small sizes: a relay that accumulated the whole body looked
			// perfectly incremental until the payload was big enough to matter.
			const lines = 20_000;
			const exec = await engine.execCreate(containerId, {
				Cmd: [
					'sh',
					'-c',
					`i=0; while [ $i -lt ${lines} ]; do echo "line-$i-padding-payload"; i=$((i+1)); done`,
				],
				AttachStdout: true,
				AttachStderr: true,
			});
			let chunks = 0;
			let bytes = 0;
			let sawFirstLine = false;
			let sawLastLine = false;
			await engine.execStart(exec, {
				onChunk: (chunk) => {
					chunks += 1;
					bytes += chunk.text.length;
					if (chunk.text.includes('line-0-')) sawFirstLine = true;
					if (chunk.text.includes(`line-${lines - 1}-`)) sawLastLine = true;
				},
			});
			// Arrived in pieces, not as one buffered blob.
			expect(chunks).toBeGreaterThan(1);
			// And nothing was dropped between the first line and the last.
			expect(sawFirstLine).toBe(true);
			expect(sawLastLine).toBe(true);
			expect(bytes).toBeGreaterThan(lines * 10);
		}, 300_000);

		it('gives a second container its own filesystem and process space', async () => {
			// The premise the whole pool rests on. `selectPoolMember` decides *which*
			// container a run gets and is pure, so it is unit-tested - but "two
			// containers are genuinely independent" is a property of the backend, and
			// the pool's headline promise (one greedy run can no longer take down its
			// siblings) is worth nothing if a provider shares state between sandboxes.
			//
			// Worth the second container it costs: this is the one assertion that
			// fails if a backend turns out to hand out views of one machine.
			const second = await engine.createContainer(`hezo-conf-pool-${conformanceRunId()}`, {
				Image: fixture.image,
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			await engine.startContainer(second.Id);
			try {
				const marker = '/tmp/hezo-conformance-isolation';
				const write = await engine.execCreate(containerId, {
					Cmd: ['sh', '-c', `echo first > ${marker}`],
					User: 'root',
					AttachStdout: true,
					AttachStderr: true,
				});
				await engine.execStart(write);

				// Not visible next door: separate writable layers.
				const peek = await engine.execCreate(second.Id, {
					Cmd: ['sh', '-c', `cat ${marker} 2>/dev/null || echo ABSENT`],
					User: 'root',
					AttachStdout: true,
					AttachStderr: true,
				});
				expect((await engine.execStart(peek)).stdout).toContain('ABSENT');

				// And a marker kill aimed at one leaves the other's processes alone,
				// which is the sibling-safety claim stated directly.
				const runId = `conf-iso-${conformanceRunId()}`;
				const victim = await engine.execCreate(containerId, {
					Cmd: ['sh', '-c', 'sleep 300'],
					Env: [`HEZO_HEARTBEAT_RUN_ID=${runId}`],
					AttachStdout: true,
					AttachStderr: true,
				});
				const bystander = await engine.execCreate(second.Id, {
					Cmd: ['sh', '-c', 'sleep 301'],
					Env: [`HEZO_HEARTBEAT_RUN_ID=${runId}`],
					AttachStdout: true,
					AttachStderr: true,
				});
				void engine.execStart(victim).catch(() => undefined);
				void engine.execStart(bystander).catch(() => undefined);
				await new Promise((r) => setTimeout(r, 2000));
				// Both alive before the kill, so a failure below distinguishes "the kill
				// crossed containers" from "the exec never started".
				expect(await countProcesses(containerId, '[s]leep 300')).toBeGreaterThanOrEqual(1);
				expect(await countProcesses(second.Id, '[s]leep 301')).toBeGreaterThanOrEqual(1);

				await engine.killRunProcesses(containerId, runId);
				await new Promise((r) => setTimeout(r, 1000));

				expect(await countProcesses(containerId, '[s]leep 300')).toBe(0);
				// "At least one", not "exactly one": the claim is that the bystander
				// survived. An exact count would be counting the *adapter's* exec wrapping -
				// Daytona renders a deprivileged exec as `runuser -u node -- sh -c …`, so the
				// process table legitimately shows more entries than Docker's would, and a
				// suite that pinned the number would fail the next adapter for having a
				// different wrapper rather than for sharing process space.
				expect(await countProcesses(second.Id, '[s]leep 301')).toBeGreaterThanOrEqual(1);
			} finally {
				await engine.removeContainer(second.Id, true).catch(() => undefined);
			}
		}, 600_000);
	});
}
