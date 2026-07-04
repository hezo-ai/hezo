import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProviderCardGrid } from './provider-card-grid';
import { ADD_PROVIDER_ORDER, ProviderConfigForm } from './provider-config-form';
import { DialogContent } from './ui/dialog';

interface AddAiProviderDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Settings "Add provider" modal. Two-step: pick a provider from the card grid,
 * then configure its credential. Unlike the onboarding wizard this surface
 * carries no welcome blurb or step indicator — just the dialog title, a back
 * affordance, and the shared {@link ProviderConfigForm}.
 */
export function AddAiProviderDialog({ open, onOpenChange }: AddAiProviderDialogProps) {
	const [provider, setProvider] = useState<AiProvider | null>(null);
	const info = provider ? AI_PROVIDER_INFO[provider] : null;

	// Reset back to the card grid each time the dialog opens.
	useEffect(() => {
		if (open) setProvider(null);
	}, [open]);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md" aria-describedby={undefined}>
				<div className="flex items-center gap-2 mb-4 pr-8">
					{provider && info && (
						<button
							type="button"
							onClick={() => setProvider(null)}
							className="text-text-2 hover:text-text-1 p-2 -m-2"
							aria-label="Back"
						>
							<ArrowLeft className="w-4 h-4" />
						</button>
					)}
					<Dialog.Title className="text-lg font-semibold">
						{provider && info ? `Connect ${info.name}` : 'Add AI provider'}
					</Dialog.Title>
				</div>

				{!provider || !info ? (
					<ProviderCardGrid providers={ADD_PROVIDER_ORDER} onSelect={setProvider} />
				) : (
					<ProviderConfigForm
						key={provider}
						provider={provider}
						showName
						submitLabel="Add provider"
						onCancel={() => onOpenChange(false)}
						onDone={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog.Root>
	);
}
