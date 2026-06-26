import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { logger } from '../logger';
import type { DockerClient } from './docker';
import { EGRESS_PORT_RANGE_END, EGRESS_PORT_RANGE_START } from './egress/port-allocator';
import { ensureImage } from './ensure-image';
import { MANAGED_AGENT_BASE_IMAGE, resolveAgentBaseImage } from './image-registry';

const log = logger.child('connectivity-preflight');

/**
 * Operator opt-out for the boot-time container→host connectivity check. For the
 * rare setup whose container↔host path works via a route this probe can't model
 * (custom networking, an external proxy) and who doesn't want the check booting
 * a throwaway container each start. Never surfaced in the failure guidance — it
 * suppresses the diagnosis, it doesn't fix the underlying problem.
 */
export const SKIP_CONNECTIVITY_ENV = 'HEZO_SKIP_CONTAINER_CONNECTIVITY_CHECK';

/** Where the user-facing networking/firewall guidance lives. */
export const NETWORKING_DOCS_URL = 'https://hezo.ai/docs/deployment/self-hosting';

export type ConnectivityOutcome = 'ok' | 'mcp-unreachable' | 'bind-loopback' | 'bind-firewalled';

export interface ConnectivityProbeResult {
	/** A container could open an HTTP connection to the MCP/web port on the host. */
	mcpReachable: boolean;
	/** A container could reach a throwaway listener bound at `containerBindHost`. */
	bindReachable: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/** Whether `host` is a loopback address — bound there, a host port is
 * unreachable from a container on native-Linux Docker (bridge gateway path). */
export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Decide the connectivity outcome from the two container→host probes. MCP
 * reachability (the server's own `0.0.0.0` port) is the firewall signal; the
 * bind probe (a listener at `containerBindHost`) is the egress/SSH signal — a
 * loopback bind is unreachable from a container on native-Linux Docker, while a
 * non-loopback bind that is still unreachable points at the firewall.
 */
export function classifyConnectivity(
	result: ConnectivityProbeResult,
	containerBindHost: string,
): ConnectivityOutcome {
	if (!result.mcpReachable) return 'mcp-unreachable';
	if (result.bindReachable) return 'ok';
	return isLoopbackHost(containerBindHost) ? 'bind-loopback' : 'bind-firewalled';
}

/**
 * Parse the probe container's `MCP:<code> BIND:<code>` stdout line. A real HTTP
 * status (1xx–5xx) means reachable; curl's `000` (connect failure / timeout),
 * `DOWN`, or a missing marker means not.
 */
export function parseProbeOutput(stdout: string): ConnectivityProbeResult {
	const read = (key: string): boolean => {
		const m = stdout.match(new RegExp(`${key}:(\\d{3}|DOWN)`));
		return m ? /^[1-5]\d\d$/.test(m[1]) : false;
	};
	return { mcpReachable: read('MCP'), bindReachable: read('BIND') };
}

const FAILURE_HEADER = [
	'Agent containers cannot reach this Hezo server on the host.',
	'',
	'Agents run inside Docker containers and call back to the host for their tools',
	'(the MCP server) and outbound traffic (the egress proxy). Until the',
	'container→host path works, agent runs and the CEO chat hang with no tools and',
	'produce nothing.',
	'',
];

/**
 * Operator-actionable guidance for a failed connectivity check, logged at boot.
 * Mirrors the Docker/port preflights: a one-line diagnosis, then the exact
 * remedy (the firewall rule, or the `--container-bind-host` flag), plus a docs
 * pointer. Never surfaces `HEZO_SKIP_DOCKER` / the opt-out env (those hide the
 * symptom rather than fix it).
 */
export function formatContainerConnectivityMessage(
	outcome: Exclude<ConnectivityOutcome, 'ok'>,
	opts: { serverPort: number; containerBindHost: string },
): string {
	const { serverPort, containerBindHost } = opts;

	if (outcome === 'mcp-unreachable') {
		return [
			...FAILURE_HEADER,
			`A container timed out reaching the MCP server at http://host.docker.internal:${serverPort}/mcp.`,
			'The server listens on all interfaces, so this is almost always the host',
			'firewall dropping traffic from the Docker bridge to the host — Docker does',
			'not open that path for you (Docker Desktop tunnels it, native Linux does not).',
			'',
			'Allow the Docker bridge to reach the host, e.g. with ufw:',
			'',
			`  sudo ufw allow in on docker0 to any port ${serverPort} proto tcp`,
			'  sudo ufw allow in on docker0 to any port 20000:29999 proto tcp',
			'  sudo ufw reload',
			'',
			'Using a custom bridge network? Replace docker0 with its interface. On raw',
			'iptables, insert ACCEPT rules for `-i docker0` to those ports; firewalld',
			'usually trusts docker0 already.',
			'',
			`More detail: ${NETWORKING_DOCS_URL}`,
		].join('\n');
	}

	if (outcome === 'bind-loopback') {
		return [
			...FAILURE_HEADER,
			'The MCP server is reachable, but the egress proxy and SSH bridge bind to',
			`${containerBindHost} (loopback), which a container on native-Linux Docker cannot`,
			'reach via host.docker.internal. Outbound API calls, credentialed requests, and',
			'git-over-SSH will fail even though the MCP tools load.',
			'',
			'Bind them to all interfaces, then firewall-restrict the range to the bridge:',
			'',
			'  HEZO_CONTAINER_BIND_HOST=0.0.0.0 hezo      # or --container-bind-host 0.0.0.0',
			'  sudo ufw allow in on docker0 to any port 20000:29999 proto tcp',
			'  sudo ufw reload',
			'',
			`More detail: ${NETWORKING_DOCS_URL}`,
		].join('\n');
	}

	// bind-firewalled: the bind host is non-loopback but the range is still blocked.
	return [
		...FAILURE_HEADER,
		'The MCP server is reachable, but a container could not reach the egress proxy /',
		`SSH bridge port range on the host (bound to ${containerBindHost}). Outbound API`,
		'calls, credentialed requests, and git-over-SSH will fail.',
		'',
		'Open the Docker bridge to the host for the egress range:',
		'',
		'  sudo ufw allow in on docker0 to any port 20000:29999 proto tcp',
		'  sudo ufw reload',
		'',
		`More detail: ${NETWORKING_DOCS_URL}`,
	].join('\n');
}

/**
 * The shell the probe container runs: curl the MCP/web port and the throwaway
 * bind-host listener, printing `MCP:<code> BIND:<code>` for the host to classify.
 * `curl -w '%{http_code}'` prints `000` on a connect failure/timeout, so a
 * blocked path reads as unreachable without the shell needing to branch on exit.
 */
export function buildProbeScript(serverPort: number, bindPort: number): string {
	const probe = (name: string, url: string) =>
		`${name}=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${url} 2>/dev/null) || true; ` +
		`[ -z "$${name}" ] && ${name}=DOWN`;
	return (
		`${probe('mcp', `http://host.docker.internal:${serverPort}/mcp`)}; ` +
		`${probe('bind', `http://host.docker.internal:${bindPort}/`)}; ` +
		`printf 'MCP:%s BIND:%s\\n' "$mcp" "$bind"`
	);
}

interface ProbeListener {
	port: number;
	close: () => void;
}

const PROBE_RANGE_SPAN = EGRESS_PORT_RANGE_END - EGRESS_PORT_RANGE_START + 1;
const PROBE_BIND_ATTEMPTS = 20;

/**
 * A throwaway listener bound at `bindHost` that answers any connection with a
 * tiny HTTP 200 and closes — used to test whether a container can reach a host
 * port bound at the configured interface (the egress/SSH bind host). Binds a
 * free port **inside the egress front-proxy range** (20000–29999) so the probe
 * models the real egress ports: the firewall guidance (open that range) then
 * fixes exactly what failed, with no false alarm from an out-of-range ephemeral
 * port. A loopback bind is unreachable from a container at any port, so this
 * still catches the bind-host misconfig too. Starts at a random offset to avoid
 * colliding with a live per-run proxy on the low ports.
 */
function startProbeListener(bindHost: string): Promise<ProbeListener> {
	const startOffset = randomBytes(2).readUInt16BE(0) % PROBE_RANGE_SPAN;
	return new Promise((resolve, reject) => {
		const tryBind = (attempt: number): void => {
			if (attempt >= PROBE_BIND_ATTEMPTS) {
				reject(new Error('no free port in the egress range for the connectivity probe'));
				return;
			}
			const port = EGRESS_PORT_RANGE_START + ((startOffset + attempt) % PROBE_RANGE_SPAN);
			const server = createServer((socket) => {
				socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
			});
			server.once('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EADDRINUSE') tryBind(attempt + 1);
				else reject(err);
			});
			server.listen(port, bindHost, () => {
				resolve({ port, close: () => server.close() });
			});
		};
		tryBind(0);
	});
}

