// Reordering the queue by touch. Touch and pen don't fire HTML5 drag events, so the page drives a
// drag from pointer events through this: the grip drags at once; anywhere else on a card a press
// held still for LONG_PRESS_MS starts the drag, so a normal swipe keeps scrolling the page.
//
// Pure state, no DOM. Stacks are named by a stable key (their root PR), not by their place in the
// list, so a refresh that moves rows mid-drag can't make the drop move another stack. One pointer
// owns a gesture; any other finger is ignored until it ends.

export const LONG_PRESS_MS = 300;
/** How far a finger may wobble during a long press before it counts as a swipe. */
export const LONG_PRESS_SLOP_PX = 8;

export interface TouchDragEvents {
	/** A drag of stack `key` starts. False when it can't (the pointer is already gone). */
	start: (key: number) => boolean;
	/** The pointer is over stack `key`. */
	over: (key: number) => void;
	/** Lifted over `to`; `from === to` is no move. */
	drop: (from: number, to: number) => void;
	/** The drag ended without a drop. */
	cancel: () => void;
}

export interface Point {
	x: number;
	y: number;
	/** The stack under the pointer, or null when it is off the list. */
	over: number | null;
}

export function touchDrag(ev: TouchDragEvents) {
	let pointer: number | null = null;
	let from: number | null = null;
	let to: number | null = null;
	let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;

	const stopPress = () => {
		if (press) clearTimeout(press.timer);
		press = null;
	};
	const reset = () => {
		stopPress();
		pointer = null;
		from = null;
		to = null;
	};
	const begin = (key: number) => {
		press = null;
		if (!ev.start(key)) return reset();
		from = key;
		to = key;
	};
	const mine = (id: number) => pointer !== null && id === pointer;

	return {
		get dragging() {
			return from !== null;
		},
		/** A long press would open the link or text menu; blocked only while one is under way. */
		get blocksMenu() {
			return press !== null || from !== null;
		},
		down(id: number, key: number, p: Point, on: { handle: boolean }) {
			if (pointer !== null) return; // another finger owns the gesture
			pointer = id;
			if (on.handle) return begin(key);
			press = { timer: setTimeout(() => begin(key), LONG_PRESS_MS), x: p.x, y: p.y };
		},
		move(id: number, p: Point) {
			if (!mine(id)) return;
			if (press) {
				if (Math.hypot(p.x - press.x, p.y - press.y) > LONG_PRESS_SLOP_PX) reset();
				return;
			}
			if (from === null || p.over === to) return;
			to = p.over;
			if (to !== null) ev.over(to);
		},
		up(id: number, p: Point) {
			if (!mine(id)) return;
			const [f, t] = [from, p.over ?? null];
			const dragging = from !== null;
			reset();
			if (!dragging) return;
			if (t === null) ev.cancel();
			else ev.drop(f!, t);
		},
		/** The pointer was cancelled or lost its capture (its row was re-rendered away). */
		cancel(id: number) {
			if (!mine(id)) return;
			this.stop();
		},
		/** Ends whatever is under way without a drop: the page is going away, or reordering was turned off. */
		stop() {
			const dragging = from !== null;
			reset();
			if (dragging) ev.cancel();
		}
	};
}
