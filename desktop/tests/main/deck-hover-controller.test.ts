import assert from 'node:assert/strict';
import test from 'node:test';
import { DeckHoverController, pointInDeckRect, selectNotchLayout, type DeckDisplayGeometry, type DeckHoverScheduler, type DeckHoverState, type NotchLayout } from '../../src/main/deck-hover-controller.js';

class Clock implements DeckHoverScheduler {
  now = 0;
  private serial = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  readonly callbacks: Array<() => void> = [];
  setTimeout(callback: () => void, delay: number): unknown {
    const id = ++this.serial; this.callbacks.push(callback); this.pending.set(id, { at: this.now + delay, callback }); return id;
  }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at; this.pending.delete(next[0]); next[1].callback();
    }
    this.now = end;
  }
}
const layout = (): NotchLayout => ({ displayID: 'builtin', notchWidth: 180, notchHeight: 32, hotZone: { x: 630, y: 0, width: 180, height: 32 }, panel: { x: 530, y: 0, width: 380, height: 412 } });
const hot = { x: 700, y: 12 }, panel = { x: 700, y: 160 }, outside = { x: 1000, y: 200 };
function fixture() {
  const clock = new Clock(), states: DeckHoverState[] = [], layouts: Array<NotchLayout | null> = [];
  const controller = new DeckHoverController({ scheduler: clock, onState: state => states.push(state), onLayout: value => layouts.push(value) });
  controller.setLayout(layout());
  return { clock, states, layouts, controller };
}

test('entering a real hot zone peeks immediately and repeated cursor samples do not restart the 160ms delay', () => {
  const { controller, clock, states } = fixture();
  controller.tick(hot, 0); assert.equal(controller.state, 'peeked');
  for (let sample = 0; sample < 3; sample++) { clock.advance(50); controller.tick(hot, 0); }
  assert.equal(controller.state, 'peeked'); clock.advance(9); assert.equal(controller.state, 'peeked');
  clock.advance(1); assert.equal(controller.state, 'expanded'); assert.deepEqual(states, ['peeked', 'expanded']);
  assert.equal(clock.pending.size, 0);
});

test('leaving a peek cancels expansion and collapses at 180ms; the future expanded panel is not a hover target', () => {
  const { controller, clock, states } = fixture();
  controller.tick(hot); clock.advance(100); controller.tick(panel);
  clock.advance(179); assert.equal(controller.state, 'peeked');
  clock.advance(1); assert.equal(controller.state, 'collapsed'); assert.deepEqual(states, ['peeked', 'collapsed']);
  clock.advance(1000); assert.equal(controller.state, 'collapsed');
  controller.tick(panel); clock.advance(1000); assert.equal(controller.state, 'collapsed');
});

test('reentering during peek leave delay cancels collapse and starts one fresh hover delay', () => {
  const { controller, clock, states } = fixture();
  controller.tick(hot); clock.advance(80); controller.tick(outside); clock.advance(100); controller.tick(hot);
  clock.advance(159); assert.equal(controller.state, 'peeked');
  clock.advance(1); assert.equal(controller.state, 'expanded'); assert.deepEqual(states, ['peeked', 'expanded']);
});

test('expanded panels stay open on pointer leave; only a fresh outside mouse press dismisses', () => {
  const { controller, clock } = fixture();
  controller.tick(hot, 0); clock.advance(160);
  controller.tick(outside, 0); clock.advance(10000); assert.equal(controller.state, 'expanded');
  controller.tick(panel, 1); assert.equal(controller.state, 'expanded');
  controller.tick(outside, 1); assert.equal(controller.state, 'expanded'); // dragging a held button is not another click
  controller.tick(outside, 0); controller.tick(outside, 2); assert.equal(controller.state, 'collapsed');
  controller.expand(); controller.tick(outside, 2); assert.equal(controller.state, 'expanded');
  controller.tick(outside, 0); controller.tick(outside, 1); assert.equal(controller.state, 'collapsed');
});

test('an initial held-button sample or missing button sample cannot manufacture a click edge', () => {
  const { controller } = fixture(); controller.expand();
  controller.tick(outside, 1); controller.tick(outside); controller.tick(outside, 1);
  assert.equal(controller.state, 'expanded');
  controller.tick(outside, 0); controller.tick(outside, 1); assert.equal(controller.state, 'collapsed');
});

test('editing protects both expanded outside dismissal and peek leave; release does not replay old presses', () => {
  const { controller, clock } = fixture();
  controller.expand(); controller.tick(outside, 0); controller.setEditing(true); controller.tick(outside, 1);
  clock.advance(1000); assert.equal(controller.state, 'expanded');
  controller.setEditing(false); controller.tick(outside, 1); assert.equal(controller.state, 'expanded');
  controller.tick(outside, 0); controller.tick(outside, 1); assert.equal(controller.state, 'collapsed');
  controller.tick(hot, 0); controller.setEditing(true); controller.tick(outside, 0); clock.advance(1000);
  assert.equal(controller.state, 'peeked');
  controller.setEditing(false); clock.advance(179); assert.equal(controller.state, 'peeked');
  clock.advance(1); assert.equal(controller.state, 'collapsed');
});

