/**
 * Operator-actionable sandbox-backend failure: a backend selected without its
 * credential, a rejected key, or an unreachable API. `index.ts` prints the
 * message verbatim and exits, so the message must carry the guidance itself -
 * and must never include the raw API key; use the redacted endpoint from
 * `sandbox-backend-info.ts`.
 *
 * The point of it being fatal is that a configured managed service must never
 * silently degrade to local Docker. An instance that quietly fell back would
 * look healthy while doing something the operator did not ask for, and the
 * first sign would be an agent run failing for no visible reason.
 */
export class SandboxBackendError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'SandboxBackendError';
	}
}

/**
 * No container runtime is installed on this machine.
 *
 * A `SandboxBackendError` in every respect, carrying the same guidance and
 * killing the boot the same way. It is a distinct type only so the fatal-exit
 * path can recognise the one case where the operator may never read that
 * guidance: on Windows the binary is normally launched from Explorer and owns
 * its console window, which closes with the process, so the message is printed
 * to a window that disappears before it can be read. There the exit stops for a
 * dialog first (`lib/docker-desktop-prompt.ts`).
 *
 * Narrow on purpose. "Installed but not running" is excluded, because the fix
 * there is to start the runtime already on the machine, not to install another.
 */
export class DockerNotInstalledError extends SandboxBackendError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'DockerNotInstalledError';
	}
}

/**
 * A backend that builds from a registry was handed an image only a local Docker
 * daemon can resolve.
 *
 * The reference every project gets by default, `hezo/agent-base:latest`, is a
 * **local build sentinel**: outside a packaged release binary Hezo builds it
 * from the working-tree Dockerfile into the daemon's own image store, and it is
 * published to no registry. A managed backend has no image store to look in - it
 * is handed `FROM <ref>` and pulls - so the name resolves to Docker Hub, finds
 * nothing, and the sandbox dies during build.
 *
 * Worth its own error because of how it presents otherwise: the provider reports
 * a build failure naming a repository the operator never typed, several steps
 * removed from the actual cause, which is that a dev instance switched backends
 * while keeping an image reference only the backend it left could use. The seam
 * is honest - nothing above it learns which backend is in use - but the *image*
 * is not backend-neutral, and this is where that shows.
 */
export class SandboxImageNotPullableError extends Error {
	constructor(image: string, backendName: string) {
		super(
			`The ${backendName} backend cannot use the image "${image}": it is Hezo's local-build ` +
				"reference, built into a Docker daemon's own image store and published to no registry, " +
				'so a managed sandbox service has nothing to pull.\n' +
				'Point this instance at a published image - ' +
				'containers.agentBaseImage: "ghcr.io/hezo-ai/agent-base:<version-or-sha>" - which applies to ' +
				"every project, or set one project's base image on its Container settings. Running on " +
				'the local Docker backend instead needs no image configuration.',
		);
		this.name = 'SandboxImageNotPullableError';
	}
}

/**
 * The channel carrying a run's output died before the command finished.
 *
 * **A property of the transport, not of the agent.** The run's entire stdout
 * arrives over one long-lived connection - a `follow=true` log stream on
 * Daytona, a hijacked attach socket on Docker - held open for as long as the
 * command runs. A remote peer closing an idle one is ordinary: an agent thinking,
 * or waiting on a slow tool call, sends nothing for tens of seconds, and a
 * gateway in front of the provider reaps the connection. (Measured: Bun's `fetch`
 * client imposes no idle timeout of its own, so a mid-stream close is always the
 * far end's doing.)
 *
 * Worth its own type for two reasons. It reached the operator as
 * `The socket connection was closed unexpectedly` - Bun's wording, which names
 * none of the several sockets a run holds and reads like the agent crashed. And
 * it was classified as a run failure, burning the agent's turn and posting a
 * failure ping, when the honest reading is that the infrastructure lost the run:
 * the same class as a driver dying, which already has a bounded retry.
 *
 * Backend-agnostic on purpose. Both transports have the shape, and nothing above
 * the `ContainerEngine` seam may learn which backend is in use.
 */
export class ExecStreamLostError extends Error {
	constructor(transport: string, options?: { cause?: unknown }) {
		const cause = options?.cause;
		const detail = cause instanceof Error ? `: ${cause.message}` : '';
		super(
			`the container's output stream (${transport}) closed before the command finished${detail}`,
			options,
		);
		this.name = 'ExecStreamLostError';
	}
}

/**
 * The container could not be reached: it is stopped, gone, or the backend
 * cannot route to it.
 *
 * A fact about this attempt rather than about the instance, so it earns a
 * bounded retry - the next attempt provisions or resumes a container of its own
 * and finds nothing wrong. Left unclassified it was permanent, and a run lost to
 * a sandbox the provider had stopped underneath it burned the agent's turn and
 * posted a failure ping for infrastructure the agent had no part in.
 *
 * Backend-agnostic on purpose, and translated **inside** each adapter: a
 * provider's own error type may never be classified above the `ContainerEngine`
 * seam. Distinct from a quota or memory-cap refusal, which really is a fact
 * about the instance and stays permanent.
 */
export class ContainerUnreachableError extends Error {
	constructor(detail: string, options?: { cause?: unknown }) {
		super(`the container could not be reached: ${detail}`, options);
		this.name = 'ContainerUnreachableError';
	}
}
