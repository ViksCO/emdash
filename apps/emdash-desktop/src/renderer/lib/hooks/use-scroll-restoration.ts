import { useLayoutEffect, useRef } from 'react';

type ScrollMemory = { path: string; top: number; left: number };

// Keyed by the tab-store object, so an entry is dropped automatically when the
// tab (and its store) is garbage-collected — a reopened file starts fresh
// ("dies with the tab", no restore-on-reopen, no manual cleanup). The stored
// `path` guards against a preview tab reusing one store object for a new file.
const scrollMemory = new WeakMap<object, ScrollMemory>();

// Backstop for the restore loop (~3s at 60fps) in case scroll size never settles;
// normal content stabilizes within a few frames.
const MAX_SETTLE_FRAMES = 180;
// Consecutive frames of unchanged scroll size that count as "content laid out".
const STABLE_FRAMES = 3;

/**
 * Persists a preview's scroll position and restores it when the preview remounts —
 * on tab switch, or on the in-tab preview↔source toggle.
 *
 * `key` is the tab store (a stable object identity); `path` is the file it shows.
 * Restore re-runs whenever either changes, so a preview tab swapped to a new file
 * starts at the top instead of inheriting the previous file's offset.
 *
 * Preview content lays out asynchronously (markdown highlighting, image decode), so
 * the saved offset is re-applied each frame until the scroll size stops changing,
 * rather than once before the content has height. A genuine user scroll during that
 * window hands control back to the user; the echoed `scroll` event from our own
 * programmatic scrolling is filtered out so it can't overwrite the saved offset.
 *
 * Returns a ref to attach to the scroll container (the `overflow-*` element).
 */
export function useScrollRestoration<T extends HTMLElement>(key: object | undefined, path: string) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !key) return;

    const saved = scrollMemory.get(key);
    const target = saved && saved.path === path ? saved : null;

    let done = false;
    let rafId = 0;
    let frames = 0;
    let stable = 0;
    let prevH = -1;
    let prevW = -1;
    // The offset our own apply() last set; its async `scroll` echo must not be
    // mistaken for a user scroll (which would persist a clamped, wrong offset).
    let appliedTop = -1;
    let appliedLeft = -1;
    let expectEcho = false;

    const maxTop = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const maxLeft = () => Math.max(0, el.scrollWidth - el.clientWidth);

    const finish = () => {
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
    };

    const apply = () => {
      el.scrollTop = Math.min(target!.top, maxTop());
      el.scrollLeft = Math.min(target!.left, maxLeft());
      appliedTop = el.scrollTop;
      appliedLeft = el.scrollLeft;
      expectEcho = true;
    };

    // TODO(ADE-5): two known edge cases to revisit if a preview restores to a
    // slightly wrong spot — (1) after finish(), a late content reflow (e.g. async
    // image decode shrinking height) can clamp scrollTop and be misread below as a
    // user scroll, persisting a wrong (smaller) offset; (2) a genuine user scroll
    // landing exactly on the last applied offset is swallowed as an echo and not saved.
    const onScroll = () => {
      // Swallow the echo from our own apply() (it fires async, possibly after
      // finish()), so a clamped offset never overwrites the saved target.
      if (expectEcho && el.scrollTop === appliedTop && el.scrollLeft === appliedLeft) {
        expectEcho = false;
        return;
      }
      // Real user scroll — stop restoring and persist from here on.
      expectEcho = false;
      if (!done) finish();
      scrollMemory.set(key, { path, top: el.scrollTop, left: el.scrollLeft });
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    if (!target || (target.top <= 0 && target.left <= 0)) {
      finish();
    } else {
      apply(); // first attempt before paint — no flash when content is already laid out
      const tick = () => {
        if (done) return;
        apply();
        const h = el.scrollHeight;
        const w = el.scrollWidth;
        stable = h === prevH && w === prevW ? stable + 1 : 0;
        prevH = h;
        prevW = w;
        if (stable >= STABLE_FRAMES || frames++ >= MAX_SETTLE_FRAMES) {
          finish();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [key, path]);

  return ref;
}
