import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { ChatMessage, ChatRoom, GroupParticipant } from '../../hooks/use-chat';
import { useProjectChatRooms } from '../../hooks/use-chat';
import { useProjectsIndex } from '../../hooks/use-projects';
import { toast } from '../../hooks/use-toast';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';

/** How much of the message seeds the suggested task title. */
const TITLE_SEED_MAX_CHARS = 80;

interface ConvertedTask {
	id: string;
	identifier: string;
	title: string;
}

/**
 * Message-level convert: one chat message becomes one task, and the
 * conversation survives. In a project room the task lands in that project
 * (assignee defaulting to the DM partner, or the Captain in a group room); the
 * CEO stream spans every project, so there the dialog asks which project first
 * and the target's Captain triages. The created task lives on another page, so
 * the confirmation is a toast with the way there.
 */
export function ConvertMessageDialog({
	room,
	conversationId,
	message,
	participants,
	onClose,
}: {
	room: ChatRoom;
	/** The resolved conversation the message lives in; null only before history loads. */
	conversationId: string | null;
	message: ChatMessage;
	/** Group rooms: the roster, for the assignee picker. */
	participants: readonly GroupParticipant[];
	onClose: () => void;
}) {
	const { t } = useI18n();
	const navigate = useNavigate();
	const isProjectRoom = room.kind === 'agent' || room.kind === 'group';
	const projectSlug = isProjectRoom ? room.projectSlug : null;
	// The assignee options for a project room: the enabled roster (the DM list
	// already carries it; no second roster endpoint).
	const { rooms: rosterRooms } = useProjectChatRooms(projectSlug, isProjectRoom);
	const projectsQuery = useProjectsIndex();
	const projects = (projectsQuery.data ?? []).filter((p) => !p.is_internal && !p.archived_at);

	const firstLine = message.content.split('\n')[0]?.trim() ?? '';
	const [title, setTitle] = useState(
		firstLine.length > TITLE_SEED_MAX_CHARS
			? `${firstLine.slice(0, TITLE_SEED_MAX_CHARS - 1)}…`
			: firstLine,
	);
	const [assigneeSlug, setAssigneeSlug] = useState('');
	const [targetProject, setTargetProject] = useState('');

	const assigneeOptions =
		room.kind === 'group'
			? participants.map((p) => ({ slug: p.slug, label: p.display_name || p.title }))
			: rosterRooms.map((r) => ({ slug: r.slug, label: r.title }));
	const defaultAssigneeLabel =
		room.kind === 'agent'
			? t('chat.convert.assigneeDefaultAgent', { name: room.title })
			: t('chat.convert.assigneeDefaultCaptain');

	const convert = useMutation({
		mutationFn: () => {
			if (isProjectRoom) {
				return api.post<ConvertedTask>(
					`/api/projects/${encodeURIComponent(room.projectSlug)}/chat/conversations/${encodeURIComponent(conversationId ?? '')}/convert`,
					{
						message_id: message.id,
						title: title.trim(),
						...(assigneeSlug ? { assignee_slug: assigneeSlug } : {}),
					},
				);
			}
			return api.post<ConvertedTask>(
				`/api/chat/conversations/${encodeURIComponent(conversationId ?? '')}/convert-message`,
				{ message_id: message.id, title: title.trim(), project: targetProject },
			);
		},
		onSuccess: (task) => {
			const slug = isProjectRoom ? room.projectSlug : targetProject;
			const taskId = task.identifier.toLowerCase();
			toast.success(t('chat.convert.success', { identifier: task.identifier }), {
				link: {
					label: t('chat.convert.viewTask'),
					href: `/projects/${slug}/tasks/${taskId}`,
					onNavigate: () =>
						navigate({
							to: '/projects/$projectId/tasks/$taskId',
							params: { projectId: slug, taskId },
						}),
				},
			});
			onClose();
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? t('chat.convert.failed'));
		},
	});

	const canSubmit =
		title.trim().length > 0 &&
		conversationId !== null &&
		(isProjectRoom || targetProject !== '') &&
		!convert.isPending;

	const selectClass =
		'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-text-1';

	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<DialogContent size="sm" data-testid="chat-convert-dialog">
				<Dialog.Title className="text-sm font-semibold text-text-1">
					{t('chat.convert.title')}
				</Dialog.Title>
				<Dialog.Description className="mt-1 text-[12px] text-text-2">
					{t('chat.convert.description')}
				</Dialog.Description>
				<form
					className="mt-3 flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (canSubmit) convert.mutate();
					}}
				>
					<label className="flex flex-col gap-1 text-[12px] text-text-2">
						{t('chat.convert.titleLabel')}
						<input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							data-testid="chat-convert-title"
							className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-text-1 outline-none focus:border-border-strong"
						/>
					</label>
					{isProjectRoom ? (
						<label className="flex flex-col gap-1 text-[12px] text-text-2">
							{t('chat.convert.assigneeLabel')}
							<select
								value={assigneeSlug}
								onChange={(e) => setAssigneeSlug(e.target.value)}
								data-testid="chat-convert-assignee"
								className={selectClass}
							>
								<option value="">{defaultAssigneeLabel}</option>
								{assigneeOptions.map((a) => (
									<option key={a.slug} value={a.slug}>
										{a.label}
									</option>
								))}
							</select>
						</label>
					) : (
						<label className="flex flex-col gap-1 text-[12px] text-text-2">
							{t('chat.convert.projectLabel')}
							<select
								value={targetProject}
								onChange={(e) => setTargetProject(e.target.value)}
								data-testid="chat-convert-project"
								className={selectClass}
							>
								<option value="">{t('chat.convert.projectPlaceholder')}</option>
								{projects.map((p) => (
									<option key={p.id} value={p.slug}>
										{p.name}
									</option>
								))}
							</select>
							<span className="text-[11px] text-text-3">
								{t('chat.convert.assigneeDefaultCaptain')}
							</span>
						</label>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={onClose}>
							{t('common.cancel')}
						</Button>
						<Button type="submit" disabled={!canSubmit} data-testid="chat-convert-submit">
							{t('chat.convert.submit')}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}
