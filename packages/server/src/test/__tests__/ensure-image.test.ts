import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../../services/docker';
import { ensureImage } from '../../services/ensure-image';

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
		});
		const build = vi.fn().mockResolvedValue(undefined);

		await ensureImage(docker, 'hezo/agent-base:latest', { resolveLocal, build });

		expect(resolveLocal).toHaveBeenCalledWith('hezo/agent-base:latest');
		expect(build).toHaveBeenCalledWith(
			'hezo/agent-base:latest',
			'/repo/docker',
			'/repo/docker/Dockerfile.agent-base',
			undefined,
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
		});
		const build = vi.fn().mockResolvedValue(undefined);
		const onLine = vi.fn();

		await ensureImage(docker, 'hezo/agent-base:latest', { resolveLocal, build, onLine });

		expect(build).toHaveBeenCalledWith(
			'hezo/agent-base:latest',
			'/repo/docker',
			'/repo/docker/Dockerfile.agent-base',
			onLine,
		);
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
		});
		const build = vi.fn().mockRejectedValue(new Error('docker build exited with code 1'));

		await expect(
			ensureImage(docker, 'hezo/agent-base:latest', { resolveLocal, build }),
		).rejects.toThrow('docker build exited with code 1');
		expect(docker.pullImage).not.toHaveBeenCalled();
	});
});
