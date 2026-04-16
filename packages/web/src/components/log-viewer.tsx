import { Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';

export interface LogViewerLine {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

interface LogViewerProps {
	lines: LogViewerLine[];
	onClear?: () => void;
	emptyState?: ReactNode;
	liveLabel?: ReactNode;
	heightClassName?: string;
	testId?: string;
}

export function LogViewer({
	lines,
	onClear,
	emptyState,
	liveLabel,
	heightClassName = 'h-[400px]',
	testId,
}: LogViewerProps) {
	const [autoScroll, setAutoScroll] = useState(true);
	const scrollRef = useRef<HTMLDivElement>(null);
	const lastCountRef = useRef(0);

	useEffect(() => {
		if (!autoScroll) {
			lastCountRef.current = lines.length;
			return;
		}
		const box = scrollRef.current;
		if (!box) return;
		if (lines.length !== lastCountRef.current) {
			box.scrollTop = box.scrollHeight;
			lastCountRef.current = lines.length;
		}
	}, [lines, autoScroll]);

	return (
		<div className="flex flex-col rounded-lg border border-border-subtle overflow-hidden">
			<div className="flex items-center justify-between bg-bg-subtle px-3 py-1.5 border-b border-border-subtle">
				<div className="flex items-center gap-2 text-xs text-text-muted font-medium">
					<span>Logs</span>
					{liveLabel}
					<span className="text-text-subtle font-normal">{lines.length} lines</span>
				</div>
				<div className="flex items-center gap-2">
					<label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
						<input
							type="checkbox"
							checked={autoScroll}
							onChange={(e) => setAutoScroll(e.target.checked)}
							className="rounded"
						/>
						Auto-scroll
					</label>
					{onClear && (
						<Button variant="ghost" size="sm" onClick={onClear} className="text-xs h-6 px-2">
							<Trash2 className="w-3 h-3" /> Clear
						</Button>
					)}
				</div>
			</div>
			<div
				ref={scrollRef}
				data-testid={testId}
				className={`bg-[#0d1117] ${heightClassName} overflow-y-auto p-3 font-mono text-xs leading-relaxed`}
			>
				{lines.length === 0 ? (
					<span className="text-text-subtle">{emptyState ?? 'No output.'}</span>
				) : (
					lines.map((line) => (
						<div
							key={line.id}
							className={`whitespace-pre-wrap ${line.stream === 'stderr' ? 'text-red-400' : 'text-gray-300'}`}
						>
							{line.text}
						</div>
					))
				)}
			</div>
		</div>
	);
}
