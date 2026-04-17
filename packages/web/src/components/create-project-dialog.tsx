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
	const [goal, setGoal] = useState('');
	const createProject = useCreateProject(companyId);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await createProject.mutateAsync({ name, goal: goal || undefined });
		onOpenChange(false);
		setName('');
		setGoal('');
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-radius-lg border border-border bg-bg-elevated p-6 shadow-2xl">
					<Dialog.Title className="text-base font-medium mb-4">Create Project</Dialog.Title>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Textarea
							label="Goal"
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="Optional"
						/>
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!name.trim() || createProject.isPending}>
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
