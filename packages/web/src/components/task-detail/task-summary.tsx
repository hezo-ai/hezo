import { useState } from 'react';
import type { Task, useUpdateTask } from '../../hooks/use-tasks';
import { MarkdownProse } from '../markdown-prose';
import { MentionTextarea } from '../mention-textarea';
import { Button } from '../ui/button';
import { InfoTooltip } from '../ui/info-tooltip';

type UpdateTaskMutation = ReturnType<typeof useUpdateTask>;

interface TaskSummaryProps {
	task: Task;
	teamId: string;
	taskProjectSlug: string;
	updateTask: UpdateTaskMutation;
}

/**
 * Renders the progress-summary and rules cards just below the task header.
 * Both edit inline against `useUpdateTask`. Status changes do not run through
 * here — `progress_summary` and `rules` are plain text fields.
 */
export function TaskSummary({ task, teamId, taskProjectSlug, updateTask }: TaskSummaryProps) {
	const [editingSummary, setEditingSummary] = useState(false);
	const [summaryText, setSummaryText] = useState('');
	const [editingRules, setEditingRules] = useState(false);
	const [rulesText, setRulesText] = useState('');

	return (
		<>
			<div
				data-testid="pinned-progress-summary"
				className="bg-bg-subtle rounded-radius-md p-3 mb-3 text-[13px] text-text-muted leading-relaxed"
			>
				<div className="flex items-center justify-between mb-1">
					<div className="flex items-center gap-1">
						<span className="text-[11px] uppercase tracking-wider font-medium text-text-subtle">
							Progress Summary
						</span>
						<InfoTooltip
							label="About Progress Summary"
							data-testid="progress-summary-info"
							content="A running checkpoint of what's been done and what's left on this task. Automatically included in every agent run's prompt — alongside the description and rules — so work stays continuous across runs. Agents update it at natural milestones via the update_task tool."
						/>
					</div>
					{!editingSummary && (
						<button
							type="button"
							onClick={() => {
								setSummaryText(task.progress_summary ?? '');
								setEditingSummary(true);
							}}
							className="text-[11px] text-text-subtle hover:text-text"
						>
							Edit
						</button>
					)}
				</div>
				{editingSummary ? (
					<div className="flex flex-col gap-2">
						<MentionTextarea
							teamId={teamId}
							projectSlug={taskProjectSlug}
							value={summaryText}
							onChange={(e) => setSummaryText(e.target.value)}
							className="min-h-[60px]"
						/>
						<div className="flex gap-2 justify-end">
							<Button size="sm" variant="secondary" onClick={() => setEditingSummary(false)}>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={() => {
									updateTask.mutate({
										progress_summary: summaryText || null,
									});
									setEditingSummary(false);
								}}
							>
								Save
							</Button>
						</div>
					</div>
				) : task.progress_summary ? (
					<MarkdownProse teamId={teamId} projectSlug={taskProjectSlug}>
						{task.progress_summary}
					</MarkdownProse>
				) : (
					<span>No progress summary yet.</span>
				)}
			</div>

			<div
				data-testid="pinned-rules"
				className="bg-bg-subtle rounded-radius-md p-3 mb-5 text-[13px] text-text-muted leading-relaxed border-l-2 border-accent-blue"
			>
				<div className="flex items-center justify-between mb-1">
					<div className="flex items-center gap-1">
						<span className="text-[11px] uppercase tracking-wider font-medium text-text-subtle">
							Rules
						</span>
						<InfoTooltip
							label="About Rules"
							data-testid="rules-info"
							content="Approach constraints and required workflows for this task — e.g. 'run the full suite before pushing' or 'consult the architect before touching auth'. Automatically prepended to every agent run's task prompt. Agents can update via the update_task tool as they discover new rules."
						/>
					</div>
					{!editingRules && (
						<button
							type="button"
							onClick={() => {
								setRulesText(task.rules ?? '');
								setEditingRules(true);
							}}
							className="text-[11px] text-text-subtle hover:text-text"
						>
							Edit
						</button>
					)}
				</div>
				{editingRules ? (
					<div className="flex flex-col gap-2">
						<MentionTextarea
							teamId={teamId}
							projectSlug={taskProjectSlug}
							value={rulesText}
							onChange={(e) => setRulesText(e.target.value)}
							placeholder="e.g., Consult the architect before making changes..."
							className="min-h-[60px]"
						/>
						<div className="flex gap-2 justify-end">
							<Button size="sm" variant="secondary" onClick={() => setEditingRules(false)}>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={() => {
									updateTask.mutate({ rules: rulesText || null });
									setEditingRules(false);
								}}
							>
								Save
							</Button>
						</div>
					</div>
				) : task.rules ? (
					<MarkdownProse teamId={teamId} projectSlug={taskProjectSlug}>
						{task.rules}
					</MarkdownProse>
				) : (
					<span>No rules set.</span>
				)}
			</div>
		</>
	);
}
