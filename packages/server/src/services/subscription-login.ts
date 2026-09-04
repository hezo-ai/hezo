import { randomBytes } from 'node:crypto';
import { type AgentRuntime, type AiProvider, effectiveRuntime } from '@hezo/shared';
import { RUNTIME_HOME_LAYOUTS } from './runtime-home';
import {
	bracketedPasteEnabled,
	buildSubscriptionLoginCodeScript,
	buildSubscriptionLoginScript,
	LOGIN_EXIT_FILE,
	LOGIN_LOG_FILE,
} from './sandbox/proc-scripts';
import type { ContainerEngine } from './sandbox/types';
import {
	type LoginChallenge,
	SUBSCRIPTION_LOGIN_DRIVERS,
	type SubscriptionLoginDriver,
} from './subscription-login-drivers';

/**
 * Driving a coding CLI's own sign-in from Hezo, so the operator can complete it
 * on whatever device they are holding.
 *
 * The CLI runs inside a container believing a local browser is available. It is
 * not: Hezo reads the challenge the CLI printed, hands it to the operator's
 * browser, and feeds back whatever that browser produced. The CLI performs its
 * own token exchange and writes its own credential file, which is read out
 * through {@link ContainerEngine.files} straight into the vault - so the
 * credential never passes through the operator's clipboard, browser or form
 * state, which is what pasting `auth.json` by hand requires today.
 *
 * **There is no port forwarding here, and there must not be.** The tunnel is
 * container-initiated and restricted to fixed target keys, deliberately, so a
 * CLI's loopback callback port can never be reached from outside. Every flow
 * this drives is one the vendor already offers without a loopback: a device code
 * the CLI polls itself, or a hosted callback page that displays a code.
 */

/** Where a flow's FIFO, log and exit file live inside the container. */
const LOGIN_BASE_DIR = '/tmp/.hezo-login';

/**
 * How long an unfinished flow survives.
 *
 * Matches the longest vendor challenge expiry (15 minutes for a Codex device
 * code) plus a minute of slack, so the flow outlives the code the operator is
 * looking at rather than expiring under them.
 */
export const LOGIN_FLOW_TTL_MS = 16 * 60_000;

/** How often the log is re-read while waiting for a challenge or a credential. */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long a delivered code has to become a credential before the flow gives up
 * on it.
 *
 * A CLI that refuses a code says so on its own screen and keeps running, so
 * without this the flow waits out its whole completion timeout while the
 * operator watches a step that will never advance. The exchange itself is one
 * request - a wrong code comes back in a couple of seconds - so this is long
 * enough that only a code that was actually refused reaches it.
 */
const CODE_ACCEPT_TIMEOUT_MS = 45_000;

export type LoginFlowState =
	| { status: 'starting' }
	| { status: 'awaiting_user'; challenge: LoginChallenge; completion: 'none' | 'code' }
	| { status: 'succeeded'; credential: string }
	| { status: 'failed'; error: string; code: LoginFailureCode };

/** Named so a caller can tell "the CLI moved" from "the operator gave up". */
export type LoginFailureCode =
	| 'unsupported'
	| 'probe_failed'
	| 'challenge_timeout'
	| 'completion_timeout'
	| 'code_rejected'
	| 'exited_without_credential'
	| 'cancelled'
	| 'internal';

export interface LoginFlow {
	readonly id: string;
	readonly provider: AiProvider;
	readonly runtime: AgentRuntime;
	/** The user this flow belongs to; re-checked on every poll. */
	readonly ownerId: string;
	readonly createdAt: number;
	state: LoginFlowState;
}

interface FlowEntry extends LoginFlow {
	driver: SubscriptionLoginDriver;
	engine: ContainerEngine;
	containerId: string;
	dir: string;
	/** Released on every exit path - success, failure, cancel, expiry. */
	teardown: () => Promise<void>;
	abort: AbortController;
	/** When the operator's code reached the CLI; null until one has. */
	codeSubmittedAt: number | null;
}

export class SubscriptionLoginUnsupportedError extends Error {
	readonly code: LoginFailureCode;
	constructor(message: string, code: LoginFailureCode = 'unsupported') {
		super(message);
		this.name = 'SubscriptionLoginUnsupportedError';
		this.code = code;
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(t);
			resolve();
		});
	});
}

