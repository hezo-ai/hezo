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
				'HEZO_AGENT_BASE_IMAGE=ghcr.io/hezo-ai/agent-base:<version-or-sha> - which applies to ' +
				"every project, or set one project's base image on its Container settings. Running on " +
				'the local Docker backend instead needs no image configuration.',
		);
		this.name = 'SandboxImageNotPullableError';
	}
}
