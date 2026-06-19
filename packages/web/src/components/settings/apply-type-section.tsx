import { useState } from 'react';
import { useMe } from '../../hooks/use-me';
import { useTeamTemplates } from '../../hooks/use-team-templates';
import { useApplyTeamType } from '../../hooks/use-teams';
import { Button } from '../ui/button';

/**
 * Superuser-only: merge a team type into this team ("Refresh from type"). Adds
 * any missing roster roles and refreshes built-in prompts; never removes the
 * agents or customizations you've added. To copy another team's setup, save it
 * as a type first, then apply it here.
 */
export function ApplyTypeSection({ projectId }: { projectId: string }) {
	const { data: me } = useMe();
	const { data: templates } = useTeamTemplates();
	const [templateId, setTemplateId] = useState('');
	const [result, setResult] = useState<string | null>(null);
	const apply = useApplyTeamType(projectId);

	if (!me?.is_superuser) return null;

	async function handleApply() {
		if (!templateId) return;
		const r = await apply.mutateAsync({ template_id: templateId });
		const added = [...r.created_slugs, ...r.builtin_inserted_slugs];
		setResult(
			added.length > 0
				? `Added ${added.length} role${added.length === 1 ? '' : 's'}: ${added.join(', ')}.`
				: 'Already up to date — nothing to add.',
		);
	}

	return (
		<section data-testid="apply-type-section">
			<h2 className="text-[15px] font-medium mb-1">Refresh from a type</h2>
			<p className="text-[13px] text-text-2 mb-3">
				Merge a team type into this team — adds any missing roles and refreshes built-in prompts.
				Never removes agents or customizations you've added. To copy another team's setup, save it
				as a type first, then apply it here.
			</p>
			<div className="flex flex-wrap items-end gap-2 max-w-md">
				<label className="flex flex-col gap-1 text-[12px] font-medium text-text-1">
					Team type
					<select
						value={templateId}
						onChange={(e) => setTemplateId(e.target.value)}
						data-testid="apply-type-select"
						className="border border-border rounded-md px-3 py-2 text-[13px] bg-surface text-text-1 min-w-[200px]"
					>
						<option value="">Choose a type…</option>
						{(templates ?? []).map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))}
					</select>
				</label>
				<Button
					type="button"
					onClick={handleApply}
					disabled={!templateId || apply.isPending}
					data-testid="apply-type-submit"
				>
					Apply
				</Button>
			</div>
			{apply.error && (
				<p className="text-[13px] text-danger mt-2">
					{(apply.error as { message?: string }).message || 'Failed to apply type'}
				</p>
			)}
			{result && (
				<p className="text-[13px] text-text-2 mt-2" data-testid="apply-type-result">
					{result}
				</p>
			)}
		</section>
	);
}
