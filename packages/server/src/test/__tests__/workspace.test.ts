import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllProjectWorkspaces, ensureProjectWorkspace } from '../../services/workspace';

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-workspace-test-'));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe('clearAllProjectWorkspaces', () => {
	it('returns no entries when companies dir is missing', () => {
		expect(clearAllProjectWorkspaces(dataDir)).toEqual([]);
	});

	it('removes stale files from every project workspace and recreates the dirs', () => {
		ensureProjectWorkspace(dataDir, 'acme', 'web');
		ensureProjectWorkspace(dataDir, 'acme', 'mobile');
		ensureProjectWorkspace(dataDir, 'beta', 'platform');

		const stalePaths = [
			join(dataDir, 'companies/acme/projects/web/workspace/be-1-progress.md'),
			join(dataDir, 'companies/acme/projects/mobile/workspace/prd.md'),
			join(dataDir, 'companies/beta/projects/platform/workspace/spec.md'),
		];
		for (const p of stalePaths) writeFileSync(p, 'stale\n');

		const cleared = clearAllProjectWorkspaces(dataDir);

		expect(cleared).toHaveLength(3);
		for (const p of stalePaths) expect(existsSync(p)).toBe(false);

		const dirs = [
			join(dataDir, 'companies/acme/projects/web/workspace'),
			join(dataDir, 'companies/acme/projects/mobile/workspace'),
			join(dataDir, 'companies/beta/projects/platform/workspace'),
		];
		for (const dir of dirs) {
			expect(existsSync(dir)).toBe(true);
			expect(readdirSync(dir)).toEqual([]);
		}
	});

	it('leaves sibling worktrees and previews directories untouched', () => {
		ensureProjectWorkspace(dataDir, 'acme', 'web');
		const projectDir = join(dataDir, 'companies/acme/projects/web');
		writeFileSync(join(projectDir, 'workspace/dirty.md'), 'x');
		mkdirSync(join(projectDir, 'worktrees/feat-branch'), { recursive: true });
		writeFileSync(join(projectDir, 'worktrees/feat-branch/keep.md'), 'keep');
		mkdirSync(join(projectDir, '.previews/agent-1'), { recursive: true });
		writeFileSync(join(projectDir, '.previews/agent-1/preview.html'), 'keep');

		clearAllProjectWorkspaces(dataDir);

		expect(existsSync(join(projectDir, 'worktrees/feat-branch/keep.md'))).toBe(true);
		expect(existsSync(join(projectDir, '.previews/agent-1/preview.html'))).toBe(true);
		expect(existsSync(join(projectDir, 'workspace/dirty.md'))).toBe(false);
	});
});
