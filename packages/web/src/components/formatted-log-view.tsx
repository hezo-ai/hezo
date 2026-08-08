import { CONTAINER_META_LOG_LABEL, CONTAINER_META_LOG_SEPARATOR } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Boxes, ChevronDown, ChevronRight, Cpu, Sparkles, Terminal, Wrench } from 'lucide-react';
import { type ComponentType, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
	type CommandBlock,
	type DoneBlock,
	type LogBlock,
	parseAgentLog,
	type ResultBlock,
	type RunnerBlock,
	type SessionBlock,
	type SystemBlock,
	type TextBlock,
	type ThinkingBlock,
	type ToolBlock,
} from '../lib/parse-agent-log';
import { reflowEnumerations } from '../lib/reflow-thinking-lists';
import { type CommentRefTask, remarkCommentRefs } from '../lib/remark-comment-refs';
import { CommentRefLink } from './comment-ref-link';
import { MarkdownProse } from './markdown-prose';
import { Badge } from './ui/badge';

interface FormattedLogViewProps {
	lines: { id: number; stream: 'stdout' | 'stderr'; text: string }[];
	projectId?: string;
	projectSlug?: string;
	/** Run's task — links bare comment public_ids in the prose to its thread. */
	commentRefTask?: CommentRefTask;
	testId?: string;
}

/**
 * Document-style rendering of agent run logs: paragraph spacing between
 * sections, prose/lists via markdown, and indented tool-use blocks whose result
 * shows on expand. Parses the prefixed lines client-side (see parse-agent-log).
 */
export function FormattedLogView({
	lines,
	projectId,
	projectSlug,
	commentRefTask,
	testId,
}: FormattedLogViewProps) {
	const blocks = useMemo(() => parseAgentLog(lines), [lines]);

	return (
		<div data-testid={testId} className="space-y-3 text-sm leading-relaxed text-text-1">
			{blocks.map((block) => (
				<BlockView
					key={block.id}
					block={block}
					projectId={projectId}
					projectSlug={projectSlug}
					commentRefTask={commentRefTask}
				/>
			))}
		</div>
	);
}

function BlockView({
	block,
	projectId,
	projectSlug,
	commentRefTask,
}: {
	block: LogBlock;
	projectId?: string;
	projectSlug?: string;
	commentRefTask?: CommentRefTask;
}) {
	switch (block.type) {
		case 'session':
			return <SessionView block={block} />;
		case 'text':
			return (
				<TextView
					block={block}
					projectId={projectId}
					projectSlug={projectSlug}
					commentRefTask={commentRefTask}
				/>
			);
		case 'thinking':
			return <ThinkingView block={block} commentRefTask={commentRefTask} />;
		case 'command':
			return <CommandView block={block} />;
		case 'tool':
			return <ToolView block={block} />;
		case 'result':
			return <ResultView block={block} />;
		case 'done':
			return <DoneView block={block} />;
		case 'system':
			return <SystemView block={block} />;
		case 'runner':
			return <RunnerView block={block} />;
	}
}

function SystemView({ block }: { block: SystemBlock }) {
	const color = block.stream === 'stderr' ? 'text-danger-soft-fg' : 'text-text-3';
	return (
		<pre className={`whitespace-pre-wrap break-words font-mono text-xs ${color}`}>
			{block.lines.join('\n')}
		</pre>
	);
}

/**
 * Runner lines, styled like the system ones they sit beside.
 *
 * One element per line rather than a single joined `<pre>`, because the line
 * naming the run's container carries a link: its id goes to that container's
 * page, which is where the disk, memory, error and container log all are. Shown
 * truncated the same way the Containers list shows it, while the link and the
 * raw log both carry the full engine id.
 */
function RunnerView({ block }: { block: RunnerBlock }) {
	const color = block.stream === 'stderr' ? 'text-danger-soft-fg' : 'text-text-3';
	return (
		<div className={`font-mono text-xs ${color}`} data-testid="log-runner-block">
			{block.lines.map((line) => (
				<div key={line.id} className="whitespace-pre-wrap break-words">
					{line.container ? (
						<>
							{CONTAINER_META_LOG_LABEL}
							<Link
								to="/settings/containers/$containerId"
								params={{ containerId: line.container.id }}
								className="underline underline-offset-2 hover:text-text-1"
								data-testid="log-container-link"
							>
								{line.container.id.slice(0, 12)}
							</Link>
							{line.container.details && CONTAINER_META_LOG_SEPARATOR + line.container.details}
						</>
					) : (
						line.text
					)}
				</div>
			))}
		</div>
	);
}

