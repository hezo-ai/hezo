import { summarizeMethodAccess } from '@hezo/shared';
import { ChevronDown, ChevronRight, KeyRound, RefreshCw, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { type Connector, type ConnectorStatus, useConnectorMethods } from '../hooks/use-connectors';
import { toast } from '../hooks/use-toast';
import { apiKeyGuideFor, ConnectorApiKeyForm } from './connector-api-key-form';
import { ConnectorMethodsDialog } from './connector-methods-dialog';
import { RelatedItemsList } from './related-items-list';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { RelativeTime } from './ui/relative-time';

interface Props {
	connector: Connector;
	projectId: string;
	status: ConnectorStatus;
	/** Global ("all projects") connectors are read-only from a project page. */
	isGlobal: boolean;
	/** Only a superuser can open the credentials page, so only they get a link. */
	isSuperuser: boolean;
	/** Start with the API-key form open — a static-key connector leads with it. */
	initialApiKeyOpen?: boolean;
}

/**
 * The connector card's configuration, behind one disclosure.
 *
 * Credentials and method access are both things an operator sets once and then
 * ignores, so keeping them expanded made every card noisy. Collapsed, the row
 * summarises what is configured; opened, it holds the credential list, the
 * API-key form, and the method allowlist.
 */
export function ConnectorSettingsSection({
	connector,
	projectId,
	status,
	isGlobal,
	isSuperuser,
	initialApiKeyOpen = false,
}: Props) {
	const [open, setOpen] = useState(false);
	const [showApiKey, setShowApiKey] = useState(initialApiKeyOpen);
	const [methodsOpen, setMethodsOpen] = useState(false);

	// A `degraded` connector has completed the handshake at least once, so its
	// cached method catalog is real and the allowlist stays editable — telling
	// the operator to "connect this server to list its methods" would be both
	// wrong and a step backwards from what they already configured. The API-key
	// form below is deliberately NOT gated on this: swapping to a pasted key is a
	// legitimate way to recover a connector whose OAuth grant has died.
	const hasConnected = status === 'active' || status === 'degraded';

	// Only fetch the method catalog once the section is actually opened — a
	// connectors page can hold dozens of cards and none of them need it closed.
	const methodsQuery = useConnectorMethods(projectId, connector.id, open);

	const credentials = connector.credentials ?? [];
	const summary = summarizeMethodAccess(
		methodsQuery.data?.methods ?? connector.discovered_methods ?? [],
		methodsQuery.data?.enabled_methods ?? connector.enabled_methods ?? null,
	);
	const Chevron = open ? ChevronDown : ChevronRight;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex items-center gap-1.5 w-full mt-3.5 pt-3 border-t border-border text-left cursor-pointer"
				data-testid="connector-settings-toggle"
			>
				<Chevron className="w-3.5 h-3.5 text-text-3 shrink-0" />
				<span className="text-[13px] font-medium text-text-1">Settings</span>
				{!open && (
					<span className="ml-auto text-xs text-text-3" data-testid="connector-settings-summary">
						{settingsSummary(credentials.length, summary)}
					</span>
				)}
			</button>

			{open && (
				// Indented with a hairline rail so the rows read as contents of the
				// section rather than siblings of the card.
				<div
					className="mt-2.5 ml-1.5 pl-3.5 border-l border-border flex flex-col"
					data-testid="connector-settings-body"
				>
					<SettingRow label="Credentials">
						{credentials.length > 0 ? (
							<RelatedItemsList
								testId={`connector-credentials-${connector.id}`}
								items={credentials.map((cred) => ({
									key: cred.id,
									label: cred.name,
									href: isSuperuser
										? `/settings/credentials?focus=${cred.id}#${cred.id}`
										: undefined,
									testId: `connector-credential-link-${cred.id}`,
								}))}
							/>
						) : (
							<span className="text-xs text-text-3">None yet</span>
						)}
						{!isGlobal && status !== 'active' && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setShowApiKey((v) => !v)}
								data-testid="connector-api-key-toggle"
							>
								<KeyRound className="size-3.5 mr-1" />
								API key
							</Button>
						)}
					</SettingRow>

					{!isGlobal && status !== 'active' && showApiKey && (
						<div className="pb-3">
							<ConnectorApiKeyForm
								projectId={projectId}
								connectorId={connector.id}
								guide={apiKeyGuideFor(connector.config)}
								onSuccess={() => setShowApiKey(false)}
								onCancel={() => setShowApiKey(false)}
							/>
						</div>
					)}

					<SettingRow label="Enabled methods">
						{connector.kind !== 'saas' ? (
							<span className="text-xs text-text-3">
								Method access applies to hosted MCP servers only.
							</span>
						) : !hasConnected ? (
							<>
								<Badge color="neutral">All</Badge>
								<span className="text-xs text-text-3">
									Connect this server to list its methods.
								</span>
							</>
						) : (
							<>
								<Badge color={summary.mode === 'all' ? 'neutral' : 'info'}>
									{summary.mode === 'all'
										? summary.total > 0
											? `All ${summary.total}`
											: 'All'
										: `${summary.enabled} of ${summary.total}`}
								</Badge>
								{summary.mode === 'restricted' && (
									<span className="text-[11.5px] text-text-2 tabular-nums">
										{summary.readOnlyEnabled} read-only · {summary.writeEnabled} write
									</span>
								)}
								{summary.total > 0 && !isGlobal && (
									<button
										type="button"
										onClick={() => setMethodsOpen(true)}
										aria-label="Edit enabled methods"
										className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border text-text-2 hover:text-text-1 cursor-pointer"
										data-testid="connector-methods-edit"
									>
										<SquarePen className="w-3 h-3" />
									</button>
								)}
							</>
						)}
						<MethodsHint
							kind={connector.kind}
							active={hasConnected}
							total={summary.total}
							writeDisabled={summary.writeDisabled}
							listedAt={methodsQuery.data?.methods_listed_at ?? connector.methods_listed_at ?? null}
							setByAgent={
								(methodsQuery.data?.requested_access ?? connector.requested_access) === 'read' &&
								summary.mode === 'restricted'
							}
						/>
					</SettingRow>
				</div>
			)}

			{methodsOpen && methodsQuery.data && (
				<ConnectorMethodsDialog
					open={methodsOpen}
					onOpenChange={setMethodsOpen}
					scope={projectId}
					connectorId={connector.id}
					connectorLabel={connector.display_name ?? connector.name}
					data={methodsQuery.data}
				/>
			)}
		</>
	);
}

