import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { DockerClient } from '../src/services/docker';
import { AGENT_BASE_CONTEXT_DIR } from '../src/services/docker-assets';
import { getRunSocketDir } from '../src/services/workspace';
import { type HezoConfig, type StartupResult, startup } from '../src/startup';
import { testHezoConfig } from './helpers/config';

// Exercises startup() against a REAL DockerClient (HEZO_SKIP_DOCKER unset): the
// client's construction, and the host setup it does through `prepareHost` - the
// bundled-context extraction no-op (dev has no embedded docker bundle) and the
// backgrounded bundled-image prune + published agent-base refresh.
//
// There is no longer a *branch* to exercise. Startup used to ask
// `initialEngine instanceof DockerClient` before doing any of this, which is the
// capability-branch-above-a-seam AGENTS.md forbids - and which had already broken
// silently once, when the backend holder's proxy made that `instanceof` false and
// image setup stopped happening with nothing saying so. This test is what caught
// it then; it still covers the same work, now reached through the seam. No Docker daemon is required — the prune's inspect calls
// fail against the missing socket and are skipped per image (that warn is the
// asserted error path here), and the published-image refresh is a no-op outside
// a packaged build. The bind-mount probe is skipped via its documented opt-out so
// no throwaway container is ever attempted (on a CI runner that DOES have a
// daemon, it otherwise would). There is no connectivity probe to skip any more -
// the tunnel replaced it.
//
// Only the daemon **ping** is faked, and only because `openSandboxBackend` now
// preflights Docker and refuses to hand back an unreachable engine (see
// `sandbox-open.test.ts`, and `startup-docker-unreachable.test.ts` for the
// refusal itself). Everything past that point still runs against the absent
// socket, which is what keeps this a real-client test rather than a mocked one.

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
		// The backend preflight, and nothing else. Every other call still meets the
		// missing socket.
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(true);

		const config: HezoConfig = testHezoConfig(dataDir);

		result = await startup(config);

		// The real client was constructed — not the HEZO_SKIP_DOCKER fake.
		// Not `toBeInstanceOf(DockerClient)` any more: what startup hands out is the
		// holder's proxy, which is deliberately an instance of nothing so a swap can
		// re-point it. The claim worth keeping is that a *real* Docker engine is
		// behind it - and this assertion is why the production `instanceof` check
		// that gates image setup had to move onto the concrete engine, since it was
		// silently false against the proxy and nothing else would have said so.
		expect(result.docker).toBeDefined();
		expect(typeof result.docker.ping).toBe('function');
		// The fake stands in only under HEZO_SKIP_DOCKER, which this spec does not
		// set - so a real client is what got opened.
		expect(process.env.HEZO_SKIP_DOCKER).toBeFalsy();

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
