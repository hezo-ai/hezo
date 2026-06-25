import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../src/services/docker';
import {
	AGENT_BASE_GHCR_REPO,
	BUNDLE_SHA_LABEL,
	computeBundleSourceHash,
	findRepoRoot,
	MANAGED_AGENT_BASE_IMAGE,
	publishedAgentBaseRef,
	refreshPublishedAgentBaseImage,
	resolveAgentBaseImage,
	resolveLocalImage,
	setDockerBaseDir,
} from '../src/services/image-registry';

describe('image-registry', () => {
	it('findRepoRoot locates the monorepo root from this file', () => {
		const root = findRepoRoot();
		expect(root).not.toBeNull();
		if (root) {
			expect(existsSync(`${root}/package.json`)).toBe(true);
			expect(existsSync(`${root}/packages`)).toBe(true);
		}
	});

	it('resolves hezo/agent-base:latest to the bundled Dockerfile', () => {
		const resolved = resolveLocalImage('hezo/agent-base:latest');
		expect(resolved).not.toBeNull();
		if (resolved) {
			expect(resolved.dockerfile.endsWith('docker/Dockerfile.agent-base')).toBe(true);
			expect(resolved.context.endsWith('/docker')).toBe(true);
			expect(existsSync(resolved.dockerfile)).toBe(true);
			expect(existsSync(resolved.context)).toBe(true);
			expect(resolved.bundleSourceHash).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it('returns null for unregistered images', () => {
		expect(resolveLocalImage('alpine:latest')).toBeNull();
		expect(resolveLocalImage('some/other:tag')).toBeNull();
	});

	describe('publishedAgentBaseRef', () => {
		it('returns the :latest GHCR ref for a packaged release build', () => {
			expect(publishedAgentBaseRef(true)).toBe(`${AGENT_BASE_GHCR_REPO}:latest`);
		});
		it('returns null for an unpackaged (dev/test) build', () => {
			expect(publishedAgentBaseRef(false)).toBeNull();
		});
	});

	describe('resolveAgentBaseImage', () => {
		const ref = `${AGENT_BASE_GHCR_REPO}:latest`;
		it('maps the managed sentinel to the published ref with preferPull', () => {
			expect(resolveAgentBaseImage(MANAGED_AGENT_BASE_IMAGE, ref)).toEqual({
				image: ref,
				preferPull: true,
			});
		});
		it('keeps the sentinel and builds locally when no published ref exists', () => {
			expect(resolveAgentBaseImage(MANAGED_AGENT_BASE_IMAGE, null)).toEqual({
				image: MANAGED_AGENT_BASE_IMAGE,
				preferPull: false,
			});
		});
		it('passes custom per-project images through untouched', () => {
			expect(resolveAgentBaseImage('registry.example.com/custom:tag', ref)).toEqual({
				image: 'registry.example.com/custom:tag',
				preferPull: false,
			});
		});
	});

	describe('resolveLocalImage published-ref fallback', () => {
		const ref = `${AGENT_BASE_GHCR_REPO}:latest`;
		it('resolves the published ref for this build to the agent-base Dockerfile', () => {
			const resolved = resolveLocalImage(ref, ref);
			expect(resolved).not.toBeNull();
			expect(resolved?.image).toBe(ref);
			expect(resolved?.dockerfile.endsWith('docker/Dockerfile.agent-base')).toBe(true);
			expect(resolved?.bundleSourceHash).toMatch(/^[0-9a-f]{64}$/);
		});
		it('returns null for an image that is neither the sentinel nor the published ref', () => {
			expect(resolveLocalImage(`${AGENT_BASE_GHCR_REPO}:0.6.1`, ref)).toBeNull();
		});
	});

	describe('refreshPublishedAgentBaseImage', () => {
		it('pulls and returns the published ref when one exists', async () => {
			const docker = {
				pullImage: vi.fn().mockResolvedValue(undefined),
			} as unknown as DockerClient;
			const ref = `${AGENT_BASE_GHCR_REPO}:latest`;
			const result = await refreshPublishedAgentBaseImage(docker, ref);
			expect(docker.pullImage).toHaveBeenCalledWith(ref);
			expect(result).toBe(ref);
		});
		it('is a no-op returning null when there is no published ref', async () => {
			const docker = { pullImage: vi.fn() } as unknown as DockerClient;
			const result = await refreshPublishedAgentBaseImage(docker, null);
			expect(docker.pullImage).not.toHaveBeenCalled();
			expect(result).toBeNull();
		});
	});

	describe('setDockerBaseDir override (compiled binary)', () => {
		// The binary has no repo checkout; it extracts the embedded docker/ context
		// to the data dir and points the resolver there so the image builds locally.
		afterEach(() => setDockerBaseDir(null));

		it('resolves the agent-base Dockerfile under the override dir', () => {
			const base = mkdtempSync(join(tmpdir(), 'hezo-docker-base-'));
			try {
				mkdirSync(join(base, 'docker', 'scripts'), { recursive: true });
				writeFileSync(join(base, 'docker', 'Dockerfile.agent-base'), 'FROM node:24-slim\n');
				writeFileSync(join(base, 'docker', 'scripts', 'hezo-ssh-bridge'), '#!/bin/sh\n');

				setDockerBaseDir(base);
				const resolved = resolveLocalImage('hezo/agent-base:latest');

				expect(resolved).not.toBeNull();
				expect(resolved?.dockerfile).toBe(join(base, 'docker', 'Dockerfile.agent-base'));
				expect(resolved?.context).toBe(join(base, 'docker'));
				expect(resolved?.bundleSourceHash).toMatch(/^[0-9a-f]{64}$/);
			} finally {
				rmSync(base, { recursive: true, force: true });
			}
		});

		it('returns null when the override dir lacks the Dockerfile', () => {
			const base = mkdtempSync(join(tmpdir(), 'hezo-docker-base-'));
			try {
				setDockerBaseDir(base);
				expect(resolveLocalImage('hezo/agent-base:latest')).toBeNull();
			} finally {
				rmSync(base, { recursive: true, force: true });
			}
		});

		it('clearing the override (null) restores repo-root resolution', () => {
			setDockerBaseDir('/nonexistent/override');
			expect(resolveLocalImage('hezo/agent-base:latest')).toBeNull();
			setDockerBaseDir(null);
			expect(resolveLocalImage('hezo/agent-base:latest')).not.toBeNull();
		});
	});

	it('exposes a stable BUNDLE_SHA_LABEL constant', () => {
		expect(BUNDLE_SHA_LABEL).toBe('hezo.bundle.sha');
	});

	describe('computeBundleSourceHash', () => {
		function withFixture<T>(setup: (dir: string) => T): T {
			const dir = mkdtempSync(join(tmpdir(), 'hezo-bundle-hash-'));
			try {
				return setup(dir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		it('is deterministic across repeated calls on the same inputs', () => {
			withFixture((dir) => {
				const dockerfile = join(dir, 'Dockerfile');
				const ctx = join(dir, 'ctx');
				writeFileSync(dockerfile, 'FROM scratch\n');
				mkdirSync(ctx);
				writeFileSync(join(ctx, 'a.sh'), 'echo a\n');
				mkdirSync(join(ctx, 'sub'));
				writeFileSync(join(ctx, 'sub', 'b.sh'), 'echo b\n');

				const first = computeBundleSourceHash(dockerfile, ctx);
				const second = computeBundleSourceHash(dockerfile, ctx);
				expect(first).toBe(second);
				expect(first).toMatch(/^[0-9a-f]{64}$/);
			});
		});

		it('changes when the Dockerfile contents change', () => {
			withFixture((dir) => {
				const dockerfile = join(dir, 'Dockerfile');
				const ctx = join(dir, 'ctx');
				mkdirSync(ctx);
				writeFileSync(dockerfile, 'FROM scratch\n');
				const before = computeBundleSourceHash(dockerfile, ctx);
				writeFileSync(dockerfile, 'FROM alpine\n');
				const after = computeBundleSourceHash(dockerfile, ctx);
				expect(after).not.toBe(before);
			});
		});

		it('changes when a context file is edited', () => {
			withFixture((dir) => {
				const dockerfile = join(dir, 'Dockerfile');
				const ctx = join(dir, 'ctx');
				mkdirSync(ctx);
				writeFileSync(dockerfile, 'FROM scratch\n');
				writeFileSync(join(ctx, 'a.sh'), 'echo a\n');
				const before = computeBundleSourceHash(dockerfile, ctx);
				writeFileSync(join(ctx, 'a.sh'), 'echo a2\n');
				const after = computeBundleSourceHash(dockerfile, ctx);
				expect(after).not.toBe(before);
			});
		});

		it('changes when a context file is added', () => {
			withFixture((dir) => {
				const dockerfile = join(dir, 'Dockerfile');
				const ctx = join(dir, 'ctx');
				mkdirSync(ctx);
				writeFileSync(dockerfile, 'FROM scratch\n');
				writeFileSync(join(ctx, 'a.sh'), 'echo a\n');
				const before = computeBundleSourceHash(dockerfile, ctx);
				writeFileSync(join(ctx, 'b.sh'), 'echo b\n');
				const after = computeBundleSourceHash(dockerfile, ctx);
				expect(after).not.toBe(before);
			});
		});
	});
});
