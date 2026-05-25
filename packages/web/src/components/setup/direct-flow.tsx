import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useOnboardingDirect } from '../../hooks/use-onboarding-direct';
import { type TeamTemplate, useTeamTemplates } from '../../hooks/use-team-templates';
import { PrdUpload } from '../prd-upload';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

interface DirectFlowProps {
	teamId: string;
	onCancel: () => void;
	onDone: () => void;
}

export function DirectFlow({ teamId, onCancel, onDone }: DirectFlowProps) {
	const { data: templates, isLoading } = useTeamTemplates();
	const [selected, setSelected] = useState<TeamTemplate | null>(null);
	const [projectName, setProjectName] = useState('');
	const [projectDescription, setProjectDescription] = useState('');
	const [initialPrd, setInitialPrd] = useState('');
	const [prdFilename, setPrdFilename] = useState<string | null>(null);
	const directOnboarding = useOnboardingDirect(teamId);

	async function handleConfirm(e: React.FormEvent) {
		e.preventDefault();
		if (!selected) return;
		await directOnboarding.mutateAsync({
			template_id: selected.id,
			project_name: projectName.trim(),
			project_description: projectDescription.trim() || undefined,
			initial_prd: initialPrd.trim() || undefined,
		});
		onDone();
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12 text-text-muted">
				<Loader2 className="w-4 h-4 animate-spin mr-2" />
				Loading templates…
			</div>
		);
	}

	if (!selected) {
		return (
			<div className="flex flex-col gap-4" data-testid="direct-flow-pick">
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={onCancel}>
						<ArrowLeft className="w-3 h-3" />
						Back
					</Button>
					<h2 className="text-base font-semibold">Choose a team template</h2>
				</div>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					{(templates ?? []).map((tpl) => (
						<button
							key={tpl.id}
							type="button"
							onClick={() => setSelected(tpl)}
							className="text-left"
							data-testid={`template-card-${tpl.name}`}
						>
							<Card className="p-4 h-full hover:border-primary transition-colors">
								<h3 className="text-[14px] font-medium mb-1">{tpl.name}</h3>
								<p className="text-[12px] text-text-muted mb-2 line-clamp-2">
									{tpl.description ?? ''}
								</p>
								<p className="text-[11px] text-text-muted">
									{tpl.agent_types.length === 0
										? 'Just Captain + Coach'
										: `${tpl.agent_types.length} agent role${tpl.agent_types.length === 1 ? '' : 's'}`}
								</p>
							</Card>
						</button>
					))}
				</div>
			</div>
		);
	}

	const additions = selected.agent_types;

	return (
		<form
			onSubmit={handleConfirm}
			className="flex flex-col gap-5"
			data-testid="direct-flow-confirm"
		>
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" type="button" onClick={() => setSelected(null)}>
					<ArrowLeft className="w-3 h-3" />
					Back
				</Button>
				<h2 className="text-base font-semibold">{selected.name}</h2>
			</div>

			<Card className="p-4">
				<h3 className="text-[13px] font-medium mb-2">Agents we'll add to your team</h3>
				{additions.length === 0 ? (
					<p className="text-[12px] text-text-muted">
						This template doesn't add any new agent roles — only the built-in Captain and Coach.
					</p>
				) : (
					<ul className="space-y-2">
						{additions.map((agent) => (
							<li key={agent.agent_type_id} className="text-[12px]">
								<span className="font-medium text-text">{agent.name}</span>
								{agent.role_description && (
									<span className="text-text-muted"> — {agent.role_description}</span>
								)}
							</li>
						))}
					</ul>
				)}
			</Card>

			<div className="flex flex-col gap-3">
				<Input
					label="Project name"
					value={projectName}
					onChange={(e) => setProjectName(e.target.value)}
					placeholder="e.g. My App"
					required
				/>
				<Textarea
					label="Project description (optional)"
					value={projectDescription}
					onChange={(e) => setProjectDescription(e.target.value)}
					placeholder="A short description for the team to work from"
					rows={3}
				/>
				<PrdUpload
					value={initialPrd}
					filename={prdFilename}
					onChange={(value, filename) => {
						setInitialPrd(value);
						setPrdFilename(filename);
					}}
				/>
			</div>

			{directOnboarding.error && (
				<p className="text-[13px] text-accent-red">
					{(directOnboarding.error as { message?: string }).message || 'Something went wrong'}
				</p>
			)}

			<Button type="submit" disabled={directOnboarding.isPending || !projectName.trim()}>
				{directOnboarding.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
				{directOnboarding.isPending ? 'Setting up…' : 'Add these agents and create project'}
			</Button>
		</form>
	);
}
