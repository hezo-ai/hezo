import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { Task, useUpdateTask } from '../../hooks/use-tasks';
import { MarkdownProse } from '../markdown-prose';
import { InfoTooltip } from '../ui/info-tooltip';
import { MarkdownFieldEditor } from './markdown-field-editor';

type UpdateTaskMutation = ReturnType<typeof useUpdateTask>;

interface TaskSummaryProps {
	task: Task;
	projectId: string;
	taskProjectSlug: string;
	updateTask: UpdateTaskMutation;
}

interface CollapsibleSummaryCardProps {
	testId: string;
	toggleTestId: string;
	label: string;
	infoLabel: string;
	infoTestId: string;
	infoContent: string;
	editorAriaLabel: string;
	editorPlaceholder?: string;
	value: string | null | undefined;
	emptyText: string;
	className: string;
	projectId: string;
	taskProjectSlug: string;
	onSave: (value: string | null) => void;
}

/**
 * One collapsible progress-summary/rules card. Collapsed by default — the
 * header (chevron toggle, label, info icon, Edit) stays visible while the body
 * hides. Clicking Edit auto-expands and enters edit mode, and the card stays
 * expanded after saving so the freshly-saved content is visible.
 */
function CollapsibleSummaryCard({
	testId,
	toggleTestId,
	label,
	infoLabel,
	infoTestId,
	infoContent,
	editorAriaLabel,
	editorPlaceholder,
	value,
	emptyText,
	className,
	projectId,
	taskProjectSlug,
	onSave,
}: CollapsibleSummaryCardProps) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);

	return (
		<div data-testid={testId} className={className}>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => setOpen((o) => !o)}
						className="flex items-center gap-1 text-left cursor-pointer"
						data-testid={toggleTestId}
						aria-expanded={open}
					>
						<ChevronDown
							className={`w-3.5 h-3.5 text-text-3 transition-transform ${open ? '' : '-rotate-90'}`}
						/>
						<span className="text-[11px] uppercase tracking-wider font-medium text-text-3">
							{label}
						</span>
					</button>
					<InfoTooltip label={infoLabel} data-testid={infoTestId} content={infoContent} />
				</div>
				{!editing && (
					<button
						type="button"
						onClick={() => {
							setEditing(true);
							setOpen(true);
						}}
						className="text-[11px] text-text-3 hover:text-text-1"
					>
						Edit
					</button>
				)}
			</div>
			{open && (
				<div className="mt-2">
					{editing ? (
						<MarkdownFieldEditor
							ariaLabel={editorAriaLabel}
							projectId={projectId}
							projectSlug={taskProjectSlug}
							value={value}
							placeholder={editorPlaceholder}
							onSave={onSave}
							onClose={() => setEditing(false)}
						/>
					) : value ? (
						<MarkdownProse projectId={projectId} projectSlug={taskProjectSlug}>
							{value}
						</MarkdownProse>
					) : (
						<span>{emptyText}</span>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Renders the progress-summary and rules cards just below the task header.
 * Both are collapsible (collapsed by default) and edit inline against
 * `useUpdateTask`. Status changes do not run through here — `progress_summary`
 * and `rules` are plain text fields.
 */
export function TaskSummary({ task, projectId, taskProjectSlug, updateTask }: TaskSummaryProps) {
	return (
		<>
			<CollapsibleSummaryCard
				testId="pinned-progress-summary"
				toggleTestId="progress-summary-toggle"
				label="Progress Summary"
				infoLabel="About Progress Summary"
				infoTestId="progress-summary-info"
				infoContent="A running checkpoint of what's been done and what's left on this task. Automatically included in every agent run's prompt — alongside the description and rules — so work stays continuous across runs. Agents update it at natural milestones via the update_task tool."
				editorAriaLabel="Progress Summary"
				value={task.progress_summary}
				emptyText="No progress summary yet."
				className="bg-surface-2 rounded-md p-3 mb-3 text-[13px] text-text-2 leading-relaxed"
				projectId={projectId}
				taskProjectSlug={taskProjectSlug}
				onSave={(v) => updateTask.mutate({ progress_summary: v })}
			/>

			<CollapsibleSummaryCard
				testId="pinned-rules"
				toggleTestId="rules-toggle"
				label="Rules"
				infoLabel="About Rules"
				infoTestId="rules-info"
				infoContent="Approach constraints and required workflows for this task — e.g. 'run the full suite before pushing' or 'consult the architect before touching auth'. Automatically prepended to every agent run's task prompt. Agents can update via the update_task tool as they discover new rules."
				editorAriaLabel="Rules"
				editorPlaceholder="e.g., Consult the architect before making changes..."
				value={task.rules}
				emptyText="No rules set."
				className="bg-surface-2 rounded-md p-3 mb-5 text-[13px] text-text-2 leading-relaxed border-l-2 border-info"
				projectId={projectId}
				taskProjectSlug={taskProjectSlug}
				onSave={(v) => updateTask.mutate({ rules: v })}
			/>
		</>
	);
}
