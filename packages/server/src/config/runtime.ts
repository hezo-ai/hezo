import { DEFAULT_CONFIG, type HezoConfig } from './types';

/**
 * The process-wide resolved configuration.
 *
 * `index.ts` sets this immediately after `resolveConfig()`, before `startup()`.
 * It has to be an accessor rather than a value threaded through every caller
 * because service modules are imported before that call runs (`index.ts` imports
 * `./app` first), so anything reading config at module scope would read it too
 * early. Read it inside the function that needs it, never into a module-level
 * `const`.
 */
let current: HezoConfig | null = null;

export function setRuntimeConfig(config: HezoConfig): void {
	current = config;
}

/**
 * The resolved config, or the built-in defaults when nothing has been set - the
 * case for a unit test that imports a service without booting the server. That
 * mirrors the `process.env.X ?? default` reads this replaced, so no test has to
 * arrange config it does not care about.
 */
export function runtimeConfig(): HezoConfig {
	return current ?? DEFAULT_CONFIG;
}

/**
 * Replace the pinned-settings slice, and only that slice.
 *
 * The narrow counterpart to {@link setRuntimeConfig}: a deployment can change
 * what it pins while the server runs, and a restart would kill in-flight agent
 * runs - billed container time thrown away. Every reader already calls
 * `runtimeConfig()` inside the function that needs it rather than capturing it
 * at module scope (see above), so a swapped slice is picked up on the next call
 * with no call-site changes. That accessor discipline is what makes this cheap.
 *
 * Deliberately not a general "patch the config" entry point. Most keys - data
 * dir, port, database URL - genuinely cannot change while running, and a setter
 * that could reach them would imply they can.
 */
export function setPolicy(policy: HezoConfig['policy']): void {
	const previous = runtimeConfig().policy;
	current = { ...runtimeConfig(), policy };
	for (const listener of policyListeners) listener(previous, policy);
}

/**
 * Called with the policy before and after each swap.
 *
 * **For state the policy decides that lives outside this config**, such as a
 * database row the instance keeps in step with it. A reader of the config itself
 * needs none of this: it calls `runtimeConfig()` and sees the new slice.
 *
 * Synchronous, and called inside `setPolicy`: a listener with async work hands
 * it to `trackBackground` and returns, and must not throw.
 */
export type PolicyListener = (previous: HezoConfig['policy'], next: HezoConfig['policy']) => void;

const policyListeners = new Set<PolicyListener>();

/** Listen for policy swaps. Returns the call that stops listening. */
export function onPolicyChange(listener: PolicyListener): () => void {
	policyListeners.add(listener);
	return () => {
		policyListeners.delete(listener);
	};
}

/** Restore the unset state. Tests only, so one spec's override cannot leak into the next. */
export function resetRuntimeConfig(): void {
	current = null;
	policyListeners.clear();
}
