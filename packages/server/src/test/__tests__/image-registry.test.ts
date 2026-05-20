import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	BUNDLE_SHA_LABEL,
	computeBundleSourceHash,
	findRepoRoot,
	resolveLocalImage,
} from '../../services/image-registry';

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
