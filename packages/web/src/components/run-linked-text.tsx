import { splitRunLinks } from '@hezo/shared';
import { Link } from '@tanstack/react-router';

/**
 * Server-written text that may name another run - a `[runner]` log line, a
 * chat notice - with each named run rendered as a link to its page and
 * everything else verbatim. The text is split by the same helper that wrote
 * the reference, so the two cannot drift.
 */
export function RunLinkedText({ text, className }: { text: string; className?: string }) {
	const segments = splitRunLinks(text);
	return (
		<>
			{segments.map((segment, i) =>
				'link' in segment ? (
					<Link
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
						key={i}
						to="/projects/$projectId/agents/$agentId/executions/$runId"
						params={{
							projectId: segment.link.projectSlug,
							agentId: segment.link.agentSlug,
							runId: segment.link.runId,
						}}
						className={className ?? 'underline underline-offset-2 hover:text-text-1'}
						data-testid="run-link"
					>
						{segment.label}
					</Link>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
					<span key={i}>{segment.text}</span>
				),
			)}
		</>
	);
}
