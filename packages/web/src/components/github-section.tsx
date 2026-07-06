import { repoNameFromIdentifier } from '@hezo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, GitBranch, Github, Loader2, Lock, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useMcpConnections } from '../hooks/use-mcp-connections';
import {
	useConnectionScopeStatus,
	useEnsureConnector,
	useOAuthConnections,
} from '../hooks/use-oauth-connections';
import { useCreateRepo, useDeleteRepo, useRepos } from '../hooks/use-repos';
import { repoWebUrl } from '../lib/github';
import { queryKeys } from '../lib/query-keys';
import { ConnectorDeviceFlowDialog } from './connector-device-flow-dialog';
import { RepoPickerModal } from './repo-picker-modal';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Tooltip } from './ui/tooltip';

interface GitHubSectionProps {
	projectId: string;
}

export function GitHubSection({ projectId }: GitHubSectionProps) {
	const { data: connections = [], isLoading: connectionsLoading } = useOAuthConnections(projectId);
	const { data: connectors = [] } = useMcpConnections(projectId);
	const { data: repos } = useRepos(projectId);
	const deleteRepo = useDeleteRepo(projectId);
	const retryRepo = useCreateRepo(projectId);
	const queryClient = useQueryClient();

	const githubConnection = connections.find((c) => c.provider === 'github') ?? null;
	const githubConnector = connectors.find((c) => c.name === 'github') ?? null;
	const scopeStatusQuery = useConnectionScopeStatus(projectId, githubConnection?.id);

	const ensure = useEnsureConnector(projectId);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [deviceConnectorId, setDeviceConnectorId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const isReady = !!githubConnection && scopeStatusQuery.data?.sufficient === true;
	const needsReauth =
		!!githubConnection && scopeStatusQuery.data && scopeStatusQuery.data.sufficient === false;
	const hasConnection = !!githubConnection;
	const hasRepos = !!repos && repos.length > 0;
	const connecting = ensure.isPending;

	const startConnect = async () => {
		setError(null);
		try {
			const connector = githubConnector ?? (await ensure.mutateAsync('github'));
			setDeviceConnectorId(connector.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to start GitHub OAuth');
		}
	};

	return (
		<section data-testid="github-section">
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-sm font-medium text-text-2 flex items-center gap-1.5">
					<Github className="w-4 h-4" /> GitHub
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
			<p className="text-xs text-text-3 mb-3">
				Connects this team to GitHub for both git operations (clone, push, signed commits) and the
				official GitHub MCP server (agent-callable tools for issues, PRs, search). One OAuth flow,
				both surfaces. Tokens stay in the Hezo vault; agents see them as substituted placeholders at
				egress.
			</p>

			{error && <p className="text-xs text-danger-soft-fg mb-2">{error}</p>}

			{connectionsLoading ? (
				<div className="flex items-center gap-2 text-sm text-text-2">
					<Loader2 className="size-4 animate-spin" /> Loading…
				</div>
			) : !hasConnection ? (
				<div
					className="rounded-md border border-border bg-surface-2 p-4 flex items-start gap-3"
					data-testid="github-state-disconnected"
				>
					<Github className="size-5 text-text-2 shrink-0 mt-0.5" />
					<div className="flex-1 space-y-2">
						<div>
							<p className="text-sm font-medium">Connect GitHub</p>
							<p className="text-xs text-text-3">
								Authorize Hezo to manage repos on your behalf and give agents first-class GitHub
								tools.
							</p>
						</div>
						<Button
							size="sm"
							onClick={startConnect}
							disabled={connecting}
							data-testid="github-connect"
						>
							<Github className="size-4 mr-2" />
							{connecting ? 'Starting…' : 'Connect GitHub'}
						</Button>
					</div>
				</div>
			) : needsReauth ? (
				<div
					className="rounded-md border border-accent-yellow/40 bg-accent-yellow/10 p-4 flex items-start gap-3"
					data-testid="github-state-reauth"
				>
					<AlertTriangle className="size-5 text-accent-yellow shrink-0 mt-0.5" />
					<div className="flex-1 space-y-2">
						<div>
							<p className="text-sm font-medium">Permissions needed</p>
							<p className="text-xs text-text-3">
								Re-authorize <strong>{githubConnection.provider_account_label}</strong> to set up a
								GitHub repository. Missing scopes:{' '}
								<code className="text-text-2">{scopeStatusQuery.data?.missing.join(', ')}</code>.
							</p>
						</div>
						<Button
							size="sm"
							onClick={startConnect}
							disabled={connecting}
							data-testid="github-reauth"
						>
							{connecting ? 'Starting…' : 'Re-authorize'}
						</Button>
					</div>
				</div>
			) : (
				<div className="text-xs text-text-3 mb-3">
					Connected as <span className="font-mono">{githubConnection.provider_account_label}</span>.
				</div>
			)}

			{deviceConnectorId && (
				<ConnectorDeviceFlowDialog
					open={!!deviceConnectorId}
					onOpenChange={(open) => {
						if (!open) setDeviceConnectorId(null);
					}}
					projectId={projectId}
					connectorId={deviceConnectorId}
					providerLabel="GitHub"
					onSuccess={() => {
						queryClient.invalidateQueries({
							queryKey: queryKeys.teams.oauthConnections(projectId),
						});
						queryClient.invalidateQueries({ queryKey: queryKeys.teams.mcpConnections(projectId) });
					}}
				/>
			)}

			{isReady && githubConnection && (
				<RepoPickerModal
					open={pickerOpen}
					onOpenChange={setPickerOpen}
					projectId={projectId}
					oauthConnectionId={githubConnection.id}
				/>
			)}

			<div className="mt-4">
				{hasRepos ? (
					<div className="flex flex-col gap-2">
						{repos?.map((r) => {
							const repoName = repoNameFromIdentifier(r.repo_identifier);
							return (
								<div
									key={r.id}
									className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm"
								>
									<div className="flex items-center justify-between">
										<div className="flex flex-wrap items-center gap-2">
											<Badge color="gray">{r.host_type}</Badge>
											<span className="font-medium">{repoName}</span>
											{(() => {
												const url = repoWebUrl(r.repo_identifier, r.host_type);
												return url ? (
													<a
														href={url}
														target="_blank"
														rel="noopener noreferrer"
														className="text-info-soft-fg hover:underline"
														data-testid={`repo-link-${repoName}`}
													>
														{r.repo_identifier}
													</a>
												) : (
													<span className="text-text-2">{r.repo_identifier}</span>
												);
											})()}
											{r.is_designated && <Badge color="blue">Designated</Badge>}
											{r.setup_status === 'pending' && (
												<span
													className="flex items-center gap-1 text-xs text-text-2"
													data-testid={`repo-setup-pending-${repoName}`}
												>
													<Loader2 className="size-3 animate-spin" /> Setting up…
												</span>
											)}
										</div>
										<div className="flex items-center gap-2">
											{r.setup_status === 'failed' && githubConnection && (
												<Button
													variant="secondary"
													size="sm"
													disabled={retryRepo.isPending}
													onClick={() =>
														retryRepo.mutate({
															mode: 'link',
															url: `https://github.com/${r.repo_identifier}`,
															oauth_connection_id: githubConnection.id,
														})
													}
													data-testid={`repo-setup-retry-${repoName}`}
												>
													<RotateCw className="size-3 mr-1" /> Retry
												</Button>
											)}
											{r.is_designated ? (
												<Tooltip content="Designated repository cannot be removed">
													<span
														role="img"
														aria-label="Designated repository cannot be removed"
														className="text-text-3"
														data-testid={`repo-locked-${repoName}`}
													>
														<Lock className="w-3.5 h-3.5" />
													</span>
												</Tooltip>
											) : (
												<button
													type="button"
													onClick={() => deleteRepo.mutate(r.id)}
													className="text-text-3 hover:text-danger"
													aria-label={`Remove repo ${repoName}`}
													data-testid={`repo-delete-${repoName}`}
												>
													<Trash2 className="w-3.5 h-3.5" />
												</button>
											)}
										</div>
									</div>
									{r.setup_status === 'failed' && (
										<p
											className="text-xs text-danger-soft-fg"
											data-testid={`repo-setup-failed-${repoName}`}
										>
											Setup failed{r.setup_error ? `: ${r.setup_error}` : ''}. Retry to run it
											again.
										</p>
									)}
								</div>
							);
						})}
					</div>
				) : (
					isReady && (
						<div
							className="rounded-md border border-border bg-surface-2 p-4 flex items-start gap-3"
							data-testid="github-state-ready"
						>
							<GitBranch className="size-5 text-text-2 shrink-0 mt-0.5" />
							<div className="flex-1 space-y-2">
								<div>
									<p className="text-sm font-medium">No repositories yet</p>
									<p className="text-xs text-text-3">
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