async function execCapture(
	engine: ContainerEngine,
	containerId: string,
	script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const execId = await engine.execCreate(containerId, {
		Cmd: ['sh', '-c', script],
		AttachStdout: true,
		AttachStderr: true,
	});
	const { stdout, stderr } = await engine.execStart(execId);
	const { ExitCode } = await engine.execInspect(execId);
	return { exitCode: ExitCode, stdout, stderr };
}

/**
 * Which runtime a provider's guided sign-in would run on, or null when it has
 * none.
 *
 * Resolved through `effectiveRuntime` so a config pinned to an alternate CLI
 * gets that CLI's flow rather than the provider's default - the same resolution
 * the run path uses.
 */
export function loginRuntimeFor(
	provider: AiProvider,
	storedRuntime: AgentRuntime | null,
): AgentRuntime | null {
	const runtime = effectiveRuntime(provider, storedRuntime);
	if (!runtime) return null;
	return SUBSCRIPTION_LOGIN_DRIVERS[runtime] ? runtime : null;
}

/**
 * In-memory registry of live sign-ins.
 *
 * Deliberately not persisted: a flow is bound to a container and a challenge
 * that both die with the process, so a row surviving a restart would describe
 * something that no longer exists. A restart drops every flow and the operator
 * starts again, which is the honest outcome.
 */
export class SubscriptionLoginService {
	private readonly flows = new Map<string, FlowEntry>();

	/** Flows whose TTL has passed, torn down lazily on every touch. */
	private prune(): void {
		const cutoff = Date.now() - LOGIN_FLOW_TTL_MS;
		for (const [id, flow] of this.flows) {
			if (flow.createdAt < cutoff) {
				void this.finish(id, {
					status: 'failed',
					error: 'Sign-in expired before it was completed',
					code: 'completion_timeout',
				});
			}
		}
	}

	/**
	 * Launch a sign-in and return its id. The challenge is not ready yet; the
	 * caller polls {@link get} for it.
	 *
	 * The capability probe runs before anything is shown, so a CLI that no longer
	 * offers this flow fails here by name rather than as a silent hang.
	 */
	async start(opts: {
		provider: AiProvider;
		storedRuntime: AgentRuntime | null;
		ownerId: string;
		engine: ContainerEngine;
		containerId: string;
		teardown: () => Promise<void>;
	}): Promise<LoginFlow> {
		this.prune();
		const { provider, storedRuntime, ownerId, engine, containerId, teardown } = opts;

		const runtime = effectiveRuntime(provider, storedRuntime);
		const driver = runtime ? SUBSCRIPTION_LOGIN_DRIVERS[runtime] : null;
		if (!runtime || !driver) {
			await teardown();
			throw new SubscriptionLoginUnsupportedError(
				`${runtime ?? provider} has no guided sign-in - paste the credential manually instead`,
			);
		}

		if (driver.capabilityProbe) {
			const { argv, mustContain } = driver.capabilityProbe;
			const probe = await execCapture(engine, containerId, argv.join(' ')).catch(() => null);
			if (!probe || !`${probe.stdout}${probe.stderr}`.includes(mustContain)) {
				await teardown();
				throw new SubscriptionLoginUnsupportedError(
					`the installed ${argv[0]} CLI no longer offers ${mustContain} - paste the credential manually instead`,
					'probe_failed',
				);
			}
		}

		const id = randomBytes(16).toString('hex');
		const dir = `${LOGIN_BASE_DIR}/${id}`;
		const layout = RUNTIME_HOME_LAYOUTS[runtime];

		const entry: FlowEntry = {
			id,
			provider,
			runtime,
			ownerId,
			createdAt: Date.now(),
			state: { status: 'starting' },
			driver,
			engine,
			containerId,
			dir,
			teardown,
			abort: new AbortController(),
			codeSubmittedAt: null,
		};
		this.flows.set(id, entry);

		// The CLI's config home is the flow's own directory, so `auth-file`
		// harvesting reads exactly the path a run would later mount.
		const home = `${dir}/home`;
		const script = buildSubscriptionLoginScript({
			dir,
			argv: driver.argv,
			env: { [layout.envVarName]: home, ...driver.extraEnv },
			holdSecs: Math.ceil(LOGIN_FLOW_TTL_MS / 1000),
		});

		const launched = await execCapture(engine, containerId, `mkdir -p ${home} && ${script}`).catch(
			(e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }),
		);
		if (launched.exitCode !== 0) {
			await this.finish(id, {
				status: 'failed',
				error: `could not start ${driver.argv[0]}: ${launched.stderr.trim() || 'unknown error'}`,
				code: 'internal',
			});
			throw new SubscriptionLoginUnsupportedError(
				`could not start ${driver.argv[0]} in the container`,
				'internal',
			);
		}

