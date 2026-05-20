import { createFileRoute } from '@tanstack/react-router';
import { Github, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { GitHubDeviceFlowDialog } from '../../../../components/github-device-flow-dialog';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import {
	type OAuthConnection,
	useDeleteOAuthConnection,
	useOAuthConnections,
} from '../../../../hooks/use-oauth-connections';

export const Route = createFileRoute('/companies/$companyId/settings/connections')({
	component: ConnectionsPage,
});

function ConnectionsPage() {
	const { companyId } = Route.useParams();
	const { data: connections = [] } = useOAuthConnections(companyId);
	const deleteConn = useDeleteOAuthConnection(companyId);
	const [githubDialogOpen, setGithubDialogOpen] = useState(false);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-xl font-semibold">Connections</h2>
					<p className="text-sm text-text-subtle">
						OAuth tokens for GitHub repos and SaaS MCP servers. Tokens never leave the backend;
						agents substitute placeholders at request time.
					</p>
				</div>
				<Button onClick={() => setGithubDialogOpen(true)}>
					<Github className="size-4 mr-2" />
					Connect GitHub
				</Button>
			</div>

			<GitHubDeviceFlowDialog
				open={githubDialogOpen}
				onOpenChange={setGithubDialogOpen}
				companyId={companyId}
			/>

			<div className="rounded-md border border-border-default overflow-hidden">
				<table className="w-full text-sm">
					<thead className="bg-bg-subtle text-left">
						<tr>
							<th className="px-3 py-2 font-medium">Provider</th>
							<th className="px-3 py-2 font-medium">Account</th>
							<th className="px-3 py-2 font-medium hidden sm:table-cell">Scopes</th>
							<th className="px-3 py-2 font-medium hidden md:table-cell">Connected</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody>
						{connections.length === 0 && (
							<tr>
								<td className="px-3 py-6 text-center text-text-subtle" colSpan={5}>
									No connections yet.
								</td>
							</tr>
						)}
						{connections.map((c: OAuthConnection) => (
							<tr key={c.id} className="border-t border-border-default">
								<td className="px-3 py-2 font-mono text-xs">
									<Badge color="neutral">{c.provider}</Badge>
								</td>
								<td className="px-3 py-2">{c.provider_account_label}</td>
								<td className="px-3 py-2 hidden sm:table-cell">
									<span className="text-xs font-mono text-text-muted">{c.scopes.join(' ')}</span>
								</td>
								<td className="px-3 py-2 hidden md:table-cell text-xs text-text-subtle">
									{new Date(c.created_at).toLocaleDateString()}
								</td>
								<td className="px-3 py-2 text-right">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											if (confirm(`Remove ${c.provider_account_label}?`)) {
												deleteConn.mutate(c.id);
											}
										}}
									>
										<Trash2 className="size-4" />
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
