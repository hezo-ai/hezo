import { describe, expect, it } from 'vitest';
import {
	agentPath,
	assetPath,
	commentPath,
	GLOBAL_INBOX_PATH,
	projectDocPath,
	projectInboxPath,
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
		expect(assetPath('ops', 'a&b.png')).toBe('/projects/ops/assets?file=a%26b.png');
	});

	it('builds agent and inbox paths', () => {
		expect(agentPath('ops', 'captain')).toBe('/projects/ops/agents/captain');
		expect(projectInboxPath('ops')).toBe('/projects/ops/inbox');
	});

	it('exposes static instance paths', () => {
		expect(GLOBAL_INBOX_PATH).toBe('/home/inbox');
		expect(SKILLS_SETTINGS_PATH).toBe('/settings/skills');
	});
});
