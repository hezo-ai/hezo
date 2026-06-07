import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCreateSecret, useDeleteSecret, useSecrets } from '../../hooks/use-secrets';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SectionHeader } from './helpers';

export function SecretsSection({ projectId }: { projectId: string }) {
	const { data: secrets } = useSecrets(projectId);
	const createSecret = useCreateSecret(projectId);
	const deleteSecret = useDeleteSecret(projectId);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const [allowedHosts, setAllowedHosts] = useState('');
	const [allowAllHosts, setAllowAllHosts] = useState(false);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		const hosts = allowedHosts
			.split(/[\s,]+/)
			.map((h) => h.trim())
			.filter(Boolean);
		if (!allowAllHosts && hosts.length === 0) {
			alert(
				'Add at least one allowed host (e.g. api.stripe.com) or check Allow all hosts. ' +
					'A secret with no hosts cannot be substituted by the egress proxy.',
			);
			return;
		}
		await createSecret.mutateAsync({
			name,
			value,
			allowed_hosts: hosts,
			allow_all_hosts: allowAllHosts,
		});
		setName('');
		setValue('');
		setAllowedHosts('');
		setAllowAllHosts(false);
		setShowForm(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader
					title="Secrets vault"
					desc="Encrypted secrets agents reference by placeholder. Allowed-hosts gates which upstream hostnames the egress proxy may substitute the secret for — leave empty (and uncheck the override) and the secret is unusable."
				/>
				<Button variant="secondary" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Add
				</Button>
			</div>
			{showForm && (
				<form onSubmit={handleCreate} className="flex flex-col gap-2 mb-3">
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							placeholder="Name (e.g. STRIPE_API_KEY)"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							className="flex-1"
						/>
						<Input
							placeholder="Value"
							type="password"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							required
							className="flex-1"
						/>
					</div>
					<Input
						placeholder="Allowed hosts (comma- or space-separated, e.g. api.stripe.com, *.stripe.com)"
						value={allowedHosts}
						onChange={(e) => setAllowedHosts(e.target.value)}
						disabled={allowAllHosts}
					/>
					<label className="flex items-center gap-2 text-[13px] text-text-muted">
						<input
							type="checkbox"
							checked={allowAllHosts}
							onChange={(e) => setAllowAllHosts(e.target.checked)}
						/>
						Allow this secret to reach any host (escape hatch — use sparingly)
					</label>
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={createSecret.isPending}>
							Add
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={() => setShowForm(false)}>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{secrets?.length === 0 ? (
				<p className="text-[13px] text-text-subtle">No secrets stored.</p>
			) : (
				<div className="flex flex-col gap-1">
					{secrets?.map((s) => (
						<div
							key={s.id}
							className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
						>
							<div className="flex items-center gap-2 min-w-0 flex-1">
								<span className="font-medium">{s.name}</span>
								<Badge color="neutral">{s.category}</Badge>
								{s.project_name && (
									<span className="text-xs text-text-subtle">{s.project_name}</span>
								)}
								{s.allow_all_hosts ? (
									<Badge color="warning">all hosts</Badge>
								) : s.allowed_hosts?.length ? (
									<span className="text-xs text-text-subtle font-mono truncate">
										{s.allowed_hosts.join(', ')}
									</span>
								) : (
									<Badge color="danger">no hosts</Badge>
								)}
							</div>
							<button
								type="button"
								onClick={() => deleteSecret.mutate(s.id)}
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
