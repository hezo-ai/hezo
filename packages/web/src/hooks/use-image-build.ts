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

/**
 * The same stream, for a caller that does not know which image to watch.
 *
 * The global Containers page is instance-wide and its rows carry no image tag,
 * but a base image building is the one thing that holds up *every* container -
 * so it is exactly the page that has to show it. Returns whichever image is
 * currently building (with its tag), or null when none is.
 *
 * Deliberately the same room and the same refcount as {@link useImageBuild}
 * rather than a second subscription: two hooks joining `image-builds`
 * independently is how one of them ends up leaving the room out from under the
 * other.
 */
export function useAnyImageBuild(): (ImageBuildInfo & { image: string }) | null {
	const { joinRoom, leaveRoom, subscribe } = useSocket();
	const [state, setState] = useState<(ImageBuildInfo & { image: string }) | null>(null);

	useEffect(() => {
		const room = wsRoom.imageBuilds();
		const count = roomRefCounts.get(room) ?? 0;
		roomRefCounts.set(room, count + 1);
		if (count === 0) joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.ImageBuild, (msg) => {
			const m = msg as WsImageBuildMessage;
			const building = m.status === ImageBuildStatus.Building;
			// A terminal message clears the card, but only for the image it is
			// about - another image finishing must not hide a build still running.
			setState((prev) => {
				if (!building) return prev && prev.image === m.image ? null : prev;
				return {
					image: m.image,
					status: m.status,
					building: true,
					percent: m.percent,
					step: m.step,
					totalSteps: m.totalSteps,
					label: m.label,
				};
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
	}, [joinRoom, leaveRoom, subscribe]);

	return state;
}
