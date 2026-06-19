import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../ui/badge';
import type { CommentDataOf, ToolCall } from './comment-data';

interface Props {
	comment: CommentDataOf<'trace'>;
}

export function TraceComment({ comment }: Props) {
	const [expanded, setExpanded] = useState(false);
	const toolCalls = comment.tool_calls ?? [];
	const summary =
		comment.content?.summary || `${toolCalls.length} tool call${toolCalls.length !== 1 ? 's' : ''}`;

	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-1.5 text-xs text-text-2 hover:text-text-1"
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
				className="flex items-center gap-1.5 text-text-2 hover:text-text-1"
			>
				{showDetails ? (
					<ChevronDown className="w-2.5 h-2.5" />
				) : (
					<ChevronRight className="w-2.5 h-2.5" />
				)}
				<span className="font-mono font-medium text-text-1">{toolCall.tool_name}</span>
				<Badge color={toolCall.status === 'success' ? 'green' : 'red'} className="text-[9px]">
					{toolCall.status}
				</Badge>
				{toolCall.duration_ms != null && (
					<span className="text-text-3">{toolCall.duration_ms}ms</span>
				)}
			</button>
			{showDetails && (
				<div className="mt-1 ml-4 space-y-1">
					{toolCall.input != null && toolCall.input !== '' && (
						<pre className="text-[10px] bg-surface-3 p-1.5 rounded overflow-x-auto max-h-24 text-text-2">
							{JSON.stringify(toolCall.input, null, 2)}
						</pre>
					)}
					{toolCall.output != null && toolCall.output !== '' && (
						<pre className="text-[10px] bg-surface-3 p-1.5 rounded overflow-x-auto max-h-24 text-text-2">
							{typeof toolCall.output === 'string'
								? toolCall.output.slice(0, 500)
								: JSON.stringify(toolCall.output, null, 2).slice(0, 500)}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}
