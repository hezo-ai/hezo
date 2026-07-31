/**
 * Sandbox-backend metadata shown next to the database and asset backends, and
 * the server-side redaction that makes it safe. Same posture as
 * `AssetStorageInfo` / `StorageInfo`: the API key never exists in client-side
 * memory, because redaction runs on the server once at startup and request
 * handlers only ever see the pre-redacted value.
 */

export type SandboxBackendName = 'docker' | 'daytona';

/** Every backend Hezo can be configured to use, for validating the flag. */
export const SANDBOX_BACKENDS: readonly SandboxBackendName[] = ['docker', 'daytona'];

export function isSandboxBackendName(value: string): value is SandboxBackendName {
	return (SANDBOX_BACKENDS as readonly string[]).includes(value);
}

export interface SandboxBackendInfo {
	backend: SandboxBackendName;
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
