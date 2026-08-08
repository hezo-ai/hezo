import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DockerClient } from '../src/services/docker';
import { SandboxBackendError } from '../src/services/sandbox/errors';
import { getRunSocketDir } from '../src/services/workspace';
import { type HezoConfig, startup } from '../src/startup';
import { testHezoConfig } from './helpers/config';

/**
 * Docker is a backend like any other here, so it fails like any other: a
 * selected backend that cannot be reached aborts startup.
 *
 * This used to be a gate at the top of `index.ts`, which ran before the database
 * was open and could therefore only read the **launch flag** - while the stored
 * setting is what actually selects the backend. An instance switched to a
 * managed backend from the Containers page and restarted on a host without
 * Docker exited 1, printing Docker install guidance for a backend it would never
 * use. Being module-top-level, it was also unreachable from a test.
 *
 * Moving it into `openSandboxBackend` fixed both: the check now runs after the
 * stored backend is resolved, and it is exercised here. `index.ts` turns the
 * thrown `SandboxBackendError` into the same fatal exit the gate produced, with
 * a startup-failure breadcrumb the gate did not leave.
 */
describe('startup refuses an unreachable Docker daemon', () => {
	let dataDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		savedEnv.HEZO_SKIP_DOCKER = process.env.HEZO_SKIP_DOCKER;
		savedEnv.HEZO_SKIP_PRICING_REFRESH = process.env.HEZO_SKIP_PRICING_REFRESH;
		delete process.env.HEZO_SKIP_DOCKER;
		process.env.HEZO_SKIP_PRICING_REFRESH = '1';
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-docker-down-'));
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(getRunSocketDir(dataDir), { recursive: true, force: true });
	});

	it('aborts with actionable guidance instead of booting a server that cannot run an agent', async () => {
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(false);
		const config: HezoConfig = testHezoConfig(dataDir);

		// Pays the real 2s/4s backoff, deliberately: the retry override is an option
		// on `openSandboxBackend`, not a config field, and widening production
		// config to shave six seconds off one test is the wrong trade.
		const err = await startup(config).catch((e) => e);

		expect(err).toBeInstanceOf(SandboxBackendError);
		// `index.ts` prints this verbatim, so it is the operator's whole diagnosis.
		expect(err.message).toContain('Docker');
		expect(err.message).toContain('--sandbox-backend');
		vi.restoreAllMocks();
	}, 60_000);
});
