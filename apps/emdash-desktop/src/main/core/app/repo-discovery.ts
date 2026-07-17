import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import ignore from 'ignore';

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
// rather than stalling the crawl or flooding the renderer. The cap counts FILES,
// not directories, so the effective ceiling is the number of findable files.
const DEFAULT_MAX_ENTRIES = 20_000;

// Directory names never worth descending into while listing a repo's files:
// dependency trees, build/artifact output, worktree roots, and heavy library
// dirs. Broader than discovery's set because here we walk *inside* a repo, where
// these dirs hold thousands of files that would bury real source and exhaust the
// entry budget. Hidden dirs (.git, .next, .cache, .venv, …) are skipped separately
// by the crawl, so only visible names need listing here.
const FILE_CRAWL_IGNORES = new Set([
  'node_modules',
  'worktrees',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'venv',
  '__pycache__',
  'Library',
]);

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

/** Load the repo-root `.gitignore` matcher, or null if there is none. */
async function loadGitIgnore(repoPath: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const content = await fs.readFile(join(repoPath, '.gitignore'), 'utf-8');
    return ignore().add(content);
  } catch {
    return null; // no readable .gitignore — the static ignore set still applies
  }
}

/**
 * Enumerate the files of one repo as repo-relative paths — the in-memory list the
 * renderer fuzzy-filters per keystroke. A single readdir-based crawl that:
 *   - reads dirents only (no per-entry `stat`), so it doesn't burn a syscall per file;
 *   - skips hidden entries, the build/dependency/worktree dirs in FILE_CRAWL_IGNORES,
 *     and anything the repo's `.gitignore` excludes, so artifact trees don't flood it;
 *   - excludes symlinked directories (they'd otherwise be kept as bogus "files" and
 *     throw EISDIR on peek) while keeping symlinked files;
 *   - counts only files toward `maxEntries` and stops early once aborted or capped.
 */
export async function listRepoFiles(
  repoPath: string,
  options: { maxEntries?: number; signal?: AbortSignal } = {}
): Promise<RepoFileList> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const signal = options.signal;
  const gitIgnore = await loadGitIgnore(repoPath);

  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string, relBase: string): Promise<void> => {
    if (truncated || signal?.aborted) return;

    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (truncated || signal?.aborted) return;

      const { name } = item;
      if (name.startsWith('.')) continue; // hidden files/dirs, incl. .git internals

      const relPath = relBase ? `${relBase}/${name}` : name;

      if (item.isDirectory()) {
        if (FILE_CRAWL_IGNORES.has(name)) continue;
        // Trailing slash so `dir/`-style .gitignore patterns prune the directory.
        if (gitIgnore?.ignores(`${relPath}/`)) continue;
        await walk(join(dir, name), relPath);
        continue;
      }

      if (gitIgnore?.ignores(relPath)) continue;

      if (item.isFile()) {
        files.push(relPath);
      } else if (item.isSymbolicLink()) {
        // A dir symlink reports isDirectory()===false, so it would slip through as a
        // "file" and throw EISDIR on peek. Resolve it once: keep a symlinked file,
        // skip a symlinked dir (and don't follow it — cycle risk).
        try {
          if ((await fs.stat(join(dir, name))).isFile()) files.push(relPath);
        } catch {
          // Broken symlink — skip.
        }
      } else {
        continue; // sockets, FIFOs, devices — not peekable
      }

      if (files.length >= maxEntries) {
        truncated = true;
        return;
      }
    }
  };

  await walk(repoPath, '');
  return { files, truncated };
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
  // Don't persist an empty result: an empty list means either a genuinely empty
  // root or one that's unreachable / not yet mounted, and caching it for the full
  // TTL would hide repos for minutes after the root becomes reachable. Leaving it
  // uncached lets the next `@` rescan and pick them up.
  if (repos.length > 0) {
    discoveryCache.set(root, { repos, at: Date.now() });
  } else {
    discoveryCache.delete(root);
  }
  return repos;
}
