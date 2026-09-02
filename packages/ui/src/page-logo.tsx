import { Logo } from './logo.js';

/**
 * Brand mark pinned to the top-left of a full-screen auth / onboarding / login
 * page, mirroring where the logo sits in the signed-in app chrome. Absolutely
 * positioned so it never shifts the centered card it sits over. The parent shell
 * must be `relative`.
 */
export function PageLogo() {
	return (
		<div className="absolute left-0 top-0 p-4 sm:p-6">
			<Logo size="md" wordmark />
		</div>
	);
}
