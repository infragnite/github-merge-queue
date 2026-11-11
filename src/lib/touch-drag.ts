// Reordering the queue by touch. Touch and pen don't fire HTML5 drag events, so the page drives a
// drag from pointer events through this: the grip drags at once; anywhere else on a card a press
// held still for LONG_PRESS_MS starts the drag, so a normal swipe keeps scrolling the page.
//
// Pure state, no DOM: the page says where the pointer is and which stack it is over.

export const LONG_PRESS_MS = 300;
/** How far a finger may wobble during a long press before it counts as a swipe. */
export const LONG_PRESS_SLOP_PX = 8;

export interface TouchDragEvents {
	/** A drag of the stack at `index` starts. False when it can't (the pointer is already gone). */
	start: (index: number) => boolean;
	/** The pointer is over the stack at `index`. */
	over: (index: number) => void;
	/** Lifted over `to`; `from === to` is no move. */
	drop: (from: number, to: number) => void;
	/** The drag ended without a drop. */
	cancel: () => void;
}

export interface Point {
	x: number;
	y: number;
	/** The stack under the pointer, if any. */
	over: number | null;
}

export function touchDrag(ev: TouchDragEvents) {
	let from: number | null = null;
	let to: number | null = null;
	let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;

	const stopPress = () => {
		if (press) clearTimeout(press.timer);
		press = null;
	};
	const begin = (index: number) => {
		stopPress();
		if (!ev.start(index)) return;
		from = index;
		to = index;
	};
	const end = () => {
		from = null;
		to = null;
	};

	return {
		get dragging() {
			return from !== null;
		},
		/** A long press would open the link or text menu; blocked only while one is under way. */
		get blocksMenu() {
			return press !== null || from !== null;
		},
		down(index: number, p: Point, on: { handle: boolean }) {
			stopPress();
			if (on.handle) return begin(index);
			press = { timer: setTimeout(() => begin(index), LONG_PRESS_MS), x: p.x, y: p.y };
		},
		move(p: Point) {
			if (press) {
				if (Math.hypot(p.x - press.x, p.y - press.y) > LONG_PRESS_SLOP_PX) stopPress();
				return;
			}
			if (from === null || p.over === null || p.over === to) return;
			to = p.over;
			ev.over(to);
		},
		up() {
			stopPress();
			if (from === null) return;
			const [f, t] = [from, to ?? from];
			end();
			ev.drop(f, t);
		},
		cancel() {
			stopPress();
			if (from === null) return;
			end();
			ev.cancel();
		}
	};
}
