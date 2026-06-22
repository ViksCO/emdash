import { AlignJustify, Check, Columns2, Copy } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import type { DiffTabStore } from '@renderer/features/tasks/tabs/diff-tab-store';
import { useWorkspaceViewModel } from '@renderer/features/tasks/task-view-context';
import { splitPath } from '@renderer/features/tasks/utils';
import { MicroLabel } from '@renderer/lib/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

interface DiffToolbarProps {
  tab: DiffTabStore;
}

export const DiffToolbar = observer(function DiffToolbar({ tab }: DiffToolbarProps) {
  const diffView = useWorkspaceViewModel().diffView;
  const diffStyle = diffView?.diffStyle;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(tab.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  }, [tab.path]);

  const diffSourceLabel = (() => {
    if (tab.diffGroup === 'staged') return 'Staged';
    if (tab.diffGroup === 'disk') return 'Changed';
    if (tab.diffGroup === 'pr') return 'PR';
    if (tab.diffGroup === 'git') return 'Git';
    return undefined;
  })();

  if (!diffView || !diffStyle) return null;

  const { filename, directory } = splitPath(tab.path);

  return (
    <div className="flex h-[41px] items-center justify-between gap-2 border-b border-border bg-background-secondary-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="max-w-full shrink-0 truncate text-sm">{filename}</span>
          {directory && (
            <span className="min-w-0 shrink truncate text-xs text-foreground-muted">
              {directory}
            </span>
          )}
        </span>
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={handleCopy}
            aria-label="Copy path"
            className="shrink-0 rounded p-1 text-foreground-muted hover:bg-background-1 hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-foreground-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>Copy path</TooltipContent>
        </Tooltip>
        {diffSourceLabel && <MicroLabel>{diffSourceLabel}</MicroLabel>}
      </div>
      <div className="flex items-center gap-2">
        <ToggleGroup
          size="sm"
          multiple={false}
          value={[diffStyle]}
          onValueChange={([value]) => {
            if (value) {
              diffView.setDiffStyle(value as 'unified' | 'split');
            }
          }}
        >
          <ToggleGroupItem value="unified">
            <AlignJustify className="h-3.5 w-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="split">
            <Columns2 className="h-3.5 w-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
});
