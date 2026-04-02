import { Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useChatMessages, useSendChatMessage } from '../hooks/use-live-chat';
import { Button } from './ui/button';

interface LiveChatPanelProps {
	companyId: string;
	issueId: string;
	agents?: { slug: string; title: string }[];
}

export function LiveChatPanel({ companyId, issueId, agents = [] }: LiveChatPanelProps) {
	const { data: messages } = useChatMessages(companyId, issueId);
	const sendMessage = useSendChatMessage(companyId, issueId);
	const [input, setInput] = useState('');
	const [showMentions, setShowMentions] = useState(false);
	const [mentionFilter, setMentionFilter] = useState('');
	const scrollRef = useRef<HTMLDivElement>(null);

	const messageCount = messages?.length ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollRef is a stable ref
	useEffect(() => {
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messageCount]);

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!input.trim()) return;
		sendMessage.mutate(input.trim());
		setInput('');
		setShowMentions(false);
	}

	function handleInputChange(value: string) {
		setInput(value);
		const lastAt = value.lastIndexOf('@');
		if (lastAt >= 0 && (lastAt === 0 || value[lastAt - 1] === ' ')) {
			const query = value.slice(lastAt + 1);
			if (!query.includes(' ')) {
				setShowMentions(true);
				setMentionFilter(query.toLowerCase());
				return;
			}
		}
		setShowMentions(false);
	}

	function insertMention(slug: string) {
		const lastAt = input.lastIndexOf('@');
		setInput(`${input.slice(0, lastAt)}@${slug} `);
		setShowMentions(false);
	}

	const filteredAgents = agents.filter(
		(a) =>
			a.slug.toLowerCase().includes(mentionFilter) || a.title.toLowerCase().includes(mentionFilter),
	);

	return (
		<div className="flex flex-col h-full">
			<div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
				{!messages?.length && (
					<p className="text-xs text-text-muted text-center py-4">
						No messages yet. Start a conversation.
					</p>
				)}
				{messages?.map((msg) => (
					<div
						key={msg.id}
						className={`flex flex-col ${msg.author_type === 'board' ? 'items-end' : 'items-start'}`}
					>
						<div
							className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${
								msg.author_type === 'board'
									? 'bg-accent-blue text-white'
									: msg.author_type === 'system'
										? 'bg-bg-subtle text-text-muted italic'
										: 'bg-bg-subtle text-text'
							}`}
						>
							{msg.author_type === 'agent' && (
								<span className="text-xs font-medium text-text-muted block">
									{msg.author_name || 'Agent'}
								</span>
							)}
							<span className="whitespace-pre-wrap">{msg.content}</span>
						</div>
						<span className="text-[10px] text-text-muted mt-0.5">
							{new Date(msg.created_at).toLocaleTimeString([], {
								hour: '2-digit',
								minute: '2-digit',
							})}
						</span>
					</div>
				))}
			</div>

			<form onSubmit={handleSubmit} className="border-t border-border p-2 relative">
				{showMentions && filteredAgents.length > 0 && (
					<div className="absolute bottom-full left-2 right-2 bg-bg border border-border rounded shadow-md max-h-32 overflow-y-auto">
						{filteredAgents.map((agent) => (
							<button
								key={agent.slug}
								type="button"
								className="w-full text-left px-3 py-1.5 text-sm hover:bg-bg-subtle"
								onClick={() => insertMention(agent.slug)}
							>
								<span className="font-medium">@{agent.slug}</span>
								<span className="text-text-muted ml-2">{agent.title}</span>
							</button>
						))}
					</div>
				)}
				<div className="flex gap-1.5">
					<input
						type="text"
						value={input}
						onChange={(e) => handleInputChange(e.target.value)}
						placeholder="Message... (@ to mention an agent)"
						className="flex-1 text-sm bg-bg-subtle border border-border rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent-blue"
					/>
					<Button type="submit" size="sm" disabled={!input.trim() || sendMessage.isPending}>
						<Send className="w-3.5 h-3.5" />
					</Button>
				</div>
			</form>
		</div>
	);
}
