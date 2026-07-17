import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { LocalFileSystem } from '@main/core/fs/impl/local-fs';

export interface DiscoveredRepo {
  /** Directory name, shown in the palette. */
  name: string;
  /** Absolute path to the repository root. */
  path: string;
}

export interface RepoFileList {
  /** Repo-relative file paths (files only), forward-slashed. */
  files: string[];
  /** True if the crawl hit the entry cap before enumerating everything. */
  truncated: boolean;
}

// Directory names never worth descending into while hunting for repos: build
// artifacts, dependency trees, worktree roots, and heavy user-library dirs that
// can appear under a dev root but never contain checkouts we care to peek.
const DISCOVERY_IGNORES = new Set([
  'node_modules',
  '.git',
  'worktrees',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'Library',
  'target',
]);

// A dev root's repos sit at most a few levels down (e.g. work/<user>/<repo>);
// bounding the descent keeps the scan fast and avoids wandering deep trees.
const DEFAULT_MAX_DEPTH = 4;

// Cap the per-repo file crawl so a huge checkout degrades to a truncated list
// rather than stalling the crawl or flooding the renderer.
const DEFAULT_MAX_ENTRIES = 20_000;

/** The v1 default dev root. Configurable per call; this is the fallback. */
export function defaultDevRoot(): string {
  return join(homedir(), 'WebstormProjects');
}

/**
 * Scan `root` for git repositories, depth-bounded. A directory that contains a
 * `.git` entry (dir or file — covers worktrees and submodules) is recorded as a
 * repo and NOT descended into, so nested checkouts stop the walk at the boundary.
 * Symlinks are not followed (dirents report them as non-directories), which also
 * prevents cycles.
 */
export async function discoverGitRepos(
  root: string,
  options: { maxDepth?: number; signal?: AbortSignal } = {}
): Promise<DiscoveredRepo[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const repos: DiscoveredRepo[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (options.signal?.aborted) return;

    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (items.some((item) => item.name === '.git')) {
      repos.push({ name: basename(dir), path: dir });
      return;
    }

    if (depth >= maxDepth) return;

    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name.startsWith('.')) continue;
      if (DISCOVERY_IGNORES.has(item.name)) continue;
      await walk(join(dir, item.name), depth + 1);
    }
  };

  await walk(root, 0);
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

/**
 * Enumerate the files of one repo (paths only, non-recursive dirs excluded) via
 * a single bounded LocalFileSystem crawl. Hidden entries and the usual build /
 * dependency dirs are skipped by the crawler; the result is the in-memory list
 * the renderer fuzzy-filters per keystroke.
 */
export async function listRepoFiles(
  repoPath: string,
  options: { maxEntries?: number } = {}
): Promise<RepoFileList> {
  const provider = new LocalFileSystem(repoPath);
  const result = await provider.list('', {
    recursive: true,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
  });
  const files = result.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
  return { files, truncated: Boolean(result.truncated) };
}

// Session cache for discovery — repeated `@` opens are instant. Keyed by root so
// switching roots doesn't return the wrong list; a short TTL and an explicit
// refresh cover new checkouts. No file-watchers, no persistent index.
const DISCOVERY_TTL_MS = 5 * 60_000;

interface DiscoveryCacheEntry {
  repos: DiscoveredRepo[];
  at: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

export async function discoverGitReposCached(
  root: string,
  options: { refresh?: boolean } = {}
): Promise<DiscoveredRepo[]> {
  const cached = discoveryCache.get(root);
  if (!options.refresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.repos;
  }
  const repos = await discoverGitRepos(root);
  discoveryCache.set(root, { repos, at: Date.now() });
  return repos;
}
