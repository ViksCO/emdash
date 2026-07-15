import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Fzf } from 'fzf';
import { log } from '@main/lib/logger';
import type { PeekFileHit, PeekRepo, PeekSearchOptions } from '@shared/core/peek';

const DISCOVERY_MAX_DEPTH = 4;
const DEFAULT_LIMIT = 50;
/** Max files crawled per repo — bounds cost on very large monorepos. */
const CRAWL_MAX_FILES = 20_000;

/**
 * Directories never worth descending into. Covers common dependency/build/tooling
 * dirs across ecosystems (JS, Rust/Java, Go, Python, iOS, IDEs). Not a substitute
 * for honoring `.gitignore` — a known follow-up.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'worktrees',
  '.svn',
  '.hg',
  'target',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  '.gradle',
  'Pods',
  'DerivedData',
  '.idea',
  '.vs',
]);

/** Expand a leading `~` / `~/` to the home dir — fs APIs treat it as a literal char. */
export function expandRoot(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    // `.git` is a directory for normal clones, a file for worktrees/submodules.
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

interface PeekIndex {
  files: PeekFileHit[];
  fzf: Fzf<PeekFileHit[]>;
}

/**
 * On-demand cross-repo file peek. Discovers git repos under given roots, crawls
 * each repo's files (pure Node, no index, no workspace), and fuzzy-ranks them
 * against a query. Discovery and the built fuzzy index are cached per root set, so
 * per-keystroke queries only run `fzf.find()` — no re-scan, no index rebuild.
 * Call {@link PeekService.clearCache} to pick up new files/repos.
 */
class PeekService {
  private discoverCache = new Map<string, Promise<PeekRepo[]>>();
  private indexCache = new Map<string, Promise<PeekIndex>>();

  discoverRepos(rawRoots: string[]): Promise<PeekRepo[]> {
    return this.discover(rawRoots.map(expandRoot));
  }

  async searchFiles(query: string, options: PeekSearchOptions): Promise<PeekFileHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const { files, fzf } = await this.getIndex(options.roots.map(expandRoot));

    const trimmed = query.trim();
    if (!trimmed) return files.slice(0, limit);

    // fzf V2 scoring gives boundary bonuses after '/', so basename matches rank above
    // mid-path matches without a separate pass.
    return fzf
      .find(trimmed)
      .slice(0, limit)
      .map((r) => r.item);
  }

  /** Drop cached discovery + indexes so the next search re-scans disk. */
  clearCache(): void {
    this.discoverCache.clear();
    this.indexCache.clear();
  }

  private discover(roots: string[]): Promise<PeekRepo[]> {
    return this.cached(this.discoverCache, keyOf(roots), () => this.runDiscovery(roots));
  }

  private getIndex(roots: string[]): Promise<PeekIndex> {
    return this.cached(this.indexCache, keyOf(roots), async () => {
      const repos = await this.discover(roots);
      const crawls = await Promise.all(repos.map((repo) => this.runCrawl(repo).catch(() => [])));
      const files = crawls.flat();
      return { files, fzf: new Fzf(files, { selector: (f) => f.relPath }) };
    });
  }

  /** Get-or-build with the in-flight promise memoized; a rejected build evicts itself. */
  private cached<T>(
    map: Map<string, Promise<T>>,
    key: string,
    build: () => Promise<T>
  ): Promise<T> {
    let promise = map.get(key);
    if (!promise) {
      promise = build();
      map.set(key, promise);
      promise.catch(() => {
        if (map.get(key) === promise) map.delete(key);
      });
    }
    return promise;
  }

  private async runDiscovery(roots: string[]): Promise<PeekRepo[]> {
    const found: PeekRepo[] = [];
    await Promise.all(roots.map((root) => this.discoverUnder(root, 0, found)));
    const seen = new Set<string>();
    const unique: PeekRepo[] = [];
    for (const repo of found) {
      if (!seen.has(repo.path)) {
        seen.add(repo.path);
        unique.push(repo);
      }
    }
    return unique;
  }

  private async discoverUnder(dir: string, depth: number, found: PeekRepo[]): Promise<void> {
    if (await isGitRepo(dir)) {
      found.push({ name: basename(dir), path: dir });
      return; // don't descend into a repo
    }
    if (depth >= DISCOVERY_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
        .map((e) => this.discoverUnder(join(dir, e.name), depth + 1, found))
    );
  }

  private async runCrawl(repo: PeekRepo): Promise<PeekFileHit[]> {
    const hits: PeekFileHit[] = [];
    let truncated = false;

    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (hits.length >= CRAWL_MAX_FILES) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= CRAWL_MAX_FILES) {
          truncated = true;
          return;
        }
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          await walk(join(dir, entry.name), relPath);
        } else if (entry.isFile()) {
          hits.push({
            absPath: join(repo.path, relPath),
            relPath,
            name: entry.name,
            repoName: repo.name,
            repoPath: repo.path,
          });
        }
      }
    };

    await walk(repo.path, '');
    if (truncated) {
      log.warn(
        `[peek] ${repo.path}: crawl hit the ${CRAWL_MAX_FILES}-file cap; some files omitted`
      );
    }
    return hits;
  }
}

function keyOf(roots: string[]): string {
  return [...roots].sort().join('\n');
}

export const peekService = new PeekService();
