import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

test('app header renders the Hezo logo as the home link', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/' });
	const home = await findByTestId('app-header-home');
	const img = home.querySelector('img');
	expect(img).not.toBeNull();
	expect(img?.getAttribute('src')).toBe('/logo.svg');
	expect(img?.getAttribute('alt')).toBe('Hezo');
});
