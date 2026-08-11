import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatConversationSummary } from '../../hooks/use-chat';
import { useAllVisibleProjects } from '../../hooks/use-projects';
import { toast } from '../../hooks/use-toast';
import { useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';
import { Input } from '../ui/input';

/**
 * Convert a chat conversation into a task: pick the target project, optionally
 * override the title (the thread's auto-title is the default), confirm. The
 * server does the rest — transcript into the description, CEO assigned, thread
 * closed with a meta message — so on success this just closes; the refetched
 * thread renders the converted state.
 */
export function ConvertToTaskDialog({
	open,
	onOpenChange,
	thread,
	convertThread,
	converting,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	thread: ChatConversationSummary;
	convertThread: (input: { id: string; projectId: string; title?: string }) => Promise<unknown>;
	converting: boolean;
}) {
	const { t } = useI18n();
	const { projects } = useAllVisibleProjects();
	const [projectSlug, setProjectSlug] = useState('');
	const [title, setTitle] = useState('');

	// Re-seed per open: the title default tracks the thread's (auto-)title at the
	// moment the dialog opens, and a stale project pick never carries over.
	useEffect(() => {
		if (open) {
			setProjectSlug('');
			setTitle(thread.title?.trim() ?? '');
		}
	}, [open, thread.title]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!projectSlug || converting) return;
		try {
			await convertThread({
				id: thread.id,
				projectId: projectSlug,
				title: title.trim() || undefined,
			});
			onOpenChange(false);
		} catch (err) {
			toast.error((err as { message?: string })?.message ?? t('chat.convert.failed'));
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" data-testid="chat-convert-dialog">
				<Dialog.Title className="mb-1 pr-10 text-lg font-semibold">
					{t('chat.convert.dialogTitle')}
				</Dialog.Title>
				<Dialog.Description className="mb-4 text-sm text-text-2">
					{t('chat.convert.dialogDescription')}
				</Dialog.Description>
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<label className="flex flex-col gap-1.5">
						<span className="text-sm text-text-2">{t('chat.convert.projectLabel')} *</span>
						<select
							value={projectSlug}
							onChange={(e) => setProjectSlug(e.target.value)}
							required
							data-testid="chat-convert-project"
							className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
						>
							<option value="">{t('chat.convert.selectProject')}</option>
							{projects.map((p) => (
								<option key={p.id} value={p.slug}>
									{p.name}
								</option>
							))}
						</select>
					</label>
					<Input
						label={t('chat.convert.titleLabel')}
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						data-testid="chat-convert-title"
					/>
					<p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-text-2">
						{t('chat.convert.note')}
					</p>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
							{t('common.cancel')}
						</Button>
						<Button
							type="submit"
							disabled={!projectSlug || converting}
							data-testid="chat-convert-submit"
						>
							{converting && <Loader2 className="h-4 w-4 animate-spin" />}
							{converting ? t('chat.convert.converting') : t('chat.convert.confirm')}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}
