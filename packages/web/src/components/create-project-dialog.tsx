import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useCreateProject } from '../hooks/use-projects';
import { PrdUpload } from './prd-upload';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface CreateProjectDialogProps {
	teamId: string;
	open: boolean;
	onOpenChange: (v: boolean) => void;
}

function derivePrefix(name: string): string {
	const cleaned = name.trim().replace(/[^a-zA-Z0-9\s]/g, '');
	const words = cleaned.split(/\s+/).filter(Boolean);
	if (words.length === 0) return '';
	if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
	return words
		.map((w) => w[0])
		.join('')
		.substring(0, 4)
		.toUpperCase();
}

export function CreateProjectDialog({ teamId, open, onOpenChange }: CreateProjectDialogProps) {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [initialPrd, setInitialPrd] = useState('');
	const [prdFilename, setPrdFilename] = useState<string | null>(null);
	const [taskPrefix, setTaskPrefix] = useState('');
	const [prefixTouched, setPrefixTouched] = useState(false);
	const createProject = useCreateProject(teamId);
	const navigate = useNavigate();

	const derivedPrefix = derivePrefix(name);
	const effectivePrefix = prefixTouched ? taskPrefix : derivedPrefix;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || !description.trim()) return;
		const customPrefix = prefixTouched ? taskPrefix.trim().toUpperCase() : undefined;
		const intake = await createProject.mutateAsync({
			name: name.trim(),
			description: description.trim(),
			initial_prd: initialPrd.trim() || undefined,
			task_prefix: customPrefix && customPrefix.length > 0 ? customPrefix : undefined,
		});
		onOpenChange(false);
		setName('');
		setDescription('');
		setInitialPrd('');
		setPrdFilename(null);
		setTaskPrefix('');
		setPrefixTouched(false);
		navigate({
			to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
			params: {
				teamId,
				projectId: intake.project_slug,
				taskId: intake.intake_task_identifier.toLowerCase(),
			},
		});
	}

	const canSubmit = name.trim().length > 0 && description.trim().length > 0;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<Dialog.Title className="text-base font-medium mb-1">Create Project</Dialog.Title>
					<p className="text-sm text-text-muted mb-4">
						The Captain will analyze your requirements and confirm the team has the right people
						before opening the project.
					</p>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Input
							label="Task prefix"
							value={effectivePrefix}
							onChange={(e) => {
								setPrefixTouched(true);
								setTaskPrefix(e.target.value.toUpperCase());
							}}
							placeholder={derivedPrefix || 'Auto-derived from name'}
							maxLength={4}
							pattern="[A-Z][A-Z0-9]{1,3}"
							title="2–4 uppercase alphanumeric characters starting with a letter"
						/>
						<Textarea
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							required
							rows={4}
							placeholder="What is this project? Domain, users, and the core problem it solves."
						/>
						<PrdUpload
							value={initialPrd}
							filename={prdFilename}
							onChange={(value, filename) => {
								setInitialPrd(value);
								setPrdFilename(filename);
							}}
						/>
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
