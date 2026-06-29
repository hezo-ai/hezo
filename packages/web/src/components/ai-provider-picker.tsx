import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { ProviderCardGrid } from './provider-card-grid';
import { ADD_PROVIDER_ORDER, ProviderConfigForm } from './provider-config-form';
import { ProviderLogo } from './provider-logos';

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
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setProvider(null)}
					className="text-text-2 hover:text-text-1 p-2 -m-2"
					aria-label="Back"
				>
					<ArrowLeft className="w-4 h-4" />
				</button>
				<span className="flex h-6 w-6 items-center justify-center text-text-1">
					<ProviderLogo provider={provider} className="h-5 w-5" />
				</span>
				<div className="flex flex-col">
					<span className="text-sm font-medium text-text-1">Connect {info.name}</span>
					<span className="text-xs text-text-3">{info.runtimeLabel}</span>
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
