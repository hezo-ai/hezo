import { useMemo } from 'react';
import { useSignedUrlText } from '../hooks/use-signed-url-text';
import { parseCsvPreview } from '../lib/csv';
import { AssetIcon } from './asset-icon';

/** Rows a card-sized preview can show before the mask fades them out. */
const THUMBNAIL_ROWS = 6;

/**
 * A card thumbnail fetches the asset's whole body, so a dataset export is left
 * as a glyph rather than pulled down once per card. The viewer, where opening
 * the file is the deliberate act, has no such cap.
 */
const THUMBNAIL_MAX_BYTES = 256 * 1024;

interface CsvThumbnailProps {
	url: string;
	contentType: string;
	byteSize: number;
}

/**
 * Mini-table preview for a CSV asset card: the top few rows rendered as the
 * grid they are, so a card reads as tabular data rather than as one more
 * document glyph. Falls back to the glyph while the fetch is in flight, if it
 * fails, or if the file has no columns to show - the same contract
 * `MarkdownThumbnail` keeps.
 */
export function CsvThumbnail({ url, contentType, byteSize }: CsvThumbnailProps) {
	const overCap = byteSize > THUMBNAIL_MAX_BYTES;
	// Passing no URL keeps the hook from fetching a file too big to preview.
	const { text } = useSignedUrlText(overCap ? undefined : url);
	const rows = useMemo(
		() => (text === null ? [] : parseCsvPreview(text, THUMBNAIL_ROWS).rows),
		[text],
	);

	if (rows.length === 0 || rows[0].length < 2) return <AssetIcon contentType={contentType} />;
	const [header, ...body] = rows;

	return (
		<div
			data-testid="asset-csv-thumbnail"
			aria-hidden
			className="pointer-events-none h-full w-full overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
		>
			{/* Scaled like the markdown thumbnail so a few more columns fit; each
			    cell truncates, so one long free-text column cannot push the rest of
			    the grid out of the card. */}
			<div className="w-[166%] origin-top-left scale-[0.6] px-2 py-1.5">
				<table className="w-full table-fixed border-collapse text-[11px] text-text-1">
					<thead>
						<tr>
							{header.map((cell, c) => (
								<th
									// biome-ignore lint/suspicious/noArrayIndexKey: a CSV column has no identity beyond its position
									key={c}
									className="max-w-[8rem] truncate border-b border-border px-1 py-0.5 text-left font-medium text-text-2"
								>
									{cell}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.map((row, r) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a CSV row has no identity beyond its position
							<tr key={r}>
								{header.map((_, c) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: same - column position is the identity
									<td key={c} className="max-w-[8rem] truncate px-1 py-0.5">
										{row[c] ?? ''}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
