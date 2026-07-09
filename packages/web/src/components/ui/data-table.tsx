import { Fragment, type ReactNode, useCallback } from 'react';

export interface Column<T> {
	key: string;
	header: string;
	width?: string;
	render: (row: T) => ReactNode;
	className?: string;
	hideOnMobile?: boolean;
}

interface DataTableProps<T> {
	columns: Column<T>[];
	data: T[];
	rowKey: (row: T) => string;
	onRowClick?: (row: T) => void;
	/** When set with indentColumnKey, adds left padding on that column per depth. */
	getRowDepth?: (row: T) => number;
	indentColumnKey?: string;
	/** Extra class(es) applied per row — e.g. to fade finished (terminal) tasks. */
	rowClassName?: (row: T) => string;
	/**
	 * Optional full-width block rendered as an extra row beneath each row (e.g. an
	 * indented sub-list of related items). Return null/undefined to render nothing
	 * for a given row; when it yields content the main row's bottom border is
	 * dropped so the pair reads as one group. Receives the row's stable id so the
	 * sub-row can carry a DOM anchor.
	 */
	subRow?: (row: T, rowId: string) => ReactNode;
	/**
	 * DOM id for each row's `<tr>` — enables `#<id>` hash anchoring and, together
	 * with `focusedRowId`, a scroll-into-view + highlight for deep-linked rows.
	 */
	getRowId?: (row: T) => string;
	/** When it matches a row's `getRowId`, that row scrolls into view + highlights. */
	focusedRowId?: string;
}

const depthIndentClass: Record<number, string> = {
	1: 'pl-5 sm:pl-6',
	2: 'pl-9 sm:pl-10',
};

export function DataTable<T>({
	columns,
	data,
	rowKey,
	onRowClick,
	getRowDepth,
	indentColumnKey,
	rowClassName,
	subRow,
	getRowId,
	focusedRowId,
}: DataTableProps<T>) {
	// Ref callback fires when the focused row mounts (which can be after the first
	// render, once data resolves) — scroll it into view then, mirroring the
	// connectors list's focus behavior.
	const focusRef = useCallback((el: HTMLTableRowElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);
	return (
		<div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
			<table className="w-full border-collapse">
				<thead>
					<tr>
						{columns.map((col) => (
							<th
								key={col.key}
								className={`text-left text-xs text-text-2 font-normal px-2 py-2 border-b border-border ${
									col.hideOnMobile ? 'hidden md:table-cell' : ''
								}`}
								style={col.width ? { width: col.width } : undefined}
							>
								{col.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{data.map((row) => {
						const depth = getRowDepth?.(row) ?? 0;
						const id = rowKey(row);
						const sub = subRow?.(row, id) ?? null;
						const cellBorder = sub ? '' : 'border-b border-border';
						const domId = getRowId?.(row);
						const isFocused = domId != null && domId === focusedRowId;
						return (
							<Fragment key={id}>
								<tr
									id={domId}
									ref={isFocused ? focusRef : undefined}
									data-depth={depth > 0 ? depth : undefined}
									onClick={onRowClick ? () => onRowClick(row) : undefined}
									className={`${onRowClick ? 'cursor-pointer hover:bg-surface-2' : ''} ${
										isFocused ? 'bg-info-soft' : ''
									} ${rowClassName?.(row) ?? ''}`.trim()}
								>
									{columns.map((col) => {
										const indent =
											indentColumnKey === col.key && depth > 0
												? (depthIndentClass[depth] ?? depthIndentClass[2])
												: '';
										return (
											<td
												key={col.key}
												className={`px-2 py-2.5 ${cellBorder} text-[13px] align-middle ${
													col.hideOnMobile ? 'hidden md:table-cell ' : ''
												}${indent ? `${indent} ` : ''}${col.className ?? ''}`}
											>
												{col.render(row)}
											</td>
										);
									})}
								</tr>
								{sub && (
									<tr>
										<td
											colSpan={columns.length}
											className="px-2 pb-2.5 border-b border-border align-top"
										>
											{sub}
										</td>
									</tr>
								)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
