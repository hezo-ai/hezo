import { type PageLogoProps, PageLogo as UiPageLogo } from '@hezo/ui';
import { LOGO_ALT, LOGO_SRC, LOGO_WORDMARK } from './logo';

/** The corner brand mark for a full-screen page, in this app's identity. */
export function PageLogo(props: Omit<PageLogoProps, 'src' | 'alt' | 'wordmark'>) {
	return <UiPageLogo {...props} src={LOGO_SRC} alt={LOGO_ALT} wordmark={LOGO_WORDMARK} />;
}
