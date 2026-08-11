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
 * **A provider is not a runtime, and this registers per runtime.** A credential
 * carries its own CLI choice, and Prime Agent is never any provider's default -
 * so a fixture entry names the runtime and the suite runs once per entry, each
 * with its own container. Resolving the CLI from the provider alone, which this
 * did until Prime Agent arrived, can only ever exercise defaults.
 *
 * Cost: one short completion per fixture entry, on whatever model it pins (pick
 * the provider's cheapest). It is opt-in for the same reason the Daytona suites
 * are - see `test/live/`.
 *
 * **`HEZO_CONFORMANCE_DUMP=<dir>` writes the raw evidence** - the transcript, the
 * log the production parser rendered from it, and a `meta.json` carrying the exit
 * code, the MCP methods that reached the host (and the status each was answered
 * with), the resolved runtime and a phase timeline. A live run costs a sandbox
 * and a completion to reproduce, and the questions it raises are
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
	opencodeModelArg,
	PROVIDER_TO_RUNTIME,
	primeAgentProviderArgs,
	providerSupportsRuntime,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_DISALLOWED_TOOLS_ARGS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_PROMPT_DELIVERY,
	RUNTIME_STREAM_ARGS,
} from '@hezo/shared';
import { buildProviderEnv } from '../../src/services/agent-runner';
import { createAgentStreamParser } from '../../src/services/agent-stream-parser';
import type { AiProviderCredential } from '../../src/services/ai-provider-keys';
import { type ContainerRunUser, chownToRunUser } from '../../src/services/container-user';
import {
	HEZO_MCP_SERVER_NAME,
	MCP_ADAPTERS,
	type McpDescriptor,
	validateInjection,
} from '../../src/services/mcp-injectors';
import {
	buildSubscriptionMount,
	ensureRuntimeHomeDir,
	getHostSubscriptionBase,
	RUNTIME_HOME_LAYOUTS,
	type RuntimeHomeMount,
	SUBSCRIPTION_DIR_MODE,
	type SubscriptionMount,
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
	SUBSCRIPTION_ROTATION_WARNING,
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
 * Which CLI this entry runs on: its own choice, else the provider's default.
 *
 * Never `PROVIDER_RUNTIME_ADAPTERS[provider].runtime` on its own. That reads the
 * *default*, so it can only ever exercise defaults - and Prime Agent is never any
 * provider's default, so a provider-keyed lookup cannot reach it at all.
 */
function resolvedRuntime(mp: LiveModelProvider): AgentRuntime {
	return mp.runtime ?? PROVIDER_TO_RUNTIME[mp.provider];
}

/**
 * Refuses a pairing the provider has no binding for.
 *
 * Called from `beforeAll` rather than at registration, and that placement is the
 * point: a throw while the module is loading takes the whole fixture file down
 * with it, so one mistyped runtime would stop the engine, files, tunnel, egress
 * and git suites running at all. In `beforeAll` it fails this suite and leaves
 * the rest of the backend's coverage intact - the same shape as the
 * `hezo-tunnel` precondition below. A refusal either way, never a skip: a fixture
 * naming an impossible pairing is a bug, and a skip would report green.
 */
function assertSupportedPairing(mp: LiveModelProvider, runtime: AgentRuntime): void {
	if (providerSupportsRuntime(mp.provider, runtime)) return;
	throw new Error(
		`${mp.name}: ${mp.provider} cannot run on ${runtime}. The fixture names a pairing ` +
			'`providerSupportsRuntime` rejects, so the run would be configured for a CLI the ' +
			'credential has no binding for.',
	);
}

/**
 * Says so, loudly, when a live run will invalidate the credential it was given.
 *
 * Codex's subscription blob carries a single-use refresh token: production
 * serialises runs on it (`acquireCredentialLock`) and writes the rotated value
 * back afterwards. This suite does neither, so a run consumes the token and
 * leaves the operator's copy stale. That is a real cost to whoever supplied it,
 * and the honest place to say so is before the run rather than in a doc nobody
 * reads at 2am - so it goes to stderr as the suite starts.
 *
 * A warning rather than a refusal: the user asked for this pairing to be
 * covered, and declining to run it would be deciding for them.
 */
function warnIfCredentialRotates(mp: LiveModelProvider, runtime: AgentRuntime): void {
	if ((mp.authMethod ?? AiAuthMethod.ApiKey) !== AiAuthMethod.Subscription) return;
	if (!RUNTIME_HOME_LAYOUTS[runtime]?.rotates) return;
	console.warn(`[conformance] ${mp.name} on ${runtime}: ${SUBSCRIPTION_ROTATION_WARNING}.`);
}

/**
 * Environment for the run, from the production builder itself.
 *
 * `buildProviderEnv` resolves the binding from the credential's runtime rather
 * than the provider's default, which is the whole point here - a restatement of
 * it would build the default runtime's env for a switched credential and the run
 * would fail as "no credentials found". It also carries the per-runtime details
 * easy to omit by hand: each quiet-env bag, and the model overrides that have to
 * land in a variable rather than only on `--model`.
 *
 * This deliberately no longer blanks `ANTHROPIC_API_KEY`. The copy it replaced
 * did, claiming to mirror the runner - but the runner only blanks it for a local
 * provider carrying its own base URL, where an inherited key would outrank the
 * one being set. Mirroring production means mirroring what it actually does; the
 * container is a fresh sandbox whose image sets no such variable, so there is
 * nothing to inherit here anyway.
 */
function liveCredential(mp: LiveModelProvider, runtime: AgentRuntime): AiProviderCredential {
	return {
		value: mp.credential,
		authMethod: mp.authMethod ?? AiAuthMethod.ApiKey,
		// Only a local runner carries one; it is what makes `buildProviderEnv`
		// stamp ANTHROPIC_BASE_URL at the operator's own server.
		baseUrl: mp.baseUrl ?? null,
		runtime,
	};
}

function providerEnv(mp: LiveModelProvider, runtime: AgentRuntime): string[] {
	return [
		...buildProviderEnv(mp.provider, liveCredential(mp, runtime), mp.model ?? null),
		'HOME=/home/node',
		'CI=1',
	];
}

/**
 * The argv the runner would build for this runtime, in the runner's own order -
 * including the MCP injection, which is where `--mcp-config` and `--settings`
 * come from. Mirrors `buildRuntimeInvocation`'s `cmd` (`agent-runner.ts`), minus
 * the effort args and Grok's debug-file flag.
 */
function cliArgv(
	mp: LiveModelProvider,
	runtime: AgentRuntime,
	mcpArgs: readonly string[],
): string[] {
	// The model id is remapped per runtime, not per provider: Claude Code and
	// OpenCode each want their own spelling, everything else takes it verbatim.
	let cliModel = mp.model ?? null;
	if (cliModel) {
		if (runtime === AgentRuntime.ClaudeCode) cliModel = claudeCodeModelArg(mp.provider, cliModel);
		else if (runtime === AgentRuntime.OpenCode) cliModel = opencodeModelArg(mp.provider, cliModel);
	}
	// Prime Agent selects its upstream by flag rather than env var, so the provider
	// has to be named on the command line. Empty for every other runtime.
	const providerArgs =
		runtime === AgentRuntime.PrimeAgent ? [...primeAgentProviderArgs(mp.provider)] : [];
	return [
		RUNTIME_COMMANDS[runtime],
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtime],
		...mcpArgs,
		...RUNTIME_STREAM_ARGS[runtime],
		...RUNTIME_AUTO_APPROVE_ARGS[runtime],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtime],
		...providerArgs,
		...(cliModel ? ['--model', cliModel] : []),
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

/** Registers the live agent-CLI suite for one backend, once per model provider. */
export function describeAgentCliConformance(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
): void {
	const providers = fixture.modelProviders ?? [];

	if (providers.length === 0) {
		h.describe(`${fixture.name}: live agent CLI run`, () => {
			h.it.skip('skipped - no model-provider key supplied', () => {});
		});
		return;
	}

	// One independent registration per entry: each provisions its own container and
	// bills its own completion, and the runtime is in the title so a failure names
	// which CLI broke rather than just which backend.
	for (const mp of providers) describeOneAgentCliRun(fixture, h, mp);
}

function describeOneAgentCliRun(
	fixture: LiveAdapterFixture,
	h: ConformanceHarness,
	mp: LiveModelProvider,
): void {
	const { describe, it, expect, beforeAll, afterAll } = h;
	const runtime = resolvedRuntime(mp);
	const authMethod = mp.authMethod ?? AiAuthMethod.ApiKey;
	// The auth method is in the title because a provider can appear twice - once
	// per key and once per subscription - and those exercise different delivery
	// paths. A failure has to say which one broke.
	const label = `${mp.name} on ${runtime}${
		authMethod === AiAuthMethod.Subscription ? ' (subscription)' : ''
	}`;

	describe(`${fixture.name}: live agent CLI run (${label})`, () => {
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
		/**
		 * The same methods again, once answered, as `<method>=<status>`.
		 *
		 * Arrival and success are different claims. A client that reaches `/mcp`
		 * and is rejected produces exactly the same `mcpMethods` as one that is
		 * served, so the arrival list alone would pass a run where every tool call
		 * came back 401. That matters most for a runtime whose MCP client is not
		 * the CLI's own - Prime Agent builds the request in Python - because that
		 * is where an auth header goes missing without anything else changing.
		 */
		const mcpAnswers: string[] = [];
		/** Set if the tunnel died on its own at any point during the run. */
		let tunnelDeath: string | null = null;
		/** Set for a subscription credential the runtime materialises as a file. */
		let subscriptionMount: SubscriptionMount | null = null;
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
			assertSupportedPairing(mp, runtime);
			warnIfCredentialRotates(mp, runtime);
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
				onResponse: (req: ObservedRequest, status: number) => {
					if (!req.url.startsWith('/mcp')) return;
					for (const m of jsonRpcMethods(req.body)) mcpAnswers.push(`${m}=${status}`);
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
			// own helpers rather than a re-implementation: the subscription mount, the
			// per-run config home, the injector, the file writes through SandboxFiles,
			// and the chown that makes them readable by the non-root user the CLI runs
			// as.
			//
			// A subscription credential is materialised exactly as production does it -
			// a 0600 file under the per-run home for the runtimes that mount one
			// (Codex's `auth.json`, Gemini's `oauth_creds.json`), and nothing at all for
			// the ones that take it as an env var (Anthropic's `CLAUDE_CODE_OAUTH_TOKEN`,
			// which `buildProviderEnv` already emitted). `null` for an api-key
			// credential, which is what makes this a no-op on most of the matrix.
			subscriptionMount = await buildSubscriptionMount(
				host.dataDir,
				seat.team_id,
				seat.project_id,
				runId,
				mp.provider,
				runtime,
				liveCredential(mp, runtime),
				engine,
				containerId,
			);
			// The home dir is handed the subscription mount, so the two share one
			// directory rather than the CLI being pointed at a home that does not hold
			// the credential it was just given.
			const homeMount: RuntimeHomeMount | null = MCP_ADAPTERS[runtime].capabilities.requiresHomeDir
				? await ensureRuntimeHomeDir(
						mp.provider,
						runtime,
						host.dataDir,
						seat.team_id,
						seat.project_id,
						runId,
						subscriptionMount,
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

			const argv = cliArgv(mp, runtime, injection.cliArgs).map(shellQuote).join(' ');
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
					...providerEnv(mp, runtime),
					// The runner's own precedence: a subscription mount sets the runtime's
					// home variable itself, so the bare home entry is the fallback rather
					// than an addition - setting both would point the CLI at two homes.
					...(subscriptionMount?.envEntries ?? (homeMount ? [homeMount.envEntry] : [])),
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
				const { mkdirSync, writeFileSync } = await import('node:fs');
				// One directory per entry, because the whole point of the matrix is
				// running several. Fixed filenames under the dump root meant each entry
				// overwrote the last, so a two-entry run left the evidence of exactly
				// one of them - and silently, since the surviving file looks complete.
				const dir =
					`${process.env.HEZO_CONFORMANCE_DUMP}/${fixture.name}-${mp.provider}-${runtime}-${authMethod}`
						.toLowerCase()
						.replaceAll(/[^a-z0-9/._-]+/g, '-');
				mkdirSync(dir, { recursive: true });
				writeFileSync(`${dir}/transcript.txt`, transcript);
				writeFileSync(`${dir}/rendered.txt`, renderedLog);
				writeFileSync(
					`${dir}/meta.json`,
					JSON.stringify(
						{
							backend: fixture.name,
							provider: mp.provider,
							runtime,
							authMethod,
							model: mp.model ?? null,
							exitCode,
							tunnelDeath,
							timeline,
							mcpMethods,
							mcpAnswers,
						},
						null,
						2,
					),
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
			// A `tools/call` arriving at the host proves most of the chain at once -
			// the server connected, its catalogue reached the model, the model could
			// name a tool from it, and the call travelled the tunnel.
			expect(`called: ${mcpMethods.join(', ')}`).toContain(`tools/call:${HEZO_PROBE_TOOL}`);
		});

		it('has that tool call answered, not rejected', () => {
			// Arrival is not acceptance. The assertion above passes just as happily on
			// a run where every call came back 401, because the request reached `/mcp`
			// either way - so on its own it proves the transport, not the credential.
			//
			// This is where a runtime whose MCP client is not the CLI's own gets
			// caught: Prime Agent's requests are built in Python by a generated skill,
			// so its bearer travels a different path from every other runtime's and
			// can go missing without anything upstream changing.
			//
			// A 2xx is the honest limit of what this can claim. Streamable HTTP
			// answers a tool that *errored* with 200 and a JSON-RPC error body, so
			// this separates "rejected at the door" from "served" - not "served" from
			// "succeeded". The prompt's sentinel in the transcript covers the rest.
			// Stated as "at least one 2xx" rather than "no 4xx/5xx": the negative form
			// passes vacuously on an empty list, which is the one outcome this is
			// supposed to catch. A retry that failed and then succeeded is still a
			// success, so one served call is the bar.
			const statuses = mcpAnswers
				.filter((a) => a.startsWith(`tools/call:${HEZO_PROBE_TOOL}=`))
				.map((a) => a.slice(a.lastIndexOf('=') + 1));
			expect(`${HEZO_PROBE_TOOL} answered: ${statuses.join(', ') || '(never)'}`).toMatch(
				/\b2\d\d\b/,
			);
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
