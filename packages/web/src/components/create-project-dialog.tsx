import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { FileText, Loader2, Upload, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useCreateProject } from '../hooks/use-projects';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface CreateProjectDialogProps {
	companyId: string;
	open: boolean;
	onOpenChange: (v: boolean) => void;
}

export function CreateProjectDialog({ companyId, open, onOpenChange }: CreateProjectDialogProps) {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [initialPrd, setInitialPrd] = useState('');
	const [prdFilename, setPrdFilename] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const createProject = useCreateProject(companyId);
	const navigate = useNavigate();

	const handleFileUpload = useCallback((file: File) => {
		const reader = new FileReader();
		reader.onload = (ev) => {
			const content = ev.target?.result;
			if (typeof content === 'string') {
				setInitialPrd(content);
				setPrdFilename(file.name);
			}
		};
		reader.readAsText(file);
	}, []);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || !description.trim()) return;
		const project = await createProject.mutateAsync({
			name: name.trim(),
			description: description.trim(),
			initial_prd: initialPrd.trim() || undefined,
		});
		onOpenChange(false);
		setName('');
		setDescription('');
		setInitialPrd('');
		setPrdFilename(null);
		if (project.planning_issue_identifier) {
			navigate({
				to: '/companies/$companyId/issues/$issueId',
				params: {
					companyId,
					issueId: project.planning_issue_identifier.toLowerCase(),
				},
			});
		}
	}

	const canSubmit = name.trim().length > 0 && description.trim().length > 0;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg rounded-radius-lg border border-border bg-bg-elevated p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
					<Dialog.Title className="text-base font-medium mb-1">Create Project</Dialog.Title>
					<p className="text-sm text-text-muted mb-4">
						The CEO will draft an execution plan from your description.
					</p>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Textarea
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							required
							rows={4}
							placeholder="What is this project? Domain, users, and the core problem it solves."
						/>
						<div className="flex flex-col gap-1.5">
							<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
								Requirements Document (optional)
							</span>
							{initialPrd ? (
								<div className="rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]">
									<div className="flex items-center justify-between mb-2">
										<span className="flex items-center gap-1.5 text-text-muted">
											<FileText className="w-3.5 h-3.5" />
											{prdFilename || 'Pasted content'}
										</span>
										<button
											type="button"
											onClick={() => {
												setInitialPrd('');
												setPrdFilename(null);
											}}
											className="text-text-subtle hover:text-text p-0.5"
										>
											<X className="w-3.5 h-3.5" />
										</button>
									</div>
									<p className="text-text-subtle text-xs truncate">
										{initialPrd.slice(0, 120)}
										{initialPrd.length > 120 ? '…' : ''}
									</p>
								</div>
							) : (
								<button
									type="button"
									className="rounded-radius-md border border-dashed border-border bg-bg px-3 py-4 text-[13px] text-center cursor-pointer hover:border-border-hover transition-colors w-full"
									onClick={() => fileInputRef.current?.click()}
									onDragOver={(e) => {
										e.preventDefault();
										e.stopPropagation();
									}}
									onDrop={(e) => {
										e.preventDefault();
										e.stopPropagation();
										const file = e.dataTransfer.files[0];
										if (file) handleFileUpload(file);
									}}
								>
									<Upload className="w-4 h-4 mx-auto mb-1 text-text-subtle" />
									<p className="text-text-subtle">Drop a file here or click to upload</p>
									<p className="text-text-subtle text-xs mt-1">.md or .txt</p>
								</button>
							)}
							<input
								ref={fileInputRef}
								type="file"
								accept=".md,.txt,.markdown"
								className="hidden"
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (file) handleFileUpload(file);
									e.target.value = '';
								}}
							/>
						</div>
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!canSubmit || createProject.isPending}>
								{createProject.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
