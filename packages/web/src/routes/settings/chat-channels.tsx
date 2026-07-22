import { createFileRoute } from '@tanstack/react-router';
import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import {
	type ChatChannelConfigView,
	useChatChannels,
	useChatIdentities,
} from '../../hooks/use-chat-channels';
import { useMe } from '../../hooks/use-me';

function ChatChannelsSettingsPage() {
	const { data: me } = useMe();
	if (me && !me.is_superuser) {
		return (
			<div className="max-w-[900px]">
				<p className="text-[13px] text-text-2">
					Chat channels are managed by the Admin. You don't have access to this page.
				</p>
			</div>
		);
	}
	return (
		<div className="max-w-[900px]">
			<div className="mb-5">
				<div className="flex items-center gap-1.5">
					<h1 className="text-[22px] font-medium">Chat channels</h1>
					<InfoTooltip
						label="About chat channels"
						content="Connect external chat apps (Telegram, Slack) so the CEO is reachable outside the web app — as a personal assistant over DM, or as a coworker in your team's channels."
					/>
				</div>
				<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
					Chat apps connect in two modes. <span className="font-medium">Assistant (DM)</span>: DM
					the bot and the conversation is a real-time CEO chat thread, mirrored with the chatbox
					here — only linked identities may chat.{' '}
					<span className="font-medium">Coworker (channels)</span>: invite the bot to a channel and
					anyone there can @-mention it; it reads the channel history for context and replies
					in-thread. Those conversations stay in the chat app and never appear in the web chatbox.
				</p>
			</div>

			<TelegramSection />
			<SlackSection />
			<IdentitiesSection />
		</div>
	);
}

function TelegramSection() {
	const { channels, saveChannel, saving } = useChatChannels();
	const telegram = channels.find((c) => c.channel === 'telegram');
	return (
		<section
			className="border border-border rounded-md p-4 bg-surface mb-4"
			data-testid="telegram-channel"
		>
			<h2 className="text-[15px] font-medium mb-1">
				Telegram{' '}
				<span className="text-text-2 font-normal text-[13px]">— assistant + coworker modes</span>
			</h2>
			<p className="text-[13px] text-text-2 mb-3 max-w-[680px]">
				Create a bot with @BotFather, then paste its token. Saving registers the inbound webhook
				automatically. A private DM is one thread; the Topics supergroup you designate below gives
				you parallel personal threads (one per topic). For coworker mode, add the bot to any other
				group and disable BotFather privacy mode (/setprivacy → Disable) so it can see mentions —
				anyone there can then @-mention it, and it answers with the group’s recent messages as
				context.
			</p>
			<ChannelForm channel="telegram" config={telegram} onSave={saveChannel} saving={saving} />
		</section>
	);
}

