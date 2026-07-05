import { createFileRoute } from '@tanstack/react-router';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { type Column, DataTable } from '../../components/ui/data-table';
import { InPlaceForm } from '../../components/ui/in-place-form';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import {
	type CredentialUsage,
	useCreateInstanceSecret,
	useDeleteInstanceSecret,
	useInstanceCredentials,
	useUpdateInstanceSecret,
} from '../../hooks/use-instance-credentials';
import { useMe } from '../../hooks/use-me';

function formatRelative(iso: string | null): string {
	if (!iso) return 'never';
	const ms = Date.now() - new Date(iso).getTime();
	const min = 60 * 1000;
	const hr = 60 * min;
	const day = 24 * hr;
	if (ms < min) return 'just now';
	if (ms < hr) return `${Math.floor(ms / min)}m ago`;
	if (ms < day) return `${Math.floor(ms / hr)}h ago`;
	return `${Math.floor(ms / day)}d ago`;
}

function InstanceCredentialsPage() {
	const { data: me } = useMe();
	const { data: rows = [] } = useInstanceCredentials();
	const createSecret = useCreateInstanceSecret();
	const updateSecret = useUpdateInstanceSecret();
	const deleteSecret = useDeleteInstanceSecret();

	// `editing` null = the form (when open) creates; otherwise it edits that row.
	const [showForm, setShowForm] = useState(false);
	const [editing, setEditing] = useState<CredentialUsage | null>(null);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const [allowedHosts, setAllowedHosts] = useState('');
	const [allowAllHosts, setAllowAllHosts] = useState(false);
	const [allowBodySubstitution, setAllowBodySubstitution] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function resetForm() {
		setShowForm(false);
		setEditing(null);
		setName('');
		setValue('');
		setAllowedHosts('');
		setAllowAllHosts(false);
		setAllowBodySubstitution(false);
		setError(null);
	}

	function openCreate() {
		resetForm();
		setShowForm(true);
	}

	function openEdit(row: CredentialUsage) {
		setEditing(row);
		setName(row.name);
		setValue('');
		setAllowedHosts(row.allowed_hosts.join(', '));
		setAllowAllHosts(row.allow_all_hosts);
		setAllowBodySubstitution(row.allow_body_substitution);
		setError(null);
		setShowForm(true);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const hosts = allowedHosts
			.split(/[\s,]+/)
			.map((h) => h.trim())
			.filter(Boolean);
		if (!allowAllHosts && hosts.length === 0) {
			setError(
				'Add at least one allowed host (e.g. api.stripe.com) or check Allow all hosts — a secret with no hosts cannot be substituted by the egress proxy.',
			);
			return;
		}
		try {
			if (editing) {
				await updateSecret.mutateAsync({
					secretId: editing.id,
					// Blank value = keep the existing secret; only rotate when provided.
					value: value ? value : undefined,
					allowed_hosts: hosts,
					allow_all_hosts: allowAllHosts,
					allow_body_substitution: allowBodySubstitution,
				});
			} else {
				await createSecret.mutateAsync({
					name: name.trim(),
					value,
					allowed_hosts: hosts,
					allow_all_hosts: allowAllHosts,
					allow_body_substitution: allowBodySubstitution,
				});
			}
			resetForm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save credential');
		}
	}

	const columns: Column<CredentialUsage>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (r) => (
				<span className="flex items-center gap-2">
					<span className="font-mono text-[13px]">{r.name}</span>
					<Badge color="neutral">{r.category}</Badge>
				</span>
			),
		},
		{
			key: 'hosts',
			header: 'Allowed hosts',
			hideOnMobile: true,
			render: (r) => {
				if (r.allow_all_hosts) return <Badge color="warning">all hosts</Badge>;
				if (!r.allowed_hosts.length) return <Badge color="danger">no hosts</Badge>;
				return (
					<span className="text-xs font-mono text-text-2 truncate">
						{r.allowed_hosts.join(', ')}
					</span>
				);
			},
		},
		{
			key: 'usage',
			header: 'Last used',
			render: (r) => (
				<span className="text-xs">
					{r.last_used_at ? (
						<Tooltip content={r.last_used_at}>
							<span>{formatRelative(r.last_used_at)}</span>
						</Tooltip>
					) : (
						<span>{formatRelative(r.last_used_at)}</span>
					)}
					{r.last_host && <span className="text-text-3 ml-2 font-mono">{r.last_host}</span>}
				</span>
			),
		},
		{
			key: 'count',
			header: 'Uses',
			hideOnMobile: true,
			render: (r) => <span className="text-xs">{r.use_count.toLocaleString()}</span>,
		},
		{
			key: 'actions',
			header: '',
			render: (r) => (
				<span className="flex items-center gap-2 justify-end">
					<Tooltip content="Edit">
						<button
							type="button"
							onClick={() => openEdit(r)}
							aria-label={`Edit ${r.name}`}
							className="text-text-3 hover:text-text-1"
						>
							<Pencil className="w-3.5 h-3.5" />
						</button>
					</Tooltip>
					<Tooltip content="Revoke">
						<button
							type="button"
							onClick={() => {
								if (
									confirm(
										`Revoke instance credential "${r.name}"? Every team that references the placeholder will get an unknown_secret 400 from the proxy on the next outbound call.`,
									)
								) {
									deleteSecret.mutate(r.id);
								}
							}}
							aria-label={`Revoke ${r.name}`}
							className="text-text-3 hover:text-danger"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</Tooltip>
				</span>
			),
		},
	];

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Instance credentials are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">Credentials</h1>
							<InfoTooltip
								label="About credentials"
								content="Secrets shared with every team's egress. Agents reference them by placeholder; a team-scoped secret with the same name overrides this."
								data-testid="credentials-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							Secrets shared with every team's egress. Agents reference them by placeholder (
							<span className="font-mono">__HEZO_SECRET_NAME__</span>); the egress proxy substitutes
							the real value at request time, bounded by the allowed-hosts policy. A team-scoped
							secret with the same name overrides the instance one for that team.
						</p>
					</div>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => (showForm ? resetForm() : openCreate())}
					>
						<Plus className="w-3 h-3" /> Add
					</Button>
				</div>

				{showForm && (
					<InPlaceForm
						title={editing ? 'Edit credential' : 'Add credential'}
						onClose={resetForm}
						onSubmit={handleSubmit}
					>
						<div className="flex flex-col sm:flex-row gap-2">
							<Input
								placeholder="Name (e.g. SHARED_API_KEY)"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								disabled={!!editing}
								className="flex-1"
							/>
							<Input
								placeholder={editing ? 'New value (leave blank to keep)' : 'Value'}
								type="password"
								value={value}
								onChange={(e) => setValue(e.target.value)}
								required={!editing}
								className="flex-1"
							/>
						</div>
						<Input
							placeholder="Allowed hosts (comma- or space-separated, e.g. api.stripe.com, *.stripe.com)"
							value={allowedHosts}
							onChange={(e) => setAllowedHosts(e.target.value)}
							disabled={allowAllHosts}
						/>
						<label className="flex items-center gap-2 text-[13px] text-text-2">
							<input
								type="checkbox"
								checked={allowAllHosts}
								onChange={(e) => setAllowAllHosts(e.target.checked)}
							/>
							Allow this credential to reach any host (escape hatch — use sparingly)
						</label>
						<label className="flex items-start gap-2 text-[13px] text-text-2">
							<input
								type="checkbox"
								checked={allowBodySubstitution}
								onChange={(e) => setAllowBodySubstitution(e.target.checked)}
								className="mt-0.5"
								data-testid="credential-body-substitution"
							/>
							<span>
								Allow substitution into small JSON request bodies (e.g. an API login that takes the
								credential in the body). Off by default — enable only for APIs that require it.
							</span>
						</label>
						{error && <p className="text-[13px] text-danger">{error}</p>}
						<div className="flex gap-2">
							<Button
								type="submit"
								size="sm"
								disabled={createSecret.isPending || updateSecret.isPending}
							>
								{editing ? 'Save changes' : 'Add credential'}
							</Button>
							<Button type="button" variant="secondary" size="sm" onClick={resetForm}>
								Cancel
							</Button>
						</div>
					</InPlaceForm>
				)}

				{!rows.length ? (
					<p className="text-[13px] text-text-2">
						No instance credentials yet. Add one above to share it across every team.
					</p>
				) : (
					<DataTable columns={columns} data={rows} rowKey={(row) => row.id} />
				)}
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

export const Route = createFileRoute('/settings/credentials')({
	component: InstanceCredentialsPage,
});
