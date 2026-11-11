import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { touchDrag, type TouchDragEvents } from './touch-drag';

// Stacks are named by their root PR; pointers by id.
let ev: TouchDragEvents & { calls: string[] };
beforeEach(() => {
	vi.useFakeTimers();
	const calls: string[] = [];
	ev = {
		calls,
		start: (k) => {
			calls.push(`start ${k}`);
			return true;
		},
		over: (k) => calls.push(`over ${k}`),
		drop: (from, to) => calls.push(`drop ${from}->${to}`),
		cancel: () => calls.push('cancel')
	};
});
afterEach(() => vi.useRealTimers());

const at = (x: number, y: number, over: number | null = null) => ({ x, y, over });

test('the grip drags at once; moving over another stack and lifting drops it there', () => {
	const d = touchDrag(ev);
	d.down(1, 10, at(0, 0), { handle: true });
	expect(d.dragging).toBe(true);
	d.move(1, at(0, 40, 30));
	d.up(1, at(0, 40, 30));
	expect(ev.calls).toEqual(['start 10', 'over 30', 'drop 10->30']);
	expect(d.dragging).toBe(false);
});

test('elsewhere on the card a press must be held before it drags', () => {
	const d = touchDrag(ev);
	d.down(1, 20, at(0, 0), { handle: false });
	expect(d.dragging).toBe(false);
	vi.advanceTimersByTime(299);
	expect(ev.calls).toEqual([]);
	vi.advanceTimersByTime(1);
	expect(ev.calls).toEqual(['start 20']);
	expect(d.dragging).toBe(true);
});

test('a swipe before the press is held scrolls the page: no drag starts', () => {
	const d = touchDrag(ev);
	d.down(1, 20, at(0, 0), { handle: false });
	d.move(1, at(0, 9, 30));
	vi.advanceTimersByTime(1000);
	d.up(1, at(0, 9, 30));
	expect(ev.calls).toEqual([]);
});

test('a small wobble under the slop keeps the long press', () => {
	const d = touchDrag(ev);
	d.down(1, 20, at(0, 0), { handle: false });
	d.move(1, at(3, 4, 20));
	vi.advanceTimersByTime(300);
	expect(ev.calls).toEqual(['start 20']);
});

test('lifting before the long press ends is a tap: nothing happens', () => {
	const d = touchDrag(ev);
	d.down(1, 20, at(0, 0), { handle: false });
	d.up(1, at(0, 0, 20));
	vi.advanceTimersByTime(1000);
	expect(ev.calls).toEqual([]);
});

test('a cancelled pointer (or one whose capture was lost) ends the drag without a drop', () => {
	const d = touchDrag(ev);
	d.down(1, 10, at(0, 0), { handle: true });
	d.move(1, at(0, 40, 20));
	d.cancel(1);
	expect(ev.calls).toEqual(['start 10', 'over 20', 'cancel']);
	expect(d.dragging).toBe(false);
});

test('lifting off the list (over no stack) cancels, as a mouse drop outside does', () => {
	const d = touchDrag(ev);
	d.down(1, 10, at(0, 0), { handle: true });
	d.move(1, at(0, 40, 20));
	d.move(1, at(0, 900, null));
	d.up(1, at(0, 900, null));
	expect(ev.calls).toEqual(['start 10', 'over 20', 'cancel']);
});

test('a drag the page refuses to start (pointer gone) stays off', () => {
	const d = touchDrag({ ...ev, start: () => false });
	d.down(1, 10, at(0, 0), { handle: true });
	expect(d.dragging).toBe(false);
	d.up(1, at(0, 0, 10));
	expect(ev.calls).toEqual([]);
});

test('lifting where it started drops it in place: the page treats from === to as no move', () => {
	const d = touchDrag(ev);
	d.down(1, 30, at(0, 0), { handle: true });
	d.up(1, at(0, 0, 30));
	expect(ev.calls).toEqual(['start 30', 'drop 30->30']);
});

test('a second finger neither starts, steers nor ends the first one’s drag', () => {
	const d = touchDrag(ev);
	d.down(1, 10, at(0, 0), { handle: true });
	d.down(2, 40, at(0, 100), { handle: false });
	vi.advanceTimersByTime(1000);
	d.move(2, at(0, 120, 50));
	d.up(2, at(0, 120, 50));
	expect(d.dragging).toBe(true);
	d.cancel(2);
	expect(d.dragging).toBe(true);
	d.move(1, at(0, 40, 20));
	d.up(1, at(0, 40, 20));
	expect(ev.calls).toEqual(['start 10', 'over 20', 'drop 10->20']);
});

test('a second finger during a long press does not replace it', () => {
	const d = touchDrag(ev);
	d.down(1, 10, at(0, 0), { handle: false });
	d.down(2, 40, at(0, 100), { handle: true });
	expect(d.dragging).toBe(false);
	vi.advanceTimersByTime(300);
	expect(ev.calls).toEqual(['start 10']);
});

test('stop() ends whatever is under way without a drop (the page goes away)', () => {
	const d = touchDrag(ev);
	d.down(1, 10, at(0, 0), { handle: false });
	d.stop();
	vi.advanceTimersByTime(1000);
	expect(ev.calls).toEqual([]);
	d.down(1, 10, at(0, 0), { handle: true });
	d.stop();
	expect(ev.calls).toEqual(['start 10', 'cancel']);
	expect(d.dragging).toBe(false);
});

test('the menu a long press opens is blocked while pressing or dragging only', () => {
	const d = touchDrag(ev);
	expect(d.blocksMenu).toBe(false);
	d.down(1, 10, at(0, 0), { handle: false });
	expect(d.blocksMenu).toBe(true);
	vi.advanceTimersByTime(300);
	expect(d.blocksMenu).toBe(true);
	d.up(1, at(0, 0, 10));
	expect(d.blocksMenu).toBe(false);
});
