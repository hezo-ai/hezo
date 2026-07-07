import { DOCUMENT_STATUS_LABELS, type DocumentStatus } from '@hezo/shared';
import { Archive } from 'lucide-react';
import type { ReactNode } from 'react';
import { documentStatusMeta } from '../../lib/status-meta';
import { ActorBadge } from '../ui/actor-badge';
import { getInitials } from '../ui/avatar';
import { Badge } from '../ui/badge';

export interface DocMetadata {
	createdAt?: string;
	updatedAt?: string;
	editorName?: string | null;
	editorType?: string;
	/** Lifecycle status: 'planning' | 'approved'. */
	status?: string;
	/** When set, the status renders as an editable dropdown instead of a static badge. */
	onStatusChange?: (status: DocumentStatus) => void;
	/** Soft-delete stamp — null/absent = active. When set, the banner flags the doc as archived. */
	archivedAt?: string | null;
	/** Resolved name of whoever archived it (single-doc responses only). */
	archivedByName?: string | null;
}

function shortDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fullDateTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

const K = 'text-[9.5px] font-semibold uppercase tracking-wide text-text-3';

/**
 * The compact document-details banner at the top of a project doc — structured,
 * reliable facts only (created/updated timestamps + who last edited it), which
 * replaces the old run-on metadata paragraph. Update logs live in the revision
 * history, not here. Renders nothing when it has no data to show.
 */
export function DocumentMetadataBanner({
	createdAt,
	updatedAt,
	editorName,
	editorType,
	status,
	onStatusChange,
	archivedAt,
	archivedByName,
}: DocMetadata) {
	if (!createdAt && !updatedAt && !editorName && !status && !archivedAt) return null;
	const sep = <span className="text-border-strong">·</span>;
	const items: ReactNode[] = [];
	if (archivedAt) {
		items.push(
			<span
				key="archived"
				className="inline-flex items-center gap-1.5 tabular-nums text-warning-soft-fg"
			>
				<Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
				<span className="text-[9.5px] font-semibold uppercase tracking-wide">Archived</span>
				<span title={fullDateTime(archivedAt)}>{shortDate(archivedAt)}</span>
				{archivedByName && <span className="text-text-2">by {archivedByName}</span>}
			</span>,
		);
	}
	if (status) {
		items.push(
			<span key="status" className="inline-flex items-center gap-1.5">
				<span className={K}>Status</span>
				{onStatusChange ? (
					<select
						aria-label="Document status"
						value={status}
						onChange={(e) => onStatusChange(e.target.value as DocumentStatus)}
						className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text-1 outline-none"
					>
						{Object.entries(DOCUMENT_STATUS_LABELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				) : (
					<Badge color={documentStatusMeta(status).color}>{documentStatusMeta(status).label}</Badge>
				)}
			</span>,
		);
	}
	if (createdAt) {
		items.push(
			<span key="created" className="inline-flex items-center gap-1.5 tabular-nums">
				<span className={K}>Created</span>
				<span title={fullDateTime(createdAt)}>{shortDate(createdAt)}</span>
			</span>,
		);
	}
	if (updatedAt) {
		items.push(
			<span key="updated" className="inline-flex items-center gap-1.5 tabular-nums">
				<span className={K}>Updated</span>
				<span title={fullDateTime(updatedAt)}>{shortDate(updatedAt)}</span>
			</span>,
		);
	}
	if (editorName) {
		items.push(
			<span key="editor" className="inline-flex items-center gap-1.5">
				<span className={K}>Last edited by</span>
				<span className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full border border-border bg-surface-3 text-[7.5px] font-semibold text-text-2">
					{getInitials(editorName)}
				</span>
				<span className="text-text-1">{editorName}</span>
				<ActorBadge actorType={editorType} name={editorName} />
			</span>,
		);
	}

	return (
		<div
			data-testid="doc-metadata-banner"
			className="mb-5 rounded-md border border-border bg-surface-2 px-3 py-2"
		>
			<div className="flex flex-col gap-1.5 text-[11.5px] text-text-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1">
				{items.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static list, order fixed
					<span key={i} className="inline-flex items-center gap-3">
						{i > 0 && <span className="hidden sm:inline">{sep}</span>}
						{item}
					</span>
				))}
			</div>
		</div>
	);
}
