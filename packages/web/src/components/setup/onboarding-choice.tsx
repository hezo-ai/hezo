import { MessagesSquare, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useOnboardingDirect } from '../../hooks/use-onboarding-direct';
import { useStartOnboardingIntake } from '../../hooks/use-onboarding-intake';
import { useTeamTemplates } from '../../hooks/use-team-templates';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { DirectFlow } from './direct-flow';

type Mode = 'choose' | 'direct';

interface OnboardingChoiceProps {
	teamId: string;
	/** Called after the chat-flow ticket is created so the wizard can refresh state and exit step 3. */
	onChosen: () => void;
}

export function OnboardingChoice({ teamId, onChosen }: OnboardingChoiceProps) {
	const [mode, setMode] = useState<Mode>('choose');
	const startIntake = useStartOnboardingIntake(teamId);
	const directOnboarding = useOnboardingDirect(teamId);
	const { data: templates } = useTeamTemplates();

	const blankTemplate = templates?.find((t) => t.name === 'Blank');

	async function handleStartChat() {
		await startIntake.mutateAsync();
		onChosen();
	}

	async function handleGeneralHelp() {
		if (!blankTemplate) return;
		await directOnboarding.mutateAsync({
			template_id: blankTemplate.id,
			project_name: 'General',
			project_description: 'Catch-all for ad-hoc help and one-off tasks.',
			skip_planning_task: true,
		});
		onChosen();
	}

	if (mode === 'direct') {
		return <DirectFlow teamId={teamId} onCancel={() => setMode('choose')} onDone={onChosen} />;
	}

	return (
		<div className="flex flex-col gap-6" data-testid="onboarding-choice">
			<div className="text-center">
				<h2 className="text-lg sm:text-xl font-semibold mb-2">How do you want to get started?</h2>
				<p className="text-[13px] text-text-muted max-w-md mx-auto">
					Chat with the Captain and let them propose a team plus a first project, or pick the team
					template yourself and dive straight in.
				</p>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
				<Card className="p-5 flex flex-col gap-3" data-testid="choice-chat">
					<div className="flex items-center gap-2">
						<MessagesSquare className="w-5 h-5 text-accent-blue-text" />
						<h3 className="text-[15px] font-medium">Chat with the Captain</h3>
					</div>
					<p className="text-[13px] text-text-muted flex-1">
						Captain asks a few questions, then recommends the right team template and proposes your
						first project for you to approve.
					</p>
					<Button onClick={handleStartChat} disabled={startIntake.isPending}>
						{startIntake.isPending ? 'Starting…' : 'Start chat'}
					</Button>
				</Card>

				<Card className="p-5 flex flex-col gap-3" data-testid="choice-direct">
					<div className="flex items-center gap-2">
						<Sparkles className="w-5 h-5 text-accent-purple-text" />
						<h3 className="text-[15px] font-medium">Pick a template</h3>
					</div>
					<p className="text-[13px] text-text-muted flex-1">
						Choose a team template, name your first project, and we'll add the agents to your team
						and spin it up.
					</p>
					<Button variant="secondary" onClick={() => setMode('direct')}>
						Browse templates
					</Button>
				</Card>
			</div>

			<div className="text-center">
				<button
					type="button"
					onClick={handleGeneralHelp}
					disabled={!blankTemplate || directOnboarding.isPending}
					data-testid="choice-general"
					className="text-[13px] text-text-muted hover:text-text underline disabled:opacity-50"
				>
					{directOnboarding.isPending
						? 'Setting up your General project…'
						: 'Just exploring? Set me up with general help →'}
				</button>
				{directOnboarding.error && (
					<p className="mt-2 text-[12px] text-accent-red">
						{(directOnboarding.error as { message?: string }).message || 'Something went wrong'}
					</p>
				)}
			</div>
		</div>
	);
}
