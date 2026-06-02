import { describe, expect, it } from 'vitest';
import { parseCommit } from '../../src/release/conventional';

describe('parseCommit', () => {
	it('parses type, scope, and description', () => {
		const c = parseCommit({
			subject: 'feat(projects): add Assets library',
			body: '',
			hash: 'abc123',
		});
		expect(c.type).toBe('feat');
		expect(c.scope).toBe('projects');
		expect(c.description).toBe('add Assets library');
		expect(c.breaking).toBe(false);
		expect(c.pr).toBeNull();
		expect(c.hash).toBe('abc123');
	});

	it('parses a type without a scope', () => {
		const c = parseCommit({ subject: 'fix: correct a typo', body: '', hash: 'h' });
		expect(c.type).toBe('fix');
		expect(c.scope).toBeNull();
		expect(c.description).toBe('correct a typo');
	});

	it('extracts a trailing PR number and strips it from the description', () => {
		const c = parseCommit({
			subject: 'feat(projects): add Assets library (#105)',
			body: '',
			hash: 'h',
		});
		expect(c.pr).toBe(105);
		expect(c.description).toBe('add Assets library');
	});

	it('detects a breaking change from the `!` marker', () => {
		const c = parseCommit({ subject: 'feat(api)!: drop legacy endpoint', body: '', hash: 'h' });
		expect(c.breaking).toBe(true);
		expect(c.type).toBe('feat');
		expect(c.description).toBe('drop legacy endpoint');
	});

	it('detects a breaking change from a BREAKING CHANGE footer', () => {
		const c = parseCommit({
			subject: 'refactor(db): reshape schema',
			body: 'Body text.\n\nBREAKING CHANGE: the column was removed.',
			hash: 'h',
		});
		expect(c.breaking).toBe(true);
		expect(c.type).toBe('refactor');
	});

	it('also accepts the hyphenated BREAKING-CHANGE footer form', () => {
		const c = parseCommit({
			subject: 'chore: bump',
			body: 'BREAKING-CHANGE: removed config flag',
			hash: 'h',
		});
		expect(c.breaking).toBe(true);
	});

	it('lowercases the type', () => {
		const c = parseCommit({ subject: 'FEAT: shout', body: '', hash: 'h' });
		expect(c.type).toBe('feat');
	});

	it('returns an empty type for a non-conventional subject', () => {
		const c = parseCommit({ subject: 'just some words', body: '', hash: 'h' });
		expect(c.type).toBe('');
		expect(c.scope).toBeNull();
		expect(c.description).toBe('just some words');
		expect(c.breaking).toBe(false);
	});

	it('extracts the PR number and strips it from a non-conventional subject', () => {
		const c = parseCommit({ subject: 'Add update notifications (#42)', body: '', hash: 'h' });
		expect(c.type).toBe('');
		expect(c.pr).toBe(42);
		expect(c.description).toBe('Add update notifications');
	});
});
