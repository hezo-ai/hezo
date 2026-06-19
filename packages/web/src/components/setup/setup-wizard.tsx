import type { MasterKeyState } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAiProviderStatus } from '../../hooks/use-ai-providers';
import { AiProviderPicker } from '../ai-provider-picker';
import { MasterKeyForm } from '../master-key-gate';
import { Stepper, type StepStatus } from './stepper';

export type WizardStep = 'master-key' | 'ai-provider' | 'done';

interface WizardShellProps {
	currentStep: 'master-key' | 'ai-provider';
	children: ReactNode;
}

function WizardShell({ currentStep, children }: WizardShellProps) {
	const masterKeyStatus: StepStatus = currentStep === 'master-key' ? 'current' : 'complete';
	const aiProviderStatus: StepStatus = currentStep === 'ai-provider' ? 'current' : 'pending';
	return (
		<div className="min-h-screen flex flex-col items-center px-4 py-8 sm:py-16 bg-surface">
			<div className="w-full max-w-2xl">
				<div className="text-center mb-6 sm:mb-10">
					<h1 className="text-xl sm:text-2xl font-semibold mb-2">Welcome to Hezo</h1>
					<p className="text-[13px] text-text-2">A quick setup before you get to work.</p>
				</div>
				<Stepper
					steps={[
						{ label: 'Master key', status: masterKeyStatus },
						{ label: 'AI provider', status: aiProviderStatus },
					]}
				/>
				<div className="rounded-lg border border-border bg-surface p-5 sm:p-8 shadow-sm">
					{children}
				</div>
			</div>
		</div>
	);
}

export function MasterKeyStep({ state }: { state: MasterKeyState }) {
	return (
		<WizardShell currentStep="master-key">
			<div data-testid="setup-step-master-key">
				<h2 className="text-base sm:text-lg font-semibold mb-1">Set Master Key</h2>
				<p className="text-[13px] text-text-2 mb-5">
					Your master key is 12 words that encrypt your data. Save them somewhere safe — you'll need
					them to unlock Hezo on restart.
				</p>
				<MasterKeyForm state={state} embedded />
			</div>
		</WizardShell>
	);
}

export function SetupWizard() {
	return (
		<WizardShell currentStep="ai-provider">
			<div data-testid="setup-step-ai-provider">
				<h2 className="text-base sm:text-lg font-semibold mb-1">Set up an AI provider</h2>
				<p className="text-[13px] text-text-2 mb-5">
					Configure at least one provider so your agents can run. Shared across every team on this
					instance — you can add more later in settings.
				</p>
				<AiProviderPicker />
			</div>
		</WizardShell>
	);
}

/**
 * Returns the current wizard step, or 'done' once an AI provider is configured.
 * SetupGate is only mounted when the master key is unlocked, so this hook does
 * not re-check master-key state — that would add a second observer to
 * useStatus() and trigger a refetch loop against AppShell's isFetching gate.
 */
export function useWizardStep(): WizardStep | 'loading' {
	const { data: providerStatus, isPending } = useAiProviderStatus();
	if (isPending) return 'loading';
	if (!providerStatus?.configured) return 'ai-provider';
	return 'done';
}

interface SetupGateProps {
	children: React.ReactNode;
}

/** Wraps the app shell: shows the wizard until an AI provider is configured. */
export function SetupGate({ children }: SetupGateProps) {
	const step = useWizardStep();
	if (step === 'loading') {
		return (
			<div className="flex items-center justify-center h-screen text-text-2">
				<Loader2 className="w-4 h-4 animate-spin" />
			</div>
		);
	}
	if (step === 'done') return <>{children}</>;
	return <SetupWizard />;
}