test('display changes and unplugging cancel pending work, reject stale callbacks and require a new hover entry', () => {
  const { controller, clock, states } = fixture();
  controller.tick(hot, 0); clock.advance(80); const oldExpand = clock.callbacks[0];
  controller.setLayout(null); assert.equal(controller.state, 'collapsed'); assert.equal(clock.pending.size, 0);
  oldExpand(); clock.advance(1000); assert.equal(controller.state, 'collapsed');
  const other = layout(); other.displayID = 'left-display'; other.hotZone.x -= 1440; other.panel.x -= 1440;
  controller.setLayout(other); const otherHot = { x: hot.x - 1440, y: hot.y };
  controller.tick(otherHot, 1); clock.advance(1000); assert.equal(controller.state, 'collapsed');
  controller.tick({ x: -1400, y: 400 }, 0); controller.tick(otherHot, 0); clock.advance(160); assert.equal(controller.state, 'expanded');
  assert.deepEqual(states, ['peeked', 'collapsed', 'peeked', 'expanded']);
  controller.setLayout(null); assert.equal(controller.state, 'collapsed'); controller.expand(); assert.equal(controller.state, 'collapsed');
});

test('identical geometry does not restart hover and outside consumers cannot mutate internal layout', () => {
  const { controller, clock } = fixture();
  controller.tick(hot); clock.advance(100); controller.setLayout(layout());
  const returned = controller.layout!; returned.hotZone.x = -99999;
  clock.advance(60); assert.equal(controller.state, 'expanded'); assert.equal(controller.layout?.hotZone.x, 630);
  controller.collapse(); controller.tick(hot); clock.advance(1000); assert.equal(controller.state, 'collapsed');
  controller.tick(outside); controller.tick(hot); clock.advance(160); assert.equal(controller.state, 'expanded');
});

test('selection prefers a genuinely notched built-in screen and never invents a notch on external or plain displays', () => {
  const plain: DeckDisplayGeometry = { displayID: 'plain', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, builtIn: true, hasNotch: false, notchHeight: 24, notchWidth: 160 };
  const external: DeckDisplayGeometry = { ...plain, displayID: 'external-notch', builtIn: false, hasNotch: true, bounds: { x: -1440, y: -900, width: 1440, height: 900 }, notchHeight: 32, notchWidth: 180 };
  const builtin: DeckDisplayGeometry = { ...external, displayID: 'actual-builtin', builtIn: true, bounds: { x: 0, y: 0, width: 1512, height: 982 } };
  assert.equal(selectNotchLayout([plain]), null); assert.equal(selectNotchLayout([]), null);
  const selected = selectNotchLayout([plain, external, builtin])!;
  assert.equal(selected.displayID, 'actual-builtin');
  assert.deepEqual(selected.hotZone, { x: 666, y: 0, width: 180, height: 32 });
  assert.deepEqual(selected.panel, { x: 566, y: 0, width: 380, height: 412 });
  assert.equal(selectNotchLayout([{ ...builtin, notchWidth: 0 }]), null);
  assert.equal(selectNotchLayout([{ ...builtin, notchHeight: Infinity }]), null);
  assert.equal(selectNotchLayout([{ ...builtin, notchWidth: 9999 }]), null);
});

test('multi-display negative coordinates, half-open hot zones and small-screen clamping stay in DIP bounds', () => {
  const selected = selectNotchLayout([{ displayID: 'small-left', builtIn: true, hasNotch: true, bounds: { x: -320, y: -200, width: 320, height: 200 }, notchWidth: 100, notchHeight: 30 }])!;
  assert.deepEqual(selected.hotZone, { x: -210, y: -200, width: 100, height: 30 });
  assert.deepEqual(selected.panel, { x: -320, y: -200, width: 320, height: 200 });
  assert.equal(pointInDeckRect({ x: -210, y: -200 }, selected.hotZone), true);
  assert.equal(pointInDeckRect({ x: -110, y: -200 }, selected.hotZone), false);
  assert.equal(pointInDeckRect({ x: -210, y: -170 }, selected.hotZone), false);
  const clock = new Clock(); const controller = new DeckHoverController({ scheduler: clock, onState() {} });
  controller.setLayout(selected); controller.tick({ x: -160, y: -190 }, 0); clock.advance(160);
  assert.equal(controller.state, 'expanded'); controller.tick({ x: 0, y: 0 }, 1); assert.equal(controller.state, 'collapsed');
});

test('native auxiliary screen areas determine the notch position without losing fractional alignment', () => {
  const selected = selectNotchLayout([{ displayID: 'actual-gap', builtIn: true, hasNotch: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, notchX: 663, notchWidth: 185, notchHeight: 32 }])!;
  assert.deepEqual(selected.hotZone, { x: 663, y: 0, width: 185, height: 32 });
  assert.deepEqual(selected.panel, { x: 565.5, y: 0, width: 380, height: 412 });
  const invalid = selectNotchLayout([{ displayID: 'invalid-gap', builtIn: true, hasNotch: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, notchX: -100, notchWidth: 185, notchHeight: 32 }])!;
  assert.equal(invalid.hotZone.x, 663.5);
});

test('dispose cancels timers and suppresses all later callbacks, geometry and pointer updates', () => {
  const { controller, clock, states, layouts } = fixture();
  controller.tick(hot); const stale = clock.callbacks[0]; controller.dispose(); controller.dispose();
  assert.equal(clock.pending.size, 0); stale(); clock.advance(1000);
  controller.tick(hot, 1); controller.expand(); controller.collapse(); controller.setLayout(null); controller.setEditing(true);
  assert.deepEqual(states, ['peeked']); assert.equal(layouts.length, 1);
});
