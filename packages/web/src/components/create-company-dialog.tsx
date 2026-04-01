import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useCreateCompany } from '../hooks/use-companies';
import { useCompanyTypes } from '../hooks/use-company-types';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface CreateCompanyDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateCompanyDialog({ open, onOpenChange }: CreateCompanyDialogProps) {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [typeId, setTypeId] = useState('');
	const { data: types } = useCompanyTypes();
	const createCompany = useCreateCompany();
	const navigate = useNavigate();

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await createCompany.mutateAsync({
			name,
			description: description || undefined,
			company_type_id: typeId || undefined,
		});
		onOpenChange(false);
		setName('');
		setDescription('');
		setTypeId('');
		navigate({ to: '/companies/$companyId', params: { companyId: result.id } });
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-xl border border-border bg-bg-subtle p-6 shadow-2xl">
					<div className="flex items-center justify-between mb-4">
						<Dialog.Title className="text-lg font-semibold">Create Company</Dialog.Title>
						<Dialog.Close asChild>
							<button type="button" className="text-text-muted hover:text-text">
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>

					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Input
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Optional"
						/>

						<div className="flex flex-col gap-1.5">
							<label htmlFor="company-type" className="text-sm text-text-muted">
								Company Type
							</label>
							<select
								id="company-type"
								value={typeId}
								onChange={(e) => setTypeId(e.target.value)}
								className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-primary"
							>
								<option value="">None</option>
								{types?.map((t) => (
									<option key={t.id} value={t.id}>
										{t.name}
									</option>
								))}
							</select>
						</div>

						{createCompany.error && (
							<p className="text-sm text-danger">
								{(createCompany.error as { message: string }).message}
							</p>
						)}

						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!name.trim() || createCompany.isPending}>
								{createCompany.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
