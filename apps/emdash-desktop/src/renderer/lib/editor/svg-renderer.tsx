import { Eye, Pencil } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type { FileTabStore } from '@renderer/features/tasks/tabs/file-tab-store';
import { useWorkspaceViewModel } from '@renderer/features/tasks/task-view-context';
import { useScrollRestoration } from '@renderer/lib/hooks/use-scroll-restoration';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { buildMonacoModelPath } from '@renderer/lib/monaco/monacoModelPath';
import { ContainedImage } from '@renderer/lib/ui/contained-image';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';

interface SvgRendererProps {
  tab: FileTabStore;
}

/**
 * Renders an SVG file as an image.
 */
export const SvgRenderer = observer(function SvgRenderer({ tab }: SvgRendererProps) {
  const taskView = useWorkspaceViewModel();
  const { editorView, tabManager } = taskView;
  // `tab` is the pane-local store passed by FileRenderer — do NOT re-derive it from
  // the (focused-pane) tabManager, which resolves the wrong pane in split view.
  const filePath = tab.path;
  const scrollRef = useScrollRestoration<HTMLDivElement>(tab, filePath);
  const bufferUri = buildMonacoModelPath(editorView.modelRootPath, filePath);

  // Touch bufferVersions so this observer re-renders when the buffer is first
  // populated — otherwise the preview can stick on an empty src.
  void modelRegistry.bufferVersions.get(bufferUri);
  const content = modelRegistry.getValue(bufferUri) ?? '';
  const svgUrl = useMemo(
    () => (content ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}` : ''),
    [content]
  );
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div
      ref={scrollRef}
      className="relative flex h-full items-center justify-center overflow-auto p-4"
    >
      {svgUrl ? (
        <ContainedImage src={svgUrl} alt={fileName} className="max-h-full max-w-full" />
      ) : (
        <div className="text-xs text-foreground-passive">Loading…</div>
      )}
      <ToggleGroup
        value={['svg']}
        onValueChange={(value) => {
          if (value.includes('svg-source')) {
            tabManager.updateRenderer(filePath, () => ({ kind: 'svg-source' }));
          }
        }}
        size="sm"
        className="absolute top-3 right-3 z-10"
      >
        <ToggleGroupItem value="svg" aria-label="View rendered">
          <Eye className="h-3.5 w-3.5" />
        </ToggleGroupItem>
        <ToggleGroupItem value="svg-source" aria-label="Edit source">
          <Pencil className="h-3.5 w-3.5" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
});
