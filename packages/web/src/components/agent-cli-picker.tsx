import {
	AGENT_RUNTIME_LABELS,
	type AgentRuntime,
	type AiProvider,
	effectiveRuntime,
	providerRuntimes,
} from '@hezo/shared';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';

/**
 * Whether this provider offers a choice of CLI at all. Most do not — they run on
 * exactly one — and for those the picker (and the Advanced section that would
 * hold it) is omitted entirely rather than rendered as a single dead button.
 */
export function providerHasCliChoice(provider: AiProvider): boolean {
	return providerRuntimes(provider).length > 1;
}

interface AgentCliPickerProps {
	provider: AiProvider;
	/** The stored choice: null means "follow the provider default". */
	value: AgentRuntime | null;
	onChange: (runtime: AgentRuntime) => void;
	disabled?: boolean;
}

/**
 * The CLI a credential runs on, as a segmented row matching the Authentication
 * control above it in the same form.
 *
 * Shared by the add-credential form and the settings row so the two can't drift
 * on which runtimes are offered or which is marked default. Selection is by
 * resolved runtime, not by the raw stored value, so a credential that stores
 * null still shows its provider default as active.
 */
export function AgentCliPicker({ provider, value, onChange, disabled }: AgentCliPickerProps) {
	const { t } = useI18n();
	const runtimes = providerRuntimes(provider);
	if (runtimes.length <= 1) return null;

	const selected = effectiveRuntime(provider, value);
	const defaultRuntime = runtimes[0];

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-eyebrow text-text-2">{t('settings.provider.agentCli')}</span>
			<div className="flex flex-wrap gap-2">
				{runtimes.map((runtime) => (
					<Button
						key={runtime}
						type="button"
						size="sm"
						disabled={disabled}
						variant={runtime === selected ? 'primary' : 'secondary'}
						onClick={() => onChange(runtime)}
					>
						{/* Product name — never translated, same rule as Captain/CEO/Hezo. */}
						{AGENT_RUNTIME_LABELS[runtime]}
						{runtime === defaultRuntime && (
							<span className="text-[10px] uppercase tracking-wide opacity-70">
								{t('settings.provider.cliDefault')}
							</span>
						)}
					</Button>
				))}
			</div>
			<p className="text-[13px] text-text-3">{t('settings.provider.agentCliHint')}</p>
		</div>
	);
}
