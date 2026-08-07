/**
 * Targeted old-string/new-string edits for the DB-backed text records agents
 * author (project docs, text project assets).
 *
 * These records used to be writable only by sending the whole body back, which
 * has two costs an edit primitive removes. The argument grows with the
 * document rather than the change, and a runtime that caps tool-call argument
 * size can cut it mid-stream; and an agent that wants a one-line fix is offered
 * nothing that matches its intent, so it reaches for the filesystem `Edit` tool
 * instead - which writes to a disk nobody reads.
 *
 * Pure string logic, no IO: the callers own reading, authorization and
 * persistence.
 */

/** Lines of surrounding context returned either side of an applied edit. */
const HUNK_CONTEXT_LINES = 3;

/**
 * Cap on the returned hunk. The hunk exists so a caller can confirm what landed
 * without a re-read; past a point it stops being a confirmation and starts
 * being the document again.
 */
const HUNK_MAX_CHARS = 2_000;

export type StringEditResult =
	| { ok: true; content: string; replacements: number; hunk: string }
	| { ok: false; error: string };

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	let n = 0;
	for (
		let i = haystack.indexOf(needle);
		i !== -1;
		i = haystack.indexOf(needle, i + needle.length)
	) {
		n++;
	}
	return n;
}

/** Index of the line containing character `offset`. */
function lineIndexAt(lines: string[], offset: number): number {
	let pos = 0;
	for (let i = 0; i < lines.length; i++) {
		pos += lines[i].length + 1; // + 1 for the newline the split consumed
		if (offset < pos) return i;
	}
	return Math.max(0, lines.length - 1);
}

/**
 * Render the region around an applied edit, with line numbers and a few lines
 * of context, so the caller can see what actually landed.
 */
export function buildEditHunk(
	content: string,
	start: number,
	end: number,
	contextLines: number = HUNK_CONTEXT_LINES,
): string {
	const lines = content.split('\n');
	const firstLine = Math.max(0, lineIndexAt(lines, start) - contextLines);
	const lastLine = Math.min(
		lines.length - 1,
		lineIndexAt(lines, Math.max(start, end - 1)) + contextLines,
	);
	const rendered = lines
		.slice(firstLine, lastLine + 1)
		.map((line, i) => `${firstLine + i + 1}\t${line}`)
		.join('\n');
	if (rendered.length <= HUNK_MAX_CHARS) return rendered;
	return `${rendered.slice(0, HUNK_MAX_CHARS)}\n... (hunk truncated; read the record for its full text)`;
}

/**
 * Replace `oldString` with `newString` in `text`.
 *
 * Refuses rather than guesses: an empty or unchanged anchor, an anchor that
 * matches nothing, and an ambiguous anchor that matches several places without
 * `replaceAll` are all errors. Silently editing the first of several matches is
 * the failure mode this exists to prevent - the caller cannot tell which one it
 * got, and the wrong one looks identical to the right one.
 */
export function applyStringEdit(
	text: string,
	oldString: string,
	newString: string,
	opts: { replaceAll?: boolean } = {},
): StringEditResult {
	if (oldString === '') {
		return {
			ok: false,
			error:
				'`old_string` must not be empty - it is the anchor this edit replaces. To replace an entire body, use the write tool instead.',
		};
	}
	if (oldString === newString) {
		return {
			ok: false,
			error: '`old_string` and `new_string` are identical, so this edit would change nothing.',
		};
	}

	const count = countOccurrences(text, oldString);
	if (count === 0) {
		// Whitespace is the usual culprit, and the usual cause is retyping the
		// anchor from memory instead of copying it, so say so explicitly.
		const looseHint = text.includes(oldString.trim())
			? ' A match exists ignoring leading/trailing whitespace, so the difference is whitespace only.'
			: '';
		return {
			ok: false,
			error: `\`old_string\` was not found. It must match the current text exactly, including indentation, punctuation and line breaks.${looseHint} Read the record first and copy the span verbatim rather than retyping it.`,
		};
	}
	if (count > 1 && !opts.replaceAll) {
		return {
			ok: false,
			error: `\`old_string\` matches ${count} places, so which one to change is ambiguous. Extend it with surrounding lines until it is unique, or pass replace_all: true to change all ${count}.`,
		};
	}

	const start = text.indexOf(oldString);
	if (opts.replaceAll) {
		const content = text.split(oldString).join(newString);
		return {
			ok: true,
			content,
			replacements: count,
			hunk: buildEditHunk(content, start, start + newString.length),
		};
	}
	const content = text.slice(0, start) + newString + text.slice(start + oldString.length);
	return {
		ok: true,
		content,
		replacements: 1,
		hunk: buildEditHunk(content, start, start + newString.length),
	};
}
