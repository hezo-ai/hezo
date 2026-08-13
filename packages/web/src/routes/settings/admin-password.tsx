import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Retired: the password form is a section of Users & access, where the rest of
 * "who can sign in" lives. Kept as a redirect so a bookmark or a link in an
 * older doc still lands somewhere useful.
 */
export const Route = createFileRoute('/settings/admin-password')({
	beforeLoad: () => {
		throw redirect({ to: '/settings/users', replace: true });
	},
});
