import type { ReactNode } from 'react';
import { PageLogo } from '../ui/page-logo';

/**
 * The full-screen frame shared by the top-aligned onboarding screens (the
 * language step and the setup wizard). The vault gates use `VaultShell`
 * instead, which centres its card vertically.
 *
 * `pt-20` on mobile is load-bearing: `PageLogo` is absolutely positioned at the
 * top-left, so at phone widths a heading starting at the old `py-8` ran
 * straight into the wordmark. Desktop has room to spare and keeps the larger
 * symmetric padding.
 */
export function OnboardingShell({
	children,
	width = 'md',
	cornerAction,
}: {
	children: ReactNode;
	width?: 'md' | '2xl';
	/** Rendered fixed to the top-right (the locale switcher on wizard screens). */
	cornerAction?: ReactNode;
}) {
	return (
		<div className="relative min-h-screen flex flex-col items-center px-4 pt-20 pb-8 sm:py-16 bg-surface">
			{cornerAction}
			<PageLogo />
			<div className={`w-full ${width === 'md' ? 'max-w-md' : 'max-w-2xl'}`}>{children}</div>
		</div>
	);
}
