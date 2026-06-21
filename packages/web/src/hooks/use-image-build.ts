import { ImageBuildStatus, type WsImageBuildMessage, WsMessageType, wsRoom } from '@hezo/shared';
import { useEffect, useState } from 'react';
import { useSocket } from '../contexts/socket-context';

export interface ImageBuildInfo {
	status: ImageBuildStatus;
	building: boolean;
	percent: number;
	step: number | null;
	totalSteps: number | null;
	label: string | null;
}

/**
 * Reference counts the single global `image-builds` room across every
 * `useImageBuild` consumer. The container page mounts the banner (project
 * layout) and the page body simultaneously, so leaving the room when one
 * unmounts must not cut the other off — only the last consumer leaves.
 */
const roomRefCounts = new Map<string, number>();

/**
 * Live build state for a base image, sourced from the global `image-builds`
 * WebSocket room. Base images are shared across projects, so the server tracks
 * one build per image tag and replays the current state on subscribe — a
 * consumer that mounts mid-build sees the bar immediately. Returns null until a
 * message for `image` arrives; `building` is false on terminal done/error.
 */
export function useImageBuild(image: string | null | undefined): ImageBuildInfo | null {
	const { joinRoom, leaveRoom, subscribe } = useSocket();
	const [state, setState] = useState<ImageBuildInfo | null>(null);

	useEffect(() => {
		// Drop stale state whenever the project's image changes (or clears).
		setState(null);
		if (!image) return;
		const room = wsRoom.imageBuilds();
		const count = roomRefCounts.get(room) ?? 0;
		roomRefCounts.set(room, count + 1);
		if (count === 0) joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.ImageBuild, (msg) => {
			const m = msg as WsImageBuildMessage;
			if (m.image !== image) return;
			setState({
				status: m.status,
				building: m.status === ImageBuildStatus.Building,
				percent: m.percent,
				step: m.step,
				totalSteps: m.totalSteps,
				label: m.label,
			});
		});

		return () => {
			unsubscribe();
			const remaining = (roomRefCounts.get(room) ?? 1) - 1;
			if (remaining <= 0) {
				roomRefCounts.delete(room);
				leaveRoom(room);
			} else {
				roomRefCounts.set(room, remaining);
			}
		};
	}, [image, joinRoom, leaveRoom, subscribe]);

	return state;
}
