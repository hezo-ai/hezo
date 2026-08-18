/**
 * Delimiter-separated text (CSV) → rows of cells, for the asset viewer's table
 * rendering. CSV assets are stored as `text/plain` (see `ATTACHMENT_EXTENSIONS`
 * — script/data formats are served inert), so the viewer recognises one by its
 * filename rather than its content type.
 *
 * Quoting follows RFC 4180: a field wrapped in double quotes may contain the
 * delimiter, CR/LF and doubled quotes (`""` → `"`). Parsing stops at a row
 * limit so a multi-megabyte export costs a bounded amount of work and never
 * builds a table the browser has to lay out.
 */

/** Rows rendered before the table stops and points at the source/download. */
export const CSV_PREVIEW_ROW_LIMIT = 500;

/** Delimiters sniffed for, in no particular order — the best score wins. */
const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;

/** How much of the file the delimiter sniff parses (per candidate). */
const SNIFF_SAMPLE_CHARS = 64 * 1024;

/** Rows the sniff scores a candidate over. */
const SNIFF_SAMPLE_ROWS = 20;

export interface CsvPreview {
	/** The delimiter the rows were split on. */
	delimiter: string;
	/** Parsed rows, capped at the row limit. The first is treated as a header. */
	rows: string[][];
	/** True when the file holds more rows than `rows` carries. */
	truncated: boolean;
}

export function isCsvAssetPath(path: string): boolean {
	return path.toLowerCase().endsWith('.csv');
}

/** Whether any non-blank character remains from `from` on. */
function hasContentFrom(content: string, from: number): boolean {
	for (let i = from; i < content.length; i++) {
		const ch = content[i];
		if (ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t') return true;
	}
	return false;
}

/**
 * Parse up to `rowLimit` rows. Blank lines are dropped (a CSV's blank line
 * carries no cells, and an empty table row only reads as a rendering fault).
 */
function parseRows(
	content: string,
	delimiter: string,
	rowLimit: number,
): { rows: string[][]; truncated: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let i = 0;

	const pushRow = (): boolean => {
		row.push(field);
		field = '';
		// A blank line parses to a single empty cell; skip it rather than
		// rendering an empty stripe.
		if (!(row.length === 1 && row[0] === '')) rows.push(row);
		row = [];
		return rows.length >= rowLimit;
	};

	while (i < content.length) {
		const ch = content[i];
		if (quoted) {
			if (ch === '"') {
				if (content[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		// A quote only opens a quoted field at the field's start; anywhere else
		// it is a literal character (`a"b`).
		if (ch === '"' && field === '') {
			quoted = true;
			i++;
			continue;
		}
		if (ch === delimiter) {
			row.push(field);
			field = '';
			i++;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && content[i + 1] === '\n') i++;
			i++;
			if (pushRow()) {
				// Anything left past the limit (beyond a trailing newline) is a row
				// we chose not to render.
				return { rows, truncated: hasContentFrom(content, i) };
			}
			continue;
		}
		field += ch;
		i++;
	}
	if (field !== '' || row.length > 0) pushRow();
	return { rows, truncated: false };
}

/**
 * The candidate that splits the sample into the widest, most consistent rows.
 * Falls back to a comma when nothing splits the file into more than one column.
 */
export function sniffDelimiter(content: string): string {
	const sample = content.slice(0, SNIFF_SAMPLE_CHARS);
	let best = ',';
	let bestScore = 0;
	for (const candidate of DELIMITER_CANDIDATES) {
		const { rows } = parseRows(sample, candidate, SNIFF_SAMPLE_ROWS);
		if (rows.length === 0) continue;
		const columns = rows[0].length;
		if (columns < 2) continue;
		const consistent = rows.filter((r) => r.length === columns).length / rows.length;
		const score = columns * consistent;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
}

export function parseCsvPreview(content: string, rowLimit = CSV_PREVIEW_ROW_LIMIT): CsvPreview {
	// A leading BOM would otherwise ride along in the first header cell.
	const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const delimiter = sniffDelimiter(body);
	const { rows, truncated } = parseRows(body, delimiter, rowLimit);
	return { delimiter, rows, truncated };
}

/** Widest row in the table — short rows are padded out to it when rendering. */
export function csvColumnCount(rows: string[][]): number {
	return rows.reduce((max, row) => Math.max(max, row.length), 0);
}
