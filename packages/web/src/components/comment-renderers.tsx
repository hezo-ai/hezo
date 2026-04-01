import { Check, ChevronDown, ChevronRight, ExternalLink, Terminal } from 'lucide-react';
import { useState } from 'react';
import { Badge } from './ui/badge';

export interface CommentData {
	id: string;
	content_type: string;
	// biome-ignore lint/suspicious/noExplicitAny: content varies by type
	content: any;
	// biome-ignore lint/suspicious/noExplicitAny: varies
	chosen_option?: any;
	author_name?: string;
	author_type?: string;
	created_at: string;
	tool_calls?: ToolCall[];
}

interface ToolCall {
	id: string;
	tool_name: string;
	// biome-ignore lint/suspicious/noExplicitAny: varies
	input: any;
	// biome-ignore lint/suspicious/noExplicitAny: varies
	output: any;
	status: string;
	duration_ms: number | null;
	created_at: string;
}

interface RenderProps {
	comment: CommentData;
	onChooseOption?: (commentId: string, chosenId: string) => void;
}

export function CommentRenderer({ comment, onChooseOption }: RenderProps) {
	switch (comment.content_type) {
		case 'trace':
			return <TraceComment comment={comment} />;
		case 'options':
			return <OptionsComment comment={comment} onChoose={onChooseOption} />;
		case 'preview':
			return <PreviewComment comment={comment} />;
		case 'system':
			return <SystemComment comment={comment} />;
		default:
			return <TextComment comment={comment} />;
	}
}

function TextComment({ comment }: { comment: CommentData }) {
	const content =
		typeof comment.content === 'object'
			? comment.content.text || JSON.stringify(comment.content)
			: String(comment.content);
	return <p className="text-sm text-text whitespace-pre-wrap">{content}</p>;
}

function SystemComment({ comment }: { comment: CommentData }) {
	const text =
		typeof comment.content === 'object'
			? comment.content.text || JSON.stringify(comment.content)
			: String(comment.content);
	return <p className="text-xs text-text-subtle italic">{text}</p>;
}

function TraceComment({ comment }: { comment: CommentData }) {
	const [expanded, setExpanded] = useState(false);
	const toolCalls = comment.tool_calls ?? [];
	const content = typeof comment.content === 'object' ? comment.content : {};
	const summary =
		content.summary || `${toolCalls.length} tool call${toolCalls.length !== 1 ? 's' : ''}`;

	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text"
			>
				{expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
				<Terminal className="w-3 h-3" />
				<span>{summary}</span>
			</button>

			{expanded && toolCalls.length > 0 && (
				<div className="mt-2 space-y-1.5 pl-4 border-l-2 border-border">
					{toolCalls.map((tc) => (
						<ToolCallEntry key={tc.id} toolCall={tc} />
					))}
				</div>
			)}
		</div>
	);
}

function ToolCallEntry({ toolCall }: { toolCall: ToolCall }) {
	const [showDetails, setShowDetails] = useState(false);

	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => setShowDetails(!showDetails)}
				className="flex items-center gap-1.5 text-text-muted hover:text-text"
			>
				{showDetails ? (
					<ChevronDown className="w-2.5 h-2.5" />
				) : (
					<ChevronRight className="w-2.5 h-2.5" />
				)}
				<span className="font-mono font-medium text-text">{toolCall.tool_name}</span>
				<Badge color={toolCall.status === 'success' ? 'green' : 'red'} className="text-[9px]">
					{toolCall.status}
				</Badge>
				{toolCall.duration_ms != null && (
					<span className="text-text-subtle">{toolCall.duration_ms}ms</span>
				)}
			</button>
			{showDetails && (
				<div className="mt-1 ml-4 space-y-1">
					{toolCall.input && (
						<pre className="text-[10px] bg-bg-muted p-1.5 rounded overflow-x-auto max-h-24 text-text-muted">
							{JSON.stringify(toolCall.input, null, 2)}
						</pre>
					)}
					{toolCall.output && (
						<pre className="text-[10px] bg-bg-muted p-1.5 rounded overflow-x-auto max-h-24 text-text-muted">
							{typeof toolCall.output === 'string'
								? (toolCall.output as string).slice(0, 500)
								: JSON.stringify(toolCall.output, null, 2).slice(0, 500)}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

function OptionsComment({
	comment,
	onChoose,
}: {
	comment: CommentData;
	onChoose?: (commentId: string, chosenId: string) => void;
}) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const prompt = content.prompt || '';
	const options = (content.options || []) as { id: string; label: string; description?: string }[];
	const chosenId: string | null =
		typeof comment.chosen_option === 'object' && comment.chosen_option
			? comment.chosen_option.chosen_id
			: null;

	return (
		<div>
			{prompt && <p className="text-sm text-text mb-2">{prompt}</p>}
			<div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
				{options.map((opt) => {
					const isChosen = chosenId === opt.id;
					const isOther = chosenId && !isChosen;
					return (
						<button
							key={opt.id}
							type="button"
							disabled={!!chosenId}
							onClick={() => onChoose?.(comment.id, opt.id)}
							className={`text-left p-2.5 rounded-lg border transition-colors ${
								isChosen
									? 'border-primary bg-primary/10'
									: isOther
										? 'border-border bg-bg-subtle opacity-50'
										: 'border-border hover:border-primary/50 cursor-pointer'
							}`}
						>
							<div className="flex items-center gap-1.5">
								{isChosen && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
								<span className="text-sm font-medium text-text">{opt.label}</span>
							</div>
							{opt.description && (
								<p className="text-xs text-text-muted mt-0.5">{opt.description}</p>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function PreviewComment({ comment }: { comment: CommentData }) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const url = content.url || content.preview_url || '';
	const title = content.title || 'Preview';

	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
		>
			<ExternalLink className="w-3.5 h-3.5" />
			{title}
		</a>
	);
}
