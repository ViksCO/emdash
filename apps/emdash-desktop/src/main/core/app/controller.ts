import { getDiagnosticLogAttachment } from '@main/lib/file-logger';
import { telemetryService } from '@main/lib/telemetry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { OpenInAppId } from '@shared/openInApps';
import { defaultDevRoot, discoverGitReposCached, listRepoFiles } from './repo-discovery';
import { appService } from './service';

// Only one repo scope is active in the palette at a time, so a new file listing
// supersedes any still-running crawl. Aborting the previous one keeps quick scope
// switches from stacking concurrent full crawls. Tagged with its repoPath so an
// explicit cancel (palette closed / scope cleared) only aborts the crawl it meant to.
let activeRepoFilesCrawl: { repoPath: string; abort: AbortController } | null = null;

export const appController = createRPCController({
  openExternal: async (url: string) => {
    try {
      await appService.openExternal(url);
      telemetryService.capture('open_in_external', { app: 'browser' });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  openPath: async (path: string) => {
    try {
      await appService.openPath(path);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  readUserFile: async (path: string) => {
    try {
      const result = await appService.readUserFile(path);
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  clipboardWriteText: async (text: string) => {
    try {
      appService.clipboardWriteText(text);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  quit: () => {
    try {
      appService.quit();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  openIn: async (args: {
    app: OpenInAppId;
    path: string;
    isRemote?: boolean;
    sshConnectionId?: string | null;
  }) => {
    try {
      await appService.openIn(args);
      telemetryService.capture('open_in_external', { app: args.app });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  checkInstalledApps: () => appService.checkInstalledApps(),
  listInstalledFonts: async (args?: { refresh?: boolean }) => {
    const { fonts, cached, error } = await appService.listInstalledFonts(args?.refresh);
    return { success: !error, fonts, cached, ...(error ? { error } : {}) };
  },
  openSelectDirectoryDialog: (args: { title: string; message: string; defaultPath?: string }) =>
    appService.openSelectDirectoryDialog(args),
  openSelectAudioFileDialog: (args: { title: string; message: string }) =>
    appService.openSelectAudioFileDialog(args),
  readAudioFileDataUrl: async (filePath: string) => {
    try {
      return { success: true, dataUrl: await appService.readAudioFileDataUrl(filePath) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  getAppVersion: () => appService.getCachedAppVersion(),
  getElectronVersion: () => process.versions.electron,
  getPlatform: () => process.platform,
  getDiagnosticLogAttachment,
  // Cross-repo file peek: discover git repos under a dev root, then enumerate one
  // repo's files on demand so the palette can fuzzy-find and peek across repos
  // emdash hasn't mounted. Path-addressed, like readUserFile — see repo-discovery.
  discoverRepos: async (args?: { root?: string; refresh?: boolean }) => {
    try {
      const root = args?.root ?? defaultDevRoot();
      const repos = await discoverGitReposCached(root, { refresh: args?.refresh });
      return { success: true as const, root, repos };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  },
  listRepoFiles: async (args: { repoPath: string }) => {
    activeRepoFilesCrawl?.abort.abort();
    const abort = new AbortController();
    const crawl = { repoPath: args.repoPath, abort };
    activeRepoFilesCrawl = crawl;
    try {
      const result = await listRepoFiles(args.repoPath, { signal: abort.signal });
      return { success: true as const, ...result };
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (activeRepoFilesCrawl === crawl) activeRepoFilesCrawl = null;
    }
  },
  // Stop the in-flight crawl when the renderer no longer wants it (palette closed or
  // scope cleared). Guarded by repoPath so a request that lost the race — a newer
  // scope's crawl is already active — is a no-op rather than aborting the new one.
  cancelRepoFilesCrawl: (args: { repoPath: string }) => {
    if (activeRepoFilesCrawl?.repoPath === args.repoPath) {
      activeRepoFilesCrawl.abort.abort();
      activeRepoFilesCrawl = null;
    }
    return { success: true as const };
  },
});
