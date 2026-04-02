import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useCreateIssue } from '../hooks/use-issues';
import { useProjects } from '../hooks/use-projects';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface CreateIssueDialogProps {
	companyId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateIssueDialog({ companyId, open, onOpenChange }: CreateIssueDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [projectId, setProjectId] = useState('');
	const [assigneeId, setAssigneeId] = useState('');
	const [priority, setPriority] = useState('medium');
	const { data: projects } = useProjects(companyId);
	const { data: agents } = useAgents(companyId);
	const createIssue = useCreateIssue(companyId);
	const navigate = useNavigate();

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!projectId) return;
		const result = await createIssue.mutateAsync({
			title,
			description: description || undefined,
			project_id: projectId,
			assignee_id: assigneeId || undefined,
			priority,
		});
		onOpenChange(false);
		setTitle('');
		setDescription('');
		navigate({
			to: '/companies/$companyId/issues/$issueId',
			params: { companyId, issueId: result.id },
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl">
					<div className="flex items-center justify-between mb-4">
						<Dialog.Title className="text-lg font-semibold">Create Issue</Dialog.Title>
						<Dialog.Close asChild>
							<button type="button" className="text-text-muted hover:text-text">
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>

					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input
							label="Title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							required
						/>
						<Textarea
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Optional"
						/>

						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-muted">Project *</span>
							<select
								value={projectId}
								onChange={(e) => setProjectId(e.target.value)}
								required
								className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
							>
								<option value="">Select project</option>
								{projects?.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
						</label>

						<div className="grid grid-cols-2 gap-4">
							<label className="flex flex-col gap-1.5">
								<span className="text-sm text-text-muted">Priority</span>
								<select
									value={priority}
									onChange={(e) => setPriority(e.target.value)}
									className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
								>
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
									<option value="urgent">Urgent</option>
								</select>
							</label>
							<label className="flex flex-col gap-1.5">
								<span className="text-sm text-text-muted">Assignee</span>
								<select
									value={assigneeId}
									onChange={(e) => setAssigneeId(e.target.value)}
									className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
								>
									<option value="">Unassigned</option>
									{agents
										?.filter((a) => a.status !== 'terminated')
										.map((a) => (
											<option key={a.id} value={a.id}>
												{a.title}
											</option>
										))}
								</select>
							</label>
						</div>

						{createIssue.error && (
							<p className="text-sm text-accent-red">
								{(createIssue.error as { message: string }).message}
							</p>
						)}

						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!title.trim() || !projectId || createIssue.isPending}>
								{createIssue.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
