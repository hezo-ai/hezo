import { AiAuthMethod } from '@hezo/shared';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAiProviderModels } from '../hooks/use-ai-providers';
import { useI18n } from '../lib/i18n';
import { SearchableSelect, type SearchableSelectOption } from './ui/searchable-select';

interface ModelPickerProps {
	/** The stored config whose catalog is listed. */
	configId: string;
	/** That config's auth method - subscription has no listable catalog. */
	authMethod: string;
	/** Selected model id, or null for the CLI's own default. */
	value: string | null;
	onChange: (value: string | null) => void;
	/** Accessible name, since the trigger renders only the current selection. */
	ariaLabel: string;
	/** Trigger width. Fixed by every caller, so a long model name cannot move the layout. */
	widthClassName?: string;
	/** Show a spinner beside the trigger while the caller persists the change. */
	busy?: boolean;
	disabled?: boolean;
	testId?: string;
}

/**
 * The default-model dropdown, shared by the providers table row, the add-provider
 * dialog and the edit-provider dialog. Owns the lazy catalog fetch and the option
 * list; each host owns when the choice is persisted.
 *
 * Ordering is not decided here: the catalog arrives sorted from
 * `useAiProviderModels`, and this adds only the two rows that are not models -
 * the CLI-default fallback, and a stored id the provider no longer lists.
 */
export function ModelPicker({
	configId,
	authMethod,
	value,
	onChange,
	ariaLabel,
	widthClassName = 'w-[200px]',
	busy = false,
	disabled = false,
	testId,
}: ModelPickerProps) {
	const { t } = useI18n();
	// Subscription sign-in stores an OAuth blob, not a key the catalog endpoint
	// accepts - the CLI picks the model, so there is nothing to list.
	const isSubscription = authMethod === AiAuthMethod.Subscription;
	// Lazy: the settings page would otherwise fire a live catalog call per row on
	// mount. Hovering the trigger is intent enough to prefetch, so by the time the
	// panel opens the models are usually already there.
	const [wanted, setWanted] = useState(false);
	const models = useAiProviderModels(configId, { enabled: wanted && !isSubscription });

	const options = useMemo<SearchableSelectOption[]>(() => {
		const catalog = models.data ?? [];
		const opts: SearchableSelectOption[] = [
			{ value: '', label: t('settings.provider.model.cliDefault') },
		];
		// A model the provider has since retired stays selectable, so opening the
		// picker never silently drops what the credential is actually running on.
		if (value && !catalog.some((m) => m.id === value)) {
			opts.push({
				value,
				label: value,
				description: t('settings.provider.model.notInCatalog'),
			});
		}
		for (const [i, m] of catalog.entries()) {
			opts.push({
				value: m.id,
				label: m.label,
				// The id is searchable as well as readable: "anthropic/" finds a vendor's
				// models where the display label never names it.
				description: m.id === m.label ? undefined : m.id,
				separatorBefore: i === 0,
			});
		}
		return opts;
	}, [models.data, value, t]);

	const selectedLabel = isSubscription
		? t('settings.provider.model.subscription')
		: value
			? (models.data?.find((m) => m.id === value)?.label ?? value)
			: t('settings.provider.model.cliDefault');

	const trigger = (
		<button
			type="button"
			aria-label={ariaLabel}
			disabled={disabled || busy || isSubscription}
			data-testid={testId}
			className={`flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text-1 outline-none hover:border-border-strong focus:border-border-strong disabled:opacity-50 cursor-pointer ${widthClassName}`}
		>
			<span className={`truncate ${value && !isSubscription ? '' : 'text-text-2'}`}>
				{selectedLabel}
			</span>
			<ChevronDown className="w-3.5 h-3.5 text-text-3 shrink-0" />
		</button>
	);

	// Nothing to open: rendering the trigger alone keeps the row's geometry and
	// states the answer, rather than an empty panel or a note beside the control.
	if (isSubscription) return trigger;

	return (
		// Hover intent, so the first open is not an empty panel. `onOpenChange` is
		// the guarantee that the fetch happens at all; this only makes it instant.
		<span className="flex items-center gap-2" onPointerEnter={() => setWanted(true)}>
			<SearchableSelect
				options={options}
				value={value ?? ''}
				onChange={(next) => onChange(next || null)}
				onOpenChange={(open) => {
					if (open) setWanted(true);
				}}
				disabled={disabled || busy}
				searchPlaceholder={t('settings.provider.model.search')}
				emptyLabel={t('settings.provider.model.empty')}
				loading={models.isFetching}
				loadingLabel={t('settings.provider.model.loading')}
				// `||`, not `??`: an upstream failure can carry an empty `message`, and a
				// blank row reads as "no error" in the one place that has to say there was.
				errorLabel={
					models.error
						? (models.error as { message?: string }).message ||
							t('settings.provider.model.loadFailed')
						: null
				}
				contentClassName="w-[300px]"
				testId={testId}
				trigger={trigger}
			/>
			{busy && <Loader2 className="w-3 h-3 animate-spin text-text-3" />}
		</span>
	);
}
