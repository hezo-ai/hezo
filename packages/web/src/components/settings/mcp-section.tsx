import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
	useCreateMcpConnection,
	useDeleteMcpConnection,
	useMcpConnections,
} from '../../hooks/use-mcp-connections';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SectionHeader } from './helpers';

export function McpServersSection({ teamId }: { teamId: string }) {
	const { data: connections = [] } = useMcpConnections(teamId);
	const createConn = useCreateMcpConnection(teamId);
	const deleteConn = useDeleteMcpConnection(teamId);
	const [showAdd, setShowAdd] = useState(false);
	const [kind, setKind] = useState<'saas' | 'local'>('saas');
	const [name, setName] = useState('');
	const [url, setUrl] = useState('');
	const [headersJson, setHeadersJson] = useState('');
	const [command, setCommand] = useState('');
	const [argsText, setArgsText] = useState('');
	const [envJson, setEnvJson] = useState('');

	function reset() {
		setName('');
		setUrl('');
		setHeadersJson('');
		setCommand('');
		setArgsText('');
		setEnvJson('');
		setKind('saas');
		setShowAdd(false);
	}

	async function handleAdd(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		const config: Record<string, unknown> = {};
		if (kind === 'saas') {
			if (!url.trim()) return;
			config.url = url.trim();
			if (headersJson.trim()) {
				try {
					config.headers = JSON.parse(headersJson);
				} catch {
					alert('Headers must be valid JSON');
					return;
				}
			}
		} else {
			if (!command.trim()) return;
			config.command = command.trim();
			const args = argsText
				.split(/\s+/)
				.map((s) => s.trim())
				.filter(Boolean);
			if (args.length > 0) config.args = args;
			if (envJson.trim()) {
				try {
					config.env = JSON.parse(envJson);
				} catch {
					alert('Env must be valid JSON');
					return;
				}
			}
		}
		await createConn.mutateAsync({ name: name.trim(), kind, config });
		reset();
	}

	return (
		<section>
			<SectionHeader
				title="MCP servers"
				desc="Model Context Protocol servers available to every agent run in this team. Header values may include __HEZO_SECRET_<NAME>__ placeholders, substituted by the egress proxy at request time."
			/>
			{connections.length === 0 && !showAdd && (
				<p className="text-[13px] text-text-muted mb-2">No MCP servers configured.</p>
			)}
			<div className="space-y-2 mb-3">
				{connections.map((conn) => {
					const config = conn.config as { url?: string; command?: string };
					const target = conn.kind === 'saas' ? config.url : config.command;
					return (
						<div
							key={conn.id}
							className="border border-border rounded-radius-md p-3 flex items-center gap-3 bg-bg-subtle"
						>
							<Badge color={conn.kind === 'saas' ? 'blue' : 'gray'}>{conn.kind}</Badge>
							<div className="flex-1 min-w-0">
								<span className="text-[13px] font-medium">{conn.name}</span>
								<span className="text-xs text-text-muted block font-mono truncate">{target}</span>
							</div>
							{conn.install_status !== 'installed' && (
								<Badge color={conn.install_status === 'failed' ? 'danger' : 'warning'}>
									{conn.install_status}
								</Badge>
							)}
							<Button variant="danger-text" size="sm" onClick={() => deleteConn.mutate(conn.id)}>
								<Trash2 className="w-3 h-3" />
							</Button>
						</div>
					);
				})}
			</div>
			{showAdd ? (
				<form onSubmit={handleAdd} className="space-y-2 border border-border rounded-radius-md p-3">
					<div className="flex gap-2">
						<label className="flex items-center gap-1 text-[13px]">
							<input type="radio" checked={kind === 'saas'} onChange={() => setKind('saas')} /> SaaS
							HTTP
						</label>
						<label className="flex items-center gap-1 text-[13px]">
							<input type="radio" checked={kind === 'local'} onChange={() => setKind('local')} />{' '}
							Local stdio
						</label>
					</div>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Server name (e.g. exa)"
					/>
					{kind === 'saas' ? (
						<>
							<Input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="URL (e.g. https://mcp.exa.ai/mcp)"
							/>
							<Input
								value={headersJson}
								onChange={(e) => setHeadersJson(e.target.value)}
								placeholder='Headers JSON (e.g. {"x-api-key":"__HEZO_SECRET_EXA_KEY__"})'
							/>
						</>
					) : (
						<>
							<Input
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								placeholder="Command (e.g. /workspace/.hezo/mcp/fs/node_modules/.bin/server-filesystem)"
							/>
							<Input
								value={argsText}
								onChange={(e) => setArgsText(e.target.value)}
								placeholder="Args (space-separated)"
							/>
							<Input
								value={envJson}
								onChange={(e) => setEnvJson(e.target.value)}
								placeholder='Env JSON (optional, e.g. {"FOO":"bar"})'
							/>
						</>
					)}
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={createConn.isPending}>
							Add
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={reset}>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<Button variant="secondary" size="sm" onClick={() => setShowAdd(true)}>
					<Plus className="w-3 h-3" /> Add MCP Server
				</Button>
			)}
		</section>
	);
}
