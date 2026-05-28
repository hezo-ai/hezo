import { Fragment } from 'react';
import type { ExecutionLock } from '../../hooks/use-execution-locks';

type RunCommentRef = { id: string; content_type: string; content: unknown };

interface RunningAgentsLineProps {
	locks: ExecutionLock[];
	comments: RunCommentRef[];
}

export function RunningAgentsLine({ locks, comments }: RunningAgentsLineProps) {
	const runCommentIdByAgentId = new Map<string, string>();
	for (const c of comments) {
		if (c.content_type !== 'run') continue;
		const agentId =
			c.content && typeof c.content === 'object'
				? (c.content as { agent_id?: string }).agent_id
				: undefined;
		if (agentId) runCommentIdByAgentId.set(agentId, c.id);
	}

	const ordered = [...locks].sort((a, b) => a.locked_at.localeCompare(b.locked_at));

	const nameNodes = ordered.map((l) => {
		const commentId = runCommentIdByAgentId.get(l.member_id);
		if (!commentId) {
			return (
				<span key={l.id} className="text-accent-blue-text font-medium">
					{l.member_name}
				</span>
			);
		}
		const targetId = `comment-${commentId}`;
		return (
			<a
				key={l.id}
				href={`#${targetId}`}
				onClick={(e) => {
					// Drive scroll via the hash so the task page's hashchange handler
					// can ask Virtuoso to mount and scroll to the row even when it
					// isn't currently in the DOM. Falling back to scrollIntoView
					// alone silently fails for off-screen virtualized rows.
					e.preventDefault();
					const next = `#${targetId}`;
					if (window.location.hash === next) {
						window.dispatchEvent(new HashChangeEvent('hashchange'));
					} else {
						window.history.pushState(null, '', next);
						window.dispatchEvent(new HashChangeEvent('hashchange'));
					}
				}}
				className="text-accent-blue-text font-medium hover:underline"
			>
				{l.member_name}
			</a>
		);
	});

	const parts: { key: string; node: React.ReactNode }[] = [];
	for (let i = 0; i < ordered.length; i++) {
		if (i > 0) {
			const isLastGap = i === ordered.length - 1;
			const sep = ordered.length === 2 ? ' and ' : isLastGap ? ', and ' : ', ';
			parts.push({ key: `sep-${ordered[i].id}`, node: sep });
		}
		parts.push({ key: `name-${ordered[i].id}`, node: nameNodes[i] });
	}

	const verb = ordered.length === 1 ? 'is' : 'are';

	return (
		<div
			className="rounded-radius-md bg-accent-blue-bg px-3 py-2 text-xs"
			data-testid="running-agents-line"
		>
			<span className="inline-block w-2 h-2 rounded-full bg-accent-blue animate-pulse mr-1.5 align-middle" />
			{parts.map((p) => (
				<Fragment key={p.key}>{p.node}</Fragment>
			))}{' '}
			<span className="text-text-muted">{verb} running</span>
		</div>
	);
}
