import { describe, expect, it, vi } from 'vitest';
import {
	BUNDLE_SHA_LABEL,
	pruneStaleBundledImages,
	resolveLocalImage,
} from '../src/services/image-registry';
import type { ContainerEngine, ImageInfo } from '../src/services/sandbox/types';

function fakeDocker(
	inspect: (name: string) => Promise<ImageInfo | null> | ImageInfo | null,
	remove: (name: string, force?: boolean) => Promise<void> | void = async () => {},
): ContainerEngine {
	return {
		inspectImage: vi.fn(async (name: string) => inspect(name)),
		removeImage: vi.fn(async (name: string, force?: boolean) => remove(name, force)),
	} as unknown as ContainerEngine;
}

describe('pruneStaleBundledImages', () => {
	it('keeps an image whose label matches the current source hash', async () => {
		const resolved = resolveLocalImage('hezo/agent-base:latest');
		expect(resolved).not.toBeNull();
		if (!resolved) return;

		const docker = fakeDocker(() => ({
			Id: 'sha256:fresh',
			Config: { Labels: { [BUNDLE_SHA_LABEL]: resolved.bundleSourceHash } },
		}));

		const outcome = await pruneStaleBundledImages(docker);

		expect(outcome.kept).toContain('hezo/agent-base:latest');
		expect(outcome.removed).toEqual([]);
		expect(docker.removeImage).not.toHaveBeenCalled();
	});

	it('removes an image whose label is missing', async () => {
		const docker = fakeDocker(() => ({
			Id: 'sha256:stale',
			Config: { Labels: null },
		}));

		const outcome = await pruneStaleBundledImages(docker);

		expect(outcome.removed).toContain('hezo/agent-base:latest');
		expect(outcome.kept).toEqual([]);
		expect(docker.removeImage).toHaveBeenCalledWith('hezo/agent-base:latest', true);
	});

	it('removes an image whose label does not match', async () => {
		const docker = fakeDocker(() => ({
			Id: 'sha256:stale',
			Config: { Labels: { [BUNDLE_SHA_LABEL]: 'deadbeef'.repeat(8) } },
		}));

		const outcome = await pruneStaleBundledImages(docker);

		expect(outcome.removed).toContain('hezo/agent-base:latest');
		expect(docker.removeImage).toHaveBeenCalledWith('hezo/agent-base:latest', true);
	});

	it('no-ops when the image is absent', async () => {
		const docker = fakeDocker(() => null);

		const outcome = await pruneStaleBundledImages(docker);

		expect(outcome.kept).toEqual([]);
		expect(outcome.removed).toEqual([]);
		expect(outcome.skipped).toEqual([]);
		expect(docker.removeImage).not.toHaveBeenCalled();
	});

	it('reports skipped when inspect throws', async () => {
		const docker = fakeDocker(() => {
			throw new Error('socket gone');
		});

		const outcome = await pruneStaleBundledImages(docker);

		expect(outcome.skipped).toEqual([
			{ image: 'hezo/agent-base:latest', reason: expect.stringContaining('socket gone') },
		]);
		expect(outcome.removed).toEqual([]);
	});

	it('reports skipped when removal throws but does not crash', async () => {
		const docker = fakeDocker(
			() => ({ Id: 'sha256:stale', Config: { Labels: null } }),
			() => {
				throw new Error('still in use');
			},
		);

		const outcome = await pruneStaleBundledImages(docker);

		expect(outcome.skipped).toEqual([
			{ image: 'hezo/agent-base:latest', reason: expect.stringContaining('still in use') },
		]);
		expect(outcome.removed).toEqual([]);
	});
});
