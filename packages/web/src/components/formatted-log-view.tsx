import { Boxes, ChevronDown, ChevronRight, Cpu, Sparkles, Terminal, Wrench } from 'lucide-react';
import { type ComponentType, useMemo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
	type CommandBlock,
	type DoneBlock,
	type LogBlock,
	parseAgentLog,
	type ResultBlock,
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
		<div data-testid={testId} className="space-y-3 text-sm leading-relaxed text-text">
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
	}
}

function SystemView({ block }: { block: SystemBlock }) {
	const color = block.stream === 'stderr' ? 'text-accent-red-text' : 'text-text-subtle';
	return (
		<pre className={`whitespace-pre-wrap break-words font-mono text-xs ${color}`}>
			{block.lines.join('\n')}
		</pre>
	);
}

function SessionView({ block }: { block: SessionBlock }) {
	return (
		<div className="flex items-center gap-1.5 text-xs text-text-subtle">
			<Cpu className="w-3.5 h-3.5 shrink-0" />
			<span className="font-medium text-text-muted">{block.model}</span>
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
			<pre className="whitespace-pre-wrap break-words font-mono text-xs text-accent-red-text">
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
	'text-xs italic leading-relaxed [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_li]:marker:text-text-subtle';

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
	return (
		<div className="border-l-2 border-border-subtle pl-3 text-text-subtle">
			<div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wider">
				<Sparkles className="w-3 h-3 shrink-0" />
				Thinking
			</div>
			<div className={THINKING_PROSE}>
				<Markdown
					remarkPlugins={remarkPlugins}
					components={commentRefTask ? THINKING_COMPONENTS : undefined}
				>
					{reflowed}
				</Markdown>
			</div>
		</div>
	);
}

function CommandView({ block }: { block: CommandBlock }) {
	const [open, setOpen] = useState(false);
	const isLong = block.text.length > 100;
	return (
		<div className="rounded-radius-md border border-border-subtle bg-bg-muted">
			<button
				type="button"
				onClick={() => isLong && setOpen((o) => !o)}
				className={`flex w-full items-start gap-2 px-3 py-1.5 text-left font-mono text-xs text-text-muted ${
					isLong ? 'cursor-pointer' : 'cursor-default'
				}`}
				aria-expanded={isLong ? open : undefined}
			>
				<span className="select-none text-text-subtle">$</span>
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
	pending: 'bg-text-subtle',
	success: 'bg-accent-green',
	error: 'bg-accent-red',
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
				className="flex w-full items-center gap-1.5 text-left text-xs text-text-muted hover:text-text"
			>
				{open ? (
					<ChevronDown className="w-3 h-3 shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 shrink-0" />
				)}
				<Icon className="w-3 h-3 shrink-0" />
				<span className="font-mono font-medium text-text">{label}</span>
				<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[block.status]}`} />
				{block.argsPreview && (
					<span className="min-w-0 flex-1 truncate font-mono text-text-subtle">
						{block.argsPreview}
					</span>
				)}
			</button>
			{open && (
				<div className="mt-1.5 space-y-1.5">
					{block.argsPreview && (
						<pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-bg-muted p-2 text-[11px] text-text-muted">
							{block.argsPreview}
						</pre>
					)}
					{block.result != null ? (
						<pre
							className={`overflow-x-auto whitespace-pre-wrap break-all rounded p-2 text-[11px] ${
								block.status === 'error'
									? 'bg-accent-red-bg text-accent-red-text'
									: 'bg-bg-muted text-text-muted'
							}`}
						>
							{block.result}
						</pre>
					) : (
						<div className="text-[11px] italic text-text-subtle">No result captured.</div>
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
				block.isError ? 'bg-accent-red-bg text-accent-red-text' : 'bg-bg-muted text-text-muted'
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
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-radius-md border border-border-subtle bg-bg-subtle px-3 py-2 text-xs">
			<Badge color={isError ? 'red' : 'green'}>{block.status}</Badge>
			{block.turns != null && <span className="text-text-muted">{block.turns} turns</span>}
			{block.durationMs != null && (
				<span className="text-text-muted">{formatDuration(block.durationMs)}</span>
			)}
			{(block.inputTokens != null || block.outputTokens != null) && (
				<span className="text-text-muted">
					{(block.inputTokens ?? 0).toLocaleString()} in /{' '}
					{(block.outputTokens ?? 0).toLocaleString()} out
				</span>
			)}
			{block.costUsd != null && (
				<span className="text-text-muted">${block.costUsd.toFixed(2)}</span>
			)}
		</div>
	);
}