function SessionView({ block }: { block: SessionBlock }) {
	return (
		<div className="flex items-center gap-1.5 text-xs text-text-3">
			<Cpu className="w-3.5 h-3.5 shrink-0" />
			<span className="font-medium text-text-2">{block.model}</span>
			{block.toolCount != null && <span>· {block.toolCount} tools</span>}
		</div>
	);
}

function TextView({
	block,
	projectId,
	projectSlug,
	commentRefTask,
}: {
	block: TextBlock;
	projectId?: string;
	projectSlug?: string;
	commentRefTask?: CommentRefTask;
}) {
	if (block.stream === 'stderr') {
		return (
			<pre className="whitespace-pre-wrap break-words font-mono text-xs text-danger-soft-fg">
				{block.text}
			</pre>
		);
	}
	return (
		<MarkdownProse projectId={projectId} projectSlug={projectSlug} commentRefTask={commentRefTask}>
			{block.text}
		</MarkdownProse>
	);
}

// `a`-component for the thinking block's bare markdown renderer: turns the
// comment-ref link nodes emitted by remarkCommentRefs into in-app scroll-to
// links, and leaves any other anchor as a plain external link.
const THINKING_COMPONENTS: Components = {
	a: (props) => {
		const attrs = props as {
			'data-mention-comment-task-identifier'?: string;
			'data-mention-comment-id'?: string;
			'data-mention-comment-project-slug'?: string;
			'data-mention-comment-task-title'?: string;
			href?: string;
		};
		const taskIdentifier = attrs['data-mention-comment-task-identifier'];
		const commentId = attrs['data-mention-comment-id'];
		const projectSlug = attrs['data-mention-comment-project-slug'];
		if (taskIdentifier && commentId && projectSlug) {
			return (
				<CommentRefLink
					taskIdentifier={taskIdentifier}
					commentId={commentId}
					projectSlug={projectSlug}
					taskTitle={attrs['data-mention-comment-task-title']}
				>
					{props.children}
				</CommentRefLink>
			);
		}
		return (
			<a href={attrs.href} target="_blank" rel="noopener noreferrer">
				{props.children}
			</a>
		);
	},
};

// Markers (`1.`/`2.`/`•`) the server flattened onto a single line are reflowed into
// markdown so they render as lists; the de-emphasized thinking look (small, italic,
// subtle) is preserved with explicit list styling rather than the full `prose` plugin,
// which would impose its own font size and colours.
const THINKING_PROSE =
	'text-xs italic leading-relaxed [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_li]:marker:text-text-3';

