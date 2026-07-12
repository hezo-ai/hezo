import type { SkillRecord } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { MarkdownProse } from './markdown-prose';
import { Badge } from './ui/badge';
import { DialogContent } from './ui/dialog';

interface SkillViewDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The full skill (including `content`). Undefined while it loads. */
	skill: SkillRecord | undefined;
	/** Name shown in the title while the full skill is still loading. */
	fallbackName?: string;
}

/**
 * Read-only skill viewer: renders a skill's markdown content in a modal. Shared
 * by the global Skills page and the per-project Skills page so any skill — a
 * stored one or the built-in, non-editable `connector-recipes` — can be read in
 * full without leaving the page.
 */
export function SkillViewDialog({ open, onOpenChange, skill, fallbackName }: SkillViewDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="2xl" data-testid="skill-view-dialog">
				<Dialog.Title className="pr-8 text-lg font-semibold">
					{skill?.name ?? fallbackName ?? 'Skill'}
				</Dialog.Title>
				{skill?.description ? (
					<Dialog.Description className="mt-1 text-[13px] text-text-2">
						{skill.description}
					</Dialog.Description>
				) : (
					<Dialog.Description className="sr-only">Skill content</Dialog.Description>
				)}
				{skill && skill.tags.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1">
						{skill.tags.map((t) => (
							<Badge key={t} color="neutral">
								{t}
							</Badge>
						))}
					</div>
				)}
				<div className="mt-4 min-h-[120px]">
					{skill ? (
						<MarkdownProse testId="skill-view-content">{skill.content}</MarkdownProse>
					) : (
						<div className="flex items-center gap-2 text-[13px] text-text-2">
							<Loader2 className="h-4 w-4 animate-spin" /> Loading…
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
