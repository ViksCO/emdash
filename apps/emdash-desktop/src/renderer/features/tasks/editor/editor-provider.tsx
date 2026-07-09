import { autorun } from 'mobx';
import { observer } from 'mobx-react-lite';
import type * as monacoNS from 'monaco-editor';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useTabGroupContext } from '@renderer/features/tasks/tabs/tab-group-context';
import { useWorkspaceViewModel } from '@renderer/features/tasks/task-view-context';
import { registerActiveCodeEditor } from '@renderer/lib/editor/activeCodeEditor';
import { DEFAULT_EDITOR_OPTIONS } from '@renderer/lib/editor/utils';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { codeEditorPool } from '@renderer/lib/monaco/monaco-code-pool';
import {
  addMonacoKeyboardShortcuts,
  configureMonacoEditor,
} from '@renderer/lib/monaco/monaco-config';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { defineMonacoThemes, getMonacoTheme } from '@renderer/lib/monaco/monaco-themes';
import { buildMonacoModelPath } from '@renderer/lib/monaco/monacoModelPath';
import { useIsActiveTask } from '../hooks/use-is-active-task';

interface EditorContextValue {
  /**
   * Ref callback that appends the pane's stable Monaco editor container to the
   * given DOM element. Called by PaneContent to position the editor host.
   */
  setEditorHost: (el: HTMLElement | null) => void;
  /**
   * Explicitly re-runs layout() on the Monaco editor.
   * Call this whenever the Monaco host transitions from hidden to visible
   * (e.g. when activeRenderer switches to 'monaco').
   */
  triggerLayout: () => void;
  /**
   * Restore the editor's scroll + cursor for the active file without switching
   * models — recovers scroll when toggling preview→source (same model, so attach()
   * never fires). Saving is continuous (see onDidScrollChange in editor creation).
   */
  restoreActiveViewState: () => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditorContext must be used within EditorProvider');
  return ctx;
}

// Per-editor gate for scroll persistence, keyed by the Monaco editor instance so it
// is pane-safe and survives renders without being a React hook (a hook would change
// the component signature and break Fast Refresh). False from editor creation / a
// new model attach until the file's view state is restored, so a recreated editor's
// clamp-to-0 scroll isn't persisted over the real saved offset.
const scrollSaveEnabled = new WeakMap<object, boolean>();

