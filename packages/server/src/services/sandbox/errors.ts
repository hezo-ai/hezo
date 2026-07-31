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
