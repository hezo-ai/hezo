import {
	DASHBOARD_WIDGET_IDS,
	type DashboardWidgetId,
	type DashboardWidgetOrder,
} from '@hezo/shared';

/** Default widget render order — matches the peer-feedback layout. */
export const DEFAULT_WIDGET_ORDER: DashboardWidgetOrder = [
	'goals',
	'team_snapshot',
	'in_progress',
	'spend',
];

/** Sanitise a stored order: drop unknown ids, append any missing ones at the end. */
export function sanitizeWidgetOrder(raw: unknown): DashboardWidgetOrder {
	const known = new Set(DASHBOARD_WIDGET_IDS as readonly string[]);
	const valid: DashboardWidgetId[] = [];
	const seen = new Set<string>();
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === 'string' && known.has(item) && !seen.has(item)) {
				valid.push(item as DashboardWidgetId);
				seen.add(item);
			}
		}
	}
	// Append any widget ids that are missing from the stored order.
	for (const id of DEFAULT_WIDGET_ORDER) {
		if (!seen.has(id)) valid.push(id);
	}
	return valid;
}
