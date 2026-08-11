import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_BACKENDS, SandboxBackend } from '@hezo/shared';
import { describe, expect, it } from 'vitest';

/**
 * Every container backend runs the **whole** conformance set, and this is what
 * makes that true rather than customary.
 *
 * The set only means anything if it runs everywhere. A suite some fixtures
 * register and others do not stops describing `ContainerEngine` and starts
 * describing whichever backend's author remembered it - and the failure is
 * silent, because a fixture that registers four of six suites is green.
 *
 * Two rules, checked here because the compiler cannot see either:
 *
 * 1. **Every suite in `conformance/` is in the aggregate.** Adding a file there
 *    and forgetting the one line in `conformance/index.ts` would leave it
 *    running against nothing at all.
 * 2. **Every fixture calls the aggregate, and only the aggregate.** A fixture
 *    that hand-picks suites is how (1) stops helping: the aggregate could be
 *    complete and a backend still skip half of it.
 *
 * Together they mean a new adapter gets the full set by writing one call, and a
 * new suite reaches every existing adapter without touching a fixture. Both
 * directions were manual before, which is the shape where coverage quietly
 * diverges between backends.
 *
 * A fixture is found by looking for the aggregate's import rather than by a
 * naming convention, so a backend added under any filename is still covered.
 */

const CONFORMANCE_DIR = join(__dirname, 'conformance');
const AGGREGATE = join(CONFORMANCE_DIR, 'index.ts');

/** Files under `conformance/` that are suites rather than shared plumbing. */
const NOT_SUITES = new Set(['index.ts', 'fixture.ts']);

/** Where a backend's entry point may live. Both runners, one contract. */
const FIXTURE_DIRS = [join(__dirname, 'bun'), join(__dirname, 'live')];

/**
 * Does this fixture stand up the named backend?
 *
 * Matched on the engine class the adapter exports rather than on the enum string,
 * because a fixture constructs an engine and never needs to name the backend it
 * is: `DockerClient` for `docker`, `DaytonaEngine` for `daytona`. A new backend
 * adds its row here alongside its adapter.
 */
const BACKEND_ENGINE_CLASS: Record<SandboxBackend, string> = {
	[SandboxBackend.Docker]: 'DockerClient',
	[SandboxBackend.Daytona]: 'DaytonaEngine',
};

function backendMentioned(src: string, backend: SandboxBackend): boolean {
	return src.includes(BACKEND_ENGINE_CLASS[backend]);
}

function suiteFiles(): string[] {
	return readdirSync(CONFORMANCE_DIR)
		.filter((f) => f.endsWith('.ts') && !NOT_SUITES.has(f))
		.sort();
}

/** Every file that imports the aggregate - i.e. every backend's entry point. */
function fixtureFiles(): string[] {
	const found: string[] = [];
	for (const dir of FIXTURE_DIRS) {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.ts')) continue;
			const path = join(dir, name);
			if (readFileSync(path, 'utf8').includes("from '../conformance'")) found.push(path);
		}
	}
	return found.sort();
}

describe('conformance coverage', () => {
	it('runs every suite in the directory from the aggregate', () => {
		const aggregate = readFileSync(AGGREGATE, 'utf8');
		const missing = suiteFiles().filter((f) => !aggregate.includes(`./${f.replace(/\.ts$/, '')}`));
		expect(
			missing,
			`conformance/index.ts does not import: ${missing.join(', ')}. A suite outside the ` +
				'aggregate runs against no backend at all.',
		).toEqual([]);
	});

	it('calls each of them, not just imports them', () => {
		// An import with no call is the same as no import, and reads as covered.
		const aggregate = readFileSync(AGGREGATE, 'utf8');
		const calls = [...aggregate.matchAll(/(describe\w+Conformance)\(fixture, harness\)/g)].map(
			(m) => m[1],
		);
		const imported = [...aggregate.matchAll(/import \{ (describe\w+Conformance) \}/g)].map(
			(m) => m[1],
		);
		expect(imported.length).toBeGreaterThan(0);
		expect([...calls].sort()).toEqual([...imported].sort());
	});

	it('has at least two backends wired to it', () => {
		// The set is only a cross-backend contract if more than one backend runs
		// it; with one, a divergence has nothing to diverge from.
		expect(fixtureFiles().length).toBeGreaterThanOrEqual(2);
	});

	it('wires up every backend Hezo actually supports, local and managed alike', () => {
		// Counted against the production enum rather than a number, because the
		// failure this prevents is a *new* backend shipping with no fixture: ">= 2"
		// is satisfied by the two that already exist, so a third would land
		// uncovered and nothing would say so. Every suite here - the agent-CLI
		// matrix included - is only a contract to the extent it runs on each
		// backend a user can actually select.
		const wired = fixtureFiles().map((p) => readFileSync(p, 'utf8'));
		const missing = SANDBOX_BACKENDS.filter(
			(backend) => !wired.some((src) => backendMentioned(src, backend)),
		);
		expect(
			missing,
			`no conformance fixture for: ${missing.join(', ')}. Every backend in ` +
				'`SandboxBackend` needs one under test/bun/ (local, runs in CI) or ' +
				'test/live/ (managed, manual and opt-in), or it is supported in production ' +
				'and proven nowhere.',
		).toEqual([]);
	});

	it('leaves no fixture registering suites by hand', () => {
		// The rule a new adapter is most likely to break: copy an older fixture,
		// register the suites it happened to list, and silently skip the rest.
		for (const path of fixtureFiles()) {
			const src = readFileSync(path, 'utf8');
			expect(src).toContain('describeContainerBackendConformance(fixture, harness)');
			const direct = [...src.matchAll(/\bdescribe(\w+)Conformance\(fixture, harness\)/g)]
				.map((m) => m[0])
				.filter((c) => !c.startsWith('describeContainerBackendConformance'));
			expect(
				direct,
				`${path} registers conformance suites directly (${direct.join(', ')}). Call ` +
					'describeContainerBackendConformance so a suite added later reaches this backend too.',
			).toEqual([]);
		}
	});
});
