import type { MarketplaceTeamDef } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, Loader2, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../hooks/use-toast';
import { ApiError, api } from '../lib/api';
import { downloadTextFile } from '../lib/download-file';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';

// Where a publisher sends their exported bundle. A new-issue link (not a raw repo
// URL) so the flow lands on the contribution surface with the file attached.
const HEZO_SUBMIT_URL = 'https://github.com/hezo-ai/hezo/issues/new';

/**
 * "Export team" control shown on the Team page beside "Hire agent". Opens a
 * dialog that explains what a team bundle is, then downloads the team's current
 * state as a self-contained marketplace bundle (`MarketplaceTeamDef` JSON) the
 * user can submit to the Hezo authors for inclusion in the marketplace. The JSON
 * is fetched from `GET /api/projects/:projectId/team-bundle` and written to a
 * file client-side (see {@link downloadTextFile}).
 */
export function ExportTeamButton({ projectId }: { projectId: string }) {
	const [open, setOpen] = useState(false);
	const [exporting, setExporting] = useState(false);

	async function handleExport() {
		setExporting(true);
		try {
			const bundle = await api.get<MarketplaceTeamDef>(`/api/projects/${projectId}/team-bundle`);
			const filename = `${bundle.slug || 'team'}-team-bundle.json`;
			// Tab-indented to match the committed marketplace/teams/*.json style, with
			// a trailing newline so the file is diff-clean if committed as-is.
			downloadTextFile(filename, `${JSON.stringify(bundle, null, '\t')}\n`, 'application/json');
			setOpen(false);
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'Failed to export the team bundle');
		} finally {
			setExporting(false);
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger asChild>
				<Button variant="secondary" data-testid="export-team-button">
					<Upload className="w-4 h-4" /> Export team
				</Button>
			</Dialog.Trigger>
			<DialogContent size="lg" data-testid="export-team-dialog">
				<Dialog.Title className="text-base font-semibold mb-2">
					Export team as a bundle
				</Dialog.Title>
				<Dialog.Description className="text-[13px] text-text-2 mb-4 leading-relaxed">
					This packages your team's current state into a single JSON file - a team bundle - and
					downloads it to your device. It's the same self-contained format the team marketplace
					ships.
				</Dialog.Description>

				<div className="rounded-md border border-border-subtle bg-surface-2 p-3 mb-4">
					<p className="text-[12px] uppercase tracking-wide text-text-3 font-medium mb-2">
						What's included
					</p>
					<ul className="text-[13px] text-text-2 space-y-1 list-disc pl-4">
						<li>The team name, description, and summary</li>
						<li>Every role - the Captain and each teammate - with its reporting line</li>
						<li>Each role's system prompt, effort, budgets, and settings</li>
					</ul>
					<p className="text-[12px] text-text-3 mt-2 leading-relaxed">
						Skills, connections, secrets, and project data are not included - those are configured
						per project, not carried by a team.
					</p>
				</div>

				<p className="text-[13px] text-text-2 mb-5 leading-relaxed">
					To get your team added to the marketplace, send the downloaded file to the Hezo authors on{' '}
					<a
						href={HEZO_SUBMIT_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="text-accent hover:underline"
					>
						GitHub
					</a>
					.
				</p>

				<div className="flex justify-end gap-2">
					<Dialog.Close asChild>
						<Button variant="ghost" disabled={exporting}>
							Cancel
						</Button>
					</Dialog.Close>
					<Button onClick={handleExport} disabled={exporting} data-testid="export-team-confirm">
						{exporting ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<Download className="w-4 h-4" />
						)}
						Export & download
					</Button>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
