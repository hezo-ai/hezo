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
}

export function DataTable<T>({ columns, data, rowKey, onRowClick }: DataTableProps<T>) {
	return (
		<table className="w-full border-collapse">
			<thead>
				<tr>
					{columns.map((col) => (
						<th
							key={col.key}
							className={`text-left text-xs text-text-muted font-normal px-2 py-2 border-b border-border ${
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
				{data.map((row) => (
					<tr
						key={rowKey(row)}
						onClick={onRowClick ? () => onRowClick(row) : undefined}
						className={onRowClick ? 'cursor-pointer hover:bg-bg-subtle' : ''}
					>
						{columns.map((col) => (
							<td
								key={col.key}
								className={`px-2 py-2.5 border-b border-border text-[13px] align-middle ${
									col.hideOnMobile ? 'hidden md:table-cell ' : ''
								}${col.className ?? ''}`}
							>
								{col.render(row)}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
