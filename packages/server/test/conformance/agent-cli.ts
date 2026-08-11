/**
 * A real coding-CLI run, inside a real container, against a real model provider,
 * **with a real tunnel back to a real Hezo**.
 *
 * The engine and files suites prove a backend can create a sandbox, exec in it
 * and move bytes. None of that answers the question an operator actually has:
 * *can an agent run there*. That depends on things only the live combination
 * exercises - the image really carries the CLI, the sandbox can reach the
 * provider's endpoint, the exec transport carries a long-lived streaming
 * stdout without truncating or reordering it, the prompt arrives on the channel
 * the runtime expects, the CLI reports token usage the pricing table can charge
 * against, and - the part this suite used to skip - **the agent gets its Hezo
 * tools**. A fake provider answers none of them, which is why this suite is
 * opt-in on a real key rather than part of the default run.
 *
 * **Why the MCP half is here and not in a unit test.** A live CEO run on Daytona
 * finished as "produced no output" after burning a whole max-effort budget: its
 * tunnel had died, the Hezo MCP server never connected, and the agent spent the
 * run with 25 Claude Code built-ins and none of Hezo's ~73 tools. Every piece of
 * that is real infrastructure - a per-run tunnel, an MCP client inside the
 * container, an agent JWT, an HTTP server on the host - so the only place the
 * whole chain can be asserted is against a live backend. `tools=25` in the
 * session line was the sole tell, and nothing looked at it.
 *
 * **The invocation is assembled from the production tables**
 * (`PROVIDER_RUNTIME_ADAPTERS`, `RUNTIME_COMMANDS`, the arg tables in
 * `@hezo/shared`) and from the production MCP injector, never hand-written here.
 * A suite that spelled out its own flags or its own `--mcp-config` would keep
 * passing after the runner changed how it invokes the CLI, which is the one
 * failure it exists to catch. It also means a second provider is a fixture field
 * rather than a second suite - the same rule the rest of `test/conformance/`
 * follows.
 *
 * Cost: one short completion per run, on whatever model the fixture pins (pick
 * the provider's cheapest). It is opt-in for the same reason the Daytona suites
 * are - see `test/live/`.
 *
 * **`HEZO_CONFORMANCE_DUMP=<dir>` writes the raw evidence** - the transcript, the
 * log the production parser rendered from it, and a `meta.json` carrying the exit
 * code, the MCP methods that reached the host and a phase timeline. A live run
 * costs a sandbox and a completion to reproduce, and the questions it raises are
 * usually about ordering ("the tunnel carried the handshake and was gone by the
 * end - which step killed it?"), so recording that once beats paying again to
 * find out. It is what located the PTY message-size limit.
 */

import { rmSync } from 'node:fs';
import { relative } from 'node:path';
import {
	AgentRuntime,
	AiAuthMethod,
	CEO_AGENT_SLUG,
	claudeCodeModelArg,
	PROVIDER_RUNTIME_ADAPTERS,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_DISALLOWED_TOOLS_ARGS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_PROMPT_DELIVERY,
	RUNTIME_STREAM_ARGS,
} from '@hezo/shared';
import { createAgentStreamParser } from '../../src/services/agent-stream-parser';
import { type ContainerRunUser, chownToRunUser } from '../../src/services/container-user';
import {
	HEZO_MCP_SERVER_NAME,
	MCP_ADAPTERS,
	type McpDescriptor,
	validateInjection,
} from '../../src/services/mcp-injectors';
import {
	ensureRuntimeHomeDir,
	getHostSubscriptionBase,
	type RuntimeHomeMount,
	SUBSCRIPTION_DIR_MODE,
	subscriptionFiles,
} from '../../src/services/runtime-home';
import { type RunTunnel, startRunTunnel } from '../../src/services/sandbox/tunnel/run-tunnel';
import type { ContainerEngine, ExecLogChunk } from '../../src/services/sandbox/types';
import { safeClose } from '../helpers';
import { createTestApp, mintAgentToken } from '../helpers/app';
import { type ObservedRequest, type ServedTestApp, serveTestApp } from '../helpers/context';
import {
	CONFORMANCE_LABEL,
	type ConformanceHarness,
	conformanceRunId,
	type LiveAdapterFixture,
	type LiveModelProvider,
	sweepConformanceContainers,
} from './fixture';

