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

/** Restore the unset state. Tests only, so one spec's override cannot leak into the next. */
export function resetRuntimeConfig(): void {
	current = null;
}
