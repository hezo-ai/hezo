/**
 * How a container addresses the Hezo host.
 *
 * A run reaches back to Hezo over four legs, and today every one of them is
 * hardcoded to the same Docker-specific hostname in a different file:
 *
 * - the MCP endpoint (`agent-runner.ts` builds the descriptor URL)
 * - signed asset download URLs (`lib/asset-urls.ts`)
 * - the per-run egress proxy (`services/egress/proxy.ts`)
 * - the per-run ssh-agent TCP listener (`ssh-agent/host.ts`, and the bridge
 *   argv built by `agent-runner.ts` and `chat-session-manager.ts`)
 *
 * That is why they all break together when the address changes - which is
 * exactly what happens when the container stops being local. Defining the
 * address once here is the seam: a backend whose containers are not on the
 * host's Docker bridge supplies different values, and none of the four call
 * sites has to know.
 *
 * `host.docker.internal` is the Docker answer specifically. Containers get it
 * via `ExtraHosts: ['host.docker.internal:host-gateway']` (see
 * `services/containers.ts`), which Docker Desktop tunnels to host loopback and
 * native Linux resolves to the bridge gateway IP. Nothing else should spell the
 * literal.
 */

/**
 * Hostname a container uses for the host, under the Docker backend.
 *
 * Paired with the `ExtraHosts` entry that makes it resolve; changing one
 * without the other silently breaks every callback listed above.
 */
export const DOCKER_CONTAINER_HOST_ALIAS = 'host.docker.internal';

/** The `ExtraHosts` entry that makes {@link DOCKER_CONTAINER_HOST_ALIAS} resolve. */
export const DOCKER_HOST_GATEWAY_ENTRY = `${DOCKER_CONTAINER_HOST_ALIAS}:host-gateway`;

/**
 * The addresses a run hands to its container. Resolved per run by the backend
 * that owns the container, so the call sites consume values rather than
 * spelling a hostname.
 */
export interface RunEndpoints {
	/**
	 * Origin for Hezo's own HTTP surface — the MCP endpoint and signed asset
	 * URLs. Both authenticate for real (a per-run JWT and an HMAC-signed URL
	 * respectively), so neither carries a credential placeholder and both are
	 * NO_PROXY-exempt.
	 */
	hezoBaseUrl: string;
	/** Host the container uses to reach the run's egress proxy. */
	proxyHost: string;
	/** Host the container uses to reach the run's ssh-agent TCP listener. */
	sshHost: string;
}

/** The endpoints a container gets under the Docker backend. */
export function dockerRunEndpoints(serverPort: number): RunEndpoints {
	return {
		hezoBaseUrl: `http://${DOCKER_CONTAINER_HOST_ALIAS}:${serverPort}`,
		proxyHost: DOCKER_CONTAINER_HOST_ALIAS,
		sshHost: DOCKER_CONTAINER_HOST_ALIAS,
	};
}
