import * as Dialog from '@radix-ui/react-dialog';
import { AlignLeft, Check, Code, Copy, Maximize2, Minimize2, MoveVertical } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { CommentRefTask } from '../lib/remark-comment-refs';
import { FormattedLogView } from './formatted-log-view';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

export interface LogViewerLine {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

interface LogViewerProps {
	lines: LogViewerLine[];
	emptyState?: ReactNode;
	liveLabel?: ReactNode;
	heightClassName?: string;
	testId?: string;
	compact?: boolean;
	headerAction?: ReactNode;
	headerActionLeading?: ReactNode;
	/** Enables the Formatted/Raw switcher and defaults to the formatted view.
	 *  Only meaningful for agent-run logs (prefixed lines); container logs leave
	 *  it off and stay raw. */
	formattable?: boolean;
	/** Threaded to the formatted view's markdown renderer for @mention links. */
	projectId?: string;
	projectSlug?: string;
	/**
	 * Run's task. When set, bare/inline-code comment public_ids in the formatted
	 * view link to that comment in the task thread.
	 */
	commentRefTask?: CommentRefTask;
}

export function LogViewer({
	lines,
	emptyState,
	liveLabel,
	heightClassName = 'h-[400px]',
	testId,
	compact = false,
	headerAction,
	headerActionLeading,
	formattable = false,
	projectId,
	projectSlug,
	commentRefTask,
}: LogViewerProps) {
	const [autoScroll, setAutoScroll] = useState(true);
	const [copied, setCopied] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [viewMode, setViewMode] = useState<'formatted' | 'raw'>(formattable ? 'formatted' : 'raw');
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const lastCountRef = useRef(0);
	const pendingBottomOffsetRef = useRef<number | null>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const attachScrollRef = useCallback((node: HTMLDivElement | null) => {
		scrollRef.current = node;
		if (!node) return;
		const offset = pendingBottomOffsetRef.current;
		if (offset === null) return;
		node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - offset);
		pendingBottomOffsetRef.current = null;
	}, []);

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

	const toggleExpanded = () => {
		const box = scrollRef.current;
		if (box) {
			pendingBottomOffsetRef.current = Math.max(
				0,
				box.scrollHeight - box.scrollTop - box.clientHeight,
			);
		}
		setIsExpanded((v) => !v);
	};

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

	const isFormatted = formattable && viewMode === 'formatted';
	const sizing = isExpanded ? 'flex-1 min-h-0' : heightClassName;
	const bodyClassName = isFormatted
		? `bg-[#0d1117] log-surface-dark text-text ${sizing} overflow-y-auto p-3 text-sm leading-relaxed`
		: `bg-[#0d1117] ${sizing} overflow-y-auto p-3 font-mono text-xs leading-relaxed`;

	const content = (
		<>
			<div className="flex items-center justify-between bg-bg-subtle px-3 py-1.5 border-b border-border-subtle">
				<div className="flex items-center gap-2 text-xs text-text-muted font-medium">
					<span>Logs</span>
					{liveLabel}
					<span className="text-text-subtle font-normal">{lines.length} lines</span>
					{formattable && (
						<div className="flex items-center gap-0.5">
							<Tooltip content="Formatted view">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setViewMode('formatted')}
									aria-pressed={viewMode === 'formatted'}
									aria-label="Formatted view"
									className={`h-6 px-1.5 ${viewMode === 'formatted' ? 'bg-bg-muted text-text border border-border shadow-inner' : ''}`}
								>
									<AlignLeft className="w-3 h-3" />
								</Button>
							</Tooltip>
							<Tooltip content="Raw logs">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setViewMode('raw')}
									aria-pressed={viewMode === 'raw'}
									aria-label="Raw logs"
									className={`h-6 px-1.5 ${viewMode === 'raw' ? 'bg-bg-muted text-text border border-border shadow-inner' : ''}`}
								>
									<Code className="w-3 h-3" />
								</Button>
							</Tooltip>
						</div>
					)}
				</div>
				<div className="flex items-center gap-2">
					{headerActionLeading}
					<Tooltip content="Copy logs">
						<Button
							variant="ghost"
							size="sm"
							onClick={handleCopy}
							disabled={lines.length === 0}
							className="text-xs h-6 px-2"
							aria-label="Copy logs to clipboard"
						>
							{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
						</Button>
					</Tooltip>
					<Tooltip content={autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setAutoScroll((v) => !v)}
							aria-pressed={autoScroll}
							aria-label="Toggle auto-scroll"
							className={`text-xs h-6 px-2 ${autoScroll ? 'bg-bg-muted text-text border border-border shadow-inner' : ''}`}
						>
							<MoveVertical className="w-3 h-3" />
						</Button>
					</Tooltip>
					{headerAction}
					<Tooltip content={isExpanded ? 'Collapse' : 'Expand'}>
						<Button
							variant="ghost"
							size="sm"
							onClick={toggleExpanded}
							className="text-xs h-6 px-2"
							aria-label={isExpanded ? 'Collapse log viewer' : 'Expand log viewer'}
						>
							{isExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
						</Button>
					</Tooltip>
				</div>
			</div>
			<div ref={attachScrollRef} data-testid={testId} className={bodyClassName}>
				{lines.length === 0 ? (
					<span className="text-text-subtle">{emptyState ?? 'No output.'}</span>
				) : isFormatted ? (
					<FormattedLogView
						lines={lines}
						projectId={projectId}
						projectSlug={projectSlug}
						commentRefTask={commentRefTask}
					/>
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
					if (!open) toggleExpanded();
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
