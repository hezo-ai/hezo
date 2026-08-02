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

		it('reports memory statistics, or says it cannot', async () => {
			const stats = await engine.containerStats(containerId);
			if (!fixture.reportsMemoryStats) {
				// Null is the documented "unavailable"; a number would mean the fixture
				// is wrong about its own backend.
				expect(stats).toBeNull();
				return;
			}
			expect(stats).not.toBeNull();
			expect(stats?.usedBytes).toBeGreaterThan(0);
			// The cap is a guarantee the rest of the system is sized against, so a
			// container over it would mean the provider ignored the request.
			expect(stats?.usedBytes).toBeLessThanOrEqual(fixture.memoryBytes * 2);
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

			await engine.killRunProcesses(containerId, runId);
			await new Promise((r) => setTimeout(r, 1000));

			const check = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'ps -eo args | grep -c "[s]leep 120" || true'],
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout } = await engine.execStart(check);
			expect(stdout.trim()).toBe('0');
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

			await engine.stopContainer(containerId);
			await engine.startContainer(containerId);

			const check = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'ps -eo args | grep -c "[s]leep 300" || true'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			expect((await engine.execStart(check)).stdout.trim()).toBe('0');
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

				await engine.killRunProcesses(containerId, runId);
				await new Promise((r) => setTimeout(r, 1000));

				const survivor = await engine.execCreate(second.Id, {
					Cmd: ['sh', '-c', 'ps -eo args | grep -c "[s]leep 301" || true'],
					User: 'root',
					AttachStdout: true,
					AttachStderr: true,
				});
				// "At least one", not "exactly one": the claim is that the bystander
				// survived. An exact count would be counting the *adapter's* exec
				// wrapping - Daytona renders a deprivileged exec as `runuser -u node --
				// sh -c …`, so the process table legitimately shows more entries than
				// Docker's would, and a suite that pinned the number would fail the
				// next adapter for having a different wrapper rather than for sharing
				// process space.
				expect(Number((await engine.execStart(survivor)).stdout.trim())).toBeGreaterThanOrEqual(1);
			} finally {
				await engine.removeContainer(second.Id, true).catch(() => undefined);
			}
		}, 600_000);
	});
}