		void this.watch(id);
		return entry;
	}

	/** Current state, with the owner re-checked as `routes/oauth.ts` does on poll. */
	get(id: string, ownerId: string): LoginFlow | null {
		this.prune();
		const flow = this.flows.get(id);
		if (!flow || flow.ownerId !== ownerId) return null;
		return flow;
	}

	/**
	 * Deliver the operator's code to a waiting CLI.
	 *
	 * Rejected unless the flow actually asked for one - a driver whose CLI polls
	 * the vendor itself has no prompt to answer, and writing to its FIFO would
	 * put stray input in front of whatever it does read.
	 */
	async submitCode(id: string, ownerId: string, code: string): Promise<boolean> {
		const flow = this.flows.get(id);
		if (!flow || flow.ownerId !== ownerId) return false;
		if (flow.state.status !== 'awaiting_user' || flow.driver.completion !== 'code') return false;

		// The prompt's own paste setting, taken from the output it has printed so
		// far. Read here rather than stored on the driver because it is a property
		// of the prompt currently on screen, not of the binary.
		const log = await flow.engine
			.files(flow.containerId, flow.dir)
			.read(LOGIN_LOG_FILE)
			.catch(() => '');

		const res = await execCapture(
			flow.engine,
			flow.containerId,
			buildSubscriptionLoginCodeScript(flow.dir, code.trim(), {
				bracketed: bracketedPasteEnabled(log),
			}),
		).catch(() => null);

		if (res?.exitCode !== 0) return false;
		// Starts the clock the watcher settles the flow on. Only the first delivery
		// sets it, so a repeated submit cannot keep pushing the deadline out.
		flow.codeSubmittedAt ??= Date.now();
		return true;
	}

	/** Operator-initiated stop. Tears the container down like any other exit. */
	async cancel(id: string, ownerId: string): Promise<boolean> {
		const flow = this.flows.get(id);
		if (!flow || flow.ownerId !== ownerId) return false;
		await this.finish(id, { status: 'failed', error: 'Sign-in cancelled', code: 'cancelled' });
		return true;
	}

	/** Drop every flow - process shutdown, so nothing is left holding a container. */
	async shutdown(): Promise<void> {
		await Promise.all(
			[...this.flows.keys()].map((id) =>
				this.finish(id, { status: 'failed', error: 'Server shutting down', code: 'cancelled' }),
			),
		);
	}

	/**
	 * Poll the flow's log until it yields a challenge and then a credential.
	 *
	 * A file read rather than a byte stream, because `SandboxFiles` behaves
	 * identically on every backend where an exec channel's stream semantics do
	 * not - Daytona's redirects stderr to a file drained only on close, which
	 * would strand a challenge printed there.
	 */
	private async watch(id: string): Promise<void> {
		const flow = this.flows.get(id);
		if (!flow) return;
		const { driver, engine, containerId, dir, abort } = flow;
		const files = engine.files(containerId, dir);
		const startedAt = Date.now();

		try {
			while (!abort.signal.aborted) {
				const log = await files.read(LOGIN_LOG_FILE).catch(() => '');

				if (flow.state.status === 'starting') {
					const challenge = driver.parseChallenge(log);
					if (challenge) {
						flow.state = {
							status: 'awaiting_user',
							challenge,
							completion: driver.completion,
						};
					} else if (Date.now() - startedAt > driver.challengeTimeoutMs) {
						await this.finish(id, {
							status: 'failed',
							error: `${driver.argv[0]} printed no sign-in link - its output format may have changed`,
							code: 'challenge_timeout',
						});
						return;
					}
				}

				if (flow.state.status === 'awaiting_user') {
					const credential = await this.tryHarvest(flow, files, log);
					if (credential) {
						await this.finish(id, { status: 'succeeded', credential });
						return;
					}
					// The CLI exiting without a credential is terminal: nothing else
					// is going to write one, so waiting out the TTL would only make
					// the operator watch a spinner for fifteen minutes.
					//
					// One last harvest first, against freshly read output. A CLI
					// issues its credential and exits in the same breath, and the log
					// above was read a round trip before this check - so a credential
					// written in between is in the container and not in `log`, and
					// failing on the exit file alone would throw away a sign-in that
					// actually succeeded.
					if (await files.exists(LOGIN_EXIT_FILE)) {
						const final = await files.read(LOGIN_LOG_FILE).catch(() => log);
						const late = await this.tryHarvest(flow, files, final);
						await this.finish(
							id,
							late
								? { status: 'succeeded', credential: late }
								: {
										status: 'failed',
										error: `${driver.argv[0]} exited before a credential was issued`,
										code: 'exited_without_credential',
									},
						);
						return;
					}
					// A refused code leaves the CLI running with its own error on screen,
					// which is a screen nobody is looking at. Checked after the harvest
					// above, so a code that did work is never reported as refused.
					if (
						flow.codeSubmittedAt !== null &&
						Date.now() - flow.codeSubmittedAt > CODE_ACCEPT_TIMEOUT_MS
					) {
						await this.finish(id, {
							status: 'failed',
							error: `${driver.argv[0]} did not accept that code - it may have been mistyped or expired`,
							code: 'code_rejected',
						});
						return;
					}
					if (Date.now() - startedAt > driver.completionTimeoutMs) {
						await this.finish(id, {
							status: 'failed',
							error: 'Sign-in expired before it was completed',
							code: 'completion_timeout',
						});
						return;
					}
				}

				await delay(POLL_INTERVAL_MS, abort.signal);
			}
		} catch (e) {
			await this.finish(id, {
				status: 'failed',
				error: e instanceof Error ? e.message : String(e),
				code: 'internal',
			});
		}
	}

	private async tryHarvest(
		flow: FlowEntry,
		files: ReturnType<ContainerEngine['files']>,
		log: string,
	): Promise<string | null> {
		const { harvest } = flow.driver;
		if (typeof harvest === 'function') return harvest(log);

		// `auth-file`: the runtime's own auth path under the flow's home, so the
		// path a login writes and the path a run reads cannot drift.
		const rel = RUNTIME_HOME_LAYOUTS[flow.runtime].authFileRelative;
		if (!rel) return null;
		const path = `home/${rel}`;
		if (!(await files.exists(path))) return null;
		const contents = await files.read(path).catch(() => '');
		return contents.trim().length > 0 ? contents : null;
	}

	/**
	 * Settle a flow and release its container, exactly once.
	 *
	 * Every exit path lands here - success, each failure, cancel, TTL expiry and
	 * shutdown - so there is one place that can strand a container and it is this
	 * one. Teardown failures are swallowed: the flow's outcome is already decided,
	 * and a container that outlives it is swept by label.
	 */
	private async finish(id: string, state: LoginFlowState): Promise<void> {
		const flow = this.flows.get(id);
		if (!flow) return;
		this.flows.delete(id);
		flow.state = state;
		flow.abort.abort();
		await flow.teardown().catch(() => undefined);

		// A settled flow stays readable briefly so the poll that follows the last
		// state change sees the outcome rather than a bare 404.
		this.settled.set(id, { flow, at: Date.now() });
		for (const [key, held] of this.settled) {
			if (Date.now() - held.at > SETTLED_RETENTION_MS) this.settled.delete(key);
		}
	}

	private readonly settled = new Map<string, { flow: FlowEntry; at: number }>();

	/** State of a flow that has already settled, for the poll that reads the result. */
	getSettled(id: string, ownerId: string): LoginFlow | null {
		const held = this.settled.get(id);
		if (!held || held.flow.ownerId !== ownerId) return null;
		return held.flow;
	}
}

/** How long a settled flow's outcome remains readable to its poller. */
const SETTLED_RETENTION_MS = 60_000;

/**
 * The instance the routes drive.
 *
 * Module-level for the same reason `routes/oauth.ts` keeps its device-flow map
 * there: a flow is bound to a container and a challenge that both die with this
 * process, so there is nothing a second instance could usefully hold and nothing
 * worth persisting. Exported so shutdown can drain it.
 */
export const subscriptionLoginService = new SubscriptionLoginService();
