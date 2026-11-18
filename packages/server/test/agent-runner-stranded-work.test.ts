import { describe, expect, it } from 'vitest';
import { strandedWorkChange } from '../src/services/agent-runner';
import type { RepoLoc, UnpushedWork } from '../src/services/git';
import { createStubDocker } from './helpers/app';

/**
 * Which clones a task run pins its container for, and which it releases.
 *
 * Pure, so every shape is enumerated here; the run-level test covers the wiring.
 * What matters is what a run may not release: a clone it did not scan, and a
 * clean-looking clone in a scan that could not answer for every clone.
 */
describe('strandedWorkChange', () => {
	const docker = createStubDocker();
	const clone = (name: string): RepoLoc => {
		const containerPath = `/workspace/${name}`;
		return { containerPath, files: docker.files('stub-container', containerPath) };
	};
	const app = clone('app');
	const api = clone('api');
	const web = clone('web');
	const cloneName = (repo: RepoLoc): string => repo.containerPath.split('/').pop() ?? '';
	const work = (repo: RepoLoc, commits = 2): UnpushedWork => ({
		repo,
		branch: 'hezo/T-1',
		commits,
	});

	it('pins the clone still holding the only copy and releases the clean one', () => {
		const stranded = [work(app)];
		expect(strandedWorkChange({ work: stranded, complete: true }, stranded, [app, api])).toEqual({
			stranded: ['app'],
			released: ['api'],
		});
	});

	it('releases a clone whose commits were copied to the vault', () => {
		expect(strandedWorkChange({ work: [work(app)], complete: true }, [], [app])).toEqual({
			stranded: [],
			released: ['app'],
		});
	});

	it('releases no clean-looking clone when some clone could not answer', () => {
		// "Could not tell" for one clone must not clear a pin an earlier run set
		// on any of them; vaulted work is still released, since Hezo holds it.
		expect(strandedWorkChange({ work: [work(app)], complete: false }, [], [app, api])).toEqual({
			stranded: [],
			released: ['app'],
		});
	});

	it('says nothing about a clone the run did not scan', () => {
		const change = strandedWorkChange({ work: [], complete: true }, [], [api]);
		expect(change).toEqual({ stranded: [], released: ['api'] });
		expect(change.released).not.toContain(cloneName(web));
	});

	it('changes nothing when there was nothing to scan', () => {
		expect(strandedWorkChange({ work: [], complete: false }, [], [])).toEqual({
			stranded: [],
			released: [],
		});
	});
});
