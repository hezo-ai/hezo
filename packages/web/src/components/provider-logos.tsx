import { AI_PROVIDER_INFO, type AiProvider, AiProvider as Provider } from '@hezo/shared';
import type { FC } from 'react';

/**
 * Brand marks for AI providers, rendered on the provider-picker cards.
 *
 * Each logo is a self-contained monochrome inline SVG using `currentColor`, so
 * it inherits the card's text colour and themes correctly in light/dark. Only
 * providers whose mark can be reproduced cleanly get an SVG here; everything
 * else falls back to a big-font wordmark via {@link ProviderLogo}. Drop a new
 * entry in this map to give another provider a real logo.
 */

type LogoProps = { className?: string };

const XAiLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M3 3h4.4l4.1 5.9L15.9 3h4.4l-6.4 9 6.6 9h-4.4l-4.4-6.3L7.1 21H2.7l6.7-9.4z" />
	</svg>
);

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
	[Provider.XAi]: XAiLogo,
	[Provider.Anthropic]: AnthropicLogo,
	[Provider.Google]: GoogleLogo,
};

interface ProviderLogoProps {
	provider: AiProvider;
	className?: string;
}

/**
 * Render a provider's brand mark, or — when no SVG is registered — its name as
 * a big-font wordmark. Used on the provider-picker cards.
 */
export function ProviderLogo({ provider, className }: ProviderLogoProps) {
	const Logo = PROVIDER_LOGOS[provider];
	if (Logo) return <Logo className={className} />;
	return (
		<span className="text-lg font-bold leading-none tracking-tight text-center sm:text-xl">
			{AI_PROVIDER_INFO[provider].name}
		</span>
	);
}
