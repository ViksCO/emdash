import { useTheme } from '@renderer/lib/hooks/useTheme';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { DialogDescription, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { FilePreview } from './file-preview';

export type FilePeekModalArgs = { absPath: string };

/**
 * Read-only peek at any file by absolute path, hosted on the global modal system
 * (no task workspace, no navigation). Escape / the close button dismiss it.
 */
export function FilePeekModal({ absPath }: BaseModalProps<void> & FilePeekModalArgs) {
  const { effectiveTheme } = useTheme();
  const fileName = absPath.split('/').pop() || absPath;

  return (
    <>
      <DialogHeader>
        <div className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle className="truncate font-sans text-sm tracking-normal text-foreground normal-case">
            {fileName}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{absPath}</DialogDescription>
        </div>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <FilePreview absPath={absPath} effectiveTheme={effectiveTheme} />
      </div>
    </>
  );
}
