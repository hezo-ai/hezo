import { formatGoalHealth, GoalHealth } from '@hezo/shared';
import { Badge, type BadgeColor } from './ui/badge';

interface GoalHealthPillProps {
	health: string;
	testId?: string;
}

const HEALTH_COLOR: Record<string, BadgeColor> = {
	[GoalHealth.Pending]: 'neutral',
	[GoalHealth.OnTrack]: 'success',
	[GoalHealth.AtRisk]: 'warning',
	[GoalHealth.OffTrack]: 'danger',
};

/**
 * Small pill summarising a goal's health. Colour follows the design tokens:
 * pending → neutral, on_track → green, at_risk → amber, off_track → red.
 */
export function GoalHealthPill({ health, testId }: GoalHealthPillProps) {
	const color = HEALTH_COLOR[health] ?? 'neutral';
	return (
		<Badge color={color} testId={testId}>
			{formatGoalHealth(health)}
		</Badge>
	);
}