// Thinking blocks are often long run-on reasoning. Collapse anything taller than
// 3 rendered lines (the `line-clamp-3` below) behind a Show more/less toggle so the
// log stays scannable; blocks that fit in 3 lines are shown whole with no toggle.
function ThinkingView({
	block,
	commentRefTask,
}: {
	block: ThinkingBlock;
	commentRefTask?: CommentRefTask;
}) {
	const reflowed = useMemo(() => reflowEnumerations(block.text), [block.text]);
	const remarkPlugins = useMemo<Parameters<typeof Markdown>[0]['remarkPlugins']>(
		() => (commentRefTask ? [remarkGfm, [remarkCommentRefs, commentRefTask]] : [remarkGfm]),
		[commentRefTask],
	);

	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	// Measure whether the block exceeds the clamp height. Clamp is applied
	// transiently for the read so the result is independent of the current
	// expanded state; a ResizeObserver re-measures on reflow (responsive widths).
	// happy-dom reports 0 for scroll/clientHeight, so component tests see no
	// overflow and render the block whole — the clamp is verified in a browser.
	useLayoutEffect(() => {
		const el = contentRef.current;
		// Re-measure whenever the rendered content (`reflowed`) changes; empty
		// thinking can never overflow, so it never gets a toggle.
		if (!el || reflowed.trim() === '') {
			setOverflows(false);
			return;
		}
		const measure = () => {
			const wasClamped = el.classList.contains('line-clamp-3');
			if (!wasClamped) el.classList.add('line-clamp-3');
			const isOverflowing = el.scrollHeight > el.clientHeight + 1;
			if (!wasClamped) el.classList.remove('line-clamp-3');
			setOverflows(isOverflowing);
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [reflowed]);

	// If the content shrinks below the clamp height (e.g. a narrower reflow), drop
	// the now-meaningless expanded state so the toggle disappears cleanly.
	useEffect(() => {
		if (!overflows && expanded) setExpanded(false);
	}, [overflows, expanded]);

	const clamp = overflows && !expanded;

	return (
		<div className="border-l-2 border-border-subtle pl-3 text-text-3" data-testid="thinking-block">
			<div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wider">
				<Sparkles className="w-3 h-3 shrink-0" />
				Thinking
			</div>
			<div
				ref={contentRef}
				data-testid="thinking-content"
				className={`${THINKING_PROSE} ${clamp ? 'line-clamp-3' : ''}`}
			>
				<Markdown
					remarkPlugins={remarkPlugins}
					components={commentRefTask ? THINKING_COMPONENTS : undefined}
				>
					{reflowed}
				</Markdown>
			</div>
			{overflows && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					data-testid="thinking-toggle"
					className="mt-1 flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-text-3 hover:text-text-2"
				>
					<ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
					{expanded ? 'Show less' : 'Show more'}
				</button>
			)}
		</div>
	);
}

function CommandView({ block }: { block: CommandBlock }) {
	const [open, setOpen] = useState(false);
	const isLong = block.text.length > 100;
	return (
		<div className="rounded-md border border-border-subtle bg-surface-3">
			<button
				type="button"
				onClick={() => isLong && setOpen((o) => !o)}
				className={`flex w-full items-start gap-2 px-3 py-1.5 text-left font-mono text-xs text-text-2 ${
					isLong ? 'cursor-pointer' : 'cursor-default'
				}`}
				aria-expanded={isLong ? open : undefined}
			>
				<span className="select-none text-text-3">$</span>
				<span className={`min-w-0 flex-1 ${open ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>
					{block.text}
				</span>
				{isLong &&
					(open ? (
						<ChevronDown className="mt-0.5 w-3 h-3 shrink-0" />
					) : (
						<ChevronRight className="mt-0.5 w-3 h-3 shrink-0" />
					))}
			</button>
		</div>
	);
}

function toolDisplay(name: string): { label: string; Icon: ComponentType<{ className?: string }> } {
	if (name.startsWith('mcp__')) {
		const parts = name.split('__');
		const server = parts[1] ?? '';
		const tool = parts.slice(2).join('__');
		return { label: tool ? `${server} / ${tool}` : name, Icon: Boxes };
	}
	if (name === 'Bash') return { label: name, Icon: Terminal };
	return { label: name, Icon: Wrench };
}

const STATUS_DOT: Record<ToolBlock['status'], string> = {
	pending: 'bg-text-3',
	success: 'bg-success',
	error: 'bg-danger',
};

function ToolView({ block }: { block: ToolBlock }) {
	const [open, setOpen] = useState(false);
	const { label, Icon } = toolDisplay(block.name);
	return (
		<div className="border-l-2 border-border pl-3">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex w-full items-center gap-1.5 text-left text-xs text-text-2 hover:text-text-1"
			>
				{open ? (
					<ChevronDown className="w-3 h-3 shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 shrink-0" />
				)}
				<Icon className="w-3 h-3 shrink-0" />
				<span className="font-mono font-medium text-text-1">{label}</span>
				<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[block.status]}`} />
				{block.argsPreview && (
					<span className="min-w-0 flex-1 truncate font-mono text-text-3">{block.argsPreview}</span>
				)}
			</button>
			{open && (
				<div className="mt-1.5 space-y-1.5">
					{block.argsPreview && (
						<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-3 p-2 text-[11px] text-text-2">
							{block.argsPreview}
						</pre>
					)}
					{block.result != null ? (
						<pre
							className={`overflow-x-auto whitespace-pre-wrap break-all rounded p-2 text-[11px] ${
								block.status === 'error'
									? 'bg-danger-soft text-danger-soft-fg'
									: 'bg-surface-3 text-text-2'
							}`}
						>
							{block.result}
						</pre>
					) : (
						<div className="text-[11px] italic text-text-3">No result captured.</div>
					)}
				</div>
			)}
		</div>
	);
}

function ResultView({ block }: { block: ResultBlock }) {
	return (
		<pre
			className={`overflow-x-auto whitespace-pre-wrap break-all rounded p-2 text-[11px] ${
				block.isError ? 'bg-danger-soft text-danger-soft-fg' : 'bg-surface-3 text-text-2'
			}`}
		>
			{block.text}
		</pre>
	);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m ${rest}s`;
}

function DoneView({ block }: { block: DoneBlock }) {
	const isError = block.status === 'error' || block.status.startsWith('error');
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-xs">
			<Badge color={isError ? 'red' : 'green'}>{block.status}</Badge>
			{block.turns != null && <span className="text-text-2">{block.turns} turns</span>}
			{block.durationMs != null && (
				<span className="text-text-2">{formatDuration(block.durationMs)}</span>
			)}
			{(block.inputTokens != null || block.outputTokens != null) && (
				<span className="text-text-2">
					{(block.inputTokens ?? 0).toLocaleString()} in /{' '}
					{(block.outputTokens ?? 0).toLocaleString()} out
				</span>
			)}
			{block.costUsd != null && <span className="text-text-2">${block.costUsd.toFixed(2)}</span>}
		</div>
	);
}
