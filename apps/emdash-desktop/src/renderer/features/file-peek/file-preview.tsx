import { useEffect, useState } from 'react';
import { colorizeToHtml } from '@renderer/lib/editor/code-colorizer';
import { getFileKind } from '@renderer/lib/editor/fileKind';
import { useDelayedBoolean } from '@renderer/lib/hooks/use-delay-boolean';
import { rpc } from '@renderer/lib/ipc';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Spinner } from '@renderer/lib/ui/spinner';

/** Show raw text only if highlighting takes longer than this; a fast highlight skips it. */
const PLAINTEXT_AFTER_MS = 60;

const CODE_PRE_CLASS = 'm-0 overflow-x-auto p-4 font-mono text-[13px] leading-[1.5] whitespace-pre';

type PreviewState =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }
  | { status: 'markdown'; content: string }
  | { status: 'plain'; content: string }
  | { status: 'highlighted'; html: string };

/**
 * Reads a file by absolute path and renders it read-only, in place. Markdown is
 * rendered formatted; text/code is syntax-highlighted via Monaco's colorizer with
 * a plaintext-first threshold; images and binaries offer an "open externally"
 * fallback. No editor/model/worker and no task workspace involved.
 */
export function FilePreview({
  absPath,
  effectiveTheme,
}: {
  absPath: string;
  effectiveTheme: string;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const showSpinner = useDelayedBoolean(state.status === 'loading', 200);

  useEffect(() => {
    let cancelled = false;
    let plainTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: 'loading' });

    const kind = getFileKind(absPath);
    if (kind === 'image' || kind === 'binary') {
      setState({ status: 'unsupported' });
      return;
    }

    void (async () => {
      const res = await rpc.app.readUserFile(absPath);
      if (cancelled) return;
      if (!res.success) {
        setState({ status: 'error', message: res.error ?? 'Could not read file.' });
        return;
      }
      const content = res.content ?? '';

      // A NUL byte means the file is binary despite an unlisted/absent extension —
      // rendering it as UTF-8 would be mojibake.
      if (/\u0000/.test(content.slice(0, 4096))) {
        setState({ status: 'unsupported' });
        return;
      }

      if (kind === 'markdown') {
        setState({ status: 'markdown', content });
        return;
      }

      // Drop the file's terminating newline so the last line isn't followed by a blank one.
      const code = content.endsWith('\n') ? content.slice(0, -1) : content;

      plainTimer = setTimeout(() => {
        if (!cancelled) {
          setState((s) => (s.status === 'loading' ? { status: 'plain', content: code } : s));
        }
      }, PLAINTEXT_AFTER_MS);

      try {
        const html = await colorizeToHtml(code, absPath, effectiveTheme);
        if (cancelled) return;
        clearTimeout(plainTimer);
        setState({ status: 'highlighted', html });
      } catch {
        if (cancelled) return;
        clearTimeout(plainTimer);
        setState({ status: 'plain', content: code });
      }
    })();

    return () => {
      cancelled = true;
      if (plainTimer) clearTimeout(plainTimer);
    };
  }, [absPath, effectiveTheme]);

  if (state.status === 'loading') {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center">
        {showSpinner ? <Spinner /> : null}
      </div>
    );
  }

  if (state.status === 'unsupported' || state.status === 'error') {
    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 py-10 text-center">
        <p className="text-sm text-foreground-tertiary">
          {state.status === 'error'
            ? 'Couldn’t open this file.'
            : 'Can’t preview this file type — use “Open externally” below.'}
        </p>
      </div>
    );
  }

  if (state.status === 'markdown') {
    return (
      <MarkdownRenderer
        content={state.content}
        variant="full"
        className="mx-auto max-w-3xl px-6 py-4"
      />
    );
  }

  if (state.status === 'highlighted') {
    return (
      <div className="min-h-full" style={{ background: 'var(--monaco-bg, transparent)' }}>
        <pre
          className={CODE_PRE_CLASS}
          style={{ color: 'var(--monaco-fg)' }}
          dangerouslySetInnerHTML={{ __html: state.html }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-full" style={{ background: 'var(--monaco-bg, transparent)' }}>
      <pre className={CODE_PRE_CLASS} style={{ color: 'var(--monaco-fg)' }}>
        {state.content}
      </pre>
    </div>
  );
}
