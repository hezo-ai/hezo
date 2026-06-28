import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import { ProviderLogo } from './provider-logos';
import { Badge } from './ui/badge';

interface ProviderCardGridProps {
	/** Providers to show, in display order. */
	providers: readonly AiProvider[];
	onSelect: (provider: AiProvider) => void;
}

/**
 * Responsive grid of selectable AI-provider cards, each showing the provider's
 * brand logo (or a big-font wordmark fallback) plus its name and runtime label.
 * Mobile-first: two columns on phones, three from the `sm` breakpoint up. Cards
 * are real buttons so they're keyboard-focusable and screen-reader friendly.
 */
export function ProviderCardGrid({ providers, onSelect }: ProviderCardGridProps) {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
			{providers.map((provider) => {
				const info = AI_PROVIDER_INFO[provider];
				return (
					<button
						key={provider}
						type="button"
						onClick={() => onSelect(provider)}
						aria-label={`${info.name} · ${info.runtimeLabel}`}
						className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4 text-center shadow-xs transition-[border-color] duration-150 hover:border-border-strong focus:border-accent focus:outline-none"
					>
						<span className="flex h-10 w-full items-center justify-center text-text-1">
							<ProviderLogo provider={provider} className="h-8 w-8" />
						</span>
						<span className="text-[13px] font-medium text-text-1">{info.name}</span>
						<Badge color="neutral">{info.runtimeLabel}</Badge>
					</button>
				);
			})}
		</div>
	);
}
