import type * as monaco from 'monaco-editor';

let extIndex: Map<string, string> | null = null;

function buildExtIndex(m: typeof monaco): Map<string, string> {
  const index = new Map<string, string>();
  for (const lang of m.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) index.set(ext.toLowerCase(), lang.id);
    for (const filename of lang.filenames ?? []) index.set(filename.toLowerCase(), lang.id);
  }
  return index;
}

/** Resolve a Monaco language id from a file path, falling back to 'plaintext'. */
function monacoLanguageForPath(path: string, m: typeof monaco): string {
  if (!extIndex) extIndex = buildExtIndex(m);
  const name = (path.split('/').pop() ?? path).toLowerCase();
  const byName = extIndex.get(name);
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const byExt = extIndex.get(name.slice(dot));
    if (byExt) return byExt;
  }
  return 'plaintext';
}

/**
 * Colorize file content to read-only HTML using the shared, already-loaded Monaco
 * instance — no editor, model, or worker is created. The active theme is applied
 * first so the token color CSS (`.mtk*`) is present. Throws if Monaco is
 * unavailable; callers should fall back to rendering plain text.
 */
export async function colorizeToHtml(
  content: string,
  path: string,
  effectiveTheme: string
): Promise<string> {
  // Loaded lazily so a peek only pulls Monaco when a code file is actually highlighted.
  const [{ codeEditorPool }, { defineMonacoThemes, getMonacoTheme }] = await Promise.all([
    import('@renderer/lib/monaco/monaco-code-pool'),
    import('@renderer/lib/monaco/monaco-themes'),
  ]);
  await codeEditorPool.init();
  const m = codeEditorPool.getMonaco();
  if (!m) throw new Error('Monaco is not available');
  defineMonacoThemes(m as Parameters<typeof defineMonacoThemes>[0]);
  m.editor.setTheme(getMonacoTheme(effectiveTheme));
  return m.editor.colorize(content, monacoLanguageForPath(path, m), {});
}
