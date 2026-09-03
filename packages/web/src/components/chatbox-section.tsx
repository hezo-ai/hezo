import {
	CEO_AGENT_SLUG,
	DEFAULT_MAX_CHAT_HISTORY_SIZE,
	HQ_PROJECT_SLUG,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
	type InstanceSettings,
	useInstanceSettings,
	useUpdateInstanceSettings,
} from '../hooks/use-instance-settings';
import type { ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { InfoTooltip } from './ui/info-tooltip';
import { Input } from './ui/input';

const MIN_KB = Math.round(MAX_CHAT_HISTORY_SIZE_MIN / 1024);
const MAX_KB = Math.round(MAX_CHAT_HISTORY_SIZE_MAX / 1024);
const DEFAULT_KB = Math.round(DEFAULT_MAX_CHAT_HISTORY_SIZE / 1024);

function toKb(bytes: number): number {
	return Math.round(bytes / 1024);
}

/**
 * The in-app chatbox: how large its live conversation window grows before it is
 * compacted, and what its long-term memory does. A section of the Chat page,
 * beside the external channels - both answer "how do people reach the CEO".
 */
export function ChatboxSection() {
	const { t } = useI18n();
	const { data: settings } = useInstanceSettings();

	return (
		<section className="mb-8" data-testid="chatbox-section">
			<div className="flex items-center gap-1.5 mb-1">
				<h2 className="text-[15px] font-medium">{t('settings.chatbox')}</h2>
				<InfoTooltip
					label="About the chatbox"
					content="Settings for the assistant chatbox - how much conversation it keeps live before older messages are compacted into long-term memory."
					data-testid="chatbox-info"
				/>
			</div>
			<p className="text-[13px] text-text-2 mb-3 max-w-[680px]">
				The chatbox is your direct line to the assistant. These settings control how large the live
				conversation window grows before it is compacted, and explain its automatic long-term
				memory.
			</p>
			<section className="border border-border rounded-md p-4 bg-surface mb-4">
				<label className="block text-[13px] font-medium mb-1" htmlFor="chat-history-size-input">
					Conversation window size (KB)
				</label>
				<p className="text-[13px] text-text-2 mb-2.5 max-w-[680px]">
					The maximum size, in kilobytes, of the live message window the assistant keeps verbatim
					and replays into its context each turn. When the window grows past this, the assistant
					summarizes the whole window into long-term memory and all but the latest few messages are
					dropped from the chatbox. A larger window keeps more recent conversation in view but costs
					more tokens per reply. Must be between {MIN_KB} and {MAX_KB} KB; defaults to {DEFAULT_KB}{' '}
					KB.
				</p>
				{settings === undefined ? null : <HistorySizeForm settings={settings} />}
			</section>

			<section className="border border-border rounded-md p-4 bg-surface">
				<h2 className="text-[13px] font-medium mb-1">Long-term memory</h2>
				<p className="text-[13px] text-text-2 max-w-[680px]">
					When the window fills, the assistant summarizes the older messages into a durable
					long-term memory and drops them from the chatbox - so standing facts survive even as
					messages scroll out. That memory is fed back into every chat turn, and it captures durable
					operator preferences, decisions, and the gist of off-project threads (never live project
					or task data, which is always read fresh). It's maintained automatically - you never have
					to tell the assistant to remember anything. You can review and edit it on the assistant's{' '}
					<Link
						to="/projects/$projectId/agents/$agentId/chat-history"
						params={{ projectId: HQ_PROJECT_SLUG, agentId: CEO_AGENT_SLUG }}
						className="text-accent hover:underline"
					>
						Chat history
					</Link>{' '}
					tab.
				</p>
			</section>
		</section>
	);
}

function HistorySizeForm({ settings }: { settings: InstanceSettings }) {
	const updateSettings = useUpdateInstanceSettings();
	const [value, setValue] = useState(String(toKb(settings.max_chat_history_size)));
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		const kb = Number.parseInt(value, 10);
		if (Number.isNaN(kb) || kb < MIN_KB || kb > MAX_KB) {
			setError(`Enter a whole number of KB between ${MIN_KB} and ${MAX_KB}.`);
			return;
		}
		try {
			const result = await updateSettings.mutateAsync({ max_chat_history_size: kb * 1024 });
			setValue(String(toKb(result.max_chat_history_size)));
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = value.trim() !== String(toKb(settings.max_chat_history_size));

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="chat-history-size-input"
					data-testid="chat-history-size-input"
					type="number"
					inputMode="numeric"
					min={MIN_KB}
					max={MAX_KB}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					wrapperClassName="sm:w-40"
				/>
				<Button
					size="sm"
					data-testid="chat-history-size-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
				</Button>
			</div>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="chat-history-size-error">
					{error}
				</p>
			)}
		</>
	);
}
