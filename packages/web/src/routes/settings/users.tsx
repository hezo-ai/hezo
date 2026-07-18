import { createFileRoute } from '@tanstack/react-router';
import { IconUploadSection } from '../../components/icon-upload-section';
import { getInitials } from '../../components/ui/avatar';
import { useMe } from '../../hooks/use-me';
import {
	type AdminUser,
	useRemoveUserIcon,
	useUploadUserIcon,
	useUsers,
} from '../../hooks/use-users';

function UserRow({ user }: { user: AdminUser }) {
	const upload = useUploadUserIcon(user.id);
	const remove = useRemoveUserIcon(user.id);

	return (
		<div className="rounded-lg border border-border-subtle bg-surface p-4">
			<div className="mb-3">
				<div className="text-sm font-medium text-text-1">{user.display_name}</div>
				<div className="text-xs text-text-3">{user.is_superuser ? 'Admin' : 'User'}</div>
			</div>
			<IconUploadSection
				label="Avatar"
				helpText="Your profile picture. Square images work best; we crop to a square and resize to 512×512. Leave unset to show your initials."
				initials={getInitials(user.display_name || 'Admin')}
				currentIconUrl={user.icon_url}
				onUpload={(blob) => upload.mutateAsync(blob)}
				onRemove={() => remove.mutateAsync()}
				isUploading={upload.isPending}
				isRemoving={remove.isPending}
				testIdPrefix="user-icon"
			/>
		</div>
	);
}

function UsersPage() {
	const { data: me } = useMe();
	const { data: users, isLoading } = useUsers();

	if (me && !me.is_superuser) {
		return (
			<div className="max-w-[900px]">
				<p className="text-[13px] text-text-2">
					Users are managed by the Admin. You don't have access to this page.
				</p>
			</div>
		);
	}

	return (
		<div className="max-w-[900px]">
			<div className="mb-5">
				<h1 className="text-[22px] font-medium">Users</h1>
				<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
					The people with access to this Hezo instance. Set an avatar to personalize how you appear
					across the app.
				</p>
			</div>
			{isLoading ? (
				<p className="text-[13px] text-text-2">Loading…</p>
			) : (
				<div className="flex flex-col gap-4" data-testid="users-list">
					{users?.map((user) => (
						<UserRow key={user.id} user={user} />
					))}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/settings/users')({
	component: UsersPage,
});
