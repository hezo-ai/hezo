import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/lib/frontmatter';

describe('parseFrontmatter', () => {
	it('returns empty data and the input as body when there is no fence', () => {
		expect(parseFrontmatter('just a body')).toEqual({ data: {}, body: 'just a body' });
	});

	it('extracts top-level scalar key/value pairs and the trailing body', () => {
		const input = '---\nname: Deploy\ndescription: Ship the app\n---\n# Heading\nbody text';
		const { data, body } = parseFrontmatter(input);
		expect(data).toEqual({ name: 'Deploy', description: 'Ship the app' });
		expect(body).toBe('# Heading\nbody text');
	});

	it('strips matching single or double quotes around values', () => {
		const { data } = parseFrontmatter('---\na: "quoted"\nb: \'single\'\n---\n');
		expect(data).toEqual({ a: 'quoted', b: 'single' });
	});

	it('ignores nested/indented children and non key:value lines', () => {
		const input = '---\nname: Top\n  nested: child\nnot a pair\n---\nbody';
		const { data, body } = parseFrontmatter(input);
		expect(data).toEqual({ name: 'Top' });
		expect(body).toBe('body');
	});

	it('tolerates a leading BOM and CRLF line endings', () => {
		const input = '﻿---\r\nname: WithBom\r\n---\r\nbody';
		const { data, body } = parseFrontmatter(input);
		expect(data).toEqual({ name: 'WithBom' });
		expect(body).toBe('body');
	});
});
