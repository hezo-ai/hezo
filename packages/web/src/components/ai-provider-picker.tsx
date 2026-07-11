import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import { useState } from 'react';
import { ProviderCardGrid } from './provider-card-grid';
import { ADD_PROVIDER_ORDER, ProviderConfigForm } from './provider-config-form';
import { ProviderLogo } from './provider-logos';
import { BackLink } from './ui/back-link';

/**
 * Onboarding AI-provider setup: a grid of provider cards. Picking one drills
 * into the shared {@link ProviderConfigForm}; "Back" returns to the full card
 * view. The surrounding welcome heading + step indicator are supplied by the
 * setup wizard, so this component renders only the grid and the form — the same
 * picker the settings modal reuses without that onboarding chrome.
 */
export function AiProviderPicker() {
	const [provider, setProvider] = useState<AiProvider | null>(null);

	if (!provider) {
		return <ProviderCardGrid providers={ADD_PROVIDER_ORDER} onSelect={setProvider} />;
	}

	const info = AI_PROVIDER_INFO[provider];
	return (
		// Keep the credential entry pane a comfortable reading width on desktop
		// rather than stretching across the full onboarding card.
		<div className="mx-auto flex w-full max-w-md flex-col gap-4">
			<BackLink onClick={() => setProvider(null)} />
			<div className="flex items-center gap-2">
				<span className="flex h-6 w-6 shrink-0 items-center justify-center text-text-1">
					<ProviderLogo provider={provider} className="h-5 w-5" />
				</span>
				<div className="flex min-w-0 flex-col">
					<span className="truncate text-sm font-medium text-text-1">Connect {info.name}</span>
					<span className="truncate text-xs text-text-3">{info.runtimeLabel}</span>
				</div>
			</div>

			<ProviderConfigForm
				key={provider}
				provider={provider}
				submitLabel="Save"
				onCancel={() => setProvider(null)}
				onDone={() => setProvider(null)}
			/>
		</div>
	);
}
