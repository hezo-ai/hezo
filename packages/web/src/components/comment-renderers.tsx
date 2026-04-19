import { Link } from '@tanstack/react-router';
import {
	ArrowRight,
	Check,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	GitBranch,
	Terminal,
} from 'lucide-react';
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isActiveRunStatus, useHeartbeatRun } from '../hooks/use-heartbeat-runs';
import { useRunLogs } from '../hooks/use-run-logs';
import { LogViewer } from './log-viewer';
import { RepoSetupWizard } from './repo-setup-wizard';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

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
	companyId?: string;
	projectId?: string;
}

export function CommentRenderer({ comment, onChooseOption, companyId, projectId }: RenderProps) {
	switch (comment.content_type) {
		case 'run':
			return <RunComment comment={comment} companyId={companyId} />;
		case 'trace':
			return <TraceComment comment={comment} />;
		case 'options':
			return <OptionsComment comment={comment} onChoose={onChooseOption} />;
		case 'preview':
			return <PreviewComment comment={comment} />;
		case 'system':
			return <SystemComment comment={comment} />;
		case 'action':
			return <ActionComment comment={comment} companyId={companyId} projectId={projectId} />;
		default:
			return <TextComment comment={comment} />;
	}
}

function ActionComment({
	comment,
	companyId,
	projectId,
}: {
	comment: CommentData;
	companyId?: string;
	projectId?: string;
}) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const kind: string = content.kind ?? '';
	const resolved =
		typeof comment.chosen_option === 'object' &&
		comment.chosen_option &&
		comment.chosen_option.status === 'complete';

	const [wizardOpen, setWizardOpen] = useState(false);

	if (kind !== 'setup_repo') {
		return <p className="text-xs text-text-subtle italic">Unknown action: {kind}</p>;
	}

	if (resolved) {
		const result = comment.chosen_option?.result ?? {};
		return (
			<div
				className="flex items-center gap-2 text-sm text-accent-green-text"
				data-testid="action-complete"
			>
				<Check className="w-4 h-4" />
				<span>Repository set: {result.repo_identifier ?? '(unknown)'}</span>
			</div>
		);
	}

	if (!companyId || !projectId) {
		return <p className="text-xs text-text-subtle italic">Repo setup unavailable in this view.</p>;
	}

	return (
		<div className="flex flex-col gap-2" data-testid="action-setup-repo">
			<div className="flex items-center gap-2 text-sm">
				<GitBranch className="w-4 h-4 text-accent-blue-text" />
				<span>
					This project has no designated repository yet. Connect GitHub and pick a repo to unblock
					work on this ticket.
				</span>
			</div>
			<div>
				<Button size="sm" onClick={() => setWizardOpen(true)}>
					Set up repository
				</Button>
			</div>
			<RepoSetupWizard
				companyId={companyId}
				projectId={projectId}
				open={wizardOpen}
				onOpenChange={setWizardOpen}
			/>
		</div>
	);
}

function runStatusLabel(status: string): string {
	if (status === 'timed_out') return 'timed out';
	return status;
}

function runStatusDotClass(status: string): string {
	if (status === 'running' || status === 'queued') return 'bg-accent-yellow animate-pulse';
	if (status === 'succeeded') return 'bg-accent-green';
	if (status === 'failed' || status === 'timed_out') return 'bg-accent-red';
	return 'bg-text-subtle';
}

function RunComment({ comment, companyId }: { comment: CommentData; companyId?: string }) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const runId: string = content.run_id ?? '';
	const agentId: string = content.agent_id ?? '';
	const agentTitle: string = content.agent_title ?? 'Agent';

	const runQuery = useHeartbeatRun(companyId ?? '', agentId, runId);
	const run = runQuery.data;
	const status = run?.status ?? 'queued';
	const isActive = isActiveRunStatus(status);
	const { lines } = useRunLogs(run?.project_id, runId, run?.log_text, isActive);

	if (!companyId || !runId || !agentId) {
		return <p className="text-xs text-text-subtle italic">Run reference missing.</p>;
	}

	const createdIssues = run?.created_issues ?? [];

	return (
		<div className="flex flex-col gap-1.5" data-testid="run-comment">
			<LogViewer
				lines={lines}
				compact
				heightClassName="h-[180px]"
				testId="run-comment-log"
				liveLabel={
					<span className="flex items-center gap-1.5">
						<span className={`inline-block w-2 h-2 rounded-full ${runStatusDotClass(status)}`} />
						<span>
							{agentTitle} — {runStatusLabel(status)}
						</span>
					</span>
				}
				emptyState={isActive ? 'Waiting for log output...' : 'No output.'}
			/>
			{createdIssues.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-issues">
					<span className="text-xs text-text-subtle">Created tickets</span>
					{createdIssues.map((issue) => (
						<Link
							key={issue.id}
							to="/companies/$companyId/issues/$issueId"
							params={{ companyId, issueId: issue.id }}
							className="text-xs text-accent-blue-text hover:underline self-start"
						>
							{issue.identifier} — {issue.title}
						</Link>
					))}
				</div>
			)}
			<Link
				to="/companies/$companyId/agents/$agentId/executions/$runId"
				params={{ companyId, agentId, runId }}
				className="inline-flex items-center gap-1 text-xs text-accent-blue-text hover:underline self-start"
			>
				View full run <ArrowRight className="w-3 h-3" />
			</Link>
		</div>
	);
}

function TextComment({ comment }: { comment: CommentData }) {
	const content =
		typeof comment.content === 'object'
			? comment.content.text || JSON.stringify(comment.content)
			: String(comment.content);
	return (
		<div
			className="prose prose-sm max-w-none text-sm text-text [&_a]:text-accent-blue-text [&_h1]:text-text [&_h2]:text-text [&_h3]:text-text [&_h4]:text-text [&_strong]:text-text [&_code]:text-accent-blue-text [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-muted [&_pre]:border [&_pre]:border-border [&_p:last-child]:mb-0 [&_p:first-child]:mt-0"
			data-testid="text-comment-body"
		>
			<Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
		</div>
	);
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
									? 'border-accent-blue bg-accent-blue-bg'
									: isOther
										? 'border-border bg-bg-subtle opacity-50'
										: 'border-border hover:border-border-hover cursor-pointer'
							}`}
						>
							<div className="flex items-center gap-1.5">
								{isChosen && <Check className="w-3.5 h-3.5 text-accent-blue-text shrink-0" />}
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
			className="inline-flex items-center gap-1.5 text-sm text-accent-blue-text hover:underline"
		>
			<ExternalLink className="w-3.5 h-3.5" />
			{title}
		</a>
	);
}
