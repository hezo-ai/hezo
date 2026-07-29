import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useAiProviderStatus } from '../../hooks/use-ai-providers';
import { api } from '../../lib/api';
import { getPendingSetupToken } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { queryClient } from '../../lib/query-client';
import { queryKeys } from '../../lib/query-keys';
import { AiProviderPicker } from '../ai-provider-picker';
import { GateLocaleSwitcher } from '../locale/locale-switcher';
import { MasterKeyForm, VaultShell } from '../master-key-gate';
import { PasswordSetForm } from '../password-set-form';
import { OnboardingShell } from './onboarding-shell';
import { Stepper, type StepStatus } from './stepper';

export type WizardStep = 'password' | 'ai-provider' | 'done';

interface WizardShellProps {
	currentStep: 'password' | 'ai-provider';
	children: ReactNode;
}

/**
 * Onboarding chrome shown AFTER the vault master-key screen. The master key is a
 * separate pre-active gate, so it's always a completed step here; the two live
 * steps are creating a password and configuring an AI provider.
 */
function WizardShell({ currentStep, children }: WizardShellProps) {
	const { t } = useI18n();
	const passwordStatus: StepStatus = currentStep === 'password' ? 'current' : 'complete';
	const aiProviderStatus: StepStatus = currentStep === 'ai-provider' ? 'current' : 'pending';
	return (
		/* The locale control stays reachable throughout setup, not just on the
		   language step. */
		<OnboardingShell width="2xl" cornerAction={<GateLocaleSwitcher />}>
			<div>
				<div className="text-center mb-6 sm:mb-10">
					<h1 className="text-xl sm:text-2xl font-semibold mb-2">{t('setup.welcome')}</h1>
					<p className="text-[13px] text-text-2">{t('setup.subtitle')}</p>
				</div>
				<Stepper
					steps={[
						{ label: t('setup.step.language'), status: 'complete' },
						{ label: t('setup.step.masterKey'), status: 'complete' },
						{ label: t('setup.step.password'), status: passwordStatus },
						{ label: t('setup.step.aiProvider'), status: aiProviderStatus },
					]}
				/>
				<div className="rounded-lg border border-border bg-surface p-5 sm:p-8 shadow-sm">
					{children}
				</div>
			</div>
		</OnboardingShell>
	);
}

/** Create/confirm the admin password. On success the session is stored and the gate advances. */
function PasswordStep() {
	const { t } = useI18n();
	return (
		<div data-testid="setup-step-password" className="mx-auto max-w-md">
			<h2 className="text-base sm:text-lg font-semibold mb-1">{t('setup.password.title')}</h2>
			<p className="text-[13px] text-text-2 mb-5">{t('setup.password.description')}</p>
			<PasswordSetForm
				submitLabel={t('setup.password.submit')}
				onSuccess={() => {
					// Now logged in (session stored) and passwordSet flips true.
					queryClient.invalidateQueries({ queryKey: queryKeys.status() });
					queryClient.invalidateQueries({ queryKey: queryKeys.me() });
				}}
			/>
		</div>
	);
}

/**
 * The create-password phase. Needs a credential to enroll the verifier — either
 * the in-memory password-setup token from the just-completed master-key flow, or
 * (if that was lost, e.g. a page refresh mid-onboarding) a fresh one obtained by
 * re-entering the master key.
 */
export function CreatePasswordFlow() {
	const { t } = useI18n();
	const [reentered, setReentered] = useState(0);
	const hasCredential = getPendingSetupToken() !== null || api.getToken() !== null;

	if (!hasCredential) {
		return (
			<VaultShell>
				<div className="rounded-2xl border border-border-strong bg-surface p-6 sm:p-8 shadow-[var(--elev-lg)]">
					<div className="mb-5 text-center">
						<h2 className="text-lg font-semibold text-text-1">
							{t('setup.masterKey.confirmTitle')}
						</h2>
						<p className="mt-1 text-sm text-text-2">{t('setup.masterKey.confirmDescription')}</p>
					</div>
					<MasterKeyForm
						state="unlocked"
						embedded
						onAuthenticated={() => setReentered((n) => n + 1)}
					/>
				</div>
			</VaultShell>
		);
	}

	return (
		<WizardShell currentStep="password" key={reentered}>
			<PasswordStep />
		</WizardShell>
	);
}

export function SetupWizard() {
	const { t } = useI18n();
	return (
		<WizardShell currentStep="ai-provider">
			<div data-testid="setup-step-ai-provider">
				<h2 className="text-base sm:text-lg font-semibold mb-1">{t('setup.aiProvider.title')}</h2>
				<p className="text-[13px] text-text-2 mb-5">{t('setup.aiProvider.description')}</p>
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

/** Wraps the app shell: shows the AI-provider wizard until a provider is configured. */
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
