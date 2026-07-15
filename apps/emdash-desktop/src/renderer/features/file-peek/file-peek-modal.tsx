import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { DialogDescription, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { FilePreview } from './file-preview';

export type FilePeekModalArgs = { absPath: string };

/**
 * Read-only peek at any file by absolute path, hosted on the global modal system
 * (no task workspace, no navigation). Escape / the close button dismiss it; the
 * footer opens the file in your preferred editor (WebStorm, VS Code, …).
 */
export function FilePeekModal({ absPath }: BaseModalProps<void> & FilePeekModalArgs) {
  const { effectiveTheme } = useTheme();
  const fileName = absPath.split('/').pop() || absPath;

  return (
    <>
      <DialogHeader>
        <FileIcon filename={fileName} size={16} />
        <div className="flex min-w-0 flex-col">
          <DialogTitle className="truncate font-sans text-sm font-medium tracking-normal text-foreground normal-case">
            {fileName}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs text-foreground/40">
            {absPath}
          </DialogDescription>
        </div>
      </DialogHeader>
      {/* Fixed height so the panel opens at full size — content loads into it
          rather than growing the modal (which read as a flash-then-expand). */}
      <div className="h-[72vh] overflow-auto border-t border-foreground/10">
        <FilePreview absPath={absPath} effectiveTheme={effectiveTheme} />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-foreground/10 px-3 py-2">
        <span className="flex items-center gap-1 text-xs text-foreground/40">
          <Shortcut hotkey="Escape" variant="badge" />
          Close
        </span>
        <OpenInMenu path={absPath} />
      </div>
    </>
  );
}
