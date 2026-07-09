import type * as monaco from 'monaco-editor';
import { rpc } from '@renderer/lib/ipc';

/**
 * Cross-restart persistence for a buffer's editor view state (scroll + cursor +
 * folding). Mirrors VS Code's approach: keep the small, JSON-serializable object from
 * `editor.saveViewState()` in one LRU-capped map keyed by buffer URI, persisted as a
 * single blob in the app's `view-state` KV (SQLite — survives restart).
 *
 * Writes are debounced (never per scroll frame). The map is hydrated once at bootstrap
 * so a file's saved state is present before its model is registered. This module owns
 * durable storage only — restore timing/correctness (restore after real layout,
 * model-identity guard) lives in the model registry.
 *
 * Design notes:
 * - One blob under one KV key (not a key per file), so growth is bounded by the LRU
 *   cap and needs no orphan pruning; at ≤LIMIT small entries the whole-blob write is
 *   cheap and only fires while scrolling.
 * - Intentionally separate from snapshotRegistry/viewStateCache: routing scroll through
 *   the MobX task snapshot would couple it to core task-state serialization, which is
 *   riskier than a small self-contained store.
 */

const KV_KEY = 'editor-view-state';
const LIMIT = 100; // max files retained; least-recently-used evicted (VS Code's cap)
const DEBOUNCE_MS = 500;

type Blob = Record<string, monaco.editor.ICodeEditorViewState>;

// Insertion order is the LRU order: entries are re-inserted on touch (get/set), so the
// first key is the least-recently-used.
const states = new Map<string, monaco.editor.ICodeEditorViewState>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function evictToLimit(): void {
  while (states.size > LIMIT) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
}

function flush(): void {
  flushTimer = null;
  const blob: Blob = Object.fromEntries(states);
  // Fire-and-forget: a persistence failure must never surface to the editor.
  void rpc.viewState.save(KV_KEY, blob).catch(() => {});
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

export const editorViewStatePersistence = {
  /** Seed the in-memory map from the blob loaded at bootstrap (via `getAll`). */
  hydrate(blob: unknown): void {
    if (!blob || typeof blob !== 'object') return;
    try {
      for (const [uri, viewState] of Object.entries(blob as Blob)) {
        if (viewState) states.set(uri, viewState);
      }
    } catch {
      // Corrupt persisted blob — start empty rather than fail bootstrap.
    }
    evictToLimit(); // enforce the cap even for a hand-edited / oversized blob
  },

  /**
   * Persisted view state for a buffer URI, or null. Used to seed a new model. Reading
   * counts as a use — it refreshes LRU recency so a just-reopened file isn't evicted
   * ahead of a freshly-scrolled one.
   */
  get(uri: string): monaco.editor.ICodeEditorViewState | null {
    const viewState = states.get(uri);
    if (!viewState) return null;
    states.delete(uri);
    states.set(uri, viewState);
    return viewState;
  },

  /** Record a buffer's latest view state (LRU-touch) and schedule a debounced write. */
  set(uri: string, viewState: monaco.editor.ICodeEditorViewState | null): void {
    if (!viewState) {
      // No valid state → drop any persisted entry rather than keep a stale one, so the
      // persisted blob stays consistent with the live session.
      if (states.delete(uri)) scheduleFlush();
      return;
    }
    states.delete(uri);
    states.set(uri, viewState);
    evictToLimit();
    scheduleFlush();
  },
};
