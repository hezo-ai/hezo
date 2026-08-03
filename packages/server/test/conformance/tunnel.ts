/**
 * The tunnel contract, for the part of a run that happens *after* readiness.
 *
 * `startRunTunnel` already refuses to return until the client's three loopback
 * ports are listening, and that check was the only defence the tunnel had. A
 * real CEO run on Daytona proved it is not enough: the tunnel bound (so the run
 * started), then died. The container stayed alive, so no `container_*`
 * transition fired; nothing in the run loop looked at the tunnel again; and the
 * agent burned a full max-effort budget with 25 built-in tools and none of
 * Hezo's, finishing as "produced no output" - which reads as a lazy model
 * rather than a dead transport.
 *
 * So this asserts the three properties a run actually depends on once it is
 * under way, and each maps to a defect that shipped:
 *
 * 1. the ports are not merely *bound* but **reachable end to end** - a
 *    connection made inside the container arrives at the host address the run
 *    was given;
 * 2. the channel **survives silence**, because it carries no bytes at all while
 *    the agent is thinking and an idle connection is exactly what an
 *    intermediary reaps;
 * 3. a death is **observable** - `onClosed` fires for an unrequested one and
 *    never for the caller's own teardown, since every run ends by closing it.
 *
 * These are properties of the *transport*, which is per backend, which is why
 * they belong here rather than in a unit test: Docker's exec channel and a
 * managed provider's PTY-over-WebSocket fail in different ways, and the second
 * one is the one that failed in production.
 */

import { createServer, type Server } from 'node:http';
import { type RunTunnel, startRunTunnel } from '../../src/services/sandbox/tunnel/run-tunnel';
import type { ContainerEngine } from '../../src/services/sandbox/types';
import {
	CONFORMANCE_LABEL,
	type ConformanceHarness,
	conformanceRunId,
	type LiveAdapterFixture,
	sweepConformanceContainers,
} from './fixture';

/**
 * How long the channel is left completely silent before it is used again.
 *
 * Longer than the adapter's own keepalive interval, so a keepalive that never
 * fires is what this catches. It is deliberately **not** claimed to reproduce a
 * real intermediary's idle timeout - those are usually 60s or more, and a suite
 * that waited that long on every backend would cost more than it is worth. What
 * it does prove is that silence itself does not break the channel, and that the
 * keepalive traffic does not corrupt the framed protocol riding the same pipe -
 * which is the failure a naive ping implementation would introduce.
 */
const IDLE_SECONDS = 25;

/**
 * How long the exec that runs *alongside* the tunnel lasts.
 *
 * Long enough that the two genuinely overlap - a backend that reaps the tunnel's
 * session when another exec starts, streams or finishes has to do it inside this
 * window - and short enough that the suite stays cheap. A real agent run holds
 * both open for minutes; this asserts the property, not the duration.
 */
const CONCURRENT_EXEC_SECONDS = 20;

/**
 * Size of the body the `/bulk` route answers with.
 *
 * Comfortably past the point where the reply stops fitting in one write, one
 * frame, or one buffer anywhere along the path, and in the range production
 * really moves: an MCP `tools/list` response for ~73 tools is tens of KB, and a
 * signed asset read is explicitly allowed to be multi-MB. 1 MiB is enough to
 * exercise every chunking boundary without making the suite slow.
 */
const BULK_BYTES = 1024 * 1024;
/** Printable, so a truncation shows up as a short count rather than as binary noise. */
const BULK_BODY = Buffer.alloc(BULK_BYTES, 'hezo-bulk-payload\n');

