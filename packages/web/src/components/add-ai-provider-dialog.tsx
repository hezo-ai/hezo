import { AI_PROVIDER_INFO, AiAuthMethod, type AiProvider } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type AiProviderConfig, useUpdateAiProviderConfig } from '../hooks/use-ai-providers';
import { toast } from '../hooks/use-toast';
import { useI18n } from '../lib/i18n';
import { ModelPicker } from './model-picker';
import { ProviderCardGrid } from './provider-card-grid';
import { ADD_PROVIDER_ORDER, ProviderConfigForm } from './provider-config-form';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';

interface AddAiProviderDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Settings "Add provider" modal. Three steps: pick a provider from the card grid,
 * configure its credential, then choose the model it runs. Unlike the onboarding
 * wizard this surface carries no welcome blurb or step indicator — just the
 * dialog title, a back affordance, and the shared {@link ProviderConfigForm}.
 *
 * The model step comes last because it has to: the catalog is listed against a
 * stored credential (`/ai-providers/:configId/models`), so there is nothing to
 * offer until the config exists.
 */
export function AddAiProviderDialog({ open, onOpenChange }: AddAiProviderDialogProps) {
	const [provider, setProvider] = useState<AiProvider | null>(null);
	const [created, setCreated] = useState<AiProviderConfig | null>(null);
	const info = provider ? AI_PROVIDER_INFO[provider] : null;

	// Reset back to the card grid each time the dialog opens.
	useEffect(() => {
		if (open) {
			setProvider(null);
			setCreated(null);
		}
	}, [open]);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md" aria-describedby={undefined}>
				<div className="flex items-center gap-2 mb-4 pr-8">
					{provider && info && !created && (
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
						{created
							? (info?.name ?? created.label)
							: provider && info
								? `Connect ${info.name}`
								: 'Add AI provider'}
					</Dialog.Title>
				</div>

				{created ? (
					<DefaultModelStep config={created} onDone={() => onOpenChange(false)} />
				) : !provider || !info ? (
					<ProviderCardGrid providers={ADD_PROVIDER_ORDER} onSelect={setProvider} />
				) : (
					<ProviderConfigForm
						key={provider}
						provider={provider}
						showName
						submitLabel="Add provider"
						onCancel={() => onOpenChange(false)}
						onDone={(config) => {
							// A subscription credential has no listable catalog, and the guided
							// sign-in path resolves without one at all — either way there is no
							// model to choose, so the dialog is finished.
							if (config && config.auth_method !== AiAuthMethod.Subscription) {
								setCreated(config);
								return;
							}
							onOpenChange(false);
						}}
					/>
				)}
			</DialogContent>
		</Dialog.Root>
	);
}

/**
 * The final add step. The choice is saved as it is picked rather than on Done, so
 * dismissing the dialog keeps it — Done only closes.
 */
function DefaultModelStep({ config, onDone }: { config: AiProviderConfig; onDone: () => void }) {
	const { t } = useI18n();
	const [model, setModel] = useState<string | null>(config.default_model);
	const update = useUpdateAiProviderConfig(config.id);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-[13px] text-success-soft-fg">
				<Check className="w-4 h-4 shrink-0" />
				{t('settings.provider.model.credentialSaved')}
			</div>

			<div className="flex flex-col gap-1.5">
				<span className="text-eyebrow text-text-2">{t('settings.provider.model.label')}</span>
				<ModelPicker
					configId={config.id}
					authMethod={config.auth_method}
					value={model}
					onChange={(next) => {
						setModel(next);
						update.mutate(
							{ default_model: next },
							{
								onError: (e) => {
									setModel(config.default_model);
									toast.error(
										e instanceof Error ? e.message : t('settings.provider.model.saveFailed'),
									);
								},
							},
						);
					}}
					ariaLabel={t('settings.provider.model.ariaFor', { name: config.label })}
					widthClassName="w-full"
					busy={update.isPending}
					testId="add-default-model"
				/>
				<p className="text-[13px] text-text-3">{t('settings.provider.model.hint')}</p>
			</div>

			<div className="flex justify-end">
				<Button type="button" onClick={onDone} disabled={update.isPending}>
					{t('common.done')}
				</Button>
			</div>
		</div>
	);
}
