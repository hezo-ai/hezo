/**
 * How a container addresses the Hezo host.
 *
 * A container reaches back to Hezo over three legs, and each used to be
 * hardcoded to the same Docker-specific hostname in a different file:
 *
 * - the MCP endpoint and signed asset download URLs (`agent-runner.ts` builds
 *   the descriptor URL, `lib/asset-urls.ts` the download URLs)
 * - the egress proxy (`services/egress/proxy.ts`)
 * - the ssh-agent TCP listener (`ssh-agent/host.ts`, and the bridge argv built
 *   by `agent-runner.ts` and `chat-session-manager.ts`)
 *
 * That is why they all broke together when the address changed - which is
 * exactly what happens when the container stops being local.
 *
 * **There is one answer, and it is the tunnel.** Every leg points at container
 * loopback, where the tunnel client listens; the host is never named at all,
 * which is precisely why it works for a container that is not on this machine.
 * A backend therefore needs no `ExtraHosts` entry, no route from the container
 * to the host, and no inbound reachability - see `sandbox/tunnel/`.
 *
 * Naming the host directly *would* work on a local daemon, and an earlier
 * revision kept it as a second path for exactly that reason. It was a mistake:
 * two ways of addressing Hezo means the network stack has two shapes, and the
 * shape local dev and CI exercise is not the one a managed backend runs
 * (AGENTS.md § One mechanism, no silent fallbacks). Docker goes through the
 * tunnel too, over the same code, so a bug reproduces in both places.
 */

/**
 * Hostname that resolves to the operator's own machine from inside a container
 * on a local Docker daemon, via the `ExtraHosts` entry below.
 *
 * **This is not how a container reaches Hezo** - that is the tunnel, above, on
 * every backend. It survives for one unrelated reason: an operator can point a
 * *local model provider* at their own machine (`http://host.docker.internal:11434`
 * for Ollama), and the container dials that host directly as it would any other
 * model-provider endpoint. Nothing Hezo constructs spells this literal.
 */
export const DOCKER_CONTAINER_HOST_ALIAS = 'host.docker.internal';

/** The `ExtraHosts` entry that makes {@link DOCKER_CONTAINER_HOST_ALIAS} resolve. */
export const DOCKER_HOST_GATEWAY_ENTRY = `${DOCKER_CONTAINER_HOST_ALIAS}:host-gateway`;

/**
 * The addresses a container gets, for one tunnel. All loopback; see the note on
 * {@link TunnelPorts} for why the ports are allocated rather than fixed.
 */
export interface RunEndpoints {
	/**
	 * Origin for Hezo's own HTTP surface — the MCP endpoint and signed asset
	 * URLs. Both authenticate for real (a per-run JWT and an HMAC-signed URL
	 * respectively), so neither carries a credential placeholder and both are
	 * NO_PROXY-exempt.
	 */
	hezoBaseUrl: string;
	/** Host the container uses to reach the egress proxy. */
	proxyHost: string;
	/** Port the container uses to reach the egress proxy. */
	proxyPort: number;
	/** Host the container uses to reach the ssh-agent TCP listener. */
	sshHost: string;
	/** Port the container uses to reach the ssh-agent TCP listener. */
	sshPort: number;
}

/** Loopback ports one tunnel client listens on, one per target key. */
export interface TunnelPorts {
	proxy: number;
	mcp: number;
	ssh: number;
}

/**
 * Range the in-container listen ports are drawn from.
 *
 * High enough to sit clear of anything an agent is likely to bind while
 * developing, and inside the container's own network namespace either way - so
 * these never collide with a host port or with another container.
 */
export const TUNNEL_PORT_BASE = 47080;
export const TUNNEL_PORT_RANGE = 300;

/**
 * The addresses a container uses to reach Hezo through one tunnel.
 *
 * Loopback throughout, because the tunnel client is *in* the container.
 */
export function tunnelRunEndpoints(ports: TunnelPorts): RunEndpoints {
	return {
		hezoBaseUrl: `http://127.0.0.1:${ports.mcp}`,
		proxyHost: '127.0.0.1',
		proxyPort: ports.proxy,
		sshHost: '127.0.0.1',
		sshPort: ports.ssh,
	};
}