export interface ConnectivityProbeDeps {
	docker: DockerClient;
	image: string;
	serverPort: number;
	containerBindHost: string;
}

/**
 * Boot a throwaway container on the default bridge and have it curl back to the
 * host — once at the MCP/web port and once at a listener bound at
 * `containerBindHost`. Mirrors project provisioning (sleep-infinity container +
 * exec), with `host.docker.internal:host-gateway` so the bridge gateway resolves.
 * Always tears the container down.
 */
async function runContainerProbe(deps: ConnectivityProbeDeps): Promise<ConnectivityProbeResult> {
	const { docker, image, serverPort, containerBindHost } = deps;
	const listener = await startProbeListener(containerBindHost);
	const name = `hezo-connectivity-check-${randomBytes(4).toString('hex')}`;
	let containerId: string | null = null;
	try {
		const { Id } = await docker.createContainer(name, {
			Image: image,
			Cmd: ['sleep', 'infinity'],
			Labels: { 'ai.hezo.role': 'connectivity-preflight' },
			HostConfig: { ExtraHosts: ['host.docker.internal:host-gateway'] },
		});
		containerId = Id;
		await docker.startContainer(Id);
		const execId = await docker.execCreate(Id, {
			Cmd: ['sh', '-c', buildProbeScript(serverPort, listener.port)],
			AttachStdout: true,
			AttachStderr: true,
		});
		const { stdout } = await docker.execStart(execId);
		return parseProbeOutput(stdout);
	} finally {
		listener.close();
		if (containerId) {
			await docker.removeContainer(containerId, true).catch((err: unknown) => {
				log.warn('failed to remove connectivity-probe container', { error: String(err) });
			});
		}
	}
}

