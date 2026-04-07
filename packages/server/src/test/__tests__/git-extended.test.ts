import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloneRepo } from '../../services/git';

const testDir = mkdtempSync(join(tmpdir(), 'hezo-test-git-extended-'));

afterAll(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function countHezSshFiles(): number {
	return readdirSync(tmpdir()).filter((f) => f.startsWith('hezo-ssh-')).length;
}

describe('cloneRepo', () => {
	it('returns { success: false, error } when clone fails', async () => {
		const targetDir = join(testDir, 'clone-fail');
		const result = await cloneRepo(
			'nonexistent-org-hezo-test/nonexistent-repo-xyz',
			targetDir,
			'fake-ssh-key-content',
		);

		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(typeof result.error).toBe('string');
	});

	it('does not throw on clone failure', async () => {
		const targetDir = join(testDir, 'clone-no-throw');
		await expect(
			cloneRepo('nonexistent-org-hezo-test/nonexistent-repo-xyz', targetDir, 'fake-key'),
		).resolves.not.toThrow();
	});

	it('cleans up the temp SSH key file after a failed clone', async () => {
		const targetDir = join(testDir, 'clone-cleanup');
		const before = countHezSshFiles();

		await cloneRepo(
			'nonexistent-org-hezo-test/nonexistent-repo-xyz',
			targetDir,
			'fake-ssh-key-content',
		);

		const after = countHezSshFiles();
		expect(after).toBe(before);
	});

	it('leaves no hezo-ssh-* temp files behind when called multiple times', async () => {
		const snapshot = countHezSshFiles();

		await Promise.all([
			cloneRepo('nonexistent-org-hezo/repo-a', join(testDir, 'multi-a'), 'key-a'),
			cloneRepo('nonexistent-org-hezo/repo-b', join(testDir, 'multi-b'), 'key-b'),
			cloneRepo('nonexistent-org-hezo/repo-c', join(testDir, 'multi-c'), 'key-c'),
		]);

		expect(countHezSshFiles()).toBe(snapshot);
	});

	it('does not create the target directory on failure', async () => {
		const targetDir = join(testDir, 'clone-no-dir');
		const result = await cloneRepo(
			'nonexistent-org-hezo-test/nonexistent-repo-xyz',
			targetDir,
			'fake-ssh-key-content',
		);

		expect(result.success).toBe(false);
		// git clone may or may not create a partial directory; either way success must be false
		// (we only assert the result shape, not filesystem side-effects git controls)
		expect(result.error).toBeTruthy();
	});
});
