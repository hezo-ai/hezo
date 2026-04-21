import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, Maximize2, Minimize2, Trash2 } from 'lucide-react';
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
	compact?: boolean;
}

export function LogViewer({
	lines,
	onClear,
	emptyState,
	liveLabel,
	heightClassName = 'h-[400px]',
	testId,
	compact = false,
}: LogViewerProps) {
	const [autoScroll, setAutoScroll] = useState(true);
	const [copied, setCopied] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const lastCountRef = useRef(0);
	const lastExpandedRef = useRef(false);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!autoScroll) {
			lastCountRef.current = lines.length;
			lastExpandedRef.current = isExpanded;
			return;
		}
		const box = scrollRef.current;
		if (!box) return;
		const expandChanged = lastExpandedRef.current !== isExpanded;
		if (expandChanged || lines.length !== lastCountRef.current) {
			box.scrollTop = box.scrollHeight;
			lastCountRef.current = lines.length;
			lastExpandedRef.current = isExpanded;
		}
	}, [lines, autoScroll, isExpanded]);

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const handleCopy = async () => {
		const text = lines.map((l) => l.text).join('\n');
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard write failed (e.g. insecure context) — leave state unchanged
		}
	};

	const bodyClassName = isExpanded
		? 'bg-[#0d1117] flex-1 min-h-0 overflow-y-auto p-3 font-mono text-xs leading-relaxed'
		: `bg-[#0d1117] ${heightClassName} overflow-y-auto p-3 font-mono text-xs leading-relaxed`;

	const content = (
		<>
			<div className="flex items-center justify-between bg-bg-subtle px-3 py-1.5 border-b border-border-subtle">
				<div className="flex items-center gap-2 text-xs text-text-muted font-medium">
					<span>Logs</span>
					{liveLabel}
					<span className="text-text-subtle font-normal">{lines.length} lines</span>
				</div>
				<div className="flex items-center gap-2">
					{!compact && (
						<>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleCopy}
								disabled={lines.length === 0}
								className="text-xs h-6 px-2"
								aria-label="Copy logs to clipboard"
							>
								{copied ? (
									<>
										<Check className="w-3 h-3" /> Copied
									</>
								) : (
									<>
										<Copy className="w-3 h-3" /> Copy
									</>
								)}
							</Button>
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
						</>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsExpanded((v) => !v)}
						className="text-xs h-6 px-2"
						aria-label={isExpanded ? 'Collapse log viewer' : 'Expand log viewer'}
					>
						{isExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
					</Button>
				</div>
			</div>
			<div ref={scrollRef} data-testid={testId} className={bodyClassName}>
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
		</>
	);

	if (isExpanded) {
		return (
			<Dialog.Root
				open
				onOpenChange={(open) => {
					if (!open) setIsExpanded(false);
				}}
			>
				<Dialog.Portal>
					<Dialog.Content
						data-testid="log-viewer-fullscreen"
						className="fixed inset-0 z-50 flex flex-col bg-bg outline-none"
					>
						<Dialog.Title className="sr-only">Log viewer (expanded)</Dialog.Title>
						{content}
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		);
	}

	return (
		<div className="flex flex-col rounded-lg border border-border-subtle overflow-hidden">
			{content}
		</div>
	);
}
