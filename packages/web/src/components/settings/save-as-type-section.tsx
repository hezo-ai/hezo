import { useState } from 'react';
import { useMe } from '../../hooks/use-me';
import { useSaveTeamAsTemplate } from '../../hooks/use-teams';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

/**
 * Superuser-only: snapshot the current team into a new reusable team type
 * (template) that the New-team flow can start from.
 */
export function SaveAsTypeSection({ projectId }: { projectId: string }) {
	const { data: me } = useMe();
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [savedName, setSavedName] = useState<string | null>(null);
	const [skipped, setSkipped] = useState<string[]>([]);
	const save = useSaveTeamAsTemplate(projectId);

	if (!me?.is_superuser) return null;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		const result = await save.mutateAsync({
			name: name.trim(),
			description: description.trim() || undefined,
		});
		setSavedName(name.trim());
		setSkipped(result.skipped_agents);
		setName('');
		setDescription('');
	}

	return (
		<section data-testid="save-as-type-section">
			<h2 className="text-[15px] font-medium mb-1">Save as team type</h2>
			<p className="text-[13px] text-text-2 mb-3">
				Snapshot this team's current roster, prompts, skills, and preferences into a reusable team
				type. New teams can then be created from it.
			</p>
			<form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-md">
				<Input
					label="Type name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="e.g. Web Squad"
					required
				/>
				<Textarea
					label="Description (optional)"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					rows={2}
				/>
				<div>
					<Button
						type="submit"
						disabled={!name.trim() || save.isPending}
						data-testid="save-as-type-submit"
					>
						Save as type
					</Button>
				</div>
				{save.error && (
					<p className="text-[13px] text-danger">
						{(save.error as { message?: string }).message || 'Failed to save team as a type'}
					</p>
				)}
				{savedName && (
					<p className="text-[13px] text-text-2" data-testid="save-as-type-success">
						Saved “{savedName}” as a team type.
						{skipped.length > 0 &&
							` Skipped ${skipped.length} custom agent(s) without a catalog type: ${skipped.join(', ')}.`}
					</p>
				)}
			</form>
		</section>
	);
}