export interface ConnectivityCheckDeps {
	docker: DockerClient;
	serverPort: number;
	containerBindHost: string;
	/** Injectable for tests; defaults to the real throwaway-container probe. */
	probe?: (deps: ConnectivityProbeDeps) => Promise<ConnectivityProbeResult>;
	env?: NodeJS.ProcessEnv;
	/** Probe attempts before logging a non-ok result (default 3). */
	attempts?: number;
	/** Gap between retries in ms (default 2000); 0 in tests. */
	retryGapMs?: number;
}

const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_GAP_MS = 2000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify a container can actually reach back to the host (MCP server + egress
 * bridge) and log operator-actionable guidance when it can't. Best-effort and
 * **non-fatal**: it never throws and never gates startup — unlike the Docker /
 * port preflights, exiting here would also take down the web UI the operator
 * needs to read the guidance and reconfigure. Skipped under `HEZO_SKIP_DOCKER`
 * (fake docker / tests) and the documented opt-out. Retries on a non-ok result
 * to absorb a transient race before logging the (alarming) failure message.
 */
export async function checkContainerToHostConnectivity(
	deps: ConnectivityCheckDeps,
): Promise<ConnectivityOutcome | 'skipped'> {
	const env = deps.env ?? process.env;
	if (env.HEZO_SKIP_DOCKER || env[SKIP_CONNECTIVITY_ENV]) return 'skipped';

	try {
		const { image, preferPull } = resolveAgentBaseImage(MANAGED_AGENT_BASE_IMAGE);
		await ensureImage(deps.docker, image, { preferPull });
		const probe = deps.probe ?? runContainerProbe;
		const attempts = deps.attempts ?? PROBE_ATTEMPTS;
		const retryGapMs = deps.retryGapMs ?? PROBE_RETRY_GAP_MS;

		let result: ConnectivityProbeResult = { mcpReachable: false, bindReachable: false };
		for (let attempt = 0; attempt < attempts; attempt++) {
			result = await probe({
				docker: deps.docker,
				image,
				serverPort: deps.serverPort,
				containerBindHost: deps.containerBindHost,
			});
			if (classifyConnectivity(result, deps.containerBindHost) === 'ok') break;
			if (attempt < attempts - 1 && retryGapMs > 0) await delay(retryGapMs);
		}

		const outcome = classifyConnectivity(result, deps.containerBindHost);
		if (outcome === 'ok') {
			log.info('container→host connectivity OK (MCP + egress bridge reachable from a container)');
			return outcome;
		}
		log.error(
			`\n${formatContainerConnectivityMessage(outcome, {
				serverPort: deps.serverPort,
				containerBindHost: deps.containerBindHost,
			})}\n`,
		);
		return outcome;
	} catch (err) {
		// Diagnostics must never break startup. If the probe machinery itself
		// fails (image unavailable offline, Docker hiccup), stay quiet at info —
		// container provisioning would surface a real image/Docker fault anyway.
		log.info('container→host connectivity check skipped (probe unavailable)', {
			error: err instanceof Error ? err.message : String(err),
		});
		return 'skipped';
	}
}
