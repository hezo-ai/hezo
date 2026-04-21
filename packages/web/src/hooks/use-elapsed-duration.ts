import { intervalToDuration } from 'date-fns';
import { useEffect, useState } from 'react';

export function formatElapsed(ms: number): string {
	if (ms < 1000) return '0s';
	const d = intervalToDuration({ start: 0, end: ms });
	const parts: string[] = [];
	if (d.days) parts.push(`${d.days}d`);
	if (d.hours || d.days) parts.push(`${d.hours ?? 0}h`);
	if (d.minutes || d.hours || d.days) parts.push(`${d.minutes ?? 0}m`);
	parts.push(`${d.seconds ?? 0}s`);
	return parts.join('');
}

export function useElapsedDuration(startedAt: string, finishedAt: string | null): string {
	const [now, setNow] = useState(() => Date.now());
	const isActive = !!startedAt && !finishedAt;

	useEffect(() => {
		if (!isActive) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isActive]);

	if (!startedAt) return '';
	const start = new Date(startedAt).getTime();
	if (Number.isNaN(start)) return '';

	const end = finishedAt ? new Date(finishedAt).getTime() : now;
	return formatElapsed(Math.max(0, end - start));
}