export const EditorProvider = observer(function EditorProvider({
  children,
  taskId,
  projectId: _projectId,
}: {
  children: ReactNode;
  taskId: string;
  projectId: string;
}) {
  const taskView = useWorkspaceViewModel();
  const { editorView, tabGroupManager } = taskView;
  const { groupId, tabManager: paneTabManager } = useTabGroupContext();
  const { effectiveTheme } = useTheme();
  const isActive = useIsActiveTask(taskId);

  // Conflict dialog — shown when editorView.pendingConflictUri is set.
  const showConflictModal = useShowModal('conflictDialog');

  // The directly-created Monaco editor for this pane.
  const editorRef = useRef<monacoNS.editor.IStandaloneCodeEditor | null>(null);
  // The container <div> appended to the pane's host element.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusPendingRef = useRef(false);

  // Stable host element provided by PaneContent via setEditorHost.
  const hostRef = useRef<HTMLElement | null>(null);

  // rAF id of the in-flight restore loop, so a new restore can cancel a stale one.
  const restoreRafRef = useRef(0);

  // Tracks the previously-attached buffer URI so modelRegistry.attach can
  // save view state before switching models.
  const prevBufUriRef = useRef<string | undefined>(undefined);

  // ---------------------------------------------------------------------------
  // Theme sync — update editor theme when app theme changes.
  // When this pane's editor is created it will inherit the current theme.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const m = codeEditorPool.getMonaco();
    if (m) defineMonacoThemes(m as Parameters<typeof defineMonacoThemes>[0]);
    codeEditorPool.setTheme(getMonacoTheme(effectiveTheme));
  }, [effectiveTheme]);

  // ---------------------------------------------------------------------------
  // Editor creation — fires once on mount. Creates a Monaco editor directly
  // (no pool lease) using the globally-loaded Monaco instance. Monaco is
  // guaranteed to be loaded before any pane renders (bootstrap awaits pool init).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const m = codeEditorPool.getMonaco();
    if (!m) return;

    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    containerRef.current = container;

    const editor = m.editor.create(container, { ...DEFAULT_EDITOR_OPTIONS, glyphMargin: true });
    editorRef.current = editor;
    scrollSaveEnabled.set(editor, false);

    configureMonacoEditor(editor);

    const cleanupActive = registerActiveCodeEditor(editor);

    addMonacoKeyboardShortcuts(editor, m, {
      onSave: () => {
        const path = paneTabManager.activeFilePath;
        if (path) void editorView.saveFile(path);
      },
      onSaveAll: () => {
        void editorView.saveAllFiles();
      },
    });

    const focusDisposable = editor.onDidFocusEditorWidget(() => {
      taskView.setFocusedRegion('main');
      tabGroupManager.setActiveGroup(groupId);
    });

    // Continuously persist scroll + cursor for the active file while the editor is
    // laid out. Skipped while the host is hidden/detached (height 0) — there
    // automaticLayout has clamped scrollTop to 0, and saving then would lose the
    // real position. Keeping each file's view state fresh lets both attach() (on
    // tab switch) and the preview↔source toggle restore the correct offset.
    const scrollDisposable = editor.onDidScrollChange(() => {
      // Skip while hidden/detached (display:none or unmounted → DOM clientHeight 0;
      // note getLayoutInfo().height reports Monaco's 5px floor, not 0). Skip until
      // the active file is restored, so a recreated editor's clamp-to-0 can't
      // overwrite the saved offset.
      if (editor.getContainerDomNode().clientHeight <= 0 || !scrollSaveEnabled.get(editor)) {
        return;
      }
      const path = paneTabManager.activeFilePath;
      if (!path) return;
      modelRegistry.saveViewState(buildMonacoModelPath(editorView.modelRootPath, path), editor);
    });

    // Satisfy any focus request that arrived before the editor was ready.
    if (focusPendingRef.current && editor.getModel()) {
      focusPendingRef.current = false;
      editor.focus();
    }

    if (hostRef.current) {
      hostRef.current.appendChild(container);
      editor.layout();
    }

    return () => {
      focusDisposable.dispose();
      scrollDisposable.dispose();
      cleanupActive();
      if (restoreRafRef.current) cancelAnimationFrame(restoreRafRef.current);
      editor.dispose();
      container.remove();
      editorRef.current = null;
      containerRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Save shortcut — handle at the task-pane level so preview/source transitions
  // (notably markdown/MDX source editing) do not depend on Monaco receiving the
  // key event. Capture and stop propagation to avoid a second Monaco save.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!isActive || taskView.focusedRegion !== 'main') return;
      if (tabGroupManager.activeGroupId !== groupId) return;
      if (event.key.toLowerCase() !== 's') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void editorView.saveAllFiles();
        return;
      }

      const path = paneTabManager.activeFilePath;
      if (!path) return;

      event.preventDefault();
      event.stopPropagation();
      void editorView.saveFile(path);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [editorView, groupId, isActive, paneTabManager, tabGroupManager, taskView]);

  // ---------------------------------------------------------------------------
  // Model attachment — autorun that re-evaluates whenever the pane-local active
  // file or model registration status changes.
  // ---------------------------------------------------------------------------
  useEffect(
    () =>
      autorun(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const entry = paneTabManager.activeFileEntry; // reactive
        const newBufUri = entry ? buildMonacoModelPath(editorView.modelRootPath, entry.path) : null;

        if (!newBufUri) {
          editor.setModel(null);
          prevBufUriRef.current = undefined;
          return;
        }

        const status = modelRegistry.modelStatus.get(newBufUri); // reactive
        if (status !== 'ready') return;

        if (newBufUri !== prevBufUriRef.current) {
          scrollSaveEnabled.set(editor, false); // suspend save until the new file is restored
        }
        modelRegistry.attach(editor, newBufUri, prevBufUriRef.current);
        prevBufUriRef.current = newBufUri;
        // attach restored the new file's view state iff the editor is on screen.
        // Re-enable persistence here: the monacoVisible-gated restore only fires on a
        // visibility transition, so a same-mode switch (e.g. source→source) would
        // otherwise leave saving wedged off. The hidden/recreate case stays suspended
        // and is re-enabled by restoreActiveViewState after its deferred restore.
        if (editor.getContainerDomNode().clientHeight > 0) {
          scrollSaveEnabled.set(editor, true);
        }
      }),
    // oxlint-disable-next-line react/exhaustive-deps
    []
  );

  // ---------------------------------------------------------------------------
  // Restore — re-apply crash-recovery buffer content for persisted open tabs.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!taskId) return;
    void editorView.restoreBuffers();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [taskId]);

  // ---------------------------------------------------------------------------
  // Conflict dialog — reaction on pendingConflictUri shows the modal.
  // ---------------------------------------------------------------------------
  useEffect(
    () =>
      autorun(() => {
        const uri = editorView.pendingConflictUri; // reactive
        if (!uri) return;
        const filePath = uri.replace(`file://${editorView.modelRootPath}/`, '');
        if (!editorView.openFilePaths.includes(filePath)) return;
        showConflictModal({
          filePath,
          onSuccess: (accept) => {
            void editorView.resolveConflict(accept);
          },
        });
      }),
    // oxlint-disable-next-line react/exhaustive-deps
    []
  );

  // ---------------------------------------------------------------------------
  // Focus restore — when this task becomes active and focusedRegion is 'main',
  // focus Monaco if a model is loaded; otherwise queue the intent.
  // ---------------------------------------------------------------------------
  const focusedRegion = taskView.focusedRegion;
  useEffect(() => {
    if (!isActive || focusedRegion !== 'main') return;
    // Only the focused pane should attempt to focus.
    if (tabGroupManager.activeGroupId !== groupId) return;
    const editor = editorRef.current;
    if (editor?.getModel()) {
      editor.focus();
    } else {
      focusPendingRef.current = true;
    }
  }, [isActive, focusedRegion, groupId, tabGroupManager.activeGroupId]);

  // ---------------------------------------------------------------------------
  // setEditorHost — called by PaneContent to give the editor a stable DOM node.
  // ---------------------------------------------------------------------------
  const setEditorHost = useCallback((el: HTMLElement | null) => {
    hostRef.current = el;
    const container = containerRef.current;
    const editor = editorRef.current;
    if (el && container && editor) {
      el.appendChild(container);
      editor.layout();
    }
  }, []);

  // ---------------------------------------------------------------------------
  // triggerLayout — called when the Monaco host transitions from hidden to visible.
  // ---------------------------------------------------------------------------
  const triggerLayout = useCallback(() => {
    editorRef.current?.layout();
  }, []);

  // ---------------------------------------------------------------------------
  // View-state persistence for the in-tab preview↔source toggle (same model, so
  // the attach() autorun above never fires). Keyed by the active file's URI.
  // ---------------------------------------------------------------------------
  const activeViewStateUri = useCallback(() => {
    const entry = paneTabManager.activeFileEntry;
    return entry ? buildMonacoModelPath(editorView.modelRootPath, entry.path) : null;
  }, [paneTabManager, editorView]);

  const restoreActiveViewState = useCallback(() => {
    const uri = activeViewStateUri();
    if (!uri) return;
    // Cancel any in-flight restore loop so a stale file's offset can't land after a
    // rapid switch (restoreViewState also guards on model identity as a backstop).
    if (restoreRafRef.current) cancelAnimationFrame(restoreRafRef.current);
    // Restore only once the editor has a real (non-zero) viewport. After a task
    // switch the editor is recreated and a restore would otherwise run at 0/5px
    // height, where automaticLayout immediately re-clamps the scroll to 0 (Monaco
    // re-validates scroll against the viewport height on every layout). Retry on
    // animation frames (bounded) until it has height, then restore once — i.e.
    // setModel → real layout → restoreViewState, the order Monaco requires.
    let frames = 0;
    const tryRestore = () => {
      const editor = editorRef.current;
      // Keep retrying while the editor doesn't exist yet (on a recreate the host's
      // layout effect runs before the provider creates the editor) or has no real
      // viewport. Restore once both hold.
      if (editor && editor.getContainerDomNode().clientHeight > 0) {
        restoreRafRef.current = 0;
        modelRegistry.restoreViewState(uri, editor);
        // Editor now shows the restored offset; from here, user scrolls persist.
        scrollSaveEnabled.set(editor, true);
        return;
      }
      // TODO(ADE-5): if the editor stays 0-height past this budget (rare: a slow or
      // collapsed/animating pane), the loop gives up without re-enabling saving, so
      // persistence for this editor stays off until the next model change or
      // visibility transition re-triggers a restore. Acceptable for now; revisit if hit.
      if (frames++ < 60) restoreRafRef.current = requestAnimationFrame(tryRestore);
    };
    tryRestore();
  }, [activeViewStateUri]);

  return (
    <EditorContext.Provider value={{ setEditorHost, triggerLayout, restoreActiveViewState }}>
      {children}
    </EditorContext.Provider>
  );
});
