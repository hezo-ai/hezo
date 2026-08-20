/**
 * Markdown-to-text helpers, and the document download shapes built on them.
 * Project documents are stored as Markdown, so the two download formats are the
 * Markdown source itself and a plain-text rendering with the syntax stripped;
 * that same strip is what every preview line renders, so no surface shows a
 * reader raw `**` or `##`. These are pure functions (no DOM, no browser APIs) so
 * they live in the shared package and are unit-tested there; the browser-side
 * blob/anchor plumbing lives in the web package.
 */

export type DocDownloadFormat = 'markdown' | 'text';

/** MIME type for each download format (UTF-8 assumed by the caller). */
export const DOC_DOWNLOAD_MIME: Record<DocDownloadFormat, string> = {
	markdown: 'text/markdown',
	text: 'text/plain',
};

/**
 * Derive the download filename for a document from its source filename (e.g.
 * `notes.md`). Markdown downloads keep the `.md` name (appending `.md` only if
 * the source somehow lacks it); text downloads swap the `.md` extension for
 * `.txt`.
 */
export function docDownloadFilename(sourceFilename: string, format: DocDownloadFormat): string {
	const base = sourceFilename.replace(/\.md$/i, '');
	if (format === 'text') return `${base}.txt`;
	return /\.md$/i.test(sourceFilename) ? sourceFilename : `${sourceFilename}.md`;
}

/** Strip inline Markdown syntax from a single (non-code) line. */
function stripInlineMarkdown(line: string): string {
	let s = line;
	// Horizontal rules (---, ***, ___) collapse to an empty line.
	if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) return '';
	// ATX heading markers and trailing closing #'s.
	s = s.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
	// Blockquote markers (possibly nested).
	s = s.replace(/^(\s{0,3}>\s?)+/, '');
	// Unordered list markers become a bullet; ordered markers are kept as-is.
	s = s.replace(/^(\s*)[-*+]\s+/, '$1• ');
	// Images -> alt text, then links -> link text (images first so the leading
	// `!` doesn't strand once the brackets are gone).
	s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	// Emphasis: bold/italic (** __ * _) and strikethrough (~~). A delimiter must
	// hug its content, and an underscore one must not sit inside a word, so
	// `snake_case_name` and `2 * 3 * 4` survive as written.
	s = s.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '$1');
	s = s.replace(/(?<!\w)__(\S(?:.*?\S)?)__(?!\w)/g, '$1');
	s = s.replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '$1');
	s = s.replace(/(?<!\w)_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1');
	s = s.replace(/~~(.+?)~~/g, '$1');
	// Inline code.
	s = s.replace(/`([^`]+)`/g, '$1');
	return s;
}

/**
 * Render Markdown as readable plain text. This is a lightweight, dependency-free
 * strip — not a full Markdown parser: it removes headings, emphasis, link/image
 * syntax (keeping the visible text), blockquote and list markers, and fenced
 * code fences (keeping the code lines verbatim). Runs of blank lines are
 * collapsed. It is intentionally conservative — tables and other constructs pass
 * through mostly intact.
 */
export function markdownToPlainText(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let inFence = false;

	for (const raw of lines) {
		if (/^\s*(```|~~~)/.test(raw)) {
			// Drop the fence line itself; toggle whether we're inside a code block.
			inFence = !inFence;
			continue;
		}
		out.push(inFence ? raw : stripInlineMarkdown(raw));
	}

	return out
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Collapse a Markdown body to the one line of prose a preview row shows - an
 * inbox snippet, a search result's lead. Strips the syntax, then folds every run
 * of whitespace so a multi-line source reads as a single line. Truncation is the
 * caller's, since each surface carries its own budget.
 */
export function markdownToPreviewText(markdown: string): string {
	return markdownToPlainText(markdown).replace(/\s+/g, ' ').trim();
}
