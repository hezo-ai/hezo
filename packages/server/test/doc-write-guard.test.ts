import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProvider } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	buildDocWriteGuardScript,
	DOC_WRITE_GUARD_FILENAME,
	DOC_WRITE_GUARD_MATCHER,
} from '../src/services/doc-write-guard';
import { claudeCodeAdapter } from '../src/services/mcp-injectors/claude-code';
import { grokAdapter } from '../src/services/mcp-injectors/grok';
import { kimiAdapter } from '../src/services/mcp-injectors/kimi';
import { buildClaudeCodeSettings } from '../src/services/stop-hook-prompt';

let dir: string;
let scriptPath: string;

/** Run the generated guard exactly as the runtime would: JSON on stdin. */
function runGuard(input: unknown, cwd: string): { status: number; stdout: string; stderr: string } {
	const r = spawnSync('node', [scriptPath], {
		input: JSON.stringify(input),
		encoding: 'utf8',
		cwd,
	});
	return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'hezo-doc-guard-'));
	scriptPath = join(dir, DOC_WRITE_GUARD_FILENAME);
	writeFileSync(scriptPath, buildDocWriteGuardScript(['todo-spec.md', 'implementation-plan.md']));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('doc-write guard script', () => {
	it('blocks a Write aimed at a project doc, and says what to call instead', () => {
		const workdir = join(dir, 'untracked');
		mkdirSync(workdir, { recursive: true });
		const r = runGuard(
			{ tool_name: 'Write', tool_input: { file_path: join(workdir, 'todo-spec.md') } },
			workdir,
		);
		// Exit 2 is the "intentional block" code; the reason goes to stderr and the
		// structured decision to stdout, so whichever channel the CLI reads sees it.
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('project doc');
		const decision = JSON.parse(r.stdout) as {
			hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
		};
		expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
		// A refusal that does not name the alternative just gets retried.
		expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('write_project_doc');
		expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('edit_project_doc');
		expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('todo-spec.md');
	});

	it('blocks Edit, MultiEdit and NotebookEdit too, not just Write', () => {
		const workdir = join(dir, 'untracked');
		for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) {
			const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
			const r = runGuard(
				{ tool_name: tool, tool_input: { [key]: join(workdir, 'implementation-plan.md') } },
				workdir,
			);
			expect(r.status, `${tool} should be blocked`).toBe(2);
		}
	});

	it('allows a filename that is not a project doc', () => {
		const workdir = join(dir, 'untracked');
		const r = runGuard(
			{ tool_name: 'Write', tool_input: { file_path: join(workdir, 'README.md') } },
			workdir,
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe('');
	});

	it('allows a same-named file the repo genuinely tracks', () => {
		// A repo may legitimately carry its own todo-spec.md. Blocking that would
		// break real work, so tracked paths stay writable.
		const repo = join(dir, 'repo');
		mkdirSync(repo, { recursive: true });
		execFileSync('git', ['init', '-q'], { cwd: repo });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
		// A throwaway repo still inherits the developer's global git config, and a
		// commit signer that expects a human (1Password, gpg-agent, a hardware key)
		// cannot run here - the commit fails and the test reads as a guard bug.
		execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
		writeFileSync(join(repo, 'todo-spec.md'), '# a real repo file\n');
		execFileSync('git', ['add', 'todo-spec.md'], { cwd: repo });
		execFileSync('git', ['commit', '-qm', 'add'], { cwd: repo });

		const r = runGuard(
			{ tool_name: 'Write', tool_input: { file_path: join(repo, 'todo-spec.md') } },
			repo,
		);
		expect(r.status).toBe(0);
	});

	it('fails open on anything unexpected rather than blocking real work', () => {
		const workdir = join(dir, 'untracked');
		// Unguarded tool, malformed payload, and a missing path all allow.
		expect(runGuard({ tool_name: 'Bash', tool_input: { command: 'ls' } }, workdir).status).toBe(0);
		expect(runGuard({ tool_name: 'Write', tool_input: {} }, workdir).status).toBe(0);
		const garbage = spawnSync('node', [scriptPath], {
			input: 'not json at all',
			encoding: 'utf8',
			cwd: workdir,
		});
		expect(garbage.status).toBe(0);
	});
});

