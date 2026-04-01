import { createFileRoute } from '@tanstack/react-router';
import { Copy, ExternalLink, Key, Link2, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useAgents } from '../../../../hooks/use-agents';
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from '../../../../hooks/use-api-keys';
import {
	useConnections,
	useDeleteConnection,
	useStartConnection,
} from '../../../../hooks/use-connections';
import { useCosts } from '../../../../hooks/use-costs';
import { usePreferences, useUpdatePreferences } from '../../../../hooks/use-preferences';
import { useCreateSecret, useDeleteSecret, useSecrets } from '../../../../hooks/use-secrets';

function SettingsPage() {
	const { companyId } = Route.useParams();

	return (
		<div className="p-6 max-w-3xl space-y-8">
			<h1 className="text-lg font-semibold">Settings</h1>
			<ConnectionsSection companyId={companyId} />
			<SecretsSection companyId={companyId} />
			<ApiKeysSection companyId={companyId} />
			<BudgetSection companyId={companyId} />
			<PreferencesSection companyId={companyId} />
		</div>
	);
}

function ConnectionsSection({ companyId }: { companyId: string }) {
	const { data: connections } = useConnections(companyId);
	const startConn = useStartConnection(companyId);
	const deleteConn = useDeleteConnection(companyId);

	async function handleConnect(platform: string) {
		const result = await startConn.mutateAsync(platform);
		window.location.href = result.auth_url;
	}

	const github = connections?.find((c) => c.platform === 'github');

	return (
		<section>
			<h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-1.5">
				<Link2 className="w-4 h-4" /> Connected Platforms
			</h2>
			{github ? (
				<Card className="p-3 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Badge color="green">GitHub</Badge>
						<Badge color={github.status === 'active' ? 'green' : 'red'}>{github.status}</Badge>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="text-danger"
						onClick={() => deleteConn.mutate(github.id)}
					>
						<Trash2 className="w-3.5 h-3.5" /> Disconnect
					</Button>
				</Card>
			) : (
				<Button
					variant="secondary"
					size="sm"
					onClick={() => handleConnect('github')}
					disabled={startConn.isPending}
				>
					{startConn.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
					<ExternalLink className="w-3.5 h-3.5" /> Connect GitHub
				</Button>
			)}
			{startConn.error && (
				<p className="text-sm text-danger mt-2">
					{(startConn.error as { message: string }).message}
				</p>
			)}
		</section>
	);
}

function SecretsSection({ companyId }: { companyId: string }) {
	const { data: secrets } = useSecrets(companyId);
	const createSecret = useCreateSecret(companyId);
	const deleteSecret = useDeleteSecret(companyId);
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		await createSecret.mutateAsync({ name, value });
		setName('');
		setValue('');
		setShowForm(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
					<Lock className="w-4 h-4" /> Secrets Vault
				</h2>
				<Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Add
				</Button>
			</div>
			{showForm && (
				<form onSubmit={handleCreate} className="flex gap-2 mb-3">
					<Input
						placeholder="Name"
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
					<Button type="submit" size="sm" disabled={createSecret.isPending}>
						Add
					</Button>
				</form>
			)}
			{secrets?.length === 0 ? (
				<p className="text-sm text-text-subtle">No secrets stored.</p>
			) : (
				<div className="flex flex-col gap-1">
					{secrets?.map((s) => (
						<div
							key={s.id}
							className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{s.name}</span>
								<Badge color="gray">{s.category}</Badge>
								{s.project_name && (
									<span className="text-xs text-text-subtle">{s.project_name}</span>
								)}
							</div>
							<button
								type="button"
								onClick={() => deleteSecret.mutate(s.id)}
								className="text-text-subtle hover:text-danger"
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

function ApiKeysSection({ companyId }: { companyId: string }) {
	const { data: apiKeys } = useApiKeys(companyId);
	const createKey = useCreateApiKey(companyId);
	const deleteKey = useDeleteApiKey(companyId);
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
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
					<Key className="w-4 h-4" /> API Keys
				</h2>
				<Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)}>
					<Plus className="w-3 h-3" /> Create
				</Button>
			</div>
			{newKey && (
				<Card className="p-3 mb-3 border-success/50 bg-success/5">
					<p className="text-xs text-success font-medium mb-1">
						New API key created — copy it now, it won't be shown again:
					</p>
					<div className="flex items-center gap-2">
						<code className="text-xs font-mono break-all flex-1">{newKey}</code>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								navigator.clipboard.writeText(newKey);
							}}
						>
							<Copy className="w-3 h-3" />
						</Button>
					</div>
					<Button variant="ghost" size="sm" className="mt-2" onClick={() => setNewKey(null)}>
						Dismiss
					</Button>
				</Card>
			)}
			{showForm && (
				<form onSubmit={handleCreate} className="flex gap-2 mb-3">
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
				<p className="text-sm text-text-subtle">No API keys.</p>
			) : (
				<div className="flex flex-col gap-1">
					{apiKeys?.map((k) => (
						<div
							key={k.id}
							className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{k.name}</span>
								<span className="text-xs text-text-subtle font-mono">hezo_{k.prefix}...</span>
							</div>
							<button
								type="button"
								onClick={() => deleteKey.mutate(k.id)}
								className="text-text-subtle hover:text-danger"
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

function BudgetSection({ companyId }: { companyId: string }) {
	const { data: costs } = useCosts(companyId, { group_by: 'agent' });
	const { data: agents } = useAgents(companyId);
	const highBudgetAgents =
		agents?.filter(
			(a) => a.monthly_budget_cents > 0 && a.budget_used_cents / a.monthly_budget_cents > 0.8,
		) ?? [];

	return (
		<section>
			<h2 className="text-sm font-medium text-text-muted mb-3">Budget Overview</h2>
			{highBudgetAgents.length > 0 && (
				<div className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
					{highBudgetAgents.length} agent{highBudgetAgents.length > 1 ? 's' : ''} at 80%+ budget
					usage: {highBudgetAgents.map((a) => a.title).join(', ')}
				</div>
			)}
			{costs?.summary?.length === 0 ? (
				<p className="text-sm text-text-subtle">No spend recorded.</p>
			) : (
				<div className="flex flex-col gap-1">
					{costs?.summary?.map((s) => (
						<div
							key={s.label}
							className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
						>
							<span>{s.label}</span>
							<span className="font-mono">${(s.total_cents / 100).toFixed(2)}</span>
						</div>
					))}
					<div className="flex items-center justify-between px-3 py-2 text-sm font-medium border-t border-border mt-1 pt-2">
						<span>Total</span>
						<span className="font-mono">${((costs?.total_cents ?? 0) / 100).toFixed(2)}</span>
					</div>
				</div>
			)}
		</section>
	);
}

function PreferencesSection({ companyId }: { companyId: string }) {
	const { data: prefs } = usePreferences(companyId);
	const updatePrefs = useUpdatePreferences(companyId);
	const [content, setContent] = useState('');
	const [editing, setEditing] = useState(false);

	useEffect(() => {
		if (prefs?.content) setContent(prefs.content);
	}, [prefs]);

	async function handleSave() {
		await updatePrefs.mutateAsync({ content });
		setEditing(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted">Company Preferences</h2>
				{!editing && (
					<Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
						Edit
					</Button>
				)}
			</div>
			{editing ? (
				<div className="flex flex-col gap-2">
					<Textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						className="min-h-[120px] font-mono text-xs"
					/>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={handleSave} disabled={updatePrefs.isPending}>
							{updatePrefs.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
							Save
						</Button>
					</div>
				</div>
			) : (
				<p className="text-sm text-text-muted whitespace-pre-wrap">
					{prefs?.content || 'No preferences set.'}
				</p>
			)}
		</section>
	);
}

export const Route = createFileRoute('/companies/$companyId/settings/')({
	component: SettingsPage,
});
