import { describe, expect, it } from 'vitest';
import { toProjectIssuePrefix, toSlug, uniqueSlug } from '../../lib/slug';

describe('toSlug', () => {
	it('converts simple string to slug', () => {
		expect(toSlug('Hello World')).toBe('hello-world');
	});

	it('removes special characters', () => {
		expect(toSlug('Hello! @World #2024')).toBe('hello-world-2024');
	});

	it('collapses multiple spaces and dashes', () => {
		expect(toSlug('hello   world---test')).toBe('hello-world-test');
	});

	it('trims leading and trailing dashes', () => {
		expect(toSlug('--hello-world--')).toBe('hello-world');
	});

	it('handles empty string', () => {
		expect(toSlug('')).toBe('');
	});

	it('handles string with only special characters', () => {
		expect(toSlug('!@#$%')).toBe('');
	});

	it('lowercases uppercase letters', () => {
		expect(toSlug('My GREAT Project')).toBe('my-great-project');
	});

	it('preserves numbers', () => {
		expect(toSlug('Project 123 Alpha')).toBe('project-123-alpha');
	});

	it('handles unicode by stripping non-ascii', () => {
		expect(toSlug('café résumé')).toBe('caf-rsum');
	});
});

describe('uniqueSlug', () => {
	it('returns base slug when no conflict', async () => {
		const result = await uniqueSlug('my-project', async () => false);
		expect(result).toBe('my-project');
	});

	it('appends -2 when base slug exists', async () => {
		const existing = new Set(['my-project']);
		const result = await uniqueSlug('my-project', async (slug) => existing.has(slug));
		expect(result).toBe('my-project-2');
	});

	it('increments suffix until unique', async () => {
		const existing = new Set(['my-project', 'my-project-2', 'my-project-3']);
		const result = await uniqueSlug('my-project', async (slug) => existing.has(slug));
		expect(result).toBe('my-project-4');
	});
});

describe('toProjectIssuePrefix', () => {
	it('takes first 2 chars for single-word names', () => {
		expect(toProjectIssuePrefix('Operations')).toBe('OP');
	});

	it('takes first 2 chars for other single-word names', () => {
		expect(toProjectIssuePrefix('Marketing')).toBe('MA');
	});

	it('takes initials for multi-word names', () => {
		expect(toProjectIssuePrefix('Web App')).toBe('WA');
	});

	it('takes up to 4 initials for longer multi-word names', () => {
		expect(toProjectIssuePrefix('My Cool Startup Project')).toBe('MCSP');
	});

	it('caps initials at 4 characters', () => {
		expect(toProjectIssuePrefix('Very Important Customer Portal Extension')).toBe('VICP');
	});

	it('handles leading/trailing whitespace', () => {
		expect(toProjectIssuePrefix('  Web App  ')).toBe('WA');
	});

	it('strips non-alphanumeric characters', () => {
		expect(toProjectIssuePrefix('Finance & Admin')).toBe('FA');
	});
});
