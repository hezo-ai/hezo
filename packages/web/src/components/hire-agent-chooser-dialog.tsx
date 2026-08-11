import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight, type LucideIcon, MessageSquare, SquarePen, Store } from 'lucide-react';
import { useState } from 'react';
import { useLaunchChat } from '../contexts/chat-launch-context';
import { useChatConversations } from '../hooks/use-chat';
import { useProjectMeta } from '../hooks/use-projects';
import { toast } from '../hooks/use-toast';
import { type MessageKey, useI18n } from '../lib/i18n';
import { DialogContent } from './ui/dialog';

/**
 * How a hire ends. Rendered as the tone of each option's consequence line, which
 * exists because the three paths genuinely differ: a marketplace role is added
 * directly (the admin already picked it off a catalog), while the other two come
 * back as an approval to review.
 */
type Ending = 'direct' | 'approval';

interface HireOption {
	id: 'marketplace' | 'ceo' | 'manual';
	icon: LucideIcon;
	titleKey: MessageKey;
	descKey: MessageKey;
	metaKey: MessageKey;
	ending: Ending;
}

/**
 * Ordered by how much the option asks of the operator, cheapest first: the
 * marketplace asks nothing, the CEO asks a sentence, the form asks for a full
 * system prompt carrying every required substitution variable.
 */
const OPTIONS: HireOption[] = [
	{
		id: 'marketplace',
		icon: Store,
		titleKey: 'agents.hire.marketplaceTitle',
		descKey: 'agents.hire.marketplaceDesc',
		metaKey: 'agents.hire.marketplaceMeta',
		ending: 'direct',
	},
	{
		id: 'ceo',
		icon: MessageSquare,
		titleKey: 'agents.hire.ceoTitle',
		descKey: 'agents.hire.ceoDesc',
		metaKey: 'agents.hire.ceoMeta',
		ending: 'approval',
	},
	{
		id: 'manual',
		icon: SquarePen,
		titleKey: 'agents.hire.manualTitle',
		descKey: 'agents.hire.manualDesc',
		metaKey: 'agents.hire.manualMeta',
		ending: 'approval',
	},
];

const endingDot: Record<Ending, string> = {
	direct: 'bg-success-soft-fg',
	approval: 'bg-warning-soft-fg',
};

/**
 * Asks how the operator wants to hire before dropping them into any one route.
 * The hire form is the right screen for exactly one of the three answers, and was
 * the only one reachable.
 *
 * A dialog rather than a route: it is a fork, not a destination, and routing it
 * would change what `/agents/hire` means for the two deep links that open that
 * route to review an agent-filed proposal (`?approvalId=`).
 */
export function HireAgentChooserDialog({
	projectId,
	open,
	onOpenChange,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useI18n();
	const navigate = useNavigate();
	const launchChat = useLaunchChat();
	const project = useProjectMeta(projectId);
	const projectName = project?.name ?? projectId;
	// `false`: the query behind this hook is for the chat's own switcher and stays
	// disabled here. Only the create mutation is used.
	const { createThread } = useChatConversations(false);
	const [busy, setBusy] = useState(false);

	async function choose(id: HireOption['id']) {
		if (busy) return;
		if (id === 'marketplace') {
			onOpenChange(false);
			navigate({ to: '/marketplace', search: { forProject: projectId } });
			return;
		}
		if (id === 'manual') {
			onOpenChange(false);
			navigate({ to: '/projects/$projectId/agents/hire', params: { projectId } });
			return;
		}
		// The CEO chat is a global HQ surface with no per-project scope, so the thread
		// title and the draft both name the project explicitly - that is how the CEO
		// knows which team the hire is for.
		setBusy(true);
		try {
			const res = await createThread(t('agents.hire.ceoThreadTitle', { project: projectName }));
			onOpenChange(false);
			launchChat({
				conversationId: res.conversation.id,
				draft: t('agents.hire.ceoDraft', { project: projectName }),
			});
		} catch {
			// `createThread` already toasts its own failure; this only covers the
			// case where the thread was never created, so there is nothing to open.
			toast.error(t('agents.hire.ceoThreadFailed'));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="lg" data-testid="hire-chooser">
				<Dialog.Title className="text-base font-semibold pr-8">
					{t('agents.hire.chooserTitle')}
				</Dialog.Title>
				<Dialog.Description className="text-[13px] text-text-2 mt-0.5 mb-4 pr-8">
					{t('agents.hire.chooserSubtitle', { project: projectName })}
				</Dialog.Description>

				<div className="flex flex-col gap-2.5">
					{OPTIONS.map((opt) => {
						const Icon = opt.icon;
						return (
							<button
								key={opt.id}
								type="button"
								disabled={busy}
								onClick={() => choose(opt.id)}
								data-testid={`hire-option-${opt.id}`}
								className="group flex w-full items-start gap-3 rounded-lg border border-border bg-surface p-3.5 text-left shadow-xs transition-[border-color] duration-150 cursor-pointer outline-none hover:border-accent-solid focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent disabled:opacity-45 disabled:pointer-events-none"
							>
								<span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface-2 text-text-2 transition-colors group-hover:bg-accent-soft group-hover:text-accent-soft-fg">
									<Icon className="h-[17px] w-[17px]" aria-hidden />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block text-[13.5px] font-medium text-text-1">
										{t(opt.titleKey)}
									</span>
									<span className="mt-0.5 block text-[12.5px] leading-relaxed text-text-2">
										{t(opt.descKey)}
									</span>
									<span className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-text-3">
										<span
											className={`h-1.5 w-1.5 shrink-0 rounded-full ${endingDot[opt.ending]}`}
											aria-hidden
										/>
										{t(opt.metaKey)}
									</span>
								</span>
								<ChevronRight className="h-4 w-4 shrink-0 self-center text-text-3" aria-hidden />
							</button>
						);
					})}
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
