import { describe, expect, it } from 'vitest';
import { deriveFileContentFlags } from './file-content-flags';
import type { FileContentTypeDef } from './file-content-types';

const Preview = () => null;
const markdown: FileContentTypeDef = { editable: true, Preview };
const text: FileContentTypeDef = { editable: true };
const image: FileContentTypeDef = { editable: false, Preview };

describe('deriveFileContentFlags', () => {
  it('offers the toggle for editable workspace files with a preview', () => {
    expect(deriveFileContentFlags(markdown, 'preview', false)).toEqual({
      showSource: false,
      showPreview: true,
      canToggle: true,
    });
  });

  it('withholds the toggle for external files so Raw never hangs', () => {
    const flags = deriveFileContentFlags(markdown, 'preview', true);
    expect(flags.canToggle).toBe(false);
    expect(flags.showPreview).toBe(true);
    expect(flags.showSource).toBe(false);
  });

  it('shows source when a workspace file is toggled to Raw', () => {
    expect(deriveFileContentFlags(markdown, 'source', false)).toEqual({
      showSource: true,
      showPreview: false,
      canToggle: true,
    });
  });

  it('shows source only for editable types without a preview', () => {
    expect(deriveFileContentFlags(text, 'preview', false)).toEqual({
      showSource: true,
      showPreview: false,
      canToggle: false,
    });
  });

  it('shows preview only for non-editable types with a preview', () => {
    expect(deriveFileContentFlags(image, 'source', false)).toEqual({
      showSource: false,
      showPreview: true,
      canToggle: false,
    });
  });

  it('exposes nothing when the content type is unknown', () => {
    expect(deriveFileContentFlags(null, 'preview', false)).toEqual({
      showSource: false,
      showPreview: false,
      canToggle: false,
    });
  });
});
