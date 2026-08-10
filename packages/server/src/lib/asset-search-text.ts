import { isTextAssetMime } from '@hezo/shared';

/**
 * Extract the searchable text of an asset for `assets.search_text` (weight B of
 * the generated `assets.search_tsv`). Asset bytes live in the AssetStore, not the
 * database, so unlike every other searchable entity there is no column a
 * generated tsvector could read — the text has to be pulled out at write time
 * and persisted onto the row.
 *
 * Pure (no DB, no store) so it is unit-testable in isolation and runs identically
 * under Node (vitest) and Bun (prod), like `image-dimensions.ts`.
 *
 * Every scrubbing rule below exists because `search_tsv` is a GENERATED column:
 * it is computed inside the INSERT/UPDATE, so an input `to_tsvector` chokes on
 * does not degrade the search result — it fails the asset write. A user's 10 MB
 * upload would 500. The caps are therefore load-bearing, not tidiness.
 */

/**
 * Bytes of extracted text stored per asset. Bounds the column's width (assets
 * are capped at `ATTACHMENT_MAX_BYTES`, 10 MB, which is far more than is worth
 * indexing) and keeps the resulting tsvector clear of Postgres' 1 MB ceiling.
 */
export const ASSET_SEARCH_TEXT_MAX_BYTES = 256 * 1024;

/**
 * Longest run of non-whitespace kept. A minified bundle, a base64 `data:` URI
 * inside an SVG, or a long hash is one enormous "word": nobody searches for it,
 * it produces garbage lexemes, and a lexeme over 2 KB makes `to_tsvector` throw.
 * Dropping the run rather than splitting it is deliberate — the fragments would
 * be noise either way.
 */
const MAX_TOKEN_CHARS = 128;

/** Content types whose bytes are markup, indexed for their visible text only. */
const MARKUP_MIME: ReadonlySet<string> = new Set(['text/html', 'image/svg+xml']);

/**
 * The handful of named entities common enough in real markup to be worth
 * decoding. Numeric references are handled separately; anything rarer is left
 * as-is, which costs one junk lexeme at worst.
 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

function decodeEntities(text: string): string {
	// `[xX]` because a hex reference is spelled either way (`&#x41;`, `&#X41;`) and
	// both are valid; matching only the lowercase form leaves the uppercase one in
	// the index as a literal `&#X41;` token.
	return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
		if (body.startsWith('#')) {
			const code =
				body.startsWith('#x') || body.startsWith('#X')
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			// Reject NUL, surrogates and out-of-range code points rather than
			// letting an entity smuggle back in what the scrub below removes.
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
			if (code >= 0xd800 && code <= 0xdfff) return ' ';
			return String.fromCodePoint(code);
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

/** Visible text of an HTML/SVG document: script and style bodies dropped, tags stripped. */
function stripMarkup(text: string): string {
	let out = text.replace(/<!--[\s\S]*?-->/g, ' ');
	out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
	// An unclosed <script> at the truncation boundary would otherwise leak its
	// body into the index; drop everything from the opening tag on.
	out = out.replace(/<(script|style)\b[\s\S]*$/i, ' ');
	out = out.replace(/<[^>]*>/g, ' ');
	return decodeEntities(out);
}

/**
 * The searchable text of an asset: `null` when the type carries none (a binary
 * asset is filename-only), otherwise the scrubbed text — possibly `''` for an
 * empty or wholly unindexable file.
 *
 * The `null` vs `''` split is meaningful: `null` records "this type has no text",
 * `''` records "text was extracted and there was nothing in it".
 */
export function extractAssetSearchText(bytes: Uint8Array, contentType: string): string | null {
	if (!isTextAssetMime(contentType)) return null;

	// Truncate before decoding, so a 10 MB file never materializes as a 10 MB
	// string. A multi-byte sequence cut at the boundary decodes to U+FFFD rather
	// than throwing — TextDecoder is in replacement mode by default.
	const slice =
		bytes.byteLength > ASSET_SEARCH_TEXT_MAX_BYTES
			? bytes.subarray(0, ASSET_SEARCH_TEXT_MAX_BYTES)
			: bytes;
	let text = new TextDecoder('utf-8').decode(slice);

	// A UTF-8 BOM decodes to U+FEFF, which the text-search parser folds into the
	// first token — without this, the first word of every BOM'd file is unfindable.
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

	if (MARKUP_MIME.has(contentType)) text = stripMarkup(text);

	// NUL is rejected outright by Postgres `text` (so it would abort the write),
	// and it doubles as HIGHLIGHT_SENTINEL, so an unscrubbed one would corrupt
	// snippet highlighting too. The other C0 controls carry no searchable text.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: scrubbing control characters is the point
	text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

	text = text.replace(/\S+/g, (token) => (token.length > MAX_TOKEN_CHARS ? ' ' : token));

	return text.replace(/\s+/g, ' ').trim();
}

/** `extractAssetSearchText` over a Blob, for the write paths that hold one. */
export async function assetSearchTextFromBlob(
	blob: Blob,
	contentType: string,
): Promise<string | null> {
	if (!isTextAssetMime(contentType)) return null;
	return extractAssetSearchText(new Uint8Array(await blob.arrayBuffer()), contentType);
}
