import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
	const [selectedTypeIds, setSelectedTypeIds] = useState<Set<string>>(new Set());
	const hasSetDefault = useRef(false);
	const { data: types } = useCompanyTypes();
	const createCompany = useCreateCompany();
	const navigate = useNavigate();

	useEffect(() => {
		if (types?.length && !hasSetDefault.current) {
			const softDev = types.find((t) => t.name === 'Software Development');
			if (softDev) setSelectedTypeIds(new Set([softDev.id]));
			hasSetDefault.current = true;
		}
	}, [types]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await createCompany.mutateAsync({
			name,
			description: description || undefined,
			team_type_ids: selectedTypeIds.size > 0 ? [...selectedTypeIds] : undefined,
		});
		onOpenChange(false);
		setName('');
		setDescription('');
		const defaultId = types?.find((t) => t.name === 'Software Development')?.id;
		setSelectedTypeIds(new Set(defaultId ? [defaultId] : []));
		navigate({ to: '/companies/$companyId', params: { companyId: result.slug } });
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl">
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

						<fieldset className="flex flex-col gap-1.5">
							<legend className="text-sm text-text-muted">Team Types</legend>
							<div className="flex flex-col gap-2">
								{types?.map((t) => (
									<label key={t.id} className="flex items-center gap-2 text-sm cursor-pointer">
										<input
											type="checkbox"
											checked={selectedTypeIds.has(t.id)}
											onChange={(e) => {
												const next = new Set(selectedTypeIds);
												if (e.target.checked) {
													next.add(t.id);
												} else {
													next.delete(t.id);
												}
												setSelectedTypeIds(next);
											}}
											className="rounded border-border"
										/>
										{t.name}
									</label>
								))}
							</div>
						</fieldset>

						{createCompany.error && (
							<p className="text-sm text-accent-red">
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
