import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDefaultSkills, parseDefaultSkills } from '../src/db/default-skills';

const IN_HOUSE_SLUGS = [
	'data-analysis',
	'deep-research',
	'web-design-guidelines',
	'writing-guidelines',
];

describe('shipped default skills content', () => {
	it('loads the full catalog with valid, self-contained definitions', async () => {
		const defs = await loadDefaultSkills();

		expect(defs).toHaveLength(15);
		const slugs = defs.map((d) => d.slug);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(slugs).not.toContain('ATTRIBUTION');

		for (const d of defs) {
			expect(d.name.length, d.slug).toBeGreaterThan(0);
			expect(d.description.length, d.slug).toBeGreaterThan(0);
			// Descriptions land in every run manifest — keep them short.
			expect(d.description.length, d.slug).toBeLessThanOrEqual(300);
			expect(d.content.length, d.slug).toBeGreaterThan(100);
			// Frontmatter must be stripped from the stored body.
			expect(d.content.startsWith('---'), d.slug).toBe(false);
			// User-facing terminology: "task", never "ticket".
			expect(/\bticket/i.test(d.content), d.slug).toBe(false);
			expect(d.contentHash).toBe(createHash('sha256').update(d.content).digest('hex'));
		}
	});

	it('carries pinned upstream source URLs on adapted skills and none on in-house ones', async () => {
		const defs = await loadDefaultSkills();
		for (const d of defs) {
			if (IN_HOUSE_SLUGS.includes(d.slug)) {
				expect(d.sourceUrl, d.slug).toBeNull();
			} else {
				expect(d.sourceUrl, d.slug).toMatch(/^https:\/\/github\.com\//);
				// Pinned to a commit, not a branch, so attribution stays stable.
				expect(d.sourceUrl, d.slug).toMatch(/\/[0-9a-f]{40}\//);
			}
		}
	});
});

describe('default skills loader', () => {
	let dir: string | undefined;
	const priorEnv = process.env.HEZO_SKILLS_DIR;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		if (priorEnv === undefined) delete process.env.HEZO_SKILLS_DIR;
		else process.env.HEZO_SKILLS_DIR = priorEnv;
	});

	it('honours HEZO_SKILLS_DIR, derives missing descriptions, skips invalid files', async () => {
		dir = mkdtempSync(join(tmpdir(), 'hezo-skills-fixture-'));
		writeFileSync(
			join(dir, 'quoted.md'),
			'---\nname: "Quoted Name"\ndescription: "A quoted description"\nsource_url: https://github.com/x/y\n---\n\n# Quoted\n\nBody text.\n',
		);
		writeFileSync(
			join(dir, 'no-description.md'),
			'---\nname: No Description\n---\n\n# No Description\n\nFirst prose line becomes the summary.\n',
		);
		// Missing `name` → skipped with a warning, not seeded half-formed.
		writeFileSync(join(dir, 'nameless.md'), '---\ndescription: x\n---\n\n# Nameless\n\nBody.\n');
		// ATTRIBUTION.md is documentation, never a skill.
		writeFileSync(join(dir, 'ATTRIBUTION.md'), '# Attribution\n\nLicense text.\n');
		process.env.HEZO_SKILLS_DIR = dir;

		const defs = await loadDefaultSkills();
		expect(defs.map((d) => d.slug)).toEqual(['no-description', 'quoted']);

		const quoted = defs.find((d) => d.slug === 'quoted');
		expect(quoted?.name).toBe('Quoted Name');
		expect(quoted?.description).toBe('A quoted description');
		expect(quoted?.sourceUrl).toBe('https://github.com/x/y');
		expect(quoted?.content).toBe('# Quoted\n\nBody text.');

		const derived = defs.find((d) => d.slug === 'no-description');
		expect(derived?.description).toBe('First prose line becomes the summary.');
	});

	it('parses a raw map deterministically and sorts by slug', () => {
		const defs = parseDefaultSkills({
			'b.md': '---\nname: B\n---\nBody B',
			'a.md': '---\nname: A\n---\nBody A',
			'ATTRIBUTION.md': 'not a skill',
		});
		expect(defs.map((d) => d.slug)).toEqual(['a', 'b']);
		expect(defs[0].contentHash).toBe(createHash('sha256').update('Body A').digest('hex'));
	});
});