/** One label/value row inside the section. Stacks under 640px. */
function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5 py-2.5 border-t border-dashed border-border first:border-t-0 first:pt-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
			<span className="text-[12.5px] text-text-2 sm:w-[124px] sm:shrink-0">{label}</span>
			<span className="flex flex-wrap items-center gap-2 min-w-0 sm:flex-1">{children}</span>
		</div>
	);
}

function MethodsHint({
	kind,
	active,
	total,
	writeDisabled,
	listedAt,
	setByAgent,
}: {
	kind: Connector['kind'];
	active: boolean;
	total: number;
	writeDisabled: number;
	listedAt: string | null;
	setByAgent: boolean;
}) {
	if (kind !== 'saas' || !active) return null;
	return (
		<span className="basis-full text-[11.5px] text-text-3 sm:pl-[136px]">
			{total === 0 ? (
				"This server's methods haven't been listed yet."
			) : (
				<>
					{writeDisabled > 0
						? `${writeDisabled} write ${writeDisabled === 1 ? 'method is' : 'methods are'} withheld. Agents never see them.`
						: 'Every method this server advertises is available to agents in this project.'}
					{setByAgent && ' Set from the requesting agent’s read-only request.'}
					{listedAt && (
						<>
							{' '}
							Last checked <RelativeTime iso={listedAt} />.
						</>
					)}
				</>
			)}
		</span>
	);
}

/** The closed row's one-line recap of what is configured. */
function settingsSummary(
	credentialCount: number,
	summary: ReturnType<typeof summarizeMethodAccess>,
): string {
	const parts: string[] = [];
	if (credentialCount > 0) {
		parts.push(`${credentialCount} credential${credentialCount === 1 ? '' : 's'}`);
	}
	parts.push(
		summary.mode === 'all' ? 'all methods' : `${summary.enabled} of ${summary.total} methods`,
	);
	return parts.join(' · ');
}
