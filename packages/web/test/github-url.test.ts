import { expect, test } from 'vitest';
import { repoWebUrl } from '../src/lib/github';

test('builds a github web url from an owner/repo identifier', () => {
	expect(repoWebUrl('hiddentao-agent/todos', 'github')).toBe(
		'https://github.com/hiddentao-agent/todos',
	);
});

test('returns null for non-github hosts and empty identifiers', () => {
	expect(repoWebUrl('owner/repo', 'gitlab')).toBeNull();
	expect(repoWebUrl('   ', 'github')).toBeNull();
});
