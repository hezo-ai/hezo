import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import type { AiProviderConfig } from '../hooks/use-ai-providers';
import { useI18n } from '../lib/i18n';
import { ProviderConfigForm } from './provider-config-form';
import { DialogContent } from './ui/dialog';

interface EditAiProviderDialogProps {
	config: AiProviderConfig;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Settings "Edit provider" modal — the single home for everything about a stored
 * credential except its default model: the name, the credential itself, and the
 * CLI it runs on. Single-step, unlike {@link AddAiProviderDialog}, because the
 * provider is already known and cannot change.
 */
export function EditAiProviderDialog({ config, open, onOpenChange }: EditAiProviderDialogProps) {
	const { t } = useI18n();
	const provider = config.provider as AiProvider;
	const info = AI_PROVIDER_INFO[provider];

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md" aria-describedby={undefined}>
				<div className="mb-4 pr-8">
					<Dialog.Title className="text-lg font-semibold">
						{t('settings.provider.editFor', { name: config.label })}
					</Dialog.Title>
					<p className="text-[13px] text-text-2 mt-1">{info?.name ?? provider}</p>
				</div>

				<ProviderConfigForm
					// Reset the in-progress credential every time the dialog reopens, and
					// whenever it is pointed at a different row.
					key={config.id}
					provider={provider}
					showName
					editing={config}
					submitLabel={t('common.save')}
					onCancel={() => onOpenChange(false)}
					onDone={() => onOpenChange(false)}
				/>
			</DialogContent>
		</Dialog.Root>
	);
}
