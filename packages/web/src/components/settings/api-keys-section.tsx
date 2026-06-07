import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from '../../hooks/use-api-keys';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SectionHeader } from './helpers';

export function ApiKeysSection({ projectId }: { projectId: string }) {
	const { data: apiKeys } = useApiKeys(projectId);
	const createKey = useCreateApiKey(projectId);
	const deleteKey = useDeleteApiKey(projectId);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [newKey, setNewKey] = useState<string | null>(null);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		const result = await createKey.mutateAsync({ name });
		setNewKey(result.key ?? null);
		setName('');
		setShowForm(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader title="API keys" />
				<Button variant="secondary" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Create
				</Button>
			</div>
			{newKey && (
				<div className="border border-accent-green rounded-radius-md bg-accent-green-bg p-3 mb-3">
					<p className="text-xs text-accent-green-text font-medium mb-1">
						New API key created — copy it now, it won't be shown again:
					</p>
					<div className="flex items-center gap-2">
						<code className="text-xs font-mono break-all flex-1">{newKey}</code>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => navigator.clipboard.writeText(newKey)}
						>
							<Copy className="w-3 h-3" />
						</Button>
					</div>
					<Button variant="secondary" size="sm" className="mt-2" onClick={() => setNewKey(null)}>
						Dismiss
					</Button>
				</div>
			)}
			{showForm && (
				<form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2 mb-3">
					<Input
						placeholder="Key name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						className="flex-1"
					/>
					<Button type="submit" size="sm" disabled={createKey.isPending}>
						Create
					</Button>
				</form>
			)}
			{apiKeys?.length === 0 ? (
				<p className="text-[13px] text-text-subtle">No API keys.</p>
			) : (
				<div className="flex flex-col gap-1">
					{apiKeys?.map((k) => (
						<div
							key={k.id}
							className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{k.name}</span>
								<span className="text-xs text-text-subtle font-mono">hezo_{k.prefix}...</span>
							</div>
							<button
								type="button"
								onClick={() => deleteKey.mutate(k.id)}
								className="text-text-subtle hover:text-accent-red"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</button>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
