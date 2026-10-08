import { describe, expect, it } from 'vitest';
import {
	joinSummaryDetails,
	SUMMARY_DETAILS_HEADING,
	SUMMARY_DETAILS_SUGGESTED_WORDS,
	SUMMARY_MAX_WORDS,
	splitSummaryDetails,
	summaryDetailsWarnings,
	summaryOf,
	summaryPreviewLine,
} from '../src/documents/summary-details';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const mentions = (part: string) => [...part.matchAll(/(?<!@)@([a-z-]+)/g)].map((m) => m[1]);

describe('splitSummaryDetails', () => {
	it('treats text with no marker as all summary', () => {
		expect(splitSummaryDetails('  Done. Nothing else.\n')).toEqual({
			summary: 'Done. Nothing else.',
			details: null,
		});
	});

	it('splits at the marker line and drops the marker itself', () => {
		const text = `Plain summary.\n\n${SUMMARY_DETAILS_HEADING}\n\n- step one\n- step two\n`;
		expect(splitSummaryDetails(text)).toEqual({
			summary: 'Plain summary.',
			details: '- step one\n- step two',
		});
	});

	it('matches the marker without regard to letter case or trailing spaces', () => {
		expect(splitSummaryDetails('S\n## TECHNICAL Details  \nD').details).toBe('D');
	});

	it('splits at the first marker only', () => {
		const text = `S\n${SUMMARY_DETAILS_HEADING}\nA\n${SUMMARY_DETAILS_HEADING}\nB`;
		expect(splitSummaryDetails(text)).toEqual({
			summary: 'S',
			details: `A\n${SUMMARY_DETAILS_HEADING}\nB`,
		});
	});

	it('ignores a marker inside a fenced code block', () => {
		const text = `S\n\n\`\`\`md\n${SUMMARY_DETAILS_HEADING}\n\`\`\`\n\nmore`;
		expect(splitSummaryDetails(text).details).toBeNull();
		const tilde = `S\n~~~\n${SUMMARY_DETAILS_HEADING}\n~~~\n${SUMMARY_DETAILS_HEADING}\nD`;
		expect(splitSummaryDetails(tilde).details).toBe('D');
	});

	it('normalizes CRLF line endings', () => {
		expect(splitSummaryDetails(`S\r\n${SUMMARY_DETAILS_HEADING}\r\nD\r\n`)).toEqual({
			summary: 'S',
			details: 'D',
		});
	});

	it('does not split on a near-miss heading', () => {
		for (const line of [
			'### Technical details',
			'## Details',
			'**Technical details**',
			'## Technical details:',
		]) {
			expect(splitSummaryDetails(`S\n${line}\nD`).details).toBeNull();
		}
	});

	it('joinSummaryDetails builds text that splits back into its parts', () => {
		const text = joinSummaryDetails(' Plain summary. ', '\n- step one\n');
		expect(splitSummaryDetails(text)).toEqual({ summary: 'Plain summary.', details: '- step one' });
	});

	it('summaryOf returns the visible part', () => {
		expect(summaryOf(`Short.\n${SUMMARY_DETAILS_HEADING}\nLong.`)).toBe('Short.');
	});
});

describe('summaryDetailsWarnings', () => {
	it('is quiet for short plain text and for a well-formed split', () => {
		expect(summaryDetailsWarnings('Reconnected. Daily check runs again.', mentions)).toEqual([]);
		const text = `Fixed. @captain please review.\n\n${SUMMARY_DETAILS_HEADING}\n\n${words(400)}\n\n| a | b |\n|---|---|`;
		expect(summaryDetailsWarnings(text, mentions)).toEqual([]);
	});

	it('warns when long text has no technical details', () => {
		const [w] = summaryDetailsWarnings(words(SUMMARY_DETAILS_SUGGESTED_WORDS + 1), mentions);
		expect(w).toContain('has no technical details section');
		expect(summaryDetailsWarnings(words(SUMMARY_DETAILS_SUGGESTED_WORDS), mentions)).toEqual([]);
	});

	it('warns when short text carries a table, heading or code block', () => {
		for (const body of ['| a | b |\n|---|---|\n| 1 | 2 |', '## Findings\nx', '```\nx\n```']) {
			expect(summaryDetailsWarnings(`S\n\n${body}`, mentions)[0]).toContain(
				'no technical details section',
			);
		}
	});

	it('warns on an overlong summary', () => {
		const text = `${words(SUMMARY_MAX_WORDS + 1)}\n${SUMMARY_DETAILS_HEADING}\nD`;
		expect(summaryDetailsWarnings(text, mentions)[0]).toContain(`${SUMMARY_MAX_WORDS + 1} words`);
	});

	it('warns on an empty summary', () => {
		expect(summaryDetailsWarnings(`${SUMMARY_DETAILS_HEADING}\nD`, mentions)[0]).toContain(
			'people see nothing',
		);
	});

	it('warns on a near-miss marker and not again about missing details', () => {
		const result = summaryDetailsWarnings(`S\n## Details\n${words(300)}`, mentions);
		expect(result).toHaveLength(1);
		expect(result[0]).toContain('"## Details" is not the technical-details marker');
	});

	it('does not treat an ordinary heading containing the word as a near miss', () => {
		expect(summaryDetailsWarnings('S\n\n### Source check details\nx', mentions)[0]).not.toContain(
			'is not the technical-details marker',
		);
	});

	it('warns when an active mention sits only under the marker', () => {
		const text = `Done.\n${SUMMARY_DETAILS_HEADING}\n@equity-analyst re-run the model. @@captain saw it.`;
		const result = summaryDetailsWarnings(text, mentions);
		expect(result).toHaveLength(1);
		expect(result[0]).toContain('@equity-analyst is mentioned only under');
		const ok = `Done. @equity-analyst please re-run.\n${SUMMARY_DETAILS_HEADING}\n@equity-analyst steps: x`;
		expect(summaryDetailsWarnings(ok, mentions)).toEqual([]);
	});
});

describe('summaryPreviewLine', () => {
	it('previews the summary as one plain line', () => {
		const text = `**Done.** Prices are\nunchanged.\n\n${SUMMARY_DETAILS_HEADING}\n\n| a | b |`;
		expect(summaryPreviewLine(text, 100)).toBe('Done. Prices are unchanged.');
	});

	it('cuts a long summary with an ellipsis inside the budget', () => {
		const line = summaryPreviewLine(words(100), 20);
		expect(line.length).toBeLessThanOrEqual(20);
		expect(line.endsWith('…')).toBe(true);
	});
});
