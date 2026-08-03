import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { DockerClient } from '../src/services/docker';
import { AGENT_BASE_CONTEXT_DIR } from '../src/services/docker-assets';
import { getRunSocketDir } from '../src/services/workspace';
import { type HezoConfig, type StartupResult, startup } from '../src/startup';

// Exercises startup()'s REAL-Docker branch (HEZO_SKIP_DOCKER unset): the
// DockerClient construction, the bundled-context extraction no-op (dev has no
// embedded docker bundle), and the backgrounded bundled-image prune + published
// agent-base refresh. No Docker daemon is required — the prune's inspect calls
// fail against the missing socket and are skipped per image (that warn is the
// asserted error path here), and the published-image refresh is a no-op outside
// a packaged build. The container→host connectivity probe and the bind-mount
// probe are skipped via their documented opt-outs so no throwaway container is
// ever attempted (on a CI runner that DOES have a daemon, they otherwise would).

describe('startup real-Docker branch (no daemon required)', () => {
	let dataDir: string;
	let result: StartupResult | null = null;
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		savedEnv.HEZO_SKIP_DOCKER = process.env.HEZO_SKIP_DOCKER;
		savedEnv.HEZO_SKIP_PRICING_REFRESH = process.env.HEZO_SKIP_PRICING_REFRESH;
		savedEnv.HEZO_SKIP_CONTAINER_CONNECTIVITY_CHECK =
			process.env.HEZO_SKIP_CONTAINER_CONNECTIVITY_CHECK;
		savedEnv.HEZO_SKIP_MOUNT_CHECK = process.env.HEZO_SKIP_MOUNT_CHECK;
		delete process.env.HEZO_SKIP_DOCKER;
		process.env.HEZO_SKIP_PRICING_REFRESH = '1';
		process.env.HEZO_SKIP_CONTAINER_CONNECTIVITY_CHECK = '1';
		process.env.HEZO_SKIP_MOUNT_CHECK = '1';
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-real-docker-'));
	});

	afterAll(async () => {
		if (result) {
			result.jobManager.shutdown();
			await result.chatSessionManager.stop();
			await waitForBackground();
			await result.db.close().catch(() => undefined);
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(getRunSocketDir(dataDir), { recursive: true, force: true });
	});

	it('boots with a real DockerClient, skipping bundled-context extraction and pruning best-effort', async () => {
		// The prune's per-image `inspect ... failed` warn (docker socket absent) is
		// the error path this test asserts; capture it instead of printing it.
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		const config: HezoConfig = {
			port: 0,
			dataDir,
			webUrl: '',
			reset: false,
			open: false,
			logLevel: 'info',
			keepOldContainers: false,
			containerBindHost: '127.0.0.1',
			telemetry: { enabled: false, endpoint: 'https://example.invalid/telemetry' },
		};

		result = await startup(config);

		// The real client was constructed — not the HEZO_SKIP_DOCKER fake.
		expect(result.docker).toBeInstanceOf(DockerClient);

		// Dev/source has no embedded docker bundle, so nothing was extracted.
		expect(existsSync(join(dataDir, AGENT_BASE_CONTEXT_DIR))).toBe(false);

		// Startup is fully usable without a docker daemon.
		expect(result.masterKeyState).toBe('unset');
		const health = await result.app.request('/health');
		expect(health.status).toBe(200);

		// The default (HQ) team still seeds — pure DB work, no docker involved.
		const teams = await result.db.query<{ slug: string }>('SELECT slug FROM teams');
		expect(teams.rows.map((r) => r.slug)).toContain('default');

		// The backgrounded prune ran against the missing socket and skipped each
		// bundled image with a warn instead of failing startup.
		await waitForBackground();
		expect(
			logSpy.mock.calls.some((c) => String(c[0]).includes('pruneStaleBundledImages: inspect')),
		).toBe(true);
		vi.restoreAllMocks();
	}, 60_000);
});
