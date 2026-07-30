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

const OpenAiLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
	</svg>
);

const GoogleLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M12 10.9v2.96h4.84c-.2 1.25-1.46 3.66-4.84 3.66-2.92 0-5.3-2.41-5.3-5.39S9.08 6.74 12 6.74c1.66 0 2.77.71 3.41 1.32l2.32-2.24C16.23 4.42 14.32 3.6 12 3.6 7.36 3.6 3.6 7.36 3.6 12s3.76 8.4 8.4 8.4c4.85 0 8.06-3.41 8.06-8.21 0-.55-.06-.97-.13-1.39H12z" />
	</svg>
);

const DeepSeekLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
	</svg>
);

const ZAiLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z" />
	</svg>
);

const KimiLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" />
		<path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" />
	</svg>
);

const XaiLogo: FC<LogoProps> = ({ className }) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
		<path d="M3.2 3h4.28l4.32 6.02L15.9 3H21l-6.86 9.05L21 21h-4.28l-4.62-6.44L7.08 21H3l7.14-9.42L3.2 3z" />
	</svg>
);

export const PROVIDER_LOGOS: Partial<Record<AiProvider, FC<LogoProps>>> = {
	[Provider.Anthropic]: AnthropicLogo,
	[Provider.OpenAI]: OpenAiLogo,
	[Provider.Google]: GoogleLogo,
	[Provider.DeepSeek]: DeepSeekLogo,
	[Provider.ZAi]: ZAiLogo,
	[Provider.Kimi]: KimiLogo,
	// Same vendor, same mark — the two Kimi cards are distinguished by their
	// runtime label, not by the logo.
	[Provider.KimiCode]: KimiLogo,
	[Provider.XAi]: XaiLogo,
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
