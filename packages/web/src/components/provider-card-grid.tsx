import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import { PROVIDER_LOGOS, ProviderLogo } from './provider-logos';

interface ProviderCardGridProps {
	/** Providers to show, in display order. */
	providers: readonly AiProvider[];
	onSelect: (provider: AiProvider) => void;
}

/**
 * Responsive grid of selectable AI-provider cards. Each card shows the
 * provider's brand logo with its name underneath; providers without a
 * registered logo render their name on its own as a big-font wordmark (no
 * duplicate label). Mobile-first: two columns on phones, three from the `sm`
 * breakpoint up. Cards are real buttons so they're keyboard-focusable and
 * screen-reader friendly.
 */
export function ProviderCardGrid({ providers, onSelect }: ProviderCardGridProps) {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
			{providers.map((provider) => {
				const info = AI_PROVIDER_INFO[provider];
				const hasLogo = Boolean(PROVIDER_LOGOS[provider]);
				return (
					<button
						key={provider}
						type="button"
						onClick={() => onSelect(provider)}
						aria-label={info.name}
						className="flex min-h-[6.5rem] flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4 text-center shadow-xs transition-[border-color] duration-150 hover:border-border-strong focus:border-accent focus:outline-none"
					>
						{hasLogo ? (
							<>
								<span className="flex h-9 w-full items-center justify-center text-text-1">
									<ProviderLogo provider={provider} className="h-8 w-8" />
								</span>
								<span className="text-[13px] font-medium text-text-1">{info.name}</span>
							</>
						) : (
							<span className="text-base font-bold leading-tight tracking-tight text-text-1 sm:text-lg">
								{info.name}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
