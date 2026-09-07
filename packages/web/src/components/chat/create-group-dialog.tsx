import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ProjectChatRoomSummary } from '../../hooks/use-chat';
import { toast } from '../../hooks/use-toast';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { queryKeys } from '../../lib/query-keys';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';

/**
 * Create a group room: a name and the teammates in it. Participants come from
 * the enabled roster (the DM list already carries it); the server validates
 * the same rule, so a stale roster fails loudly rather than quietly shrinking
 * the room. Response-driven - the room only exists once the server says so.
 */
export function CreateGroupDialog({
	projectSlug,
	agents,
	onClose,
	onCreated,
}: {
	projectSlug: string;
	agents: ProjectChatRoomSummary[];
	onClose: () => void;
	onCreated: (created: { conversationId: string; title: string }) => void;
}) {
	const { t } = useI18n();
	const queryClient = useQueryClient();
	const [title, setTitle] = useState('');
	const [selected, setSelected] = useState<string[]>([]);

	const toggle = (slug: string) => {
		setSelected((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
	};

	const create = useMutation({
		mutationFn: () =>
			api.post<{ conversation_id: string; title: string }>(
				`/api/projects/${encodeURIComponent(projectSlug)}/chat/groups`,
				{ title: title.trim(), participant_slugs: selected },
			),
		// Await the room-list refetch before selecting the new room: the switcher's
		// options come from that list, and the dead-room fallback would boot a
		// selection the list does not carry yet straight back to the CEO.
		onSuccess: async (data) => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.projectChatRooms(projectSlug) });
			onCreated({ conversationId: data.conversation_id, title: data.title });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? t('chat.group.createFailed'));
		},
	});

	const canSubmit = title.trim().length > 0 && selected.length > 0 && !create.isPending;

	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<DialogContent size="sm" data-testid="chat-create-group-dialog">
				<Dialog.Title className="text-sm font-semibold text-text-1">
					{t('chat.group.createTitle')}
				</Dialog.Title>
				<form
					className="mt-3 flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (canSubmit) create.mutate();
					}}
				>
					<label className="flex flex-col gap-1 text-[12px] text-text-2">
						{t('chat.group.nameLabel')}
						<input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							data-testid="chat-create-group-name"
							maxLength={120}
							className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-text-1 outline-none focus:border-border-strong"
						/>
					</label>
					<fieldset className="flex flex-col gap-1">
						<legend className="pb-1 text-[12px] text-text-2">
							{t('chat.group.participantsLabel')}
						</legend>
						<div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5">
							{agents.map((a) => (
								<label
									key={a.member_id}
									className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-[13px] text-text-1 hover:bg-surface-2"
								>
									<input
										type="checkbox"
										checked={selected.includes(a.slug)}
										onChange={() => toggle(a.slug)}
										data-testid="chat-create-group-participant"
									/>
									<span className="min-w-0 truncate">{a.title}</span>
									<span className="text-[11px] text-text-3">@{a.slug}</span>
								</label>
							))}
						</div>
					</fieldset>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={onClose}>
							{t('common.cancel')}
						</Button>
						<Button type="submit" disabled={!canSubmit} data-testid="chat-create-group-submit">
							{t('chat.group.create')}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}