/**
 * The word the prompt asks for back. Distinctive enough that finding it in the
 * transcript cannot be a coincidence, and short enough that a small model
 * reproduces it exactly.
 */
const SENTINEL = 'HEZO-LIVE-OK';
/**
 * The Hezo tool the run is told to call. Read-only, needs no arguments, and an
 * agent JWT resolves it to that run's own project - so it proves the round trip
 * without depending on anything the fixture had to set up.
 */
const HEZO_PROBE_TOOL = 'list_projects';
/**
 * The prompt asks for a **tool call**, and it has to.
 *
 * The obvious cheaper assertion - read the runtime's startup report and check
 * the Hezo tools are listed - does not work on Claude Code 2.1.220: MCP servers
 * connect asynchronously *after* the `init` event, so init lists the built-ins
 * only and reports the server as `pending`. Measured, not assumed. The only
 * thing that proves an agent really got its tools is an agent really using one,
 * and the evidence for it is host-side (a `tools/call` arriving) rather than
 * anything the model says about itself.
 */
const PROMPT =
	`Call the \`mcp__${HEZO_MCP_SERVER_NAME}__${HEZO_PROBE_TOOL}\` tool once, then reply with ` +
	`exactly ${SENTINEL} and nothing else.`;
/** Where the prompt file lands, mirroring the runner's own per-run prompt file. */
const PROMPT_FILE = 'live-cli-prompt.txt';

/**
 * Which runtimes state, in their own event stream, whether each configured MCP
 * server connected.
 *
 * Claude Code states it once, in `init`. That report can only ever rule a server
 * *out*, never in - it fires before the servers have connected, so a healthy run
 * says `pending` and nothing restates it later - which is why the parser reads it
 * for failures only and why the assertion here is that it does not fail a healthy
 * run. The other runtimes report nothing of the kind today, so for them the
 * host-side evidence is the whole story. A full `Record`, so a new runtime is a
 * compile error here rather than a silently-unasserted one.
 */
const RUNTIME_REPORTS_MCP_STATUS: Record<AgentRuntime, boolean> = {
	[AgentRuntime.ClaudeCode]: true,
	[AgentRuntime.Codex]: false,
	[AgentRuntime.Gemini]: false,
	[AgentRuntime.OpenCode]: false,
	[AgentRuntime.Grok]: false,
	[AgentRuntime.Kimi]: false,
	// Prime Agent reports no MCP connection status either — and could not usefully:
	// its servers are Python skills imported inside the kernel, so a server is only
	// contacted when the model actually calls one, not at session start.
	[AgentRuntime.PrimeAgent]: false,
};

/**
 * Single-quote for `sh -c`, the same way the runner's exec wrapper has to.
 * Nothing here is attacker-controlled, but a path with a space would silently
 * split into two arguments and the failure would read as "the CLI is missing".
 */
function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Every JSON line of a stream-json transcript, parsed. */
function jsonEvents(transcript: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const line of transcript.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			out.push(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			// A line that does not parse is itself a finding - the "well-formed
			// transcript" assertion below is where it is reported, so skip it here
			// rather than throwing out of a helper three tests share.
		}
	}
	return out;
}

/**
 * Environment for the run, built the way `buildProviderEnv` builds it: the
 * adapter's `staticEnv` (which is where an Anthropic-compatible provider's
 * `ANTHROPIC_BASE_URL` and model defaults live), then the credential under the
 * variable that provider's auth method names.
 */
function providerEnv(mp: LiveModelProvider): string[] {
	const adapter = PROVIDER_RUNTIME_ADAPTERS[mp.provider];
	const env = Object.entries(adapter.staticEnv ?? {}).map(([k, v]) => `${k}=${v}`);
	const varName = adapter.credentialEnvByAuthMethod[AiAuthMethod.ApiKey];
	if (!varName) throw new Error(`${mp.provider} has no api-key credential variable`);
	env.push(`${varName}=${mp.apiKey}`);
	// Claude Code prefers ANTHROPIC_API_KEY when both are present, so an inherited
	// one would be sent to the wrong endpoint. The runner blanks it; so do we.
	if (adapter.runtime === AgentRuntime.ClaudeCode) env.push('ANTHROPIC_API_KEY=');
	env.push('HOME=/home/node', 'CI=1');
	return env;
}

/**
 * The argv the runner would build for this runtime, in the runner's own order -
 * including the MCP injection, which is where `--mcp-config` and `--settings`
 * come from. Mirrors `buildRuntimeInvocation`'s `cmd`, minus the effort args.
 */
