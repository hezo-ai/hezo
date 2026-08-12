import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useAllVisibleProjects, useProjectMeta } from '../hooks/use-projects';
import { useCreateSubTask, useCreateTask } from '../hooks/use-tasks';
import { agentDisplayName } from './agent-identity-tooltip';
import { MarkdownEditor } from './markdown-editor';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';
import { Input } from './ui/input';

interface CreateTaskDialogProps {
	/** Fixed target project (slug). Pass this OR `selectProject`, not both. */
	projectId?: string;
	/** Show a project picker as the first field instead of targeting a fixed
	 *  `projectId` — used by the global mobile "+" so a task can be filed into any
	 *  project. The picked project then drives the assignee list. */
	selectProject?: boolean;
	/** When set, the dialog creates a *sub-task* of this parent (identifier or
	 *  UUID — both resolve server-side) instead of a top-level task. The project
	 *  is fixed to the parent's, so `selectProject` doesn't apply. */
	parentTaskId?: string;
	/** Parent's display identifier (e.g. "OPS-12"), shown in the dialog title. */
	parentIdentifier?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateTaskDialog({
	projectId,
	selectProject,
	parentTaskId,
	parentIdentifier,
	open,
	onOpenChange,
}: CreateTaskDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [assigneeId, setAssigneeId] = useState('');
	const [priority, setPriority] = useState('medium');
	const [moreOpen, setMoreOpen] = useState(false);
	const [pickedProjectId, setPickedProjectId] = useState('');
	// Fullscreen mode grows the panel to fill the viewport (desktop only — the
	// dialog is already near-full-screen on mobile) and lets the description
	// occupy most of the space, mirroring the CEO chat's expand affordance.
	const [fullscreen, setFullscreen] = useState(false);

	// With `selectProject` the picker drives the target; otherwise the fixed prop does.
	const effectiveProjectId = selectProject ? pickedProjectId : (projectId ?? '');

	const { projects } = useAllVisibleProjects();
	const project = useProjectMeta(effectiveProjectId);
	const { data: agents } = useAgents(effectiveProjectId);
	const createTask = useCreateTask(effectiveProjectId);
	// Both hooks are called unconditionally (rules of hooks). `useCreateSubTask`
	// only builds a URL; it never fires unless `mutateAsync` is invoked below.
	const createSubTask = useCreateSubTask(effectiveProjectId, parentTaskId ?? '');
	const isSubTask = !!parentTaskId;
	const activeMutation = isSubTask ? createSubTask : createTask;
	const navigate = useNavigate();

	// On open, seed the picker with the passed/active project (only when it's a
	// user-visible project) and clear any stale assignee. The seed is deferred
	// until the project list is actually available: the dialog can open before
	// that request resolves, and matching against an empty list would leave the
	// picker blank for as long as it stays open. Seeding happens at most once
	// per open, so a pick already in progress is never reset.
	const prevOpenRef = useRef(false);
	const seededRef = useRef(false);
	useEffect(() => {
		if (selectProject && open) {
			if (!prevOpenRef.current) {
				seededRef.current = false;
				setPickedProjectId('');
				setAssigneeId('');
			}
			if (!seededRef.current && projects.length > 0) {
				setPickedProjectId(
					projectId && projects.some((p) => p.slug === projectId) ? projectId : '',
				);
				seededRef.current = true;
			}
		}
		prevOpenRef.current = open;
	}, [open, selectProject, projectId, projects]);

	const isInternalProject = project?.is_internal ?? false;
	const captainAgent = useMemo(() => agents?.find((a) => a.slug === CAPTAIN_AGENT_SLUG), [agents]);
	const selectableAgents = useMemo(() => {
		if (!agents) return [];
		if (isInternalProject) {
			return captainAgent ? [captainAgent] : [];
		}
		return agents.filter((a) => a.admin_status !== 'disabled');
	}, [agents, captainAgent, isInternalProject]);

	const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);
	const summaryLabel = `${priorityLabel} priority · ${project?.name ?? 'No project'}`;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const payload = {
			title,
			description: description || undefined,
			assignee_id: assigneeId || undefined,
			priority,
		};
		try {
			// Branch the call (not the mutation object) so each `mutateAsync` stays
			// monomorphic — the two hooks have structurally different variables.
			const result = isSubTask
				? await createSubTask.mutateAsync(payload)
				: await createTask.mutateAsync(payload);
			onOpenChange(false);
			setTitle('');
			setDescription('');
			setAssigneeId('');
			navigate({
				to: '/projects/$projectId/tasks/$taskId',
				params: {
					projectId: result.project_slug ?? effectiveProjectId,
					taskId: result.identifier.toLowerCase(),
				},
			});
		} catch {
			// Surfaced inline via `activeMutation.error` — keep the dialog open so
			// the user can correct and retry (e.g. the sub-task depth-cap error).
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="lg"
				fullscreen={fullscreen}
				data-fullscreen={fullscreen}
				cornerActions={
					// Fullscreen toggle is desktop-only — the dialog already fills the
					// screen on mobile, where the toggle would be a no-op.
					<button
						type="button"
						onClick={() => setFullscreen((v) => !v)}
						aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
						data-testid="create-task-fullscreen"
						className="hidden text-text-2 hover:text-text-1 p-2 -m-1 sm:block"
					>
						{fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
					</button>
				}
			>
				<Dialog.Title className="text-lg font-semibold mb-4 pr-16 shrink-0">
					{isSubTask
						? `Create sub-task${parentIdentifier ? ` · ${parentIdentifier}` : ''}`
						: 'Create Task'}
				</Dialog.Title>

				<form
					onSubmit={handleSubmit}
					className={fullscreen ? 'flex min-h-0 flex-1 flex-col gap-4' : 'flex flex-col gap-4'}
				>
					{selectProject && !isSubTask && (
						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-2">Project *</span>
							<select
								value={pickedProjectId}
								onChange={(e) => {
									// Switching projects invalidates the chosen assignee (a
									// different roster), so clear it in the same update.
									setPickedProjectId(e.target.value);
									setAssigneeId('');
								}}
								required
								data-testid="create-task-project"
								className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
							>
								<option value="">Select project</option>
								{projects.map((p) => (
									<option key={p.id} value={p.slug}>
										{p.name}
									</option>
								))}
							</select>
						</label>
					)}
					<Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
					<MarkdownEditor
						projectId={effectiveProjectId}
						projectSlug={project?.slug}
						label="Description"
						ariaLabel="Description"
						value={description}
						onChange={setDescription}
						placeholder="Optional"
						previewClassName="min-h-[72px]"
						emptyPreviewText="_(nothing to preview)_"
						fill={fullscreen}
					/>

					<label className="flex flex-col gap-1.5">
						<span className="text-sm text-text-2">Assignee *</span>
						<select
							value={assigneeId}
							onChange={(e) => setAssigneeId(e.target.value)}
							required
							data-testid="create-task-assignee"
							className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
						>
							<option value="">Select assignee</option>
							{selectableAgents.map((a) => (
								<option key={a.id} value={a.id}>
									{agentDisplayName(a)}
								</option>
							))}
						</select>
					</label>

					<div className="flex flex-col gap-3">
						<button
							type="button"
							onClick={() => setMoreOpen((o) => !o)}
							aria-expanded={moreOpen}
							data-testid="create-task-more-toggle"
							className="flex items-center gap-2 self-start text-xs text-text-2 hover:text-text-1 cursor-pointer"
						>
							<ChevronDown
								className={`w-3.5 h-3.5 text-text-3 shrink-0 transition-transform ${
									moreOpen ? '' : '-rotate-90'
								}`}
							/>
							<span className="truncate">{summaryLabel}</span>
						</button>
						{moreOpen && (
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<label className="flex flex-col gap-1.5">
									<span className="text-sm text-text-2">Priority</span>
									<select
										value={priority}
										onChange={(e) => setPriority(e.target.value)}
										className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
									>
										<option value="low">Low</option>
										<option value="medium">Medium</option>
										<option value="high">High</option>
										<option value="urgent">Urgent</option>
									</select>
								</label>
							</div>
						)}
					</div>

					{activeMutation.error && (
						<p className="text-sm text-danger" data-testid="create-task-error">
							{(activeMutation.error as { message: string }).message}
						</p>
					)}

					<div className="flex justify-end gap-2 mt-2">
						<Button
							type="button"
							variant="ghost"
							shortcut="Escape"
							shortcutFire={false}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							shortcut="mod+Enter"
							disabled={
								!effectiveProjectId || !title.trim() || !assigneeId || activeMutation.isPending
							}
						>
							{activeMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
							Create
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}
