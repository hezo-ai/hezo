import { describe, expect, it } from 'vitest';
import { extractMentionSlugs } from '../../lib/mentions';

describe('extractMentionSlugs', () => {
	it('extracts a single @slug', () => {
		expect(extractMentionSlugs('hey @architect please review')).toEqual(['architect']);
	});

	it('extracts multiple distinct slugs', () => {
		expect(extractMentionSlugs('cc @architect and @product-lead for visibility').sort()).toEqual([
			'architect',
			'product-lead',
		]);
	});

	it('dedupes repeated mentions of the same slug', () => {
		expect(extractMentionSlugs('@architect and again @architect')).toEqual(['architect']);
	});

	it('ignores the passive form @@<slug>', () => {
		expect(extractMentionSlugs('BE-2 is assigned to @@researcher')).toEqual([]);
	});

	it('treats @@ and @ in the same comment correctly — passive ignored, active extracted', () => {
		const slugs = extractMentionSlugs(
			'Plan: BE-2 → @@researcher, BE-3 → @@product-lead. @architect please weigh in.',
		).sort();
		expect(slugs).toEqual(['architect']);
	});

	it('ignores mentions inside fenced code blocks', () => {
		const text = 'see snippet:\n```\n@architect\n```\nnothing else';
		expect(extractMentionSlugs(text)).toEqual([]);
	});

	it('ignores mentions inside inline code', () => {
		expect(extractMentionSlugs('write the slug as `@architect` in your docs')).toEqual([]);
	});

	it('ignores @ that follows another word character (e.g. an email)', () => {
		expect(extractMentionSlugs('reply to ops@architect.example')).toEqual([]);
	});

	it('returns [] for empty or non-text input', () => {
		expect(extractMentionSlugs('')).toEqual([]);
		expect(extractMentionSlugs(null)).toEqual([]);
		expect(extractMentionSlugs(undefined)).toEqual([]);
	});

	it('flattens nested text fields when given an object', () => {
		expect(
			extractMentionSlugs({ text: 'hey @architect', extra: 'and @product-lead' }).sort(),
		).toEqual(['architect', 'product-lead']);
	});
});
