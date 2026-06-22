import { HEZO_DOCS_URL } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { buildHezoDocsBlock, parseDoc } from '../src/services/docs-bundle';

describe('parseDoc', () => {
	it('strips frontmatter and reads title/order/section', () => {
		const raw = [
			'---',
			'title: Installation',
			'order: 2',
			'section: Getting started',
			'---',
			'',
			'# Installation',
			'',
			'Hezo ships as a single binary.',
		].join('\n');

		const doc = parseDoc(raw);
		expect(doc.title).toBe('Installation');
		expect(doc.order).toBe(2);
		expect(doc.section).toBe('Getting started');
		// Frontmatter block removed; body retained.
		expect(doc.body).not.toContain('---');
		expect(doc.body).not.toContain('order:');
		expect(doc.body).toContain('Hezo ships as a single binary.');
	});

	it('defaults order to Infinity when frontmatter is absent', () => {
		const doc = parseDoc('# No frontmatter\n\nBody only.');
		expect(doc.order).toBe(Number.POSITIVE_INFINITY);
		expect(doc.title).toBe('');
		expect(doc.body).toContain('Body only.');
	});
});

describe('buildHezoDocsBlock', () => {
	it('embeds the bundled docs, ordered and grouped, led by the live URL', async () => {
		const block = await buildHezoDocsBlock();

		// Header points at the live docs site.
		expect(block.startsWith('# Hezo documentation')).toBe(true);
		expect(block).toContain(HEZO_DOCS_URL);

		// Real doc sections + content are present (frontmatter stripped).
		expect(block).toContain('## Getting started');
		expect(block).toContain('## Concepts');
		expect(block).toContain('### Installation');
		expect(block).not.toContain('order:');

		// Ordering: the Introduction (order 1) precedes Installation (order 2),
		// which precedes the CLI reference (order 24).
		const intro = block.indexOf('Introduction');
		const install = block.indexOf('### Installation');
		const cli = block.indexOf('CLI reference');
		expect(intro).toBeGreaterThanOrEqual(0);
		expect(install).toBeGreaterThan(intro);
		expect(cli).toBeGreaterThan(install);
	});
});
