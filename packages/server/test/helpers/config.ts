import type { HezoConfig } from '../../src/startup';

/**
 * A complete {@link HezoConfig} for a test that boots `startup()`.
 *
 * One builder rather than a literal per startup spec: four files were each
 * hand-rolling the same object, so every new required field broke all four at
 * once and each got a slightly different value. The defaults here are the
 * inert ones - port 0, no telemetry, no auto-install - so a test only states
 * the field it is actually exercising.
 *
 * `Object.assign` rather than a `...overrides` spread: spreading a Partial
 * widens every key it names to `T | undefined`, which would defeat the point of
 * returning a complete config.
 */
export function testHezoConfig(dataDir: string, overrides: Partial<HezoConfig> = {}): HezoConfig {
	return Object.assign<HezoConfig, Partial<HezoConfig>>(
		{
			port: 0,
			dataDir,
			webUrl: '',
			reset: false,
			open: false,
			logLevel: 'info',
			keepOldContainers: false,
			autoInstallUpdates: false,
			egressProxyAuth: true,
			// Inert like the rest: the destination guard stays *on*, which is the
			// production posture. A test that needs to reach a private target says so.
			egressAllowPrivateTargets: false,
			telemetry: { enabled: false, endpoint: 'https://example.invalid/telemetry' },
		},
		overrides,
	);
}
