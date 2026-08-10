import { ATTACHMENT_EXTENSIONS, HIGHLIGHT_SENTINEL, isTextAssetMime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	ASSET_SEARCH_TEXT_MAX_BYTES,
	assetSearchTextFromBlob,
	extractAssetSearchText,
} from '../src/lib/asset-search-text';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('extractAssetSearchText', () => {
	it('returns null for binary types and a string for textual ones', () => {
		for (const mime of ['image/png', 'application/pdf', 'application/zip', 'video/mp4']) {
			expect(extractAssetSearchText(utf8('anything'), mime), mime).toBeNull();
		}
		for (const mime of ['text/plain', 'text/markdown', 'text/html', 'image/svg+xml']) {
			expect(typeof extractAssetSearchText(utf8('hello'), mime), mime).toBe('string');
		}
	});

	it('agrees with isTextAssetMime across the whole attachment allowlist', () => {
		// The extractor's null/non-null split is the same rule the search branch and
		// the write paths rely on; pin it to the shared predicate rather than to a
		// hand-copied list that can drift when a new extension is allowed.
		for (const mime of new Set(Object.values(ATTACHMENT_EXTENSIONS))) {
			const extracted = extractAssetSearchText(utf8('hello'), mime);
			expect(extracted !== null, mime).toBe(isTextAssetMime(mime));
		}
	});

	it('strips NUL so the write cannot fail and highlighting cannot be corrupted', () => {
		// Postgres `text` rejects NUL outright, so an unscrubbed one aborts the
		// INSERT rather than degrading the result. It is also HIGHLIGHT_SENTINEL.
		const out = extractAssetSearchText(utf8('alpha\u0000beta'), 'text/plain');
		expect(out).toBe('alpha beta');
		expect(out).not.toContain(HIGHLIGHT_SENTINEL);
	});

	it('strips other C0 controls but keeps tab and newline as whitespace', () => {
		expect(extractAssetSearchText(utf8('a\u0007b\u001Fc'), 'text/plain')).toBe('a b c');
		expect(extractAssetSearchText(utf8('one\ttwo\nthree'), 'text/plain')).toBe('one two three');
	});

	it('strips a UTF-8 BOM so the first word stays searchable', () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hello world')]);
		expect(extractAssetSearchText(bytes, 'text/plain')).toBe('hello world');
	});

	it('does not throw on invalid UTF-8', () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x42]);
		expect(() => extractAssetSearchText(bytes, 'text/plain')).not.toThrow();
		expect(extractAssetSearchText(bytes, 'text/plain')).toContain('AB');
	});

	it('caps the stored text at ASSET_SEARCH_TEXT_MAX_BYTES', () => {
		const big = utf8(`${'word '.repeat(200_000)}`);
		expect(big.byteLength).toBeGreaterThan(ASSET_SEARCH_TEXT_MAX_BYTES);
		const out = extractAssetSearchText(big, 'text/plain') as string;
		expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(ASSET_SEARCH_TEXT_MAX_BYTES);
	});

	it('truncates multi-byte input without throwing at the byte boundary', () => {
		// Every character is 3 bytes, so the cap lands mid-sequence.
		const bytes = utf8('あ'.repeat(ASSET_SEARCH_TEXT_MAX_BYTES));
		expect(() => extractAssetSearchText(bytes, 'text/plain')).not.toThrow();
	});

	it('drops runs too long to be searchable, keeping the words around them', () => {
		// A lexeme over 2 KB makes to_tsvector throw, which in a GENERATED column
		// means a failed asset write - so an over-long run must never reach the DB.
		const blob = 'a'.repeat(5_000);
		const out = extractAssetSearchText(utf8(`before ${blob} after`), 'text/plain') as string;
		expect(out).toBe('before after');
		for (const token of out.split(' ')) expect(token.length).toBeLessThanOrEqual(128);
	});

	it('returns an empty string, not null, for a textual asset with nothing in it', () => {
		expect(extractAssetSearchText(utf8(''), 'text/plain')).toBe('');
		expect(extractAssetSearchText(utf8('   \n\t '), 'text/markdown')).toBe('');
	});

	it('leaves markdown and script assets unstripped', () => {
		// Scripts store as text/plain; their identifiers are the searchable content.
		expect(extractAssetSearchText(utf8('const retryBudget = 3;'), 'text/plain')).toBe(
			'const retryBudget = 3;',
		);
		expect(extractAssetSearchText(utf8('# Heading\n\nBody text'), 'text/markdown')).toBe(
			'# Heading Body text',
		);
	});

	describe('markup types', () => {
		it('keeps visible text and drops tags', () => {
			const html = '<html><body><p>quarterly <b>revenue</b> projections</p></body></html>';
			expect(extractAssetSearchText(utf8(html), 'text/html')).toBe('quarterly revenue projections');
		});

		it('drops script and style bodies', () => {
			const html =
				'<style>.hero { color: red }</style><p>visible copy</p><script>var secret = 1</script>';
			const out = extractAssetSearchText(utf8(html), 'text/html') as string;
			expect(out).toBe('visible copy');
			expect(out).not.toContain('secret');
			expect(out).not.toContain('color');
		});

		it('drops an unclosed script body at a truncation boundary', () => {
			const out = extractAssetSearchText(
				utf8('<p>visible</p><script>var leaked = 1'),
				'text/html',
			) as string;
			expect(out).toBe('visible');
			expect(out).not.toContain('leaked');
		});

		it('drops comments and does not index attribute names', () => {
			const html = '<!-- internal note --><div class="hero-banner" id="top">copy</div>';
			const out = extractAssetSearchText(utf8(html), 'text/html') as string;
			expect(out).toBe('copy');
			expect(out).not.toContain('div');
			expect(out).not.toContain('hero-banner');
		});

		it('keeps SVG text content and drops its markup', () => {
			const svg =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Flow chart</title><text>Ingest</text></svg>';
			const out = extractAssetSearchText(utf8(svg), 'image/svg+xml') as string;
			expect(out).toBe('Flow chart Ingest');
			expect(out).not.toContain('viewBox');
			expect(out).not.toContain('xmlns');
		});

		it('decodes entities, including a numeric NUL that must not survive', () => {
			expect(extractAssetSearchText(utf8('<p>a &amp; b &#65; &nbsp; c</p>'), 'text/html')).toBe(
				'a & b A c',
			);
			const out = extractAssetSearchText(utf8('<p>x&#0;y</p>'), 'text/html') as string;
			expect(out).not.toContain(HIGHLIGHT_SENTINEL);
		});
	});
});

describe('assetSearchTextFromBlob', () => {
	it('extracts from a Blob and short-circuits binary types', async () => {
		const text = new Blob(['quarterly revenue'], { type: 'text/markdown' });
		expect(await assetSearchTextFromBlob(text, 'text/markdown')).toBe('quarterly revenue');
		const binary = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
		expect(await assetSearchTextFromBlob(binary, 'image/png')).toBeNull();
	});
});
