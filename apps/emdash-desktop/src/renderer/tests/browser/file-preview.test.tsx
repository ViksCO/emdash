import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { FilePreview } from '@renderer/features/file-peek/file-preview';
import { ThemeContext } from '@renderer/lib/providers/theme-provider';

declare global {
  interface Window {
    __testInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  }
}

// Files served to the stubbed rpc.app.readUserFile, per test.
let files: Record<string, string> = {};

// Minimal theme context so children that call useTheme (e.g. MarkdownRenderer)
// work without the rpc-backed ThemeProvider.
function renderWithTheme(ui: ReactElement) {
  return render(
    <ThemeContext.Provider
      value={{ theme: null, setTheme: () => {}, toggleTheme: () => {}, effectiveTheme: 'emdark' }}
    >
      {ui}
    </ThemeContext.Provider>
  );
}

describe('FilePreview (read-only peek render)', () => {
  beforeEach(() => {
    files = {};
    window.__testInvoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'app.readUserFile') {
        const path = args[0] as string;
        return Promise.resolve(
          path in files
            ? { success: true, content: files[path] }
            : { success: false, error: 'ENOENT' }
        );
      }
      return Promise.resolve({ success: true });
    };
  });

  afterEach(() => {
    window.__testInvoke = undefined;
  });

  it('renders code file content read-only (plaintext-first, upgrades to highlight)', async () => {
    files['/repo/src/answer.ts'] = 'export const answer: number = 42;\n';
    const screen = await renderWithTheme(
      <FilePreview absPath="/repo/src/answer.ts" effectiveTheme="emdark" />
    );
    await expect.element(screen.getByText(/export const answer/)).toBeVisible();
  });

  it('renders markdown as formatted content', async () => {
    files['/repo/README.md'] = '# Peek Heading\n\nBody paragraph.';
    const screen = await renderWithTheme(
      <FilePreview absPath="/repo/README.md" effectiveTheme="emdark" />
    );
    await expect.element(screen.getByText('Peek Heading')).toBeVisible();
  });

  it('shows an unsupported message for images instead of rendering bytes', async () => {
    const screen = await renderWithTheme(
      <FilePreview absPath="/repo/logo.png" effectiveTheme="emdark" />
    );
    await expect.element(screen.getByText(/can.t preview this file type/i)).toBeVisible();
  });

  it('treats a NUL-containing "text" file as binary rather than rendering mojibake', async () => {
    // .ts is a text extension, but the content is binary — the NUL sniff should catch it.
    files['/repo/fake.ts'] = 'MZ' + String.fromCharCode(0, 0) + 'binary junk';
    const screen = await renderWithTheme(
      <FilePreview absPath="/repo/fake.ts" effectiveTheme="emdark" />
    );
    await expect.element(screen.getByText(/can.t preview this file type/i)).toBeVisible();
  });

  it('shows an error message when the file cannot be read', async () => {
    const screen = await renderWithTheme(
      <FilePreview absPath="/repo/missing.ts" effectiveTheme="emdark" />
    );
    await expect.element(screen.getByText(/couldn.t open this file/i)).toBeVisible();
  });
});