function SlackSection() {
	const { channels, saveChannel, saving } = useChatChannels();
	const slack = channels.find((c) => c.channel === 'slack');
	const [botToken, setBotToken] = useState('');
	const [appToken, setAppToken] = useState('');
	const [enabled, setEnabled] = useState(slack?.enabled ?? false);
	const [dmMode, setDmMode] = useState(slack?.metadata?.dm_mode_enabled !== false);
	const [groupMode, setGroupMode] = useState(slack?.metadata?.group_mode_enabled !== false);
	const [validationErrors, setValidationErrors] = useState<string[]>([]);

	const handleSave = async () => {
		const result = await saveChannel({
			channel: 'slack',
			enabled,
			bot_token: botToken.trim() || undefined,
			app_token: appToken.trim() || undefined,
			metadata: { dm_mode_enabled: dmMode, group_mode_enabled: groupMode },
		});
		setBotToken('');
		setAppToken('');
		setValidationErrors(
			result?.validation && !result.validation.ok ? result.validation.errors : [],
		);
	};

	return (
		<section
			className="border border-border rounded-md p-4 bg-surface mb-4"
			data-testid="slack-channel"
		>
			<h2 className="text-[15px] font-medium mb-1">
				Slack{' '}
				<span className="text-text-2 font-normal text-[13px]">— assistant + coworker modes</span>
			</h2>
			<p className="text-[13px] text-text-2 mb-3 max-w-[680px]">
				The CEO joins your Slack workspace as a coworker: invite it to a channel, @-mention it, and
				it reads the conversation for context and replies in the thread. It also answers DMs as a
				personal assistant (linked identities only). Create the Slack app from the manifest in the
				docs, install it, then paste both tokens — no public URL needed (Socket Mode).
			</p>
			<div className="flex flex-col gap-3">
				<label className="flex items-center gap-2 text-[13px]">
					<input
						type="checkbox"
						data-testid="slack-enabled"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
					/>
					Enabled
				</label>
				<div>
					<label className="block text-[13px] font-medium mb-1" htmlFor="slack-token">
						Bot token <span className="text-text-2">(xoxb-…)</span>{' '}
						{slack?.has_token && <span className="text-text-2">(set — paste to replace)</span>}
					</label>
					<Input
						id="slack-token"
						data-testid="slack-token"
						type="password"
						autoComplete="off"
						placeholder={slack?.has_token ? '••••••••' : 'Paste bot token'}
						value={botToken}
						onChange={(e) => setBotToken(e.target.value)}
						className="sm:w-96"
					/>
				</div>
				<div>
					<label className="block text-[13px] font-medium mb-1" htmlFor="slack-app-token">
						App-level token <span className="text-text-2">(xapp-…, Socket Mode)</span>{' '}
						{slack?.has_app_token && <span className="text-text-2">(set — paste to replace)</span>}
					</label>
					<Input
						id="slack-app-token"
						data-testid="slack-app-token"
						type="password"
						autoComplete="off"
						placeholder={slack?.has_app_token ? '••••••••' : 'Paste app-level token'}
						value={appToken}
						onChange={(e) => setAppToken(e.target.value)}
						className="sm:w-96"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<label className="flex items-center gap-2 text-[13px]">
						<input
							type="checkbox"
							data-testid="slack-group-mode"
							checked={groupMode}
							onChange={(e) => setGroupMode(e.target.checked)}
						/>
						Coworker mode — respond to @-mentions in channels the bot is invited to
					</label>
					<label className="flex items-center gap-2 text-[13px]">
						<input
							type="checkbox"
							data-testid="slack-dm-mode"
							checked={dmMode}
							onChange={(e) => setDmMode(e.target.checked)}
						/>
						Assistant mode — answer DMs from linked identities (mirrored to the web chatbox)
					</label>
				</div>
				{validationErrors.length > 0 && (
					<ul className="text-[13px] text-danger" data-testid="slack-validation-errors">
						{validationErrors.map((err) => (
							<li key={err}>{err}</li>
						))}
					</ul>
				)}
				<div>
					<Button size="sm" data-testid="slack-save" onClick={handleSave} disabled={saving}>
						{saving && <Loader2 className="w-3 h-3 animate-spin" />} Save
					</Button>
				</div>
			</div>
		</section>
	);
}

function ChannelForm({
	channel,
	config,
	onSave,
	saving,
}: {
	channel: string;
	config: ChatChannelConfigView | undefined;
	onSave: (input: {
		channel: string;
		enabled: boolean;
		bot_token?: string;
		metadata?: Record<string, unknown>;
	}) => Promise<unknown>;
	saving: boolean;
}) {
	const [token, setToken] = useState('');
	const [groupId, setGroupId] = useState(String((config?.metadata?.group_id as string) ?? ''));
	const [groupMode, setGroupMode] = useState(config?.metadata?.group_mode_enabled !== false);
	const [enabled, setEnabled] = useState(config?.enabled ?? false);

	const handleSave = () =>
		onSave({
			channel,
			enabled,
			bot_token: token.trim() || undefined,
			metadata: { group_id: groupId.trim(), group_mode_enabled: groupMode },
		}).then(() => setToken(''));

	return (
		<div className="flex flex-col gap-3">
			<label className="flex items-center gap-2 text-[13px]">
				<input
					type="checkbox"
					data-testid={`${channel}-enabled`}
					checked={enabled}
					onChange={(e) => setEnabled(e.target.checked)}
				/>
				Enabled
			</label>
			<div>
				<label className="block text-[13px] font-medium mb-1" htmlFor={`${channel}-token`}>
					Bot token{' '}
					{config?.has_token && <span className="text-text-2">(set — paste to replace)</span>}
				</label>
				<Input
					id={`${channel}-token`}
					data-testid={`${channel}-token`}
					type="password"
					autoComplete="off"
					placeholder={config?.has_token ? '••••••••' : 'Paste bot token'}
					value={token}
					onChange={(e) => setToken(e.target.value)}
					className="sm:w-96"
				/>
			</div>
			<div>
				<label className="block text-[13px] font-medium mb-1" htmlFor={`${channel}-group`}>
					Your Topics supergroup id{' '}
					<span className="text-text-2">(optional — your personal parallel threads)</span>
				</label>
				<Input
					id={`${channel}-group`}
					data-testid={`${channel}-group`}
					placeholder="-1001234567890"
					value={groupId}
					onChange={(e) => setGroupId(e.target.value)}
					className="sm:w-96"
				/>
			</div>
			<label className="flex items-center gap-2 text-[13px]">
				<input
					type="checkbox"
					data-testid={`${channel}-group-mode`}
					checked={groupMode}
					onChange={(e) => setGroupMode(e.target.checked)}
				/>
				Coworker mode — respond to mentions in other groups the bot is added to
			</label>
			<div>
				<Button size="sm" data-testid={`${channel}-save`} onClick={handleSave} disabled={saving}>
					{saving && <Loader2 className="w-3 h-3 animate-spin" />} Save
				</Button>
			</div>
		</div>
	);
}

