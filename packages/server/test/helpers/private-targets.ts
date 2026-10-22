import { afterAll, beforeAll } from 'vitest';
import { runtimeConfig, setRuntimeConfig } from '../../src/config/runtime';
import type { HezoConfig } from '../../src/startup';

/**
 * Let this file's server-side fetches reach the stand-in servers it starts.
 *
 * Every server a test can start listens on loopback, which `guardedFetch`
 * refuses unless the operator switch `egress.allowPrivateTargets` is on. A file
 * whose subject is a connector, an OAuth server or a skill URL, rather than the
 * guard itself, turns the switch on for its own duration, the way a self-hoster
 * with a LAN MCP server would. Call it once at the top level of the file.
 */
export function allowPrivateEgressTargets(): void {
	let previous: HezoConfig;
	beforeAll(() => {
		previous = runtimeConfig();
		setRuntimeConfig({ ...previous, egress: { ...previous.egress, allowPrivateTargets: true } });
	});
	afterAll(() => setRuntimeConfig(previous));
}
