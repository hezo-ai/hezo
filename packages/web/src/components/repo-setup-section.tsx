import { AlertTriangle, GitBranch, Github, Loader2, Lock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useConnectionScopeStatus, useOAuthConnections } from '../hooks/use-oauth-connections';
import { useDeleteRepo, useRepos } from '../hooks/use-repos';
import { GitHubDeviceFlowDialog } from './github-device-flow-dialog';
import { RepoPickerModal } from './repo-picker-modal';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface RepoSetupSectionProps {
	teamId: string;
	projectId: string;
}

export function RepoSetupSection({ teamId, projectId }: RepoSetupSectionProps) {
	const { data: connections = [], isLoading: connectionsLoading } = useOAuthConnections(teamId);
	const { data: repos } = useRepos(teamId, projectId);
	const deleteRepo = useDeleteRepo(teamId, projectId);

	const githubConnections = connections.filter((c) => c.provider === 'github');
	const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
	const activeConnection =
		githubConnections.find((c) => c.id === selectedConnectionId) ?? githubConnections[0] ?? null;

	const scopeStatusQuery = useConnectionScopeStatus(teamId, activeConnection?.id);

	const [oauthDialogOpen, setOauthDialogOpen] = useState(false);
	const [reauthScopes, setReauthScopes] = useState<string[] | undefined>(undefined);
	const [pickerOpen, setPickerOpen] = useState(false);

	const isReady = !!activeConnection && scopeStatusQuery.data?.sufficient === true;
	const needsReauth =
		!!activeConnection && scopeStatusQuery.data && scopeStatusQuery.data.sufficient === false;
	const hasConnection = !!activeConnection;

	const hasRepos = !!repos && repos.length > 0;

	return (
		<section data-testid="repo-setup-section">
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
					<GitBranch className="w-4 h-4" /> Repositories
				</h2>
				{isReady && hasRepos && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setPickerOpen(true)}
						data-testid="repo-setup-add"
					>
						Set up repo
					</Button>
				)}
			</div>
			<p className="text-xs text-text-subtle mb-3">
				The designated repository is where primary source code and per-project{' '}
				<code>AGENTS.md</code> live. It is set on the first repo you link and cannot be changed
				later. Repos clone over HTTPS using a GitHub OAuth connection.
			</p>

			{githubConnections.length > 1 && (
				<label className="block mb-3 text-xs text-text-muted">
					GitHub account
					<select
						className="mt-1 block w-full rounded border border-border bg-bg px-2 py-1 text-sm"
						value={activeConnection?.id ?? ''}
						onChange={(e) => setSelectedConnectionId(e.target.value)}
						data-testid="repo-setup-connection"
					>
						{githubConnections.map((c) => (
							<option key={c.id} value={c.id}>
								{c.provider_account_label}
							</option>
						))}
					</select>
				</label>
			)}

			{connectionsLoading ? (
				<div className="flex items-center gap-2 text-sm text-text-muted">
					<Loader2 className="size-4 animate-spin" /> Loading…
				</div>
			) : !hasConnection ? (
				<div
					className="rounded-radius-md border border-border bg-bg-subtle p-4 flex items-start gap-3"
					data-testid="repo-setup-state-a"
				>
					<Github className="size-5 text-text-muted shrink-0 mt-0.5" />
					<div className="flex-1 space-y-2">
						<div>
							<p className="text-sm font-medium">Connect GitHub</p>
							<p className="text-xs text-text-subtle">
								Agents need a connected GitHub account to clone, push, and create repositories on
								your behalf.
							</p>
						</div>
						<Button
							size="sm"
							onClick={() => {
								setReauthScopes(undefined);
								setOauthDialogOpen(true);
							}}
							data-testid="repo-setup-connect-github"
						>
							<Github className="size-4 mr-2" />
							Connect GitHub
						</Button>
					</div>
				</div>
			) : needsReauth ? (
				<div
					className="rounded-radius-md border border-accent-yellow/40 bg-accent-yellow/10 p-4 flex items-start gap-3"
					data-testid="repo-setup-state-b"
				>
					<AlertTriangle className="size-5 text-accent-yellow shrink-0 mt-0.5" />
					<div className="flex-1 space-y-2">
						<div>
							<p className="text-sm font-medium">Permissions needed</p>
							<p className="text-xs text-text-subtle">
								Re-authorize <strong>{activeConnection.provider_account_label}</strong> to set up a
								GitHub repository. Missing scopes:{' '}
								<code className="text-text-muted">{scopeStatusQuery.data?.missing.join(', ')}</code>
								.
							</p>
						</div>
						<Button
							size="sm"
							onClick={() => {
								const required = scopeStatusQuery.data?.required ?? [];
								const union = Array.from(new Set([...activeConnection.scopes, ...required]));
								setReauthScopes(union);
								setOauthDialogOpen(true);
							}}
							data-testid="repo-setup-reauth"
						>
							Re-authorize
						</Button>
					</div>
				</div>
			) : null}

			<GitHubDeviceFlowDialog
				open={oauthDialogOpen}
				onOpenChange={setOauthDialogOpen}
				teamId={teamId}
				scopes={reauthScopes}
			/>

			{isReady && activeConnection && (
				<RepoPickerModal
					open={pickerOpen}
					onOpenChange={setPickerOpen}
					teamId={teamId}
					projectId={projectId}
					oauthConnectionId={activeConnection.id}
				/>
			)}

			<div className="mt-4">
				{hasRepos ? (
					<div className="flex flex-col gap-2">
						{repos?.map((r) => (
							<div
								key={r.id}
								className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
							>
								<div className="flex items-center gap-2">
									<Badge color="gray">{r.host_type}</Badge>
									<span className="font-medium">{r.short_name}</span>
									<span className="text-text-muted">{r.repo_identifier}</span>
									{r.is_designated && <Badge color="blue">Designated</Badge>}
								</div>
								{r.is_designated ? (
									<span
										className="text-text-subtle"
										title="Designated repository cannot be removed"
										data-testid={`repo-locked-${r.short_name}`}
									>
										<Lock className="w-3.5 h-3.5" />
									</span>
								) : (
									<button
										type="button"
										onClick={() => deleteRepo.mutate(r.id)}
										className="text-text-subtle hover:text-accent-red"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								)}
							</div>
						))}
					</div>
				) : (
					isReady && (
						<div
							className="rounded-radius-md border border-border bg-bg-subtle p-4 flex items-start gap-3"
							data-testid="repo-setup-state-c-empty"
						>
							<GitBranch className="size-5 text-text-muted shrink-0 mt-0.5" />
							<div className="flex-1 space-y-2">
								<div>
									<p className="text-sm font-medium">No repositories yet</p>
									<p className="text-xs text-text-subtle">
										Link an existing GitHub repository to this project, or create a new one in one
										of your orgs.
									</p>
								</div>
								<Button size="sm" onClick={() => setPickerOpen(true)} data-testid="repo-setup-add">
									<GitBranch className="size-4 mr-2" />
									Set up repo
								</Button>
							</div>
						</div>
					)
				)}
			</div>
		</section>
	);
}
