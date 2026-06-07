import { MessagesSquare, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectWithTeamDialog } from '../create-project-with-team-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { DirectFlow } from './direct-flow';

type Mode = 'choose' | 'direct';

interface OnboardingChoiceProps {
	projectId: string;
	/** Called after the direct flow finishes so the wizard can refresh state and exit step 3. */
	onChosen: () => void;
}

export function OnboardingChoice({ projectId, onChosen }: OnboardingChoiceProps) {
	const [mode, setMode] = useState<Mode>('choose');
	const [chatOpen, setChatOpen] = useState(false);

	if (mode === 'direct') {
		return (
			<DirectFlow projectId={projectId} onCancel={() => setMode('choose')} onDone={onChosen} />
		);
	}

	return (
		<div className="flex flex-col gap-6" data-testid="onboarding-choice">
			<div className="text-center">
				<h2 className="text-lg sm:text-xl font-semibold mb-2">How do you want to get started?</h2>
				<p className="text-[13px] text-text-muted max-w-md mx-auto">
					Every project gets its own team. Pick a team template and dive straight in, or name your
					project and let the Captain scope it with you before it opens.
				</p>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
				<Card className="p-5 flex flex-col gap-3" data-testid="choice-direct">
					<div className="flex items-center gap-2">
						<Sparkles className="w-5 h-5 text-accent-purple-text" />
						<h3 className="text-[15px] font-medium">Pick a template</h3>
					</div>
					<p className="text-[13px] text-text-muted flex-1">
						Choose a team template, name your first project, and we'll spin up its team and create
						the project straight away.
					</p>
					<Button onClick={() => setMode('direct')}>Browse templates</Button>
				</Card>

				<Card className="p-5 flex flex-col gap-3" data-testid="choice-chat">
					<div className="flex items-center gap-2">
						<MessagesSquare className="w-5 h-5 text-accent-blue-text" />
						<h3 className="text-[15px] font-medium">Chat with the Captain</h3>
					</div>
					<p className="text-[13px] text-text-muted flex-1">
						Name your project and pick a starting team; the project's Captain reviews scope and
						confirms the roster with you before opening it.
					</p>
					<Button variant="secondary" onClick={() => setChatOpen(true)}>
						Start chat
					</Button>
				</Card>
			</div>

			<CreateProjectWithTeamDialog open={chatOpen} onOpenChange={setChatOpen} />
		</div>
	);
}