describe('claude code settings wiring', () => {
	const ctx = {
		hostHomeDir: '/host/home',
		containerHomeDir: '/container/home',
		provider: AiProvider.Anthropic,
		runModel: null,
	};

	it('emits the PreToolUse hook and ships the guard when the project has docs', () => {
		const injection = claudeCodeAdapter.build([], {
			...ctx,
			projectDocSlugs: ['spec.md'],
		});
		const settingsFile = injection.files.find((f) => f.hostPath.endsWith('settings.json'));
		const guardFile = injection.files.find((f) => f.hostPath.endsWith(DOC_WRITE_GUARD_FILENAME));
		expect(guardFile).toBeDefined();
		expect(guardFile?.contents).toContain('spec.md');

		const settings = JSON.parse(settingsFile?.contents ?? '{}') as {
			hooks: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
		};
		expect(settings.hooks.PreToolUse?.[0].matcher).toBe(DOC_WRITE_GUARD_MATCHER);
		expect(settings.hooks.PreToolUse?.[0].hooks[0].command).toContain(DOC_WRITE_GUARD_FILENAME);
	});

	it('emits no PreToolUse hook and no guard file when there are no docs', () => {
		const injection = claudeCodeAdapter.build([], { ...ctx, projectDocSlugs: [] });
		expect(
			injection.files.find((f) => f.hostPath.endsWith(DOC_WRITE_GUARD_FILENAME)),
		).toBeUndefined();
		const settings = JSON.parse(injection.files[0].contents) as {
			hooks: { PreToolUse?: unknown; Stop: unknown };
		};
		expect(settings.hooks.PreToolUse).toBeUndefined();
		// The Stop judge is untouched by any of this.
		expect(settings.hooks.Stop).toBeDefined();
	});

	it('leaves the settings file unchanged when no guard command is supplied', () => {
		const without = buildClaudeCodeSettings(AiProvider.Anthropic, null, [], null);
		expect(without.hooks.PreToolUse).toBeUndefined();
	});
});

describe('kimi config wiring', () => {
	const ctx = {
		hostHomeDir: '/host/home',
		containerHomeDir: '/container/home',
		provider: AiProvider.Kimi,
		runModel: null,
	};

	it("emits a PreToolUse entry using ONLY Kimi's four permitted keys", () => {
		const injection = kimiAdapter.build([], { ...ctx, projectDocSlugs: ['spec.md'] });
		const toml = injection.files.find((f) => f.hostPath.endsWith('config.toml'))?.contents ?? '';
		const blocks = toml
			.split('[[hooks]]')
			.slice(1)
			.map((b) => b.trim().split('\n').filter(Boolean));
		expect(blocks.length).toBe(2);

		const pre = blocks.find((b) => b.some((l) => l.includes('PreToolUse')));
		expect(pre).toBeDefined();
		// Kimi refuses to load a config carrying any key outside this set, and a
		// rejected config breaks EVERY run on the runtime, not just the hook.
		const keys = (pre ?? []).map((l) => l.split('=')[0].trim()).sort();
		expect(keys).toEqual(['command', 'event', 'matcher', 'timeout']);

		expect(
			injection.files.find((f) => f.hostPath.endsWith(DOC_WRITE_GUARD_FILENAME)),
		).toBeDefined();
	});

	it('emits an unchanged single-hook config when the project has no docs', () => {
		const injection = kimiAdapter.build([], { ...ctx, projectDocSlugs: [] });
		const toml = injection.files.find((f) => f.hostPath.endsWith('config.toml'))?.contents ?? '';
		expect(toml.split('[[hooks]]').length - 1).toBe(1);
		expect(toml).not.toContain('PreToolUse');
		expect(
			injection.files.find((f) => f.hostPath.endsWith(DOC_WRITE_GUARD_FILENAME)),
		).toBeUndefined();
	});
});

describe('grok hooks wiring', () => {
	const ctx = {
		hostHomeDir: '/host/home',
		containerHomeDir: '/container/home',
		runModel: null,
	};

	it('installs the guard as Claude-Code-shaped hook JSON, its one blocking event', () => {
		const injection = grokAdapter.build([], { ...ctx, projectDocSlugs: ['spec.md'] });
		const hooksFile = injection.files.find((f) => f.hostPath.endsWith('.json'));
		expect(hooksFile).toBeDefined();
		const parsed = JSON.parse(hooksFile?.contents ?? '{}') as {
			hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
		};
		expect(parsed.hooks.PreToolUse[0].matcher).toBe(DOC_WRITE_GUARD_MATCHER);
		expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain(DOC_WRITE_GUARD_FILENAME);
		// Grok has no completeness judge; this must not have added one.
		expect(JSON.stringify(parsed)).not.toContain('Stop');
	});

	it('writes no hook files when the project has no docs', () => {
		const injection = grokAdapter.build([], { ...ctx, projectDocSlugs: [] });
		expect(injection.files.length).toBe(1);
		expect(injection.files[0].hostPath).toContain('config.toml');
	});
});
