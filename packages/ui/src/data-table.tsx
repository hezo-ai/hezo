import { ArrowDown } from 'lucide-react';
import { Fragment, type ReactNode, useCallback } from 'react';

export interface Column<T> {
	key: string;
	header: string;
	width?: string;
	render: (row: T) => ReactNode;
	className?: string;
	hideOnMobile?: boolean;
	/**
	 * Makes this header a sort button for the given key. The column declares that
	 * it can be sorted; the table's `sort` prop owns which one currently is.
	 */
	sortKey?: string;
	/** Right-align the header and its cells (numeric columns). */
	alignRight?: boolean;
}

/** Which column the table is sorted by, and what a header click does. */
export interface DataTableSort {
	key: string;
	direction: 'asc' | 'desc';
	/** Called with the clicked column's `sortKey`; the caller owns the new order. */
	onSort: (key: string) => void;
	/** Accessible name for a column's sort button, given its header text. */
	label: (header: string) => string;
}

export interface DataTableProps<T> {
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
	/** Required once any column carries a `sortKey`. */
	sort?: DataTableSort;
	/**
	 * Drop the header row below `md`. For a table whose columns mostly carry
	 * `hideOnMobile`, the surviving header names one column beside empty cells
	 * and reads as a stray row.
	 */
	hideHeaderOnMobile?: boolean;
}

// One entry per nesting level a caller can report, so every level reads as
// distinct from its parent rather than two sharing one indent. Anything deeper
// than the last entry clamps to it instead of losing its indent.
const depthIndentClass: Record<number, string> = {
	1: 'pl-5 sm:pl-6',
	2: 'pl-9 sm:pl-10',
	3: 'pl-13 sm:pl-14',
};
const deepestIndentClass = depthIndentClass[3];

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
	sort,
	hideHeaderOnMobile,
}: DataTableProps<T>) {
	// Ref callback fires when the focused row mounts, which can be after the first
	// render once the data resolves - scroll it into view then, rather than on a
	// render that does not yet have the row.
	const focusRef = useCallback((el: HTMLTableRowElement | null) => {
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}, []);
	return (
		<div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
			<table className="w-full border-collapse">
				<thead className={hideHeaderOnMobile ? 'hidden md:table-header-group' : undefined}>
					<tr>
						{columns.map((col) => {
							const sortKey = col.sortKey;
							const sortable = sortKey != null && sort != null;
							const sorted = sortable && sort.key === sortKey;
							return (
								<th
									key={col.key}
									aria-sort={
										sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
									}
									className={`text-xs font-normal border-b border-border ${
										col.alignRight ? 'text-right' : 'text-left'
									} ${sorted ? 'text-text-1' : 'text-text-2'} ${sortable ? 'p-0' : 'px-2 py-2'} ${
										col.hideOnMobile ? 'hidden md:table-cell' : ''
									}`}
									style={col.width ? { width: col.width } : undefined}
								>
									{sortable ? (
										<button
											type="button"
											onClick={() => sort.onSort(sortKey)}
											aria-label={sort.label(col.header)}
											data-testid={`data-table-sort-${sortKey}`}
											className={`inline-flex w-full cursor-pointer items-center gap-1 px-2 py-2 transition-colors hover:bg-surface-2 hover:text-text-1 ${
												col.alignRight ? 'justify-end' : ''
											} ${sorted ? 'font-semibold' : ''}`}
										>
											{col.header}
											<ArrowDown
												aria-hidden
												className={`w-3 h-3 transition-opacity ${
													sorted
														? `opacity-100 ${sort.direction === 'asc' ? 'rotate-180' : ''}`
														: 'opacity-0'
												}`}
											/>
										</button>
									) : (
										col.header
									)}
								</th>
							);
						})}
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
								{/* A clickable row is reachable by key as well as by pointer: the
								    row is the whole interaction, so leaving it mouse-only puts the
								    table's only action out of reach. */}
								<tr
									id={domId}
									ref={isFocused ? focusRef : undefined}
									data-depth={depth > 0 ? depth : undefined}
									onClick={onRowClick ? () => onRowClick(row) : undefined}
									onKeyDown={
										onRowClick
											? (e) => {
													if (e.key !== 'Enter' && e.key !== ' ') return;
													if (e.target !== e.currentTarget) return;
													e.preventDefault();
													onRowClick(row);
												}
											: undefined
									}
									// Focusable and activatable, but still a row: an explicit
									// `role` here would replace the one the table gives it, and a
									// table whose rows are buttons is no longer navigable as a table.
									tabIndex={onRowClick ? 0 : undefined}
									className={`${onRowClick ? 'cursor-pointer hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring' : ''} ${
										isFocused ? 'bg-info-soft' : ''
									} ${rowClassName?.(row) ?? ''}`.trim()}
								>
									{columns.map((col) => {
										const indent =
											indentColumnKey === col.key && depth > 0
												? (depthIndentClass[depth] ?? deepestIndentClass)
												: '';
										return (
											<td
												key={col.key}
												className={`px-2 py-2.5 ${cellBorder} text-[13px] align-middle ${
													col.alignRight ? 'text-right ' : ''
												}${col.hideOnMobile ? 'hidden md:table-cell ' : ''}${
													indent ? `${indent} ` : ''
												}${col.className ?? ''}`}
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