function IdentitiesSection() {
	const { data: me } = useMe();
	const { identities, linkIdentity, unlinkIdentity } = useChatIdentities();
	const [channel, setChannel] = useState('telegram');
	const [externalId, setExternalId] = useState('');
	const [handle, setHandle] = useState('');

	const handleLink = async () => {
		if (!externalId.trim() || !me?.user_id) return;
		await linkIdentity({
			channel,
			external_user_id: externalId.trim(),
			user_id: me.user_id,
			external_handle: handle.trim() || undefined,
		});
		setExternalId('');
		setHandle('');
	};

	return (
		<section className="border border-border rounded-md p-4 bg-surface" data-testid="identities">
			<h2 className="text-[15px] font-medium mb-1">Allowed identities</h2>
			<p className="text-[13px] text-text-2 mb-3 max-w-[680px]">
				Only these external accounts may DM the CEO (assistant mode). Telegram: your numeric user id
				(message @userinfobot to find it). Slack: your member ID (profile → ⋯ → Copy member ID,
				starts with U). Coworker mode doesn't use this list — inviting the bot to a channel is the
				authorization there.
			</p>

			<div className="flex flex-col gap-2 sm:flex-row sm:items-end mb-4">
				<div>
					<label className="block text-[13px] font-medium mb-1" htmlFor="identity-channel">
						Channel
					</label>
					<select
						id="identity-channel"
						data-testid="identity-channel"
						value={channel}
						onChange={(e) => setChannel(e.target.value)}
						className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px]"
					>
						<option value="telegram">Telegram</option>
						<option value="slack">Slack</option>
					</select>
				</div>
				<div>
					<label className="block text-[13px] font-medium mb-1" htmlFor="identity-external-id">
						External user id
					</label>
					<Input
						id="identity-external-id"
						data-testid="identity-external-id"
						value={externalId}
						onChange={(e) => setExternalId(e.target.value)}
						className="sm:w-48"
					/>
				</div>
				<div>
					<label className="block text-[13px] font-medium mb-1" htmlFor="identity-handle">
						Handle <span className="text-text-2">(optional)</span>
					</label>
					<Input
						id="identity-handle"
						data-testid="identity-handle"
						placeholder="@you"
						value={handle}
						onChange={(e) => setHandle(e.target.value)}
						className="sm:w-40"
					/>
				</div>
				<Button
					size="sm"
					data-testid="identity-add"
					onClick={handleLink}
					disabled={!externalId.trim()}
				>
					Link to me
				</Button>
			</div>

			{identities.length === 0 ? (
				<p className="text-[13px] text-text-2">No linked identities yet.</p>
			) : (
				<ul className="divide-y divide-border" data-testid="identity-list">
					{identities.map((i) => (
						<li key={i.id} className="flex items-center justify-between py-2 text-[13px]">
							<span>
								<span className="font-medium capitalize">{i.channel}</span> ·{' '}
								{i.external_handle || i.external_user_id} → {i.display_name}
							</span>
							<button
								type="button"
								aria-label="Unlink identity"
								data-testid={`identity-remove-${i.id}`}
								onClick={() => unlinkIdentity(i.id)}
								className="flex h-8 w-8 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-danger"
							>
								<Trash2 className="h-4 w-4" />
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

export const Route = createFileRoute('/settings/chat-channels')({
	component: ChatChannelsSettingsPage,
});
