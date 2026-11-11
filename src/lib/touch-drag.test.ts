import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { touchDrag, type TouchDragEvents } from './touch-drag';

let ev: TouchDragEvents & { calls: string[] };
beforeEach(() => {
	vi.useFakeTimers();
	const calls: string[] = [];
	ev = {
		calls,
		start: (i) => {
			calls.push(`start ${i}`);
			return true;
		},
		over: (i) => calls.push(`over ${i}`),
		drop: (from, to) => calls.push(`drop ${from}->${to}`),
		cancel: () => calls.push('cancel')
	};
});
afterEach(() => vi.useRealTimers());

const at = (x: number, y: number, over: number | null = null) => ({ x, y, over });

test('the grip drags at once; moving over another stack and lifting drops it there', () => {
	const d = touchDrag(ev);
	d.down(0, at(0, 0), { handle: true });
	expect(d.dragging).toBe(true);
	d.move(at(0, 40, 2));
	d.up();
	expect(ev.calls).toEqual(['start 0', 'over 2', 'drop 0->2']);
	expect(d.dragging).toBe(false);
});

test('elsewhere on the card a press must be held before it drags', () => {
	const d = touchDrag(ev);
	d.down(1, at(0, 0), { handle: false });
	expect(d.dragging).toBe(false);
	vi.advanceTimersByTime(299);
	expect(ev.calls).toEqual([]);
	vi.advanceTimersByTime(1);
	expect(ev.calls).toEqual(['start 1']);
	expect(d.dragging).toBe(true);
});

test('a swipe before the press is held scrolls the page: no drag starts', () => {
	const d = touchDrag(ev);
	d.down(1, at(0, 0), { handle: false });
	d.move(at(0, 9, 3));
	vi.advanceTimersByTime(1000);
	d.up();
	expect(ev.calls).toEqual([]);
});

test('a small wobble under the slop keeps the long press', () => {
	const d = touchDrag(ev);
	d.down(1, at(0, 0), { handle: false });
	d.move(at(3, 4));
	vi.advanceTimersByTime(300);
	expect(ev.calls).toEqual(['start 1']);
});

test('lifting before the long press ends is a tap: nothing happens', () => {
	const d = touchDrag(ev);
	d.down(1, at(0, 0), { handle: false });
	d.up();
	vi.advanceTimersByTime(1000);
	expect(ev.calls).toEqual([]);
});

test('a cancelled pointer ends the drag without a drop', () => {
	const d = touchDrag(ev);
	d.down(0, at(0, 0), { handle: true });
	d.move(at(0, 40, 1));
	d.cancel();
	expect(ev.calls).toEqual(['start 0', 'over 1', 'cancel']);
	expect(d.dragging).toBe(false);
});

test('a drag the page refuses to start (pointer gone) stays off', () => {
	const d = touchDrag({ ...ev, start: () => false });
	d.down(0, at(0, 0), { handle: true });
	expect(d.dragging).toBe(false);
	d.up();
	expect(ev.calls).toEqual([]);
});

test('lifting where it started drops it in place: the page treats from === to as no move', () => {
	const d = touchDrag(ev);
	d.down(2, at(0, 0), { handle: true });
	d.up();
	expect(ev.calls).toEqual(['start 2', 'drop 2->2']);
});

test('the menu a long press opens is blocked while pressing or dragging only', () => {
	const d = touchDrag(ev);
	expect(d.blocksMenu).toBe(false);
	d.down(0, at(0, 0), { handle: false });
	expect(d.blocksMenu).toBe(true);
	vi.advanceTimersByTime(300);
	expect(d.blocksMenu).toBe(true);
	d.up();
	expect(d.blocksMenu).toBe(false);
});
