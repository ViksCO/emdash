import { autorun } from 'mobx';
import { observer } from 'mobx-react-lite';
import type * as monacoNS from 'monaco-editor';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { useWorkspaceViewModel } from '@renderer/features/tasks/task-view-context';
import { registerActiveCodeEditor } from '@renderer/lib/editor/activeCodeEditor';
import { DEFAULT_EDITOR_OPTIONS } from '@renderer/lib/editor/utils';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { monacoBootstrap } from '@renderer/lib/monaco/monaco-bootstrap';
import {
  addMonacoKeyboardShortcuts,
  configureMonacoEditor,
} from '@renderer/lib/monaco/monaco-config';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { buildMonacoModelPath } from '@renderer/lib/monaco/monacoModelPath';
import { useIsActiveTask } from '../hooks/use-is-active-task';
import { useTaskViewContext } from '../task-view-context';
import {
  activeFileEntry as getActiveFileEntry,
  activeFilePath as getActiveFilePath,
} from './pane-selectors';

interface EditorContextValue {
  /**
   * Ref callback that appends the pane's stable Monaco editor container to the
   * given DOM element. Called by MonacoFileRenderer to position the editor host.
   */
  setEditorHost: (el: HTMLElement | null) => void;
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
}: {
  children: ReactNode;
}) {
  const { taskId } = useTaskViewContext();
  const taskView = useWorkspaceViewModel();
  const { editorView, paneLayout } = taskView;
  const { paneId, pane: paneTabManager } = usePaneContext();
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

  // Tracks the previously-attached buffer URI so modelRegistry.attach can
  // save view state before switching models.
  const prevBufUriRef = useRef<string | undefined>(undefined);

  // ---------------------------------------------------------------------------
  // Theme sync — update editor theme when app theme changes.
  // When this pane's editor is created it will inherit the current theme.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    monacoBootstrap.setTheme(effectiveTheme);
  }, [effectiveTheme]);

  // ---------------------------------------------------------------------------
  // Editor creation — fires once on mount. Creates a Monaco editor directly
  // using the globally-loaded Monaco instance. Monaco is guaranteed to be loaded
  // before any pane renders (bootstrap awaits init in main.tsx).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const m = monacoBootstrap.getMonaco();
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
        const path = getActiveFilePath(paneTabManager);
        if (path) void editorView.saveFile(path);
      },
      onSaveAll: () => {
        void editorView.saveAllFiles();
      },
    });

    const focusDisposable = editor.onDidFocusEditorWidget(() => {
      taskView.setFocusedRegion('main');
      paneLayout.setActiveGroup(paneId);
    });

    // Continuously persist scroll + cursor for the active file while the editor is
    // laid out. Skipped while the host is hidden/detached (height 0) — there
    // automaticLayout has clamped scrollTop to 0, and saving then would lose the
    // real position. Keeping each file's view state fresh lets attach() (on tab
    // switch) and restart restore the correct offset.
    const scrollDisposable = editor.onDidScrollChange(() => {
      // Skip while hidden/detached (display:none or unmounted → DOM clientHeight 0;
      // note getLayoutInfo().height reports Monaco's 5px floor, not 0). Skip until
      // the active file is restored, so a recreated editor's clamp-to-0 can't
      // overwrite the saved offset.
      if (editor.getContainerDomNode().clientHeight <= 0 || !scrollSaveEnabled.get(editor)) {
        return;
      }
      const path = getActiveFilePath(paneTabManager);
      if (!path) return;
      modelRegistry.saveViewState(buildMonacoModelPath(editorView.modelRootPath, path), editor);
    });

    if (hostRef.current) {
      hostRef.current.appendChild(container);
      editor.layout();
    }

    return () => {
      focusDisposable.dispose();
      scrollDisposable.dispose();
      cleanupActive();
      // Save the active file's view state before disposal. Must run here, not in
      // the attachment autorun's cleanup — that fires after the editor is disposed.
      modelRegistry.detach(editor, prevBufUriRef.current);
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
      if (paneLayout.activePaneId !== paneId) return;
      if (event.key.toLowerCase() !== 's') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void editorView.saveAllFiles();
        return;
      }

      const path = getActiveFilePath(paneTabManager);
      if (!path) return;

      event.preventDefault();
      event.stopPropagation();
      void editorView.saveFile(path);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [editorView, paneId, isActive, paneTabManager, paneLayout, taskView]);

  // ---------------------------------------------------------------------------
  // Model attachment — autorun that re-evaluates whenever the pane-local active
  // file or model registration status changes.
  // ---------------------------------------------------------------------------
  useEffect(
    () =>
      autorun(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const entry = getActiveFileEntry(paneTabManager); // reactive
        const newBufUri = entry ? buildMonacoModelPath(editorView.modelRootPath, entry.path) : null;

        if (!newBufUri) {
          // detach saves the file's view state, so the scroll position survives
          // switching to a non-file tab (conversation, diff, …).
          modelRegistry.detach(editor, prevBufUriRef.current);
          prevBufUriRef.current = undefined;
          return;
        }

        const status = modelRegistry.modelStatus.get(newBufUri); // reactive
        if (status !== 'ready') {
          if (prevBufUriRef.current && prevBufUriRef.current !== newBufUri) {
            modelRegistry.detach(editor, prevBufUriRef.current);
            prevBufUriRef.current = undefined;
          }
          return;
        }

        if (newBufUri !== prevBufUriRef.current) {
          scrollSaveEnabled.set(editor, false); // suspend save until the new file is restored
        }
        modelRegistry.attach(editor, newBufUri, prevBufUriRef.current);
        prevBufUriRef.current = newBufUri;

        // attach restored the new file's view state iff the editor is on screen.
        // Re-enable continuous persistence once the editor has a real viewport, so a
        // user scroll after a tab switch is saved. A recreate that starts at 0 height
        // stays suspended until the next attach re-enables it.
        if (editor.getContainerDomNode().clientHeight > 0) {
          scrollSaveEnabled.set(editor, true);
        }

        // Satisfy any focus request that arrived while the model was still loading.
        if (focusPendingRef.current) {
          focusPendingRef.current = false;
          editor.focus();
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
        const filePath = modelRegistry.filePathForUri(uri);
        if (!filePath) return;
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
    if (paneLayout.activePaneId !== paneId) return;
    const editor = editorRef.current;
    if (editor?.getModel()) {
      editor.focus();
    } else {
      focusPendingRef.current = true;
    }
  }, [isActive, focusedRegion, paneId, paneLayout.activePaneId]);

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

  return <EditorContext.Provider value={{ setEditorHost }}>{children}</EditorContext.Provider>;
});
