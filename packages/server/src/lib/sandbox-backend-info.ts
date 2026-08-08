/**
 * Sandbox-backend metadata shown next to the database and asset backends, and
 * the server-side redaction that makes it safe. Same posture as
 * `AssetStorageInfo` / `StorageInfo`: the API key never exists in client-side
 * memory, because redaction runs on the server once at startup and request
 * handlers only ever see the pre-redacted value.
 *
 * The backend names themselves live in `@hezo/shared` ({@link SandboxBackend}),
 * because the web app has to reason about them too - which limits apply, and
 * where the capacity numbers on the concurrency page come from.
 */

import type { SandboxBackend } from '@hezo/shared';

export interface SandboxBackendInfo {
	backend: SandboxBackend;
	/** `local Docker daemon`, or the pre-redacted provider endpoint. */
	display: string;
}

const OCCLUDED = '••••';

/**
 * Reduce a provider API endpoint to a display-safe form: scheme, host and path
 * survive; any userinfo and every query parameter are dropped, since neither is
 * needed to identify the endpoint and either could carry a credential. Anything
 * that is not a parseable absolute URL returns fully occluded - a malformed
 * string may hold a key in an unknown layout, so no fragment of it is echoed.
 */
export function redactSandboxApiUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return OCCLUDED;
	}
	if (!url.host) return OCCLUDED;
	return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
}
