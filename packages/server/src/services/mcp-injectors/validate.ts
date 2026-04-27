import { isAbsolute } from 'node:path';
import type { McpInjection, RuntimeMcpAdapter } from './types';

/**
 * Defensive sanity check on the spawn artifacts an adapter emits. Throws on
 * contract violations so a buggy adapter fails loudly instead of silently
 * producing a non-functional spawn. Run by both the agent runner and the
 * adapter unit tests so any contract drift trips CI.
 */
export function validateInjection(adapter: RuntimeMcpAdapter, injection: McpInjection): void {
	for (const file of injection.files) {
		if (!isAbsolute(file.hostPath)) {
			throw new Error(`mcp injection file path must be absolute: ${file.hostPath}`);
		}
		if (file.mode <= 0 || file.mode > 0o777) {
			throw new Error(`mcp injection file mode out of range: ${file.mode}`);
		}
		if (file.contents.length === 0) {
			throw new Error(`mcp injection file is empty: ${file.hostPath}`);
		}
	}

	const seenEnvKeys = new Set<string>();
	for (const entry of injection.envEntries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			throw new Error(`mcp env entry must be KEY=VALUE: ${entry}`);
		}
		const key = entry.slice(0, eq);
		if (seenEnvKeys.has(key)) {
			throw new Error(`mcp env entry duplicates key: ${key}`);
		}
		seenEnvKeys.add(key);
	}

	if (adapter.capabilities.bearerTokenStorage === 'env-var') {
		// Tokens passed via env must not also be inlined in any file.
		for (const file of injection.files) {
			if (/Bearer [A-Za-z0-9._-]{8,}/.test(file.contents)) {
				throw new Error(
					`adapter declared env-var bearer storage but inlined a bearer token in ${file.hostPath}`,
				);
			}
		}
	}
}
