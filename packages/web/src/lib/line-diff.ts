import { diffLines } from 'diff';

export type DiffLineKind = 'context' | 'added' | 'removed';

/** One line of a unified diff, numbered on the side(s) it exists on. */
export interface DiffLine {
	kind: DiffLineKind;
	oldNo: number | null;
	newNo: number | null;
	text: string;
}

/** A run of unchanged lines folded away, opened on demand. */
export interface DiffFold {
	kind: 'fold';
	/** Stable while the inputs are, so an opened fold stays open across renders. */
	id: number;
	lines: DiffLine[];
}

export type DiffItem = DiffLine | DiffFold;

export interface LineDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
}

/** Unchanged lines kept beside each change before the rest of a run folds. */
export const DIFF_CONTEXT_LINES = 3;

/** A run shorter than this is shown whole: folding it would hide less than the fold row costs. */
const MIN_FOLD_LINES = 4;

function splitLines(value: string): string[] {
	const lines = value.split('\n');
	// diffLines ends each part on its newline, so the final split is empty.
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Ends a text on a newline. The diff compares lines with their newlines, so a
 * last line without one differs from the same line with one, and an unchanged
 * final line would show as removed and added again.
 */
function terminated(value: string): string {
	return value === '' || value.endsWith('\n') ? value : `${value}\n`;
}

/** The line-by-line difference between two texts, numbered on both sides. */
export function computeLineDiff(before: string, after: string): LineDiff {
	const lines: DiffLine[] = [];
	let oldNo = 1;
	let newNo = 1;
	let added = 0;
	let removed = 0;
	for (const part of diffLines(terminated(before), terminated(after))) {
		for (const text of splitLines(part.value)) {
			if (part.added) {
				lines.push({ kind: 'added', oldNo: null, newNo: newNo++, text });
				added += 1;
			} else if (part.removed) {
				lines.push({ kind: 'removed', oldNo: oldNo++, newNo: null, text });
				removed += 1;
			} else {
				lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text });
			}
		}
	}
	return { lines, added, removed };
}

/**
 * The diff with long unchanged runs folded, keeping `context` lines beside
 * every change. A run with no change on one side (the start or the end of the
 * text) keeps context only on the side that has one.
 */
export function foldUnchanged(lines: DiffLine[], context = DIFF_CONTEXT_LINES): DiffItem[] {
	const items: DiffItem[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind !== 'context') {
			items.push(lines[i]);
			i += 1;
			continue;
		}
		let end = i;
		while (end < lines.length && lines[end].kind === 'context') end += 1;
		const run = lines.slice(i, end);
		const keepBefore = i === 0 ? 0 : context;
		const keepAfter = end === lines.length ? 0 : context;
		if (run.length - keepBefore - keepAfter < MIN_FOLD_LINES) {
			items.push(...run);
		} else {
			items.push(...run.slice(0, keepBefore));
			items.push({ kind: 'fold', id: i, lines: run.slice(keepBefore, run.length - keepAfter) });
			items.push(...run.slice(run.length - keepAfter));
		}
		i = end;
	}
	return items;
}