export function describeTunnelConformance(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	const engine: ContainerEngine = fixture.engine;

	describe(`${fixture.name}: run tunnel conformance`, () => {
		let containerId = '';
		let upstream: Server | undefined;
		let upstreamPort = 0;
		let hits: string[] = [];

		beforeAll(async () => {
			await sweepConformanceContainers(engine);

			// A plain HTTP server on host loopback, standing in for whatever the run
			// would really reach (the MCP endpoint). `curl` is in the agent image, so
			// the container side needs nothing installed - and an HTTP round trip
			// proves the whole path rather than just that a socket accepted.
			//
			// `/bulk` answers with a large body, because host-to-container is the
			// direction with real volume behind it and the one every other assertion
			// here leaves at nine bytes.
			upstream = createServer((req, res) => {
				const url = req.url ?? '';
				hits.push(url);
				if (url.startsWith('/bulk')) {
					res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
					res.end(BULK_BODY);
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end('tunnel-ok');
			});
			await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
			upstreamPort = (upstream?.address() as { port: number }).port;

			const created = await engine.createContainer(`hezo-conf-tunnel-${conformanceRunId()}`, {
				Image: fixture.image,
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);

			// Same posture as the egress suite: a precondition this suite cannot
			// satisfy is a failed run, never a quiet skip. A skip here would report
			// green while asserting nothing about the only path it exists for, and
			// the natural failure without it is a 30s "did not bind its ports" that
			// reads as a broken tunnel rather than a missing binary.
			const probe = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'command -v hezo-tunnel || echo MISSING'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			if ((await engine.execStart(probe)).stdout.includes('MISSING')) {
				throw new Error(
					`${fixture.name}: the image ${fixture.image} does not carry hezo-tunnel, so there is ` +
						'no container-to-host path to test. Point HEZO_CONFORMANCE_IMAGE at an image built ' +
						'from this branch (docker/Dockerfile.agent-base installs it).',
				);
			}
		}, 300_000);

		afterAll(async () => {
			if (upstream) await new Promise<void>((resolve) => upstream?.close(() => resolve()));
			await sweepConformanceContainers(engine);
		}, 120_000);

		/** A tunnel whose three targets all point at the host echo server. */
		async function openTunnel(label: string): Promise<RunTunnel> {
			const at = { host: '127.0.0.1', port: upstreamPort };
			return startRunTunnel({
				engine,
				containerId,
				runUser: { name: fixture.runUser, uid: 1000, gid: 1000 },
				files: engine.files(containerId, fixture.workRoot),
				configRelPath: `.hezo/tunnel/${label}.json`,
				configContainerPath: `${fixture.workRoot}/.hezo/tunnel/${label}.json`,
				// All three keyed at the same target: nothing here distinguishes them,
				// and a target must exist for the client to bind that port at all.
				addresses: { proxy: at, mcp: at, ssh: at },
				policy: { proxiedHosts: [], proxyEverything: false },
			});
		}

		/** The MCP leg's port, which `RunEndpoints` states as an origin URL. */
		function mcpPort(tunnel: RunTunnel): number {
			return Number(new URL(tunnel.endpoints.hezoBaseUrl).port);
		}

		/** `curl` the tunnel's own loopback port from inside the container. */
		async function curlThroughTunnel(port: number, path: string): Promise<string> {
			const exec = await engine.execCreate(containerId, {
				Cmd: [
					'sh',
					'-c',
					`curl -sS --max-time 20 -w '%{http_code}' http://127.0.0.1:${port}${path} || true`,
				],
				User: fixture.runUser,
				AttachStdout: true,
				AttachStderr: true,
			});
			const out = await engine.execStart(exec);
			return `${out.stdout}${out.stderr}`;
		}

		/** PIDs of the in-container tunnel client, read from `/proc` - the image has no `procps`. */
		async function tunnelPids(): Promise<string[]> {
			const exec = await engine.execCreate(containerId, {
				Cmd: [
					'sh',
					'-c',
					'for p in /proc/[0-9]*; do ' +
						'if grep -qa hezo-tunnel "$p/cmdline" 2>/dev/null; then echo "${p#/proc/}"; fi; ' +
						'done',
				],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			const out = await engine.execStart(exec);
			return out.stdout
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => /^\d+$/.test(l));
		}

		it('carries a connection made inside the container to the host address', async () => {
			// The property `waitForTunnelListeners` only approximates: it reads
			// `/proc/net/tcp` and concludes the port is bound, which is true of a
			// client that binds and then cannot forward a byte.
			hits = [];
			const tunnel = await openTunnel(`reach-${conformanceRunId()}`);
			try {
				const body = await curlThroughTunnel(mcpPort(tunnel), '/mcp-probe');
				expect(body).toContain('tunnel-ok');
				expect(body).toContain('200');
				expect(hits).toContain('/mcp-probe');
			} finally {
				tunnel.close();
			}
		}, 300_000);

		it('binds every target key, not just the one a test happens to use', async () => {
			// A run needs all three: MCP for tools, the proxy for egress, ssh for
			// git. Two of them failing silently is indistinguishable from a healthy
			// run until the agent reaches for one.
			hits = [];
			const tunnel = await openTunnel(`keys-${conformanceRunId()}`);
			try {
				for (const port of [
					mcpPort(tunnel),
					tunnel.endpoints.proxyPort,
					tunnel.endpoints.sshPort,
				]) {
					expect(await curlThroughTunnel(port, `/key-${port}`)).toContain('tunnel-ok');
				}
			} finally {
				tunnel.close();
			}
		}, 300_000);

		it('still carries traffic after the channel has been completely idle', async () => {
			// The transcript's most likely proximate cause. A coding CLI sends
			// nothing through the tunnel while it is thinking, and on a managed
			// backend the channel is a WebSocket - idle is precisely what gets
			// reaped, and neither end is told: the container keeps its listeners,
			// the host's multiplexer is gone, and the agent's next call hangs.
			hits = [];
			const tunnel = await openTunnel(`idle-${conformanceRunId()}`);
			try {
				expect(await curlThroughTunnel(mcpPort(tunnel), '/before')).toContain('tunnel-ok');
				await new Promise((r) => setTimeout(r, IDLE_SECONDS * 1000));
				expect(await curlThroughTunnel(mcpPort(tunnel), '/after')).toContain('tunnel-ok');
				expect(hits).toContain('/after');
			} finally {
				tunnel.close();
			}
		}, 300_000);

		it('carries a large response back into the container without dropping the channel', async () => {
			// The direction with real volume behind it, and the one every other
			// assertion here leaves at nine bytes. Production moves an MCP
			// `tools/list` catalogue (tens of KB for ~73 tools) through this within
			// seconds of a run starting, and signed asset reads that are allowed to be
			// multi-MB after that.
			//
			// The live agent-CLI run is what pointed here: `initialize` and
			// `tools/list` reached the host, and the tunnel died ~150ms later - i.e.
			// while the catalogue was on its way back. A small-response test cannot
			// see that, so the tunnel suite passed on the same backend a real run
			// could not get through.
			hits = [];
			const tunnel = await openTunnel(`bulk-${conformanceRunId()}`);
			const reasons: string[] = [];
			tunnel.onClosed((r) => reasons.push(r));
			try {
				// `wc -c` rather than the body itself: a byte count is the assertion,
				// and piping a megabyte through the exec transport would be testing
				// that instead of the tunnel.
				const exec = await engine.execCreate(containerId, {
					Cmd: [
						'sh',
						'-c',
						`curl -sS --max-time 60 http://127.0.0.1:${mcpPort(tunnel)}/bulk | wc -c`,
					],
					User: fixture.runUser,
					AttachStdout: true,
					AttachStderr: true,
				});
				const out = await engine.execStart(exec);
				expect(`${out.stdout}${out.stderr}`.trim()).toContain(String(BULK_BYTES));

				// Still alive afterwards, in both senses - a channel that delivered the
				// bytes and then died is exactly the failure this is chasing.
				expect(reasons).toEqual([]);
				expect(await curlThroughTunnel(mcpPort(tunnel), '/after-bulk')).toContain('tunnel-ok');
			} finally {
				tunnel.close();
			}
		}, 300_000);

		it('survives a long-running exec on the same container', async () => {
			// What a run actually looks like: the tunnel is open for the *whole* of
			// the agent's exec, and on a managed backend the two ride the same
			// per-sandbox session machinery rather than independent sockets. If
			// starting, streaming or reaping one tears the other down, the agent loses
			// its tools partway through and the only symptom is a run that did
			// nothing.
			//
			// Every other test here opens the tunnel and uses it within a second or
			// two, which is precisely the shape that would miss this.
			hits = [];
			const tunnel = await openTunnel(`exec-${conformanceRunId()}`);
			const reasons: string[] = [];
			tunnel.onClosed((r) => reasons.push(r));
			try {
				const exec = await engine.execCreate(containerId, {
					Cmd: [
						'sh',
						'-c',
						`for i in $(seq 1 ${CONCURRENT_EXEC_SECONDS}); do echo "tick $i"; sleep 1; done`,
					],
					User: fixture.runUser,
					AttachStdout: true,
					AttachStderr: true,
				});
				let chunks = 0;
				await engine.execStart(exec, {
					onChunk: () => {
						chunks += 1;
					},
				});
				expect(chunks).toBeGreaterThan(0);
				expect((await engine.execInspect(exec)).ExitCode).toBe(0);

				// Both halves matter: the tunnel must not have *reported* a death, and
				// it must still carry a connection. A backend could fail either without
				// the other - a silent death is the worse of the two, since that is the
				// one a run cannot react to.
				expect(reasons).toEqual([]);
				expect(await curlThroughTunnel(mcpPort(tunnel), '/after-exec')).toContain('tunnel-ok');
			} finally {
				tunnel.close();
			}
		}, 300_000);

		it('reports a client that dies underneath it', async () => {
			// The defect this whole suite exists for. `RunTunnel` used to be
			// `{endpoints, close()}` with no way for a caller to learn it had died,
			// so a run continued to completion with no route to Hezo.
			const tunnel = await openTunnel(`death-${conformanceRunId()}`);
			const reasons: string[] = [];
			tunnel.onClosed((r) => reasons.push(r));
			try {
				const pids = await tunnelPids();
				expect(pids.length).toBeGreaterThan(0);
				await engine.killPids(
					containerId,
					pids.map((p) => Number(p)),
				);

				// The channel's close has to propagate from the backend's transport,
				// which is the per-backend part: Docker's hijacked socket and a PTY
				// over a WebSocket learn about it by different means.
				const deadline = Date.now() + 60_000;
				while (reasons.length === 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 250));
				}
				expect(reasons.length).toBeGreaterThan(0);
			} finally {
				tunnel.close();
			}
		}, 300_000);

		it('stays silent when the caller closes it, which every run does', async () => {
			// The other half, and the one that would fail every healthy run if it
			// were wrong: a normal teardown must not look like a failure.
			const tunnel = await openTunnel(`quiet-${conformanceRunId()}`);
			const reasons: string[] = [];
			tunnel.onClosed((r) => reasons.push(r));

			tunnel.close();
			await new Promise((r) => setTimeout(r, 3_000));

			expect(reasons).toEqual([]);
		}, 300_000);

		it('surfaces the client’s stderr, which is the only legible failure signal', async () => {
			// `run-tunnel.ts` calls its stderr handler "the one place a tunnel problem
			// is legible rather than just a dead stream" - and on Daytona it was wired
			// to a no-op, with the real stream redirected to a file nothing drained.
			// A bind failure there went to a path no one read, leaving a 30s timeout
			// as the only signal and no statement of the cause.
			//
			// Provoked with a port that is already taken: the client reports
			// EADDRINUSE and exits, which is a real failure mode on a pooled
			// container rather than a synthetic one.
			const first = await openTunnel(`stderr-a-${conformanceRunId()}`);
			const lines: string[] = [];
			try {
				// A second client pointed at the first's ports cannot bind them.
				const config = JSON.stringify({
					ports: {
						proxy: first.endpoints.proxyPort,
						mcp: mcpPort(first),
						ssh: first.endpoints.sshPort,
					},
					policy: { proxiedHosts: [], proxyEverything: false },
				});
				const rel = `.hezo/tunnel/stderr-clash-${conformanceRunId()}.json`;
				await engine.files(containerId, fixture.workRoot).write(rel, config);

				const channel = await engine.openExecChannel(containerId, {
					Cmd: ['hezo-tunnel', `${fixture.workRoot}/${rel}`],
					User: fixture.runUser,
					AttachStdout: true,
					AttachStderr: true,
				});
				channel.onStderr((chunk) => lines.push(new TextDecoder().decode(chunk)));

				const deadline = Date.now() + 60_000;
				while (lines.join('').length === 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 250));
				}
				channel.close();

				expect(lines.join('')).toContain('hezo-tunnel');
			} finally {
				first.close();
			}
		}, 300_000);
	});
}
