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
						content="Connect external chat apps (Telegram) so you can talk to the CEO from outside the web app. Only linked identities may chat."
					/>
				</div>
				<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
					Talk to the CEO from Telegram. Paste your bot token, then link the accounts allowed to
					chat. For multiple threads, add the bot to a Topics-enabled supergroup as an admin with
					the “Manage topics” permission — each topic becomes its own conversation. A private DM is
					a single conversation.
				</p>
			</div>

			<TelegramSection />
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
			<h2 className="text-[15px] font-medium mb-1">Telegram</h2>
			<p className="text-[13px] text-text-2 mb-3 max-w-[680px]">
				Create a bot with @BotFather, then paste its token. Saving registers the inbound webhook
				automatically.
			</p>
			<ChannelForm channel="telegram" config={telegram} onSave={saveChannel} saving={saving} />
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
	const [enabled, setEnabled] = useState(config?.enabled ?? false);

	const handleSave = () =>
		onSave({
			channel,
			enabled,
			bot_token: token.trim() || undefined,
			metadata: { group_id: groupId.trim() },
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
					Topics supergroup id <span className="text-text-2">(optional, for threads)</span>
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
				Only these external accounts may chat with the CEO. Add your Telegram numeric user id (send
				a message to @userinfobot to find it); it links to your Hezo account.
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
