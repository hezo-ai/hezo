import type { DashboardWidgetId, DashboardWidgetOrder } from '@hezo/shared';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';
import type { Project } from './use-projects';

export type { DashboardWidgetId, DashboardWidgetOrder };

export function useDashboardWidgetOrder(projectId: string) {
	return useOptimisticMutation<DashboardWidgetOrder, { order: DashboardWidgetOrder }, Project>({
		mutationFn: (order) =>
			api.patch<{ order: DashboardWidgetOrder }>(
				`/api/projects/${projectId}/dashboard-widget-order`,
				{ order },
			),
		queryKey: queryKeys.projects.detail(projectId),
		applyOptimistic: (current, order) => {
			if (!current) return current;
			return { ...current, dashboard_widget_order: order };
		},
		mergeResponse: (current, { order }) => {
			if (!current) return current;
			return { ...current, dashboard_widget_order: order };
		},
		errorMessage: 'Failed to save widget order',
	});
}
