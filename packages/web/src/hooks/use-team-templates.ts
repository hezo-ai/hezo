import type { TeamTemplateSource } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface TeamTemplateAgentType {
	agent_type_id: string;
	name: string;
	slug: string;
	role_description: string;
	reports_to_slug: string | null;
	sort_order: number;
}

export interface TeamTemplate {
	id: string;
	name: string;
	description: string | null;
	is_builtin: boolean;
	source: TeamTemplateSource;
	metadata: Record<string, unknown>;
	kb_docs_config: Array<{ title: string; slug: string; content: string }>;
	agent_types: TeamTemplateAgentType[];
	created_at: string;
}

export function useTeamTemplates() {
	return useQuery({
		queryKey: queryKeys.teamTemplates(),
		queryFn: () => api.get<TeamTemplate[]>('/api/team-templates'),
	});
}