function cliArgv(mp: LiveModelProvider, mcpArgs: readonly string[]): string[] {
	const runtime = PROVIDER_RUNTIME_ADAPTERS[mp.provider].runtime;
	const model = mp.model ? claudeCodeModelArg(mp.provider, mp.model) : null;
	return [
		RUNTIME_COMMANDS[runtime],
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtime],
		...mcpArgs,
		...RUNTIME_STREAM_ARGS[runtime],
		...RUNTIME_AUTO_APPROVE_ARGS[runtime],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtime],
		...(model ? ['--model', model] : []),
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtime],
	];
}

/** The built-in tool names this runtime is launched with withheld. */
function disallowedToolNames(runtime: AgentRuntime): string[] {
	return RUNTIME_DISALLOWED_TOOLS_ARGS[runtime].filter((a) => !a.startsWith('-'));
}

/**
 * What one request body asked the MCP server to do (a batch may ask several
 * things).
 *
 * A `tools/call` is additionally recorded as `tools/call:<tool>`, because "the
 * client connected" and "the agent used a Hezo tool" are different claims and
 * only the second one proves the tools reached the model.
 */
function jsonRpcMethods(body: string): string[] {
	try {
		const parsed = JSON.parse(body) as unknown;
		const items = Array.isArray(parsed) ? parsed : [parsed];
		const out: string[] = [];
		for (const item of items) {
			const { method, params } = item as { method?: unknown; params?: { name?: unknown } };
			if (typeof method !== 'string') continue;
			out.push(method);
			if (method === 'tools/call' && typeof params?.name === 'string') {
				out.push(`tools/call:${params.name}`);
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Registers the live agent-CLI suite for one backend, if the fixture has a key. */
export function describeAgentCliConformance(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	const mp = fixture.modelProvider;

	if (!mp) {
		describe(`${fixture.name}: live agent CLI run`, () => {
			it.skip('skipped - no model-provider key supplied', () => {});
		});
		return;
	}

	const runtime = PROVIDER_RUNTIME_ADAPTERS[mp.provider].runtime;

	describe(`${fixture.name}: live agent CLI run (${mp.name})`, () => {
		const engine: ContainerEngine = fixture.engine;
		const runUser: ContainerRunUser = { name: fixture.runUser, uid: 1000, gid: 1000 };
		let containerId = '';
		let transcript = '';
		/** What the production stream parser made of it, line for line. */
		let renderedLog = '';
		let terminalError: string | null = null;
		let exitCode = -1;
		/** JSON-RPC methods that arrived on the host's `/mcp` endpoint. */
		const mcpMethods: string[] = [];
		/** Set if the tunnel died on its own at any point during the run. */
		let tunnelDeath: string | null = null;
		/**
		 * `<phase> +<ms>` markers, so a failure says *when* as well as what.
		 *
		 * A live suite is expensive to re-run and the thing it is diagnosing is a
		 * timing question ("the tunnel was up for the MCP handshake and gone by the
		 * end - which step killed it?"). Recording the order once beats paying for
		 * another sandbox to find out.
		 */
		const timeline: string[] = [];
		const startedAt = Date.now();
		const mark = (phase: string) => timeline.push(`${phase} +${Date.now() - startedAt}ms`);

		let host: Awaited<ReturnType<typeof createTestApp>> | null = null;
		let served: ServedTestApp | null = null;
		let tunnel: RunTunnel | null = null;

		beforeAll(async () => {
			await sweepConformanceContainers(engine);
			const created = await engine.createContainer(`hezo-conf-cli-${conformanceRunId()}`, {
				Image: fixture.image,
				Cmd: ['sleep', 'infinity'],
				Labels: { [CONFORMANCE_LABEL]: '1' },
				HostConfig: { Memory: fixture.memoryBytes },
			});
			containerId = created.Id;
			await engine.startContainer(containerId);

			// Same posture as the tunnel and egress suites: a precondition this suite
			// cannot satisfy is a failed run, never a quiet skip. Without `hezo-tunnel`
			// there is no container-to-host path at all, and the natural failure is a
			// 30s "did not bind its ports" that reads as a broken tunnel rather than a
			// missing binary. A managed backend feels this before Docker does - it
			// pulls a *published* image, while Docker builds from the working tree.
			const probe = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', 'command -v hezo-tunnel || echo MISSING'],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			if ((await engine.execStart(probe)).stdout.includes('MISSING')) {
				throw new Error(
					`${fixture.name}: the image ${fixture.image} does not carry hezo-tunnel, so the agent ` +
						'has no path to Hezo and its MCP tools cannot be asserted. Point ' +
						'HEZO_CONFORMANCE_IMAGE at an image built from this branch ' +
						'(docker/Dockerfile.agent-base installs it).',
				);
			}

			// A real Hezo on a real socket, because that is what the assertion is
			// about: a stub MCP server would prove the CLI can speak to *something*,
			// not that it reached Hezo's `/mcp` with a per-run agent JWT and got the
			// tool catalogue back. This is also the only thing that catches what a
			// port probe cannot - a 401 on the JWT, a 5xx, a stalled route.
			mark('container-ready');
			host = await createTestApp();
			served = await serveTestApp(host.app, {
				onRequest: (req: ObservedRequest) => {
					if (req.url.startsWith('/mcp')) mcpMethods.push(...jsonRpcMethods(req.body));
				},
			});

			// The CEO in HQ: an instance agent with a project to act in, which is the
			// shape the run that exposed all this actually had.
			const hq = await host.db.query<{
				team_id: string;
				project_id: string;
				member_id: string;
			}>(
				`SELECT p.team_id, p.id AS project_id, m.id AS member_id
				   FROM projects p
				   JOIN members m ON m.team_id = p.team_id
				   JOIN member_agents a ON a.id = m.id AND a.slug = $1
				  WHERE p.is_internal = true
				  LIMIT 1`,
				[CEO_AGENT_SLUG],
			);
			const seat = hq.rows[0];
			if (!seat) throw new Error('no HQ CEO seat to mint an agent token for');
			const { token: agentJwt, runId } = await mintAgentToken(
				host.db,
				host.masterKeyManager,
				seat.member_id,
				seat.team_id,
				null,
				{ projectId: seat.project_id },
			);

			// All three legs at the same host target. Only `mcp` is exercised, but a
			// target must exist for the client to bind that port at all, and a run
			// gets all three - so binding all three is the shape production has.
			const at = { host: '127.0.0.1', port: served.port };
			const tunnelLabel = `cli-${conformanceRunId()}`;
			tunnel = await startRunTunnel({
				engine,
				containerId,
				runUser,
				files: engine.files(containerId, fixture.workRoot),
				configRelPath: `.hezo/tunnel/${tunnelLabel}.json`,
				configContainerPath: `${fixture.workRoot}/.hezo/tunnel/${tunnelLabel}.json`,
				addresses: { proxy: at, mcp: at, ssh: at },
				policy: { proxiedHosts: [], proxyEverything: false },
			});
			// A death here is the exact failure the run that prompted this suite hit,
			// so record it rather than letting the MCP assertions report the symptom.
			tunnel.onClosed((reason) => {
				tunnelDeath ??= reason;
				mark(`tunnel-died(${reason})`);
			});
			mark('tunnel-up');

			// From here to the exec, this is `buildRuntimeInvocation` with the runner's
			// own helpers rather than a re-implementation: the per-run config home, the
			// injector, the file writes through SandboxFiles, and the chown that makes
			// them readable by the non-root user the CLI runs as.
			const homeMount: RuntimeHomeMount | null = MCP_ADAPTERS[runtime].capabilities.requiresHomeDir
				? await ensureRuntimeHomeDir(
						mp.provider,
						runtime,
						host.dataDir,
						seat.team_id,
						seat.project_id,
						runId,
						null,
						engine,
						containerId,
					)
				: null;

			const descriptors: McpDescriptor[] = [
				{
					kind: 'http',
					name: HEZO_MCP_SERVER_NAME,
					url: `${tunnel.endpoints.hezoBaseUrl}/mcp`,
					bearerToken: agentJwt,
				},
			];
			const injection = MCP_ADAPTERS[runtime].build(descriptors, {
				hostHomeDir: homeMount?.hostDir ?? null,
				containerHomeDir: homeMount?.containerDir ?? null,
				provider: mp.provider,
				runModel: mp.model ?? null,
			});
			validateInjection(MCP_ADAPTERS[runtime], injection);

			mark('injection-built');
			const runtimeFiles = subscriptionFiles(engine, containerId);
			const subscriptionBase = getHostSubscriptionBase(host.dataDir, seat.team_id, seat.project_id);
			for (const file of injection.files) {
				await runtimeFiles.write(relative(subscriptionBase, file.hostPath), file.contents, {
					mode: file.mode,
					dirMode: SUBSCRIPTION_DIR_MODE,
				});
			}
			if (homeMount) {
				await chownToRunUser(engine, containerId, runUser, [homeMount.containerDir], {
					recursive: true,
				});
			}

			mark('files-chowned');
			const files = engine.files(containerId, fixture.workRoot);
			await files.mkdir('.');
			await files.write(PROMPT_FILE, PROMPT);

			const argv = cliArgv(mp, injection.cliArgs).map(shellQuote).join(' ');
			const promptPath = shellQuote(`${fixture.workRoot}/${PROMPT_FILE}`);
			// Prompt delivery is the runtime's own convention, and getting it wrong is
			// a hang rather than an error - a CLI waiting on a stdin that never closes
			// looks exactly like a slow model.
			const line =
				RUNTIME_PROMPT_DELIVERY[runtime] === 'arg'
					? `${argv} "$(cat ${promptPath})"`
					: `${argv} < ${promptPath}`;

			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', line],
				Env: [
					...providerEnv(mp),
					...(homeMount ? [homeMount.envEntry] : []),
					...injection.envEntries,
				],
				WorkingDir: fixture.workRoot,
				User: fixture.honoursExecUser ? fixture.runUser : undefined,
				AttachStdout: true,
				AttachStderr: true,
			});
			// Streamed, not buffered, because that is how production consumes it: an
			// agent run's stream-json transcript reaches hundreds of MB, so the engine
			// deliberately retains nothing on this path. A suite that used the buffered
			// path would be testing a contract production never uses.
			//
			// Fed through the production parser as it arrives, for the same reason the
			// argv comes from the production tables: what matters is what *the runner*
			// would conclude about this run, not what a bespoke walk of the JSON can be
			// made to say.
			const parser = createAgentStreamParser(runtime);
			let firstChunk = true;
			mark('cli-exec-start');
			await engine.execStart(execId, {
				onChunk: (c: ExecLogChunk) => {
					if (firstChunk) {
						firstChunk = false;
						mark('cli-first-chunk');
					}
					transcript += c.text;
					renderedLog += parser.onStdout(c.text);
				},
			});
			mark('cli-exec-end');
			renderedLog += parser.flush();
			terminalError = parser.getTerminalError();
			exitCode = (await engine.execInspect(execId)).ExitCode;
			mark('exec-inspected');
			if (process.env.HEZO_CONFORMANCE_DUMP) {
				const { writeFileSync } = await import('node:fs');
				writeFileSync(`${process.env.HEZO_CONFORMANCE_DUMP}/transcript.txt`, transcript);
				writeFileSync(`${process.env.HEZO_CONFORMANCE_DUMP}/rendered.txt`, renderedLog);
				writeFileSync(
					`${process.env.HEZO_CONFORMANCE_DUMP}/meta.json`,
					JSON.stringify({ exitCode, tunnelDeath, timeline, mcpMethods }, null, 2),
				);
			}
		}, 900_000);

		afterAll(async () => {
			tunnel?.close();
			if (served) await new Promise<void>((r) => served?.server.close(() => r()));
			if (host) {
				await safeClose(host.db);
				rmSync(host.dataDir, { recursive: true, force: true });
			}
			await sweepConformanceContainers(engine);
		}, 180_000);

		it('exits cleanly', () => {
			// The transcript rides along in the message: a non-zero exit here is
			// almost always the provider refusing the credential or the endpoint being
			// unreachable, and both say so in the output.
			expect(`exit=${exitCode} :: ${transcript.slice(-2000)}`).toContain('exit=0');
		});

		it('streams a well-formed stream-json transcript', () => {
			const lines = transcript
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.startsWith('{'));
			expect(lines.length).toBeGreaterThan(0);
			// Every line parses: this is what catches a transport that interleaves or
			// splits frames. Daytona merges stdout and stderr onto one channel, so a
			// stray write landing mid-line would surface exactly here.
			const events = lines.map((l) => JSON.parse(l) as { type?: string; subtype?: string });
			const result = events.find((e) => e.type === 'result');
			expect(result).toBeDefined();
			expect(result?.subtype).toBe('success');
		});

		it('round-trips the prompt through the model', () => {
			// The prompt reached the CLI on the channel its runtime expects, the CLI
			// reached the provider, and the answer came back through the exec stream.
			expect(transcript).toContain(SENTINEL);
		});

		it('reports token usage the pricing table can charge against', () => {
			// Runs price only from `model_pricing`, using the buckets the CLI reports -
			// so a runtime that streams no usage prices every run at $0. That failure
			// is invisible in production (a $0 run looks like a cheap run), and this is
			// the only place it surfaces.
			const usage = jsonEvents(transcript).find((e) => e.type === 'result')?.usage as
				| Record<string, unknown>
				| undefined;
			expect(usage).toBeDefined();
			const total = Object.values(usage ?? {}).reduce<number>(
				(sum, v) => sum + (typeof v === 'number' ? v : 0),
				0,
			);
			expect(total).toBeGreaterThan(0);
		});

		it('keeps its tunnel for the whole run', () => {
			// The precondition for everything below, and the defect that started this:
			// the tunnel bound (so the run started), then died mid-run with nothing
			// watching. `onClosed` is that watch; a run whose only path to Hezo is gone
			// is a failed run, not a quiet one.
			expect(tunnelDeath).toBeNull();
		});

		it('reaches Hezo’s MCP endpoint from inside the container', () => {
			// Host-side evidence, and the runtime-agnostic half of the assertion: these
			// requests exist only if the tunnel carried them, the agent JWT was
			// accepted, and the client got a usable catalogue back. A run that lost its
			// tunnel produces an empty list here - which is precisely what the failing
			// run would have shown, had anyone been able to look.
			expect(mcpMethods).toContain('initialize');
			expect(mcpMethods).toContain('tools/list');
		});

		it('gives the agent Hezo’s tools, and the agent can use one', () => {
			// The assertion whose absence is exactly why `tools=25` shipped - and the
			// only form of it that actually holds. Reading the runtime's startup report
			// instead would be cheaper and wrong: Claude Code 2.1.220 emits `init`
			// *before* its MCP servers connect, so a healthy run lists its built-ins
			// there, reports the server as `pending`, and carries no Hezo tools at all.
			//
			// A `tools/call` arriving at the host proves the whole chain at once - the
			// server connected, its catalogue reached the model, the model could name a
			// tool from it, the call travelled the tunnel, and the agent JWT was
			// accepted on a method that does real work.
			expect(`called: ${mcpMethods.join(', ')}`).toContain(`tools/call:${HEZO_PROBE_TOOL}`);
		});

		if (!RUNTIME_REPORTS_MCP_STATUS[runtime]) {
			// Named rather than silent: this runtime states nothing about its MCP
			// servers in its own stream, so the host-side evidence above is the whole
			// assertion for it. Recording that here keeps "not asserted" distinct from
			// "asserted and passed".
			it.skip(`skipped - the ${runtime} runtime reports no MCP server status`, () => {});
		} else {
			it('does not let the startup MCP report fail a healthy run', () => {
				// Read through the production parser, so this asserts what the *runner*
				// would conclude rather than what a bespoke walk of the JSON can be made
				// to say. The first cut of that check treated the init report's
				// anything-but-`connected` as a terminal error, which on this CLI is
				// every single run - `pending` there means "not yet", not "failed". This
				// is the regression guard, live against the CLI the image ships.
				expect(`${terminalError ?? 'none'}`).toBe('none');
				expect(renderedLog).toContain(`mcp: ${HEZO_MCP_SERVER_NAME}=`);
			});

			it('withholds the disallowed built-ins', () => {
				// `RUNTIME_DISALLOWED_TOOLS_ARGS` as a tested property rather than a flag
				// we hope the CLI still honours under this version. Built-ins *are* in
				// the `init` list (unlike MCP tools), so this is the one tool-list claim
				// the startup report can settle.
				const init = jsonEvents(transcript).find(
					(e) => e.type === 'system' && e.subtype === 'init',
				);
				expect(init).toBeDefined();
				const raw = Array.isArray(init?.tools) ? (init.tools as unknown[]) : [];
				const tools = raw.filter((t): t is string => typeof t === 'string');
				expect(tools.length).toBeGreaterThan(0);
				for (const withheld of disallowedToolNames(runtime)) {
					expect(tools).not.toContain(withheld);
				}
			});
		}
	});
}
