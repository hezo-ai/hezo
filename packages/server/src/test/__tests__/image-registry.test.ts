import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, resolveLocalImage } from '../../services/image-registry';

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
		}
	});

	it('returns null for unregistered images', () => {
		expect(resolveLocalImage('alpine:latest')).toBeNull();
		expect(resolveLocalImage('some/other:tag')).toBeNull();
	});
});
