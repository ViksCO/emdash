import type { FileContentTypeDef } from './file-content-types';
import type { FileViewMode } from './stores/file-tab-resource';

export interface FileContentFlags {
  /** Show the Monaco source (Raw) view. */
  showSource: boolean;
  /** Show the rendered preview. */
  showPreview: boolean;
  /** Offer the Raw/Preview toggle. */
  canToggle: boolean;
}

/**
 * Derive which views a file tab exposes from its content-type capabilities,
 * current view mode, and whether it is an external (out-of-workspace) file.
 *
 * External files are read through a standalone content load and have no Monaco
 * model, so their Raw view can never leave the "Loading file..." state — the
 * toggle is withheld for them even when the kind is otherwise editable.
 */
export function deriveFileContentFlags(
  def: FileContentTypeDef | null,
  viewMode: FileViewMode,
  isExternal: boolean
): FileContentFlags {
  if (!def) return { showSource: false, showPreview: false, canToggle: false };
  return {
    showSource: def.editable && (viewMode === 'source' || !def.Preview),
    showPreview: !!def.Preview && (viewMode === 'preview' || !def.editable),
    canToggle: def.editable && !!def.Preview && !isExternal,
  };
}
