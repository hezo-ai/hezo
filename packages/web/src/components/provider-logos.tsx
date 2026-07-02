import { AI_PROVIDER_INFO, type AiProvider, AiProvider as Provider } from '@hezo/shared';
import type { FC } from 'react';

/**
 * Brand marks for AI providers, rendered on the provider-picker cards.
 *
 * Each logo is a self-contained monochrome inline SVG using `currentColor`, so
 * it inherits the card's text colour and themes correctly in light/dark. Only
 * providers whose mark can be reproduced cleanly get an SVG here; everything
 * else falls back to a compact monogram (the provider's initial) via
 * {@link ProviderLogo}. Drop a new entry in this map to give another provider a
 * real logo.
 */

type LogoProps = { className?: string };

const AnthropicLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M9.3 4h5.4l5.5 16h-3.7l-1.12-3.45H8.62L7.5 20H3.8L9.3 4zm.42 9.45h4.56L12 6.6l-2.28 6.85z" />
	</svg>
);

const GoogleLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M12 10.9v2.96h4.84c-.2 1.25-1.46 3.66-4.84 3.66-2.92 0-5.3-2.41-5.3-5.39S9.08 6.74 12 6.74c1.66 0 2.77.71 3.41 1.32l2.32-2.24C16.23 4.42 14.32 3.6 12 3.6 7.36 3.6 3.6 7.36 3.6 12s3.76 8.4 8.4 8.4c4.85 0 8.06-3.41 8.06-8.21 0-.55-.06-.97-.13-1.39H12z" />
	</svg>
);

export const PROVIDER_LOGOS: Partial<Record<AiProvider, FC<LogoProps>>> = {
	[Provider.Anthropic]: AnthropicLogo,
	[Provider.Google]: GoogleLogo,
};

interface ProviderLogoProps {
	provider: AiProvider;
	className?: string;
}

/**
 * Render a provider's brand mark, sized to fill the slot the caller sizes via
 * `className` (e.g. `h-5 w-5`). Providers with a registered SVG show it; the
 * rest fall back to a compact monogram of the provider's initial that fits the
 * same box. The full provider name is shown as a large wordmark only on the
 * card grid, which has room for it (see {@link ProviderCardGrid}) — squeezing a
 * wordmark into a small slot (the picker header) overflows and overlaps its
 * neighbours, so the fallback stays a single-letter badge here.
 */
export function ProviderLogo({ provider, className }: ProviderLogoProps) {
	const Logo = PROVIDER_LOGOS[provider];
	if (Logo) return <Logo className={className} />;
	return (
		<span
			aria-hidden="true"
			className={`flex items-center justify-center rounded-[5px] bg-surface-3 text-[13px] font-bold uppercase leading-none text-text-1 ${className ?? ''}`}
		>
			{AI_PROVIDER_INFO[provider].name.charAt(0)}
		</span>
	);
}
