import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '../../../components/ui/badge';
import { useAuditLog } from '../../../hooks/use-audit-log';

function AuditLogPage() {
	const { companyId } = Route.useParams();
	const { data: entries } = useAuditLog(companyId);

	return (
		<div>
			<div className="mb-4">
				<h2 className="text-base font-medium">Audit log</h2>
				<p className="text-[13px] text-text-muted mt-1">Recent actions across the company.</p>
			</div>
			{!entries?.length ? (
				<p className="text-[13px] text-text-muted">No audit entries yet.</p>
			) : (
				<table className="w-full border-collapse">
					<thead>
						<tr>
							<th className="text-left text-xs text-text-muted font-normal px-2 py-2 border-b border-border">
								Time
							</th>
							<th className="text-left text-xs text-text-muted font-normal px-2 py-2 border-b border-border">
								Actor
							</th>
							<th className="text-left text-xs text-text-muted font-normal px-2 py-2 border-b border-border">
								Action
							</th>
							<th className="text-left text-xs text-text-muted font-normal px-2 py-2 border-b border-border">
								Entity
							</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((e) => (
							<tr key={e.id} className="hover:bg-bg-subtle">
								<td className="px-2 py-1.5 text-xs text-text-subtle border-b border-border">
									{new Date(e.created_at).toLocaleString()}
								</td>
								<td className="px-2 py-1.5 text-xs border-b border-border">
									{e.actor_name || e.actor_type}
								</td>
								<td className="px-2 py-1.5 border-b border-border">
									<Badge color="neutral">{e.action}</Badge>
								</td>
								<td className="px-2 py-1.5 text-xs text-text-muted border-b border-border">
									{e.entity_type}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/audit-log')({
	component: AuditLogPage,
});
