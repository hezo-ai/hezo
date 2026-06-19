import {
	CHAT_HISTORY_LIMIT_MAX,
	CHAT_HISTORY_LIMIT_MIN,
	CHAT_MEMORY_SLUG,
	DEFAULT_CHAT_HISTORY_LIMIT,
	HQ_PROJECT_SLUG,
} from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	type InstanceSettings,
	useInstanceSettings,
	useUpdateInstanceSettings,
} from '../../hooks/use-instance-settings';
import { useMe } from '../../hooks/use-me';
import type { ApiError } from '../../lib/api';

function ChatboxSettingsPage() {
	const { data: me } = useMe();
	const { data: settings } = useInstanceSettings();

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Chatbox settings are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-5">
					<div className="flex items-center gap-1.5">
						<h1 className="text-[22px] font-medium">Chatbox</h1>
						<InfoTooltip
							label="About the chatbox"
							content="Settings for the assistant chatbox — how much conversation it keeps in context and how its persistent memory works."
							data-testid="chatbox-info"
						/>
					</div>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						The chatbox is your direct line to the assistant. These settings control how much of the
						conversation it keeps in working context each turn, and explain its persistent memory.
					</p>
				</div>

				<section className="border border-border rounded-md p-4 bg-surface mb-4">
					<label className="block text-[13px] font-medium mb-1" htmlFor="chat-history-limit-input">
						Conversation history window
					</label>
					<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
						How many of the most recent chatbox messages are replayed into the assistant's context
						on each turn. A larger window keeps more of the recent conversation in view but costs
						more tokens per reply; older messages beyond the window scroll out of context (durable
						facts belong in the chatbox memory below). Must be between {CHAT_HISTORY_LIMIT_MIN} and{' '}
						{CHAT_HISTORY_LIMIT_MAX}; defaults to {DEFAULT_CHAT_HISTORY_LIMIT}.
					</p>
					{settings === undefined ? null : <HistoryLimitForm settings={settings} />}
				</section>

				<section className="border border-border rounded-md p-4 bg-surface">
					<h2 className="text-[13px] font-medium mb-1">Chatbox memory</h2>
					<p className="text-[13px] text-text-2 max-w-[680px]">
						The chatbox keeps a single persistent memory document,{' '}
						<span className="font-mono">{CHAT_MEMORY_SLUG}</span>, whose full contents are injected
						into every chat turn — so it survives even after older messages scroll out of the
						history window above. The assistant records durable operator preferences, standing
						guidelines, and anything you explicitly ask it to remember; it does not store live
						project, ticket, or comment data there (that is always read fresh). You can review and
						edit this document directly — it lives in the{' '}
						<Link
							to="/projects/$projectId/documents"
							params={{ projectId: HQ_PROJECT_SLUG }}
							className="text-accent hover:underline"
						>
							HQ project documents
						</Link>{' '}
						and cannot be deleted.
					</p>
				</section>
			</>
		);

	return (
		<div className="max-w-[900px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">{content}</div>
	);
}

function HistoryLimitForm({ settings }: { settings: InstanceSettings }) {
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(settings.chat_history_limit));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const parsed = Number.parseInt(value, 10);
		if (
			Number.isNaN(parsed) ||
			parsed < CHAT_HISTORY_LIMIT_MIN ||
			parsed > CHAT_HISTORY_LIMIT_MAX
		) {
			setError(
				`Enter a whole number between ${CHAT_HISTORY_LIMIT_MIN} and ${CHAT_HISTORY_LIMIT_MAX}.`,
			);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ chat_history_limit: parsed });
			setValue(String(result.chat_history_limit));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(settings.chat_history_limit);

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="chat-history-limit-input"
					data-testid="chat-history-limit-input"
					type="number"
					inputMode="numeric"
					min={CHAT_HISTORY_LIMIT_MIN}
					max={CHAT_HISTORY_LIMIT_MAX}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					className="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="chat-history-limit-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
				</Button>
			</div>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="chat-history-limit-error">
					{error}
				</p>
			)}
		</>
	);
}

export const Route = createFileRoute('/settings/chatbox')({
	component: ChatboxSettingsPage,
});
