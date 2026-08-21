import { useMemo } from 'react';
import { findLinkRanges, type LinkRange, shiftLinkRanges } from '../../lib/autolink';
import { csvColumnCount } from '../../lib/csv';
import { claimQuoteRanges, type ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { ReviewTextSegments, segmentsForSlice } from './review-text-segments';

interface CellSlice {
	text: string;
	/** Offset of this cell's text in the table's flat text stream. */
	start: number;
	end: number;
	/** Links found in this cell, in the flat stream's coordinates. */
	links: LinkRange[];
}

interface CsvTableProps {
	/** Parsed rows; the first is rendered as the header. */
	rows: string[][];
	annotations: ReviewAnnotation[];
	activeId: string | null;
	onHighlightClick: (id: string) => void;
}

const TH_CLASS =
	'border-b border-border bg-surface-2 px-2.5 py-1.5 text-left align-bottom font-medium whitespace-nowrap text-text-2';
const TD_CLASS = 'border-b border-border-subtle px-2.5 py-1.5 align-top';
// max-width is ignored on a table cell in auto layout, so the clamp lives on an
// inner block - long free-text columns wrap into a readable column instead of
// stretching the table off the page.
const CELL_CLASS = 'max-w-[32rem] whitespace-pre-wrap break-words';

/**
 * A parsed CSV rendered as a table, with review highlights inside its cells.
 *
 * Anchoring works the same way it does for a plain-text asset, over a flat text
 * stream: here that stream is every cell's text concatenated in document order,
 * which is exactly what the DOM text walk (`collectDomText`) sees, because the
 * table emits no text of its own - no row numbers, no placeholder for an empty
 * cell, and JSX contributes no whitespace text nodes between rows and cells.
 * Anything textual rendered around the table therefore belongs after it (the
 * host renders the truncation note below the review surface), so it can never
 * shift a cell's offsets.
 */
export function CsvTable({ rows, annotations, activeId, onHighlightClick }: CsvTableProps) {
	const { stream, cells } = useMemo(() => {
		let stream = '';
		const cells: CellSlice[][] = rows.map((row) =>
			row.map((text) => {
				const start = stream.length;
				// Links are found per cell and only then shifted into the stream: the
				// stream concatenates cells with no separator, so a URL ending one cell
				// would otherwise swallow the start of the next.
				const links = shiftLinkRanges(findLinkRanges(text), start);
				stream += text;
				return { text, start, end: stream.length, links };
			}),
		);
		return { stream, cells };
	}, [rows]);

	const claimed = useMemo(() => claimQuoteRanges(stream, annotations), [stream, annotations]);
	const columnCount = useMemo(() => csvColumnCount(rows), [rows]);

	if (cells.length === 0) return null;
	const [header, ...body] = cells;

	// Ragged rows are padded out to the widest one so the grid stays aligned; a
	// padding cell holds no text, so it never enters the stream.
	const columns = Array.from({ length: columnCount }, (_, i) => i);
	const renderCell = (cell: CellSlice | undefined) =>
		cell ? (
			<ReviewTextSegments
				segments={segmentsForSlice(stream, cell.start, cell.end, claimed, cell.links)}
				activeId={activeId}
				onHighlightClick={onHighlightClick}
			/>
		) : null;

	return (
		<div
			className="overflow-x-auto rounded-md border border-border bg-surface"
			data-testid="asset-csv-table"
		>
			{/* Sized to its content (`w-max`) rather than to the pane: auto table
			    layout would otherwise squeeze a free-text column down to its longest
			    word to make room for an unbreakable URL. Columns take the width they
			    need, each cell clamped by CELL_CLASS, and the container scrolls. */}
			<table className="w-max min-w-full border-collapse text-[12.5px] text-text-1">
				<thead>
					<tr>
						{columns.map((c) => (
							<th key={c} scope="col" className={TH_CLASS}>
								{renderCell(header[c])}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((row, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a CSV row has no identity beyond its position
						<tr key={r} className="even:bg-surface-2/50">
							{columns.map((c) => (
								<td key={c} className={TD_CLASS}>
									<div className={CELL_CLASS}>{renderCell(row[c])}</div>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
