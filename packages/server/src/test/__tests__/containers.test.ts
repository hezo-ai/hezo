import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	ensureProjectWorkspace,
	getPreviewsPath,
	getProjectDir,
	getWorkspacePath,
	getWorktreePath,
	getWorktreesPath,
	removeProjectWorkspace,
} from '../../services/workspace';

const testDataDir = join(tmpdir(), `hezo-test-workspace-${Date.now()}`);

afterAll(() => {
	rmSync(testDataDir, { recursive: true, force: true });
});

describe('workspace filesystem', () => {
	it('creates project directory structure', () => {
		const projectDir = ensureProjectWorkspace(testDataDir, 'acme', 'backend-api');

		expect(existsSync(join(projectDir, 'workspace'))).toBe(true);
		expect(existsSync(join(projectDir, 'worktrees'))).toBe(true);
		expect(existsSync(join(projectDir, '.previews'))).toBe(true);
	});

	it('is idempotent', () => {
		ensureProjectWorkspace(testDataDir, 'acme', 'backend-api');
		ensureProjectWorkspace(testDataDir, 'acme', 'backend-api');
		expect(
			existsSync(join(testDataDir, 'companies', 'acme', 'projects', 'backend-api', 'workspace')),
		).toBe(true);
	});

	it('removes project workspace', () => {
		ensureProjectWorkspace(testDataDir, 'acme', 'temp-project');
		const dir = getProjectDir(testDataDir, 'acme', 'temp-project');
		expect(existsSync(dir)).toBe(true);

		removeProjectWorkspace(testDataDir, 'acme', 'temp-project');
		expect(existsSync(dir)).toBe(false);
	});

	it('handles removal of non-existent workspace', () => {
		removeProjectWorkspace(testDataDir, 'acme', 'nonexistent');
	});

	it('rejects empty dataDir', () => {
		expect(() => ensureProjectWorkspace('', 'acme', 'test')).toThrow();
	});

	it('skips removal with empty dataDir', () => {
		removeProjectWorkspace('', 'acme', 'test');
	});

	it('returns correct paths', () => {
		const dir = getProjectDir(testDataDir, 'acme', 'api');
		expect(dir).toBe(join(testDataDir, 'companies', 'acme', 'projects', 'api'));

		expect(getWorkspacePath(testDataDir, 'acme', 'api')).toBe(join(dir, 'workspace'));
		expect(getWorktreesPath(testDataDir, 'acme', 'api')).toBe(join(dir, 'worktrees'));

		const wtPath = getWorktreePath(testDataDir, 'acme', 'api', 'frontend', 'feat-auth', 'abc12345');
		expect(wtPath).toBe(join(dir, 'worktrees', 'frontend-feat-auth-agent-abc12345'));

		const previewPath = getPreviewsPath(testDataDir, 'acme', 'api', 'agent-uuid');
		expect(previewPath).toBe(join(dir, '.previews', 'agent-uuid'));
	});
});
