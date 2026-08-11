/**
 * The conformance set: **every** assertion a container backend must satisfy,
 * behind one entry point.
 *
 * A fixture calls this and nothing else. That is the whole design:
 *
 * - **A new adapter gets the full set for free.** Modal, E2B, whatever comes
 *   next - it writes a `LiveAdapterFixture` and one call, and cannot ship having
 *   quietly registered four of the six suites.
 * - **A new suite reaches every existing adapter for free.** Adding one here is
 *   the only step; no fixture is edited, so no backend is left behind by a suite
 *   whose author did not know all the fixtures.
 *
 * Both directions used to be manual - a line per suite in each fixture file -
 * which is the shape where coverage silently diverges between backends. That
 * matters more than it sounds: the value of this directory is that a divergence
 * shows up as a *shared* assertion failing on one backend, and a suite only some
 * fixtures register stops describing the interface and starts describing whoever
 * remembered to add it.
 *
 * Order is deliberate: cheap and structural first (engine, files), then the ones
 * that provision and talk to the outside world, so a backend that is broken in a
 * basic way fails fast rather than after a slow agent run.
 */

import { describeAgentCliConformance } from './agent-cli';
import { describeEgressConformance } from './egress';
import { describeEngineConformance } from './engine';
import { describeFilesConformance } from './files';
import type { ConformanceHarness, LiveAdapterFixture } from './fixture';
import { describeGitConformance } from './git';
import { describeTunnelConformance } from './tunnel';

/**
 * Register every conformance suite against one backend.
 *
 * @param fixture what this backend supplies - see {@link LiveAdapterFixture} for
 *   the flags a backend uses to declare something it legitimately cannot answer.
 * @param harness the runner's `describe`/`it`/`expect`, injected because the
 *   Docker fixture runs under `bun test` and the managed ones under vitest.
 */
export function describeContainerBackendConformance(
	fixture: LiveAdapterFixture,
	harness: ConformanceHarness,
): void {
	describeEngineConformance(fixture, harness);
	describeFilesConformance(fixture, harness);
	describeTunnelConformance(fixture, harness);
	describeEgressConformance(fixture, harness);
	describeGitConformance(fixture, harness);
	describeAgentCliConformance(fixture, harness);
}
