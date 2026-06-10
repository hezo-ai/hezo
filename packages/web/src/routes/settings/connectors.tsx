import { createFileRoute } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	useCreateInstanceConnector,
	useDeleteInstanceConnector,
	useInstanceConnectors,
} from '../../hooks/use-instance-connectors';
import { useMe } from '../../hooks/use-me';

function InstanceConnectorsPage() {
	const { data: me } = useMe();
	const { data: connectors = [] } = useInstanceConnectors();
	const createConnector = useCreateInstanceConnector();
	const deleteConnector = useDeleteInstanceConnector();

	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [displayName, setDisplayName] = useState('');
	const [url, setUrl] = useState('');
	const [error, setError] = useState<string | null>(null);

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!name.trim() || !url.trim()) {
			setError('Name and MCP server URL are required.');
			return;
		}
		try {
			await createConnector.mutateAsync({
				name: name.trim(),
				display_name: displayName.trim() || undefined,
				kind: 'saas',
				config: { url: url.trim() },
			});
			setName('');
			setDisplayName('');
			setUrl('');
			setShowForm(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create connector');
		}
	}

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-muted">
				Instance connectors are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">Connectors</h1>
							<InfoTooltip
								label="About connectors"
								content="Remote MCP servers shared with every team's agent runs."
								data-testid="connectors-info"
							/>
						</div>
						<p className="text-[13px] text-text-muted mt-1 max-w-[680px]">
							Remote (SaaS) MCP servers shared with every team's agent runs. Authenticate headers
							with a shared credential placeholder (
							<span className="font-mono">__HEZO_SECRET_NAME__</span>).
						</p>
					</div>
					<Button variant="secondary" size="sm" onClick={() => setShowForm((s) => !s)}>
						<Plus className="w-3 h-3" /> Add
					</Button>
				</div>

				{showForm && (
					<form onSubmit={handleCreate} className="flex flex-col gap-2 mb-4">
						<div className="flex flex-col sm:flex-row gap-2">
							<Input
								placeholder="Name (e.g. shared-docs)"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								className="flex-1"
							/>
							<Input
								placeholder="Display name (optional)"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								className="flex-1"
							/>
						</div>
						<Input
							placeholder="MCP server URL (e.g. https://mcp.example.com/mcp)"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							required
						/>
						{error && <p className="text-[13px] text-accent-red">{error}</p>}
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={createConnector.isPending}>
								Add connector
							</Button>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => {
									setShowForm(false);
									setError(null);
								}}
							>
								Cancel
							</Button>
						</div>
					</form>
				)}

				{!connectors.length ? (
					<p className="text-[13px] text-text-muted">
						No instance connectors yet. Add one above to share it across every team.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{connectors.map((c) => (
							<div
								key={c.id}
								className="flex items-center justify-between rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px]"
							>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="font-medium">{c.display_name || c.name}</span>
									<Badge color="neutral">{c.kind}</Badge>
									<span className="text-xs text-text-subtle font-mono truncate">
										{typeof c.config?.url === 'string' ? c.config.url : ''}
									</span>
								</div>
								<button
									type="button"
									onClick={() => {
										if (confirm(`Remove instance connector "${c.display_name || c.name}"?`)) {
											deleteConnector.mutate(c.id);
										}
									}}
									aria-label="Remove"
									className="text-text-subtle hover:text-accent-red"
								>
									<Trash2 className="w-3.5 h-3.5" />
								</button>
							</div>
						))}
					</div>
				)}
			</>
		);

	return (
		<div className="max-w-[900px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">{content}</div>
	);
}

export const Route = createFileRoute('/settings/connectors')({
	component: InstanceConnectorsPage,
});
