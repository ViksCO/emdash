// Browser-test setup: install a window.electronAPI before any renderer module
// is imported. The rpc client (lib/ipc.ts) captures window.electronAPI.invoke at
// module-eval, so it must exist up front. `invoke` delegates to a per-test
// handler that tests set on window.__testInvoke.

type TestInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

declare global {
  interface Window {
    __testInvoke?: TestInvoke;
  }
}

if (!window.electronAPI) {
  window.electronAPI = {
    invoke: (channel: string, ...args: unknown[]) =>
      (window.__testInvoke ?? (() => Promise.resolve({ success: true })))(channel, ...args),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
}

export {};
