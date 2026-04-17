import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
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
	const createProject = useCreateProject(companyId);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || !description.trim()) return;
		await createProject.mutateAsync({
			name: name.trim(),
			description: description.trim(),
		});
		onOpenChange(false);
		setName('');
		setDescription('');
	}

	const canSubmit = name.trim().length > 0 && description.trim().length > 0;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg rounded-radius-lg border border-border bg-bg-elevated p-6 shadow-2xl">
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
