import type * as monaco from 'monaco-editor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the IPC layer so `rpc.viewState.save` is an observable spy (the module's only
// side effect). `vi.hoisted` lets the hoisted `vi.mock` factory reference it.
const { save } = vi.hoisted(() => ({ save: vi.fn(() => Promise.resolve()) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { viewState: { save } } }));

const KV_KEY = 'editor-view-state';
const LIMIT = 100; // mirrors the module's cap
const DEBOUNCE_MS = 500;

// The module treats the view state as an opaque JSON blob, so a tagged stub suffices.
const vs = (tag: number) => ({ tag }) as unknown as monaco.editor.ICodeEditorViewState;

// Fresh module instance per test (the module holds module-level LRU + timer state).
async function freshPersistence() {
  vi.resetModules();
  return (await import('./editor-view-state-persistence')).editorViewStatePersistence;
}
type Persistence = Awaited<ReturnType<typeof freshPersistence>>;

describe('editorViewStatePersistence', () => {
  let p: Persistence;

  beforeEach(async () => {
    vi.useFakeTimers();
    save.mockClear();
    save.mockImplementation(() => Promise.resolve());
    p = await freshPersistence();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces writes and coalesces a burst into one save with the latest state', () => {
    p.set('a', vs(1));
    p.set('a', vs(2));
    p.set('b', vs(3));
    expect(save).not.toHaveBeenCalled(); // nothing before the debounce window elapses
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(KV_KEY, { a: vs(2), b: vs(3) });
  });

  it('returns persisted state via get and null for unknown keys', () => {
    p.set('a', vs(1));
    expect(p.get('a')).toEqual(vs(1));
    expect(p.get('missing')).toBeNull();
  });

  it('get refreshes LRU recency so a reopened entry survives eviction', () => {
    for (let i = 0; i < LIMIT; i++) p.set(`f${i}`, vs(i));
    // f0 is least-recently-used; reading it should make it most-recent.
    expect(p.get('f0')).toEqual(vs(0));
    // The next distinct write evicts the new LRU (f1), not the just-read f0.
    p.set('new', vs(999));
    expect(p.get('f0')).toEqual(vs(0));
    expect(p.get('f1')).toBeNull();
  });

  it('evicts the least-recently-used entry beyond the cap', () => {
    for (let i = 0; i <= LIMIT; i++) p.set(`f${i}`, vs(i)); // LIMIT + 1 entries
    expect(p.get('f0')).toBeNull(); // oldest evicted
    expect(p.get(`f${LIMIT}`)).toEqual(vs(LIMIT)); // newest kept
  });

  it('set(null) drops any persisted entry and flushes the removal', () => {
    p.set('a', vs(1));
    vi.advanceTimersByTime(DEBOUNCE_MS);
    save.mockClear();
    p.set('a', null);
    expect(p.get('a')).toBeNull();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(save).toHaveBeenCalledWith(KV_KEY, {});
  });

  it('hydrate seeds the map and never throws on non-object / corrupt input', () => {
    p.hydrate({ a: vs(1), b: vs(2) });
    expect(p.get('a')).toEqual(vs(1));
    expect(() => p.hydrate(undefined)).not.toThrow();
    expect(() => p.hydrate(null)).not.toThrow();
    expect(() => p.hydrate('not-an-object')).not.toThrow();
    expect(() => p.hydrate(42)).not.toThrow();
  });

  it('hydrate enforces the cap on an oversized blob', () => {
    const blob: Record<string, monaco.editor.ICodeEditorViewState> = {};
    for (let i = 0; i <= LIMIT; i++) blob[`f${i}`] = vs(i); // LIMIT + 1 entries
    p.hydrate(blob);
    expect(p.get('f0')).toBeNull(); // trimmed down to the cap
    expect(p.get(`f${LIMIT}`)).toEqual(vs(LIMIT));
  });

  it('swallows a rejected save so persistence never surfaces an error', () => {
    save.mockImplementationOnce(() => Promise.reject(new Error('kv down')));
    p.set('a', vs(1));
    expect(() => vi.advanceTimersByTime(DEBOUNCE_MS)).not.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
