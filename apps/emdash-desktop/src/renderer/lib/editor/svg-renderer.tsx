import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type { FileTabResource } from '@renderer/features/tasks/editor/stores/file-tab-resource';
import { useWorkspaceViewModel } from '@renderer/features/tasks/task-view-context';
import { useScrollRestoration } from '@renderer/lib/hooks/use-scroll-restoration';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { buildMonacoModelPath } from '@renderer/lib/monaco/monacoModelPath';
import { ContainedImage } from '@renderer/lib/ui/contained-image';

interface SvgRendererProps {
  tab: FileTabResource;
}

/**
 * Renders an SVG file as an image preview.
 * The source/preview toggle lives in the FileContent container above this component.
 */
export const SvgRenderer = observer(function SvgRenderer({ tab }: SvgRendererProps) {
  const { editorView } = useWorkspaceViewModel();
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
    </div>
  );
});
