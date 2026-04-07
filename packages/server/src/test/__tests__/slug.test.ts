import { describe, expect, it } from 'vitest';
import { toIssuePrefix, toSlug, uniqueSlug } from '../../lib/slug';

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

describe('toIssuePrefix', () => {
	it('takes first 4 chars for single word', () => {
		expect(toIssuePrefix('Acme')).toBe('ACME');
	});

	it('takes first 4 chars for single long word', () => {
		expect(toIssuePrefix('Enterprise')).toBe('ENTE');
	});

	it('takes initials for multi-word names', () => {
		expect(toIssuePrefix('Acme Corp')).toBe('AC');
	});

	it('takes initials for three words', () => {
		expect(toIssuePrefix('My Cool Startup')).toBe('MCS');
	});

	it('handles leading/trailing whitespace', () => {
		expect(toIssuePrefix('  Acme Corp  ')).toBe('AC');
	});
});
