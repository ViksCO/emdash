import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Activity, FolderOpen, GitBranch, MessageSquare, X, type LucideIcon } from 'lucide-react';
import { useObserver } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePreview } from '@renderer/features/file-peek/file-preview';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { conversationRegistry } from '@renderer/features/tasks/stores/conversation-registry';
import {
  getTaskStore,
  getTaskView,
  getWorkspaceForTask,
} from '@renderer/features/tasks/stores/task-selectors';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import { ALL_COMMAND_DEFS, type CommandDef } from '@shared/commands';
import type { SearchItem } from '@shared/core/search';
import './command-palette-peek.css';
import { getCommandIcon } from './command-icons';
import { PaletteConversationItem } from './palette-conversation-item';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';
import { PaletteNotificationsGroup } from './palette-notifications-group';
import { PaletteProjectsGroup } from './palette-projects-group';
import { PaletteTaskItem } from './palette-task-item';
import { ResourceMonitorView } from './resource-monitor-view';
import { applyContextAffinity } from './search-utils';

interface CommandPaletteProps {
  projectId?: string;
  taskId?: string;
  workspaceId?: string;
}

interface PaletteAction {
  kind: 'action';
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: ReturnType<typeof getEffectiveHotkey>;
  icon?: LucideIcon;
  execute: () => void;
}

const KIND_ICON: Record<string, React.ReactNode> = {
  action: null,
  task: <GitBranch size={14} className="shrink-0 text-foreground/40" />,
  project: <FolderOpen size={14} className="shrink-0 text-foreground/40" />,
  conversation: <MessageSquare size={14} className="shrink-0 text-foreground/40" />,
};

const GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
  '[&_[cmdk-group-heading]]:text-foreground/50'
);

// Ordered allowlists for the "Suggested Actions" empty-state group. Defined at
// module scope so the arrays keep stable references across renders.
const TASK_SUGGESTED = [
  'task.newConversation',
  'task.sidebarChanges',
  'task.sidebarFiles',
  'task.sidebarConversations',
  'task.toggleTerminalDrawer',
  'resource-monitor',
  'app.giveFeedback',
];
const PROJECT_SUGGESTED = ['app.newTask', 'app.settings', 'resource-monitor', 'app.giveFeedback'];
const APP_SUGGESTED = ['app.newProject', 'app.settings', 'resource-monitor', 'app.giveFeedback'];

function PaletteItem({
  value,
  item,
  onSelect,
}: {
  value: string;
  item: SearchItem | PaletteAction;
  onSelect: () => void;
}) {
  const action = item.kind === 'action' ? (item as PaletteAction) : null;
  const ActionIcon = action?.icon;
  const iconNode = ActionIcon ? (
    <ActionIcon size={14} className="shrink-0 text-foreground/40" />
  ) : (
    KIND_ICON[item.kind]
  );
  return (
    <Command.Item value={value} onSelect={onSelect} className={cn(PALETTE_ITEM_CLASS, 'group')}>
      {iconNode}
      <span className="flex-1 truncate">{item.title}</span>
      {action?.shortcut && (
        <>
          <Shortcut hotkey={action.shortcut} className="group-aria-selected:hidden" />
          <Shortcut
            hotkey={action.shortcut}
            variant="badge"
            className="hidden group-aria-selected:inline-flex"
          />
        </>
      )}
    </Command.Item>
  );
}

function PaletteFileItem({
  value,
  item,
  onSelect,
}: {
  value: string;
  item: SearchItem;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={cn(PALETTE_ITEM_CLASS, 'group')}>
      <FileIcon filename={item.title} size={14} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="shrink-0">{item.title}</span>
        <span className="truncate text-xs text-foreground/40">{item.subtitle}</span>
      </span>
      <span
        className="hidden shrink-0 items-center gap-1 text-tiny group-aria-selected:flex"
        style={{ color: 'var(--jade-11)' }}
      >
        <Shortcut hotkey="Mod+Enter" variant="badge" />
        Peek file
      </span>
    </Command.Item>
  );
}

