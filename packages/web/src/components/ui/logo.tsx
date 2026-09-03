import { type LogoProps, Logo as UiLogo } from '@hezo/ui';

/** Where this app serves its mark, and what the mark is called. */
export const LOGO_SRC = '/logo.svg';
export const LOGO_ALT = 'Hezo';
export const LOGO_WORDMARK = 'hezo';

/**
 * The brand mark, in this app's identity.
 *
 * **The image and the word live here, never in the package.** A path baked into
 * a primitive resolves against whichever app is serving, so a second consumer
 * would render a broken image with nothing in the markup to say why.
 */
export function Logo(props: Omit<LogoProps, 'src' | 'alt' | 'wordmark'> & { wordmark?: boolean }) {
	const { wordmark, ...rest } = props;
	return (
		<UiLogo
			{...rest}
			src={LOGO_SRC}
			alt={LOGO_ALT}
			wordmark={wordmark ? LOGO_WORDMARK : undefined}
		/>
	);
}
