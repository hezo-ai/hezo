import type { ReactNode } from 'react';

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
}: DataTableProps<T>) {
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
						return (
							<tr
								key={rowKey(row)}
								data-depth={depth > 0 ? depth : undefined}
								onClick={onRowClick ? () => onRowClick(row) : undefined}
								className={onRowClick ? 'cursor-pointer hover:bg-surface-2' : ''}
							>
								{columns.map((col) => {
									const indent =
										indentColumnKey === col.key && depth > 0
											? (depthIndentClass[depth] ?? depthIndentClass[2])
											: '';
									return (
										<td
											key={col.key}
											className={`px-2 py-2.5 border-b border-border text-[13px] align-middle ${
												col.hideOnMobile ? 'hidden md:table-cell ' : ''
											}${indent ? `${indent} ` : ''}${col.className ?? ''}`}
										>
											{col.render(row)}
										</td>
									);
								})}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
