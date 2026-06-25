import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../src/services/docker';
import { ensureImage } from '../src/services/ensure-image';
import { ImageBuildTracker } from '../src/services/image-build-tracker';

describe('ensureImage', () => {
	it('short-circuits when the image already exists locally', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(true),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const build = vi.fn();
		const resolveLocal = vi.fn();

		await ensureImage(docker, 'anything:latest', { resolveLocal, build });

		expect(docker.imageExists).toHaveBeenCalledWith('anything:latest');
		expect(build).not.toHaveBeenCalled();
		expect(resolveLocal).not.toHaveBeenCalled();
		expect(docker.pullImage).not.toHaveBeenCalled();
	});

	it('builds the image when missing and locally registered', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/agent-base:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi.fn().mockResolvedValue(undefined);

		await ensureImage(docker, 'hezo/agent-base:latest', { resolveLocal, build });

		expect(resolveLocal).toHaveBeenCalledWith('hezo/agent-base:latest');
		expect(build).toHaveBeenCalledWith(
			'hezo/agent-base:latest',
			'/repo/docker',
			'/repo/docker/Dockerfile.agent-base',
			expect.objectContaining({ labels: { 'hezo.bundle.sha': 'a'.repeat(64) } }),
		);
		expect(docker.pullImage).not.toHaveBeenCalled();
	});

	it('forwards onLine callback to the builder', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/agent-base:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi
			.fn()
			.mockImplementation(
				async (
					_image,
					_ctx,
					_dockerfile,
					options?: { onLine?: (s: string, t: string) => void },
				) => {
					options?.onLine?.('stdout', 'building line');
				},
			);
		const onLine = vi.fn();

		await ensureImage(docker, 'hezo/agent-base:latest', { resolveLocal, build, onLine });

		expect(build).toHaveBeenCalledWith(
			'hezo/agent-base:latest',
			'/repo/docker',
			'/repo/docker/Dockerfile.agent-base',
			expect.objectContaining({ labels: { 'hezo.bundle.sha': 'a'.repeat(64) } }),
		);
		expect(onLine).toHaveBeenCalledWith('stdout', 'building line');
	});

	it('falls back to pullImage when missing and not locally registered', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue(null);
		const build = vi.fn();

		await ensureImage(docker, 'alpine:latest', { resolveLocal, build });

		expect(resolveLocal).toHaveBeenCalledWith('alpine:latest');
		expect(build).not.toHaveBeenCalled();
		expect(docker.pullImage).toHaveBeenCalledWith('alpine:latest');
	});

	it('propagates pullImage errors for unregistered images', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockRejectedValue(new Error('pull denied')),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue(null);

		await expect(
			ensureImage(docker, 'ghost/image:latest', { resolveLocal, build: vi.fn() }),
		).rejects.toThrow('pull denied');
	});

	it('propagates builder errors for locally registered images', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/agent-base:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi.fn().mockRejectedValue(new Error('docker build exited with code 1'));

		await expect(
			ensureImage(docker, 'hezo/agent-base:latest', { resolveLocal, build }),
		).rejects.toThrow('docker build exited with code 1');
		expect(docker.pullImage).not.toHaveBeenCalled();
	});

	it('deduplicates concurrent builds of the same image to a single build', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/dedup:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});

		let releaseBuild!: () => void;
		const buildGate = new Promise<void>((resolve) => {
			releaseBuild = resolve;
		});
		const build = vi.fn().mockImplementation(async () => {
			await buildGate;
		});

		const first = ensureImage(docker, 'hezo/dedup:latest', { resolveLocal, build });
		const second = ensureImage(docker, 'hezo/dedup:latest', { resolveLocal, build });
		releaseBuild();
		await Promise.all([first, second]);

		expect(build).toHaveBeenCalledTimes(1);
	});

	it('fans build output out to every concurrent caller', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/fanout:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});

		let releaseBuild!: () => void;
		const buildGate = new Promise<void>((resolve) => {
			releaseBuild = resolve;
		});
		const build = vi
			.fn()
			.mockImplementation(
				async (
					_image,
					_ctx,
					_dockerfile,
					options?: { onLine?: (s: string, t: string) => void },
				) => {
					await buildGate;
					options?.onLine?.('stdout', 'building line');
				},
			);
		const onLineFirst = vi.fn();
		const onLineSecond = vi.fn();

		const first = ensureImage(docker, 'hezo/fanout:latest', {
			resolveLocal,
			build,
			onLine: onLineFirst,
		});
		const second = ensureImage(docker, 'hezo/fanout:latest', {
			resolveLocal,
			build,
			onLine: onLineSecond,
		});
		releaseBuild();
		await Promise.all([first, second]);

		expect(build).toHaveBeenCalledTimes(1);
		expect(onLineFirst).toHaveBeenCalledWith('stdout', 'building line');
		expect(onLineSecond).toHaveBeenCalledWith('stdout', 'building line');
	});

	it('treats a build failure as success when the image is present afterward', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/benign:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi.fn().mockRejectedValue(new Error('docker build exited with code 1'));

		await expect(
			ensureImage(docker, 'hezo/benign:latest', { resolveLocal, build }),
		).resolves.toBeUndefined();
		expect(docker.pullImage).not.toHaveBeenCalled();
	});

	it('reports build start, progress, and finish to the tracker', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/tracked:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi
			.fn()
			.mockImplementation(
				async (
					_image,
					_ctx,
					_dockerfile,
					options?: { onLine?: (s: string, t: string) => void },
				) => {
					options?.onLine?.('stdout', 'Step 1/2 : FROM x');
					options?.onLine?.('stdout', 'Step 2/2 : RUN y');
				},
			);
		const tracker = new ImageBuildTracker();
		const startSpy = vi.spyOn(tracker, 'start');
		const observeSpy = vi.spyOn(tracker, 'observe');
		const finishSpy = vi.spyOn(tracker, 'finish');

		await ensureImage(docker, 'hezo/tracked:latest', { resolveLocal, build, tracker });

		expect(startSpy).toHaveBeenCalledWith('hezo/tracked:latest');
		expect(observeSpy).toHaveBeenCalledWith('hezo/tracked:latest', 'Step 1/2 : FROM x');
		expect(finishSpy).toHaveBeenCalledWith('hezo/tracked:latest');
	});

	it('reports a build failure to the tracker and rethrows', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn(),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'hezo/tracked-fail:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi.fn().mockRejectedValue(new Error('docker build exited with code 1'));
		const tracker = new ImageBuildTracker();
		const failSpy = vi.spyOn(tracker, 'fail');

		await expect(
			ensureImage(docker, 'hezo/tracked-fail:latest', { resolveLocal, build, tracker }),
		).rejects.toThrow('exited with code 1');
		expect(failSpy).toHaveBeenCalledWith(
			'hezo/tracked-fail:latest',
			expect.stringContaining('exited with code 1'),
		);
	});

	it('pulls first and skips the build when preferPull is set and the pull succeeds', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockResolvedValue(undefined),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'ghcr.io/hezo-ai/agent-base:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi.fn();

		await ensureImage(docker, 'ghcr.io/hezo-ai/agent-base:latest', {
			resolveLocal,
			build,
			preferPull: true,
		});

		expect(docker.pullImage).toHaveBeenCalledWith('ghcr.io/hezo-ai/agent-base:latest');
		expect(build).not.toHaveBeenCalled();
	});

	it('falls back to a local build when the preferPull pull fails and a local spec exists', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockRejectedValue(new Error('manifest unknown')),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue({
			image: 'ghcr.io/hezo-ai/agent-base:latest',
			dockerfile: '/repo/docker/Dockerfile.agent-base',
			context: '/repo/docker',
			bundleSourceHash: 'a'.repeat(64),
		});
		const build = vi.fn().mockResolvedValue(undefined);

		await ensureImage(docker, 'ghcr.io/hezo-ai/agent-base:latest', {
			resolveLocal,
			build,
			preferPull: true,
		});

		expect(docker.pullImage).toHaveBeenCalledTimes(1);
		expect(build).toHaveBeenCalledWith(
			'ghcr.io/hezo-ai/agent-base:latest',
			'/repo/docker',
			'/repo/docker/Dockerfile.agent-base',
			expect.objectContaining({ labels: { 'hezo.bundle.sha': 'a'.repeat(64) } }),
		);
	});

	it('propagates the preferPull pull error when no local spec is available', async () => {
		const docker = {
			imageExists: vi.fn().mockResolvedValue(false),
			pullImage: vi.fn().mockRejectedValue(new Error('manifest unknown')),
		} as unknown as DockerClient;
		const resolveLocal = vi.fn().mockReturnValue(null);
		const build = vi.fn();

		await expect(
			ensureImage(docker, 'ghcr.io/hezo-ai/agent-base:latest', {
				resolveLocal,
				build,
				preferPull: true,
			}),
		).rejects.toThrow('manifest unknown');
		expect(build).not.toHaveBeenCalled();
	});
});
