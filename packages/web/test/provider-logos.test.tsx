import { AiProvider } from '@hezo/shared';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { PROVIDER_LOGOS, ProviderLogo } from '../src/components/provider-logos';

// Every provider offered in the add-provider picker (ADD_PROVIDER_ORDER) should
// carry a real brand mark so no card falls back to a monogram.
const PROVIDERS_WITH_LOGOS = [
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
	AiProvider.DeepSeek,
	AiProvider.ZAi,
	AiProvider.Kimi,
	AiProvider.XAi,
] as const;

test('registers a brand mark for each provider offered in the add picker', () => {
	for (const provider of PROVIDERS_WITH_LOGOS) {
		expect(PROVIDER_LOGOS[provider]).toBeTruthy();
	}
});

test('renders the registered brand mark as a themeable inline SVG', () => {
	for (const provider of PROVIDERS_WITH_LOGOS) {
		const { container, unmount } = render(<ProviderLogo provider={provider} className="h-5 w-5" />);
		const svg = container.querySelector('svg');
		expect(svg).toBeTruthy();
		// Monochrome + currentColor so the mark inherits the card's text colour and
		// themes correctly in light/dark, and the caller's sizing passes through.
		expect(svg?.getAttribute('fill')).toBe('currentColor');
		expect(svg?.getAttribute('aria-hidden')).toBe('true');
		expect(svg?.getAttribute('class')).toBe('h-5 w-5');
		// No monogram text leaks in alongside the mark.
		expect(container.textContent).toBe('');
		unmount();
	}
});

test('falls back to a compact monogram — not a wordmark — for a provider without a brand mark', () => {
	// OpenRouter is a real provider deliberately left without a registered mark, so
	// it exercises the fallback path. The slot shows only the provider's initial; a
	// full-name wordmark used to overflow the small icon box and overlap the UI
	// next to it.
	expect(PROVIDER_LOGOS[AiProvider.OpenRouter]).toBeUndefined();
	const { container, getByText, queryByText } = render(
		<ProviderLogo provider={AiProvider.OpenRouter} className="h-5 w-5" />,
	);
	expect(container.querySelector('svg')).toBeNull();
	getByText('O');
	expect(queryByText('OpenRouter')).toBeNull();
});
