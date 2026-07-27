import { type McpMethodInfo, summarizeMethodAccess } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, ChevronRight, Eye, Search, SquarePen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type ConnectorMethods, useUpdateConnectorMethods } from '../hooks/use-connectors';
import { toast } from '../hooks/use-toast';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';
import { Input } from './ui/input';

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	connectorId: string;
	connectorLabel: string;
	data: ConnectorMethods;
}

type Category = 'read' | 'write';

/**
 * Pick which of an MCP server's methods agents may call.
 *
 * The dialog edits a draft `Set` and only writes on Save, so an operator can
 * toggle freely — including through the intermediate states of "turn the whole
 * category off, then keep two back" — without each click hitting the server.
 *
 * The two categories start collapsed. A server can advertise fifty methods, and
 * the decision an operator usually wants ("give them reads, withhold writes")
 * is answerable from the category headers alone.
 */
export function ConnectorMethodsDialog({
	open,
	onOpenChange,
	projectId,
	connectorId,
	connectorLabel,
	data,
}: Props) {
	const update = useUpdateConnectorMethods(projectId);
	const [draft, setDraft] = useState<Set<string>>(
		() => new Set(data.enabled_methods ?? data.methods.map((m) => m.name)),
	);
	const [expanded, setExpanded] = useState<Record<Category, boolean>>({
		read: false,
		write: false,
	});
	const [search, setSearch] = useState('');

	const readOnly = useMemo(() => data.methods.filter((m) => m.readOnly), [data.methods]);
	const write = useMemo(() => data.methods.filter((m) => !m.readOnly), [data.methods]);

	const matches = (m: McpMethodInfo) => {
		const q = search.trim().toLowerCase();
		if (!q) return true;
		return m.name.toLowerCase().includes(q) || (m.description ?? '').toLowerCase().includes(q);
	};

	const draftSummary = summarizeMethodAccess(data.methods, [...draft]);

	function toggleMethod(name: string) {
		setDraft((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	function toggleCategory(methods: McpMethodInfo[], allOn: boolean) {
		setDraft((prev) => {
			const next = new Set(prev);
			for (const m of methods) {
				if (allOn) next.delete(m.name);
				else next.add(m.name);
			}
			return next;
		});
	}

	async function save(enabled: string[] | null) {
		try {
			await update.mutateAsync({ connectorId, enabledMethods: enabled });
			onOpenChange(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the enabled methods');
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="lg" data-testid="connector-methods-dialog">
				<Dialog.Title className="text-[15px] font-semibold pr-8">
					Enabled methods · {connectorLabel}
				</Dialog.Title>
				<Dialog.Description className="text-[13px] text-text-2 mt-1.5">
					Only enabled methods reach agents in this project. Disabled ones are stripped from the
					tool list before the run starts.
				</Dialog.Description>

				<div className="flex items-center gap-2 mt-4">
					<div className="relative flex-1 min-w-0">
						<Search className="w-3.5 h-3.5 text-text-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
						<Input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search methods"
							className="pl-8"
							data-testid="connector-methods-search"
						/>
					</div>
					<span
						className="text-[11.5px] text-text-2 tabular-nums whitespace-nowrap"
						data-testid="connector-methods-count"
					>
						{draftSummary.enabled} of {draftSummary.total} enabled
					</span>
				</div>

				<div className="mt-3 flex flex-col gap-2 overflow-y-auto">
					<MethodCategory
						category="read"
						label="Read-only"
						methods={readOnly}
						draft={draft}
						expanded={expanded.read}
						onToggleExpanded={() => setExpanded((e) => ({ ...e, read: !e.read }))}
						onToggleCategory={toggleCategory}
						onToggleMethod={toggleMethod}
						matches={matches}
					/>
					<MethodCategory
						category="write"
						label="Write"
						methods={write}
						draft={draft}
						expanded={expanded.write}
						onToggleExpanded={() => setExpanded((e) => ({ ...e, write: !e.write }))}
						onToggleCategory={toggleCategory}
						onToggleMethod={toggleMethod}
						matches={matches}
					/>
				</div>

				<div className="flex items-center gap-2 mt-4">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => save(null)}
						disabled={update.isPending}
						data-testid="connector-methods-reset"
					>
						Reset to all
					</Button>
					<div className="ml-auto flex items-center gap-2">
						<Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={() => save([...draft])}
							disabled={update.isPending}
							data-testid="connector-methods-save"
						>
							{update.isPending ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

interface CategoryProps {
	category: Category;
	label: string;
	methods: McpMethodInfo[];
	draft: Set<string>;
	expanded: boolean;
	onToggleExpanded: () => void;
	onToggleCategory: (methods: McpMethodInfo[], allOn: boolean) => void;
	onToggleMethod: (name: string) => void;
	matches: (m: McpMethodInfo) => boolean;
}

function MethodCategory({
	category,
	label,
	methods,
	draft,
	expanded,
	onToggleExpanded,
	onToggleCategory,
	onToggleMethod,
	matches,
}: CategoryProps) {
	const enabledCount = methods.filter((m) => draft.has(m.name)).length;
	const allOn = methods.length > 0 && enabledCount === methods.length;
	const someOn = enabledCount > 0 && !allOn;
	const visible = methods.filter(matches);
	const Icon = category === 'read' ? Eye : SquarePen;
	const Chevron = expanded ? ChevronDown : ChevronRight;

	if (methods.length === 0) return null;

	return (
		<div
			className="rounded-md border border-border overflow-hidden"
			data-testid={`connector-methods-category-${category}`}
			data-enabled-count={enabledCount}
		>
			<div className="flex items-center gap-2 bg-surface-2 px-2.5 py-2">
				<button
					type="button"
					onClick={onToggleExpanded}
					className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
					aria-expanded={expanded}
					data-testid={`connector-methods-toggle-${category}`}
				>
					<Chevron className="w-3.5 h-3.5 text-text-3 shrink-0" />
					<Icon
						className={`w-3.5 h-3.5 shrink-0 ${category === 'read' ? 'text-info' : 'text-warning'}`}
					/>
					<span className="text-[13px] font-medium">{label}</span>
				</button>
				{/* Category checkbox sits outside the expand button so toggling the
				    whole category never also expands it. */}
				<span className="text-[11.5px] text-text-2 tabular-nums whitespace-nowrap">
					{enabledCount} of {methods.length}
				</span>
				<input
					type="checkbox"
					checked={allOn}
					ref={(el) => {
						// Indeterminate is a DOM property, not an attribute — it can only
						// be set imperatively.
						if (el) el.indeterminate = someOn;
					}}
					onChange={() => onToggleCategory(methods, allOn)}
					aria-label={`Enable all ${label} methods`}
					className="w-4 h-4 shrink-0 cursor-pointer accent-info"
					data-testid={`connector-methods-category-checkbox-${category}`}
				/>
			</div>

			{expanded && (
				<div className="max-h-56 overflow-y-auto">
					{visible.length === 0 ? (
						<p className="px-2.5 py-3 text-[12px] text-text-3">No methods match that search.</p>
					) : (
						visible.map((m) => (
							<label
								key={m.name}
								className="flex items-start gap-2.5 px-2.5 py-1.5 border-t border-border cursor-pointer hover:bg-surface-2"
								data-testid={`connector-method-${m.name}`}
							>
								<input
									type="checkbox"
									checked={draft.has(m.name)}
									onChange={() => onToggleMethod(m.name)}
									className="w-4 h-4 mt-0.5 shrink-0 cursor-pointer accent-info"
								/>
								<span className="min-w-0 flex flex-col">
									<span className="flex items-center gap-1.5">
										<span
											className={`font-mono text-[12px] ${draft.has(m.name) ? 'text-text-1' : 'text-text-3'}`}
										>
											{m.name}
										</span>
										{m.inferred && (
											// The server declared no readOnlyHint, so this row's
											// category is Hezo's guess. Say so, rather than let an
											// operator take it for a declaration.
											<span
												className="text-[10px] uppercase tracking-wide text-text-3"
												title="Category inferred from the method name — this server declares no read-only hint"
											>
												inferred
											</span>
										)}
									</span>
									{m.description && (
										<span className="text-[11.5px] text-text-3 truncate">{m.description}</span>
									)}
								</span>
							</label>
						))
					)}
				</div>
			)}
		</div>
	);
}