export function CommandPaletteModal({
  projectId,
  taskId,
  workspaceId,
  onClose,
}: CommandPaletteProps & BaseModalProps) {
  const [view, setView] = useState<'search' | 'resource-monitor'>('search');
  const [query, setQuery] = useState('');
  // 'search' shows the palette; 'preview' cross-fades to the peek layer in place.
  const [phase, setPhase] = useState<'search' | 'preview'>('search');
  const [peekPath, setPeekPath] = useState<string | null>(null);
  const debouncedQuery = useDebounce(query, 100);
  const { navigate } = useNavigate();
  const { effectiveTheme } = useTheme();
  const { value: resourceMonitor } = useAppSettingsKey('resourceMonitor');
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const queryClient = useQueryClient();
  const peekRef = useRef<HTMLDivElement>(null);

  const handleClose = onClose;

  // Move focus onto the peek layer as it blooms in, so the (now hidden) search
  // input can't swallow keystrokes and Esc/Tab act on the peek.
  useEffect(() => {
    if (phase === 'preview') peekRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (view !== 'resource-monitor') return;
    appState.resourceMonitor.start();
    return () => appState.resourceMonitor.dispose();
  }, [view]);

  // Prefetch recents immediately on mount so the empty-query view is instant.
  useEffect(() => {
    void queryClient.prefetchQuery({
      queryKey: ['cmdk-search', '', projectId, taskId, workspaceId],
      queryFn: () =>
        rpc.search.commandPalette({ query: '', context: { projectId, taskId, workspaceId } }),
      staleTime: 5_000,
    });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  const { data: dbResults = [] } = useQuery({
    queryKey: ['cmdk-search', debouncedQuery, projectId, taskId, workspaceId],
    queryFn: () =>
      rpc.search.commandPalette({
        query: debouncedQuery,
        context: { projectId, taskId, workspaceId },
      }),
    // Keep results fresh for 5 s — re-opening the palette with the same query
    // returns cached data instantly rather than waiting for a round-trip.
    staleTime: 5_000,
    placeholderData: (prev) => prev,
    // Skip FTS queries that the trigram tokenizer would reject (< 3 chars).
    enabled: debouncedQuery.length === 0 || debouncedQuery.length >= 3,
  });

  // cmdk's currently-highlighted item value (for ⌘Enter to act on the selection).
  const [selectedValue, setSelectedValue] = useState('');

  // Resolve a file result's absolute path and bloom the peek layer in place.
  // Mount the peek layer at its resting (hidden) state first, then flip to
  // 'preview' next frame so the bloom transition actually fires from opacity 0.
  const peekFile = (file: SearchItem) => {
    if (!file.projectId || !file.taskId) return;
    const workspace = getWorkspaceForTask(file.projectId, file.taskId);
    if (!workspace?.path) return;
    setPeekPath(`${workspace.path}/${file.id}`);
    requestAnimationFrame(() => setPhase('preview'));
  };

  // ⌘/Ctrl+Enter peeks the highlighted file result (plain Enter peeks it too, via
  // its row onSelect). Values are compared case-insensitively (cmdk lowercases).
  const handlePeekShortcut = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    const file = rankedDb.find(
      (r) => r.kind === 'file' && `file:${r.id}`.toLowerCase() === selectedValue.toLowerCase()
    );
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    peekFile(file);
  };

  const registryActions = useObserver((): PaletteAction[] =>
    commandRegistry.activeCommands
      .filter((cmd) => cmd.enabled !== false && !cmd.hideFromPalette)
      .map((cmd) => {
        const def = ALL_COMMAND_DEFS.find((d) => d.id === cmd.id) as CommandDef | undefined;
        return {
          kind: 'action' as const,
          id: cmd.id,
          title: cmd.label,
          subtitle: cmd.description,
          shortcut: cmd.shortcutKey ? getEffectiveHotkey(cmd.shortcutKey, keyboard) : null,
          icon: getCommandIcon(def?.iconKey),
          execute: () => {
            handleClose();
            cmd.execute();
          },
        };
      })
  );

  const resourceMonitorAction = useMemo<PaletteAction | null>(
    () =>
      resourceMonitor?.enabled
        ? {
            kind: 'action',
            id: 'resource-monitor',
            title: 'Resource Monitor',
            subtitle: 'Show CPU and memory performance for running agents',
            icon: Activity,
            execute: () => {
              setView('resource-monitor');
            },
          }
        : null,
    [resourceMonitor?.enabled]
  );

  const actions = useMemo(() => {
    // Empty state: show the ordered context-specific suggested actions only.
    const suggestedIds = taskId ? TASK_SUGGESTED : projectId ? PROJECT_SUGGESTED : APP_SUGGESTED;
    const pool = resourceMonitorAction
      ? [...registryActions, resourceMonitorAction]
      : registryActions;
    return pool
      .filter((a) => suggestedIds.includes(a.id))
      .sort((a, b) => suggestedIds.indexOf(a.id) - suggestedIds.indexOf(b.id))
      .slice(0, 7);
  }, [registryActions, resourceMonitorAction, projectId, taskId]);

  const rankedDb = applyContextAffinity(dbResults, { projectId });
  const actionResults = actions;

  const q = debouncedQuery.toLowerCase();
  const matchedResourceMonitor =
    resourceMonitorAction &&
    q &&
    (resourceMonitorAction.title.toLowerCase().includes(q) ||
      resourceMonitorAction.subtitle?.toLowerCase().includes(q))
      ? resourceMonitorAction
      : null;
  const taskResults = rankedDb.filter((r): r is SearchItem => r.kind === 'task');
  const conversationResults = rankedDb.filter((r): r is SearchItem => r.kind === 'conversation');

  // cmdk only auto-selects the first item when the query changes, not when async
  // results arrive later — so highlight the first item ourselves whenever the top
  // result changes. Values mirror those set on the rendered items below.
  const firstValue = query
    ? matchedResourceMonitor
      ? matchedResourceMonitor.id
      : rankedDb[0]
        ? rankedDb[0].kind === 'command'
          ? rankedDb[0].id
          : `${rankedDb[0].kind}:${rankedDb[0].id}`
        : ''
    : (actionResults[0]?.id ?? '');
  useEffect(() => {
    setSelectedValue(firstValue);
  }, [firstValue]);

  const handleNavigateToTask = (item: SearchItem) => {
    if (!item.projectId) return;
    handleClose();
    navigate('task', { projectId: item.projectId, taskId: item.id });
  };

  const handleNavigateToProject = (item: SearchItem) => {
    handleClose();
    navigate('project', { projectId: item.id });
  };

  const handleNavigateToConversation = (item: SearchItem) => {
    if (!item.projectId || !item.taskId) return;
    getTaskView(item.projectId, item.taskId)?.tabGroupManager.openConversation(item.id);
    handleClose();
    navigate('task', { projectId: item.projectId, taskId: item.taskId });
  };

  const handleSelect = (item: SearchItem) => {
    if (item.kind === 'task') return handleNavigateToTask(item);
    if (item.kind === 'project') return handleNavigateToProject(item);
    if (item.kind === 'conversation') return handleNavigateToConversation(item);
    if (item.kind === 'file') return peekFile(item);
  };

  const handleResourceMonitorBack = useCallback(() => {
    setView('search');
  }, []);

  useEffect(() => {
    if (view !== 'resource-monitor') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        handleResourceMonitorBack();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [view, handleResourceMonitorBack]);

  const peekName = peekPath ? (peekPath.split('/').pop() ?? peekPath) : '';

  const searchCard =
    view === 'resource-monitor' ? (
      <div className="flex flex-col overflow-hidden">
        <ResourceMonitorView onBack={handleResourceMonitorBack} />
        <div className="flex items-center gap-4 border-t border-foreground/10 px-3 py-2">
          <span className="flex items-center gap-1 text-xs text-foreground/40">
            <Shortcut hotkey="Escape" variant="badge" />
            <Shortcut hotkey="Backspace" variant="badge" />
            Back
          </span>
        </div>
      </div>
    ) : (
      <Command
        className="flex flex-col overflow-hidden"
        shouldFilter={false}
        loop
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDown={handlePeekShortcut}
      >
        <div className="border-b border-foreground/10 px-1">
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Search tasks, projects, actions…"
            className="w-full bg-transparent px-3 py-3 text-sm outline-none placeholder:text-foreground/40"
            autoFocus
            data-autofocus
          />
        </div>
        <Command.List className="h-96 overflow-y-auto p-1">
          {query ? (
            <>
              <Command.Empty className="py-8 text-center text-sm text-foreground/40">
                No results for &ldquo;{query}&rdquo;
              </Command.Empty>
              {matchedResourceMonitor && (
                <PaletteItem
                  value={matchedResourceMonitor.id}
                  item={matchedResourceMonitor}
                  onSelect={matchedResourceMonitor.execute}
                />
              )}
              {rankedDb.map((item) => {
                if (item.kind === 'command') {
                  const live = commandRegistry.findById(item.id);
                  if (!live || live.enabled === false || live.hideFromPalette) return null;
                  const def = ALL_COMMAND_DEFS.find((d) => d.id === item.id) as
                    | CommandDef
                    | undefined;
                  const shortcut = def?.shortcutKey
                    ? getEffectiveHotkey(def.shortcutKey, keyboard)
                    : null;
                  const displayItem: PaletteAction = {
                    kind: 'action',
                    id: item.id,
                    title: live.label,
                    subtitle: live.description,
                    shortcut,
                    icon: getCommandIcon(def?.iconKey),
                    execute: () => {
                      handleClose();
                      live.execute();
                    },
                  };
                  return (
                    <PaletteItem
                      key={item.id}
                      value={item.id}
                      item={displayItem}
                      onSelect={() => {
                        handleClose();
                        live.execute();
                      }}
                    />
                  );
                }
                if (item.kind === 'task' && item.projectId) {
                  const store = getTaskStore(item.projectId, item.id);
                  if (store) {
                    return (
                      <PaletteTaskItem
                        key={`task:${item.id}`}
                        taskStore={store}
                        value={`task:${item.id}`}
                        onSelect={() => handleNavigateToTask(item)}
                      />
                    );
                  }
                }
                if (item.kind === 'conversation' && item.projectId && item.taskId) {
                  const convStore = conversationRegistry
                    .get(item.taskId)
                    ?.conversations.get(item.id);
                  if (convStore) {
                    return (
                      <PaletteConversationItem
                        key={`conversation:${item.id}`}
                        conv={convStore}
                        value={`conversation:${item.id}`}
                        onSelect={() => handleNavigateToConversation(item)}
                      />
                    );
                  }
                }
                if (item.kind === 'file') {
                  return (
                    <PaletteFileItem
                      key={`file:${item.id}`}
                      value={`file:${item.id}`}
                      item={item}
                      onSelect={() => peekFile(item)}
                    />
                  );
                }
                return (
                  <PaletteItem
                    key={`${item.kind}:${item.id}`}
                    value={`${item.kind}:${item.id}`}
                    item={item}
                    onSelect={() => handleSelect(item)}
                  />
                );
              })}
            </>
          ) : (
            <>
              <PaletteNotificationsGroup
                currentProjectId={projectId}
                currentTaskId={taskId}
                onClose={handleClose}
                navigate={navigate}
              />
              {actionResults.length > 0 && (
                <Command.Group heading="Suggested Actions" className={GROUP_CLASS}>
                  {actionResults.map((item) => (
                    <PaletteItem
                      key={item.id}
                      value={item.id}
                      item={item}
                      onSelect={item.execute}
                    />
                  ))}
                </Command.Group>
              )}
              {taskResults.length > 0 && (
                <Command.Group heading="Recent Tasks" className={GROUP_CLASS}>
                  {taskResults.slice(0, 5).map((item) => {
                    const store = item.projectId
                      ? getTaskStore(item.projectId, item.id)
                      : undefined;
                    return store ? (
                      <PaletteTaskItem
                        key={item.id}
                        taskStore={store}
                        value={item.id}
                        onSelect={() => handleNavigateToTask(item)}
                      />
                    ) : (
                      <PaletteItem
                        key={item.id}
                        value={item.id}
                        item={item}
                        onSelect={() => handleNavigateToTask(item)}
                      />
                    );
                  })}
                </Command.Group>
              )}
              {!taskId && (
                <PaletteProjectsGroup
                  currentProjectId={projectId}
                  limit={5}
                  onClose={handleClose}
                  navigate={navigate}
                />
              )}
              {taskId && conversationResults.length > 0 && (
                <Command.Group heading="Recent Conversations" className={GROUP_CLASS}>
                  {conversationResults.slice(0, 5).map((item) => {
                    const convStore = item.taskId
                      ? conversationRegistry.get(item.taskId)?.conversations.get(item.id)
                      : undefined;
                    return convStore ? (
                      <PaletteConversationItem
                        key={item.id}
                        conv={convStore}
                        value={item.id}
                        onSelect={() => handleNavigateToConversation(item)}
                      />
                    ) : (
                      <PaletteItem
                        key={item.id}
                        value={item.id}
                        item={item}
                        onSelect={() => handleNavigateToConversation(item)}
                      />
                    );
                  })}
                </Command.Group>
              )}
            </>
          )}
        </Command.List>

        <div className="flex items-center gap-4 border-t border-foreground/10 px-3 py-2">
          <span className="flex items-center gap-1 text-xs text-foreground/40">
            <Shortcut hotkey="ArrowUp" variant="badge" />
            <Shortcut hotkey="ArrowDown" variant="badge" />
            Navigate
          </span>
          <span className="flex items-center gap-1 text-xs text-foreground/40">
            <Shortcut hotkey="Enter" variant="badge" />
            Select
          </span>
          <span className="flex items-center gap-1 text-xs text-foreground/40">
            <Shortcut hotkey="Escape" variant="badge" />
            Close
          </span>
        </div>
      </Command>
    );

  return (
    <div className="cmdk-stage">
      <div
        data-phase={phase}
        inert={phase === 'preview'}
        className="cmdk-search-layer flex max-h-[72vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-xl bg-background-quaternary text-sm ring-1 ring-foreground/10"
      >
        {searchCard}
      </div>
      {peekPath && (
        <div
          ref={peekRef}
          tabIndex={-1}
          data-phase={phase}
          inert={phase !== 'preview'}
          className="cmdk-peek-layer flex h-[min(640px,80vh)] w-[860px] max-w-[90vw] flex-col overflow-hidden rounded-xl bg-background-quaternary text-sm ring-1 ring-foreground/10 outline-none"
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-foreground/10 px-4 py-3">
            <FileIcon filename={peekName} size={18} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-foreground">{peekName}</span>
              <span className="truncate font-mono text-xs text-foreground/40">{peekPath}</span>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-muted hover:bg-background-2 hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <FilePreview absPath={peekPath} effectiveTheme={effectiveTheme} />
          </div>
          <div className="flex shrink-0 items-center justify-between gap-4 border-t border-foreground/10 px-3 py-2">
            <span className="flex items-center gap-1 text-xs text-foreground/40">
              <Shortcut hotkey="Escape" variant="badge" />
              Close
            </span>
            <OpenInMenu path={peekPath} />
          </div>
        </div>
      )}
    </div>
  );
}
