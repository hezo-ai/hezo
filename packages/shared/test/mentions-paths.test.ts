import { describe, expect, it } from 'vitest';
import {
	agentPath,
	assetPath,
	commentPath,
	GLOBAL_INBOX_PATH,
	parseRunPath,
	projectDocPath,
	projectInboxPath,
	runPath,
	SKILLS_SETTINGS_PATH,
	taskPath,
} from '../src/mentions/paths';

describe('mention paths', () => {
	it('builds task and comment paths with a lowercased identifier', () => {
		expect(taskPath('ops', 'IN-42')).toBe('/projects/ops/tasks/in-42');
		expect(commentPath('ops', 'IN-42', '20261009112345')).toBe(
			'/projects/ops/tasks/in-42#comment-20261009112345',
		);
	});

	it('url-encodes filenames in doc and asset paths', () => {
		expect(projectDocPath('ops', 'my file.md')).toBe('/projects/ops/documents?file=my%20file.md');
		// Asset links land on the viewer (content + review comments), not the grid.
		expect(assetPath('ops', 'a&b.png')).toBe('/projects/ops/assets/view?file=a%26b.png');
		// Folder separators percent-encode too; the viewer decodes the search
		// param back to the full path.
		expect(assetPath('ops', 'blog/hero.png')).toBe(
			'/projects/ops/assets/view?file=blog%2Fhero.png',
		);
	});

	it('builds agent and inbox paths', () => {
		expect(agentPath('ops', 'captain')).toBe('/projects/ops/agents/captain');
		expect(projectInboxPath('ops')).toBe('/projects/ops/inbox');
	});

	it('builds a run path and parses it back', () => {
		const link = { projectSlug: 'hezo-marketing', agentSlug: 'growth-analyst', runId: 'run-1' };
		const path = runPath(link);
		expect(path).toBe('/projects/hezo-marketing/agents/growth-analyst/executions/run-1');
		expect(parseRunPath(path)).toEqual(link);
	});

	it('parses no other path as a run', () => {
		expect(parseRunPath('/projects/ops/agents/captain')).toBeNull();
		expect(parseRunPath('/projects/ops/agents/captain/executions')).toBeNull();
		expect(parseRunPath('/projects/ops/tasks/in-42')).toBeNull();
		expect(parseRunPath('https://example.com/projects/ops/agents/a/executions/r')).toBeNull();
	});

	it('exposes static instance paths', () => {
		expect(GLOBAL_INBOX_PATH).toBe('/home/inbox');
		expect(SKILLS_SETTINGS_PATH).toBe('/settings/skills');
	});
});
