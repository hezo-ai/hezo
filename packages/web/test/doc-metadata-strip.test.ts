import { describe, expect, test } from 'vitest';
import { stripLeadingMetadataBlock } from '../src/lib/doc-metadata-strip';

describe('stripLeadingMetadataBlock', () => {
	test('strips a bold-inline metadata block after an H1 heading', () => {
		const content = `# Distribution Plan

**Status:** draft **Date:** 2026-06-27 **Author:** seo-specialist **Purpose:** the plan

## Executive Summary

The real body.`;
		const out = stripLeadingMetadataBlock(content);
		expect(out).not.toContain('**Status:**');
		expect(out).not.toContain('**Author:**');
		expect(out).toContain('# Distribution Plan');
		expect(out).toContain('## Executive Summary');
		expect(out).toContain('The real body.');
	});

	test('strips a plain per-line metadata block after an H1', () => {
		const content = `# PRD: Feature

Status: Draft — awaiting admin approval
Author: @@product-lead
Date: 2026-07-01

What to build.`;
		const out = stripLeadingMetadataBlock(content);
		expect(out).not.toContain('Status: Draft');
		expect(out).not.toContain('Author: @@product-lead');
		expect(out).toContain('# PRD: Feature');
		expect(out).toContain('What to build.');
	});

	test('strips a metadata block with no heading (block is first)', () => {
		const content = `Status: final
Owner: alice

Body text.`;
		const out = stripLeadingMetadataBlock(content);
		expect(out).toBe('Body text.');
	});

	test('handles a heading + metadata with no blank line between them', () => {
		const content = `# Title\nStatus: draft\nAuthor: bob\n\nBody.`;
		const out = stripLeadingMetadataBlock(content);
		expect(out).toContain('# Title');
		expect(out).not.toContain('Status: draft');
		expect(out).toContain('Body.');
	});

	test('normalizes CRLF line endings', () => {
		const content = `Status: draft\r\nAuthor: bob\r\n\r\nBody.`;
		const out = stripLeadingMetadataBlock(content);
		expect(out).toBe('Body.');
	});

	describe('no-op cases (returns content unchanged)', () => {
		test('an H1-only document', () => {
			const content = '# Hello';
			expect(stripLeadingMetadataBlock(content)).toBe(content);
		});

		test('an ordinary opening paragraph', () => {
			const content = '# Project Notes\n\nSome **markdown** content and a note.';
			expect(stripLeadingMetadataBlock(content)).toBe(content);
		});

		test('a single colon-led line (fewer than 2 fields)', () => {
			const content = 'Note: this is important.\n\nMore text.';
			expect(stripLeadingMetadataBlock(content)).toBe(content);
		});

		test('a block whose first field is not a known leading key', () => {
			const content = 'Foo: 1\nBar: 2\n\nBody.';
			expect(stripLeadingMetadataBlock(content)).toBe(content);
		});

		test('the empty-doc sentinel', () => {
			expect(stripLeadingMetadataBlock('_(empty)_')).toBe('_(empty)_');
		});

		test('a bold span in a value is not mistaken for a label', () => {
			const content = '# T\n\nThe **API:** usage here is important, and so is more prose.';
			expect(stripLeadingMetadataBlock(content)).toBe(content);
		});
	});
});
