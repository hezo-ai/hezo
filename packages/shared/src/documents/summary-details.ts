import { markdownToPreviewText } from './text.js';

/**
 * Comments and task descriptions open with a summary written for a person, and
 * may carry a technical-details section after one marker heading. People see the
 * summary with the details collapsed under it; agents read both. Text without the
 * marker is all summary, so older content and human writing render whole.
 */

/** The heading line that starts the technical details. Matched without regard to letter case. */
export const SUMMARY_DETAILS_HEADING = '## Technical details';

/** Above this many words, text with no technical details section earns a warning. */
export const SUMMARY_DETAILS_SUGGESTED_WORDS = 150;

/** Above this many words, a summary earns a warning. */
export const SUMMARY_MAX_WORDS = 80;

const MARKER_RE = /^##[ \t]+technical[ \t]+details[ \t]*$/i;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// A line that looks like an attempt at the marker but is not it: another heading
// level, a bold label, a trailing colon, or the bare word "Details" as a heading.
const NEAR_MISS_RE =
	/^(?:#{1,6}[ \t]*|\*\*|__)?[ \t]*(?:technical[ \t]+details?|details)[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*$/i;
const NEAR_MISS_LEAD_RE = /^(?:#|\*\*|__)|technical/i;
const HEADING_RE = /^#{1,6}[ \t]+\S/;
const TABLE_RULE_RE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/;

export interface SummaryDetails {
	summary: string;
	/** The text after the marker, or null when the text has no marker. */
	details: string | null;
}

interface ScannedLine {
	text: string;
	inFence: boolean;
}

/** Each line of `text` with whether it sits inside a fenced code block (fence lines included). */
function scanLines(text: string): ScannedLine[] {
	const out: ScannedLine[] = [];
	let fence: string | null = null;
	for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
		const open = FENCE_RE.exec(raw);
		if (fence === null && open) {
			fence = open[1][0].repeat(open[1].length);
			out.push({ text: raw, inFence: true });
		} else if (fence !== null) {
			out.push({ text: raw, inFence: true });
			if (raw.trim().startsWith(fence)) fence = null;
		} else {
			out.push({ text: raw, inFence: false });
		}
	}
	return out;
}

/** Split text at its first technical-details marker outside code. */
export function splitSummaryDetails(text: string): SummaryDetails {
	const lines = scanLines(text);
	const at = lines.findIndex((l) => !l.inFence && MARKER_RE.test(l.text.trim()));
	if (at === -1) return { summary: text.trim(), details: null };
	const join = (ls: ScannedLine[]) =>
		ls
			.map((l) => l.text)
			.join('\n')
			.trim();
	return { summary: join(lines.slice(0, at)), details: join(lines.slice(at + 1)) };
}

/** Text that opens with `summary` and carries `details` under the marker. */
export function joinSummaryDetails(summary: string, details: string): string {
	return `${summary.trim()}\n\n${SUMMARY_DETAILS_HEADING}\n\n${details.trim()}`;
}

/** The part of `text` a person sees before expanding anything. */
export function summaryOf(text: string): string {
	return splitSummaryDetails(text).summary;
}

/**
 * The summary as one line of plain prose, cut to `maxLen` with an ellipsis: the
 * preview a row shows for a comment or description.
 */
export function summaryPreviewLine(text: string, maxLen: number): string {
	const line = markdownToPreviewText(summaryOf(text));
	if (line.length <= maxLen) return line;
	return `${line.slice(0, maxLen - 1).trimEnd()}…`;
}

function countWords(text: string): number {
	return text.match(/\S+/g)?.length ?? 0;
}

function hasStructure(lines: ScannedLine[]): boolean {
	return lines.some((l) => l.inFence || HEADING_RE.test(l.text) || TABLE_RULE_RE.test(l.text));
}

/**
 * Advisory warnings on the shape of an agent's comment or task description:
 * long or structured text with no technical details, an overlong or empty
 * summary, a near-miss marker, and active mentions that sit only in the
 * collapsed part. `activeMentions` returns the slugs a piece of text wakes.
 */
export function summaryDetailsWarnings(
	text: string,
	activeMentions: (part: string) => string[],
): string[] {
	const { summary, details } = splitSummaryDetails(text);
	const warnings: string[] = [];
	const nearMiss = scanLines(text).find(
		(l) =>
			!l.inFence &&
			!MARKER_RE.test(l.text.trim()) &&
			NEAR_MISS_RE.test(l.text.trim()) &&
			NEAR_MISS_LEAD_RE.test(l.text.trim()),
	);
	if (nearMiss) {
		warnings.push(
			`The line "${nearMiss.text.trim()}" is not the technical-details marker, so nothing below it is collapsed. ` +
				`Write the marker as its own line, exactly "${SUMMARY_DETAILS_HEADING}".`,
		);
	}
	if (details === null) {
		if (
			!nearMiss &&
			(countWords(summary) > SUMMARY_DETAILS_SUGGESTED_WORDS || hasStructure(scanLines(summary)))
		) {
			warnings.push(
				'This text is long or carries a table, heading or code block, and has no technical details section. ' +
					'People read all of it. Keep a short, plain summary at the top and move the rest under a ' +
					`"${SUMMARY_DETAILS_HEADING}" line, where it is collapsed for people.`,
			);
		}
		return warnings;
	}
	if (summary === '') {
		warnings.push(
			`The text starts with "${SUMMARY_DETAILS_HEADING}", so people see nothing until they expand it. ` +
				'Write a short, plain summary above the marker.',
		);
	} else if (countWords(summary) > SUMMARY_MAX_WORDS) {
		warnings.push(
			`The summary above "${SUMMARY_DETAILS_HEADING}" is ${countWords(summary)} words. ` +
				`Keep it to about three short sentences (at most ${SUMMARY_MAX_WORDS} words) and move the rest under the marker.`,
		);
	}
	const inSummary = new Set(activeMentions(summary));
	const hidden = activeMentions(details).filter((slug) => !inSummary.has(slug));
	if (hidden.length > 0) {
		const named = hidden.map((s) => `@${s}`).join(', ');
		warnings.push(
			`${named} ${hidden.length === 1 ? 'is' : 'are'} mentioned only under "${SUMMARY_DETAILS_HEADING}". The mention still wakes them, ` +
				'but people see that part collapsed. Put each request in the summary, in plain words, ' +
				'and keep only the exact steps under the marker.',
		);
	}
	return warnings;
}
