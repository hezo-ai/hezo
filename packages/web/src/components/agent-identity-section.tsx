import { humanNameError } from '@hezo/shared';
import { useState } from 'react';
import { type Agent, useGenerateAgentAvatar, useUpdateAgent } from '../hooks/use-agents';
import { agentAvatarUrl, generateAvatarOptions } from '../lib/agent-avatar';
import { useI18n } from '../lib/i18n';
import { agentDisplayName } from './agent-identity-tooltip';
import { Avatar, getInitials } from './ui/avatar';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface AgentIdentitySectionProps {
	projectId: string;
	agent: Agent;
	/** Roles addressed only by their role (Captain, CEO, Coach) hide the name field. */
	nameEditable: boolean;
}

/**
 * Who this agent is: the name it goes by, and the face it shows.
 *
 * Avatars are generated rather than uploaded, so the control is a shuffle: three
 * candidates are drawn locally (a preview costs nothing), and picking one sends
 * just its seed for the server to compose the stored spec around.
 */
export function AgentIdentitySection({
	projectId,
	agent,
	nameEditable,
}: AgentIdentitySectionProps) {
	const { t } = useI18n();
	const updateAgent = useUpdateAgent(projectId, agent.slug);
	const generateAvatar = useGenerateAgentAvatar(projectId, agent.slug);

	const [name, setName] = useState(agent.human_name ?? '');
	const [nameError, setNameError] = useState<string | null>(null);
	const [options, setOptions] = useState<Array<{ seed: string; url: string }> | null>(null);
	const [picked, setPicked] = useState<string | null>(null);

	const dirty = name.trim() !== (agent.human_name ?? '').trim();

	async function saveName() {
		const invalid = humanNameError(name);
		if (invalid) {
			setNameError(invalid);
			return;
		}
		setNameError(null);
		await updateAgent.mutateAsync({ human_name: name.trim() });
	}

	return (
		<div className="rounded-lg border border-border-subtle bg-surface p-4">
			<h3 className="mb-1 text-sm font-semibold">{t('agents.identity.title')}</h3>
			<p className="mb-4 text-xs text-text-2">{t('agents.identity.help')}</p>

			{nameEditable && (
				<div className="mb-5 max-w-sm">
					<label className="mb-1 block text-xs font-medium text-text-2" htmlFor="agent-human-name">
						{t('agents.identity.nameLabel')}
					</label>
					<div className="flex gap-2">
						<Input
							id="agent-human-name"
							value={name}
							onChange={(e) => {
								setName(e.target.value);
								setNameError(null);
							}}
							placeholder={agent.title}
							data-testid="agent-name-input"
						/>
						<Button
							type="button"
							onClick={saveName}
							disabled={!dirty || updateAgent.isPending}
							data-testid="agent-name-save"
						>
							{t('common.save')}
						</Button>
					</div>
					<p className="mt-1 text-xs text-text-3">{t('agents.identity.nameHelp')}</p>
					{nameError && (
						<p className="mt-1 text-xs text-danger" data-testid="agent-name-error">
							{nameError}
						</p>
					)}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-4">
				<Avatar
					size="lg"
					initials={getInitials(agentDisplayName(agent))}
					imageUrl={agentAvatarUrl(agent)}
				/>
				<div className="flex flex-col gap-1">
					<Button
						type="button"
						variant="secondary"
						onClick={() => {
							setOptions(generateAvatarOptions(agent));
							setPicked(null);
						}}
						data-testid="agent-avatar-generate"
					>
						{options ? t('agents.identity.avatarShuffle') : t('agents.identity.avatarGenerate')}
					</Button>
					<span className="text-xs text-text-3">{t('agents.identity.avatarHelp')}</span>
				</div>
			</div>

			{options && (
				<div className="mt-4" data-testid="agent-avatar-options">
					<p className="mb-2 text-xs font-medium text-text-2">{t('agents.identity.avatarPick')}</p>
					<div className="flex flex-wrap items-center gap-3">
						{options.map((option) => (
							<button
								key={option.seed}
								type="button"
								aria-pressed={picked === option.seed}
								onClick={() => setPicked(option.seed)}
								className={`rounded-lg border-2 p-1.5 transition-colors ${
									picked === option.seed
										? 'border-accent bg-accent-soft'
										: 'border-transparent hover:bg-surface-2'
								}`}
								data-testid="agent-avatar-option"
							>
								<Avatar size="lg" initials="" imageUrl={option.url} />
							</button>
						))}
						<Button
							type="button"
							disabled={!picked || generateAvatar.isPending}
							onClick={async () => {
								if (!picked) return;
								await generateAvatar.mutateAsync(picked);
								setOptions(null);
								setPicked(null);
							}}
							data-testid="agent-avatar-save"
						>
							{t('common.save')}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
