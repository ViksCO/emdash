import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverGitRepos, discoverGitReposCached, listRepoFiles } from './repo-discovery';

function makeRepo(dir: string, gitAs: 'dir' | 'file' = 'dir') {
  fs.mkdirSync(dir, { recursive: true });
  if (gitAs === 'dir') {
    fs.mkdirSync(path.join(dir, '.git'));
  } else {
    // A `.git` file (not dir) is how worktrees/submodules mark their root.
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere');
  }
}

describe('discoverGitRepos', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a repo that is a direct child', async () => {
    makeRepo(path.join(root, 'alpha'));
    const repos = await discoverGitRepos(root);
    expect(repos).toEqual([{ name: 'alpha', path: path.join(root, 'alpha') }]);
  });

  it('finds repos nested under non-repo container directories', async () => {
    makeRepo(path.join(root, 'work', 'user', 'nested-repo'));
    const repos = await discoverGitRepos(root);
    expect(repos.map((r) => r.name)).toEqual(['nested-repo']);
    expect(repos[0].path).toBe(path.join(root, 'work', 'user', 'nested-repo'));
  });

  it('recognises a repo marked by a .git file (worktree/submodule)', async () => {
    makeRepo(path.join(root, 'wt'), 'file');
    const repos = await discoverGitRepos(root);
    expect(repos.map((r) => r.name)).toEqual(['wt']);
  });

  it('stops descending at a repo boundary — inner checkouts are not reported', async () => {
    makeRepo(path.join(root, 'outer'));
    makeRepo(path.join(root, 'outer', 'vendor', 'inner'));
    const repos = await discoverGitRepos(root);
    expect(repos.map((r) => r.name)).toEqual(['outer']);
  });

  it('ignores repos buried in node_modules', async () => {
    makeRepo(path.join(root, 'node_modules', 'dep'));
    makeRepo(path.join(root, 'real'));
    const repos = await discoverGitRepos(root);
    expect(repos.map((r) => r.name)).toEqual(['real']);
  });

  it('honours the depth bound', async () => {
    makeRepo(path.join(root, 'a', 'b', 'c', 'deep-repo'));
    expect(await discoverGitRepos(root, { maxDepth: 2 })).toEqual([]);
    expect((await discoverGitRepos(root, { maxDepth: 4 })).map((r) => r.name)).toEqual([
      'deep-repo',
    ]);
  });

  it('returns repos sorted by name', async () => {
    makeRepo(path.join(root, 'zebra'));
    makeRepo(path.join(root, 'apple'));
    makeRepo(path.join(root, 'mango'));
    const repos = await discoverGitRepos(root);
    expect(repos.map((r) => r.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('returns nothing for a missing root rather than throwing', async () => {
    expect(await discoverGitRepos(path.join(root, 'does-not-exist'))).toEqual([]);
  });
});

describe('listRepoFiles', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-files-'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lists files recursively, excluding dirs, hidden entries, and dependencies', async () => {
    fs.writeFileSync(path.join(repo, 'index.ts'), 'export {};');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'app.tsx'), 'x');
    fs.writeFileSync(path.join(repo, '.hidden'), 'secret');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'dep.js'), 'x');

    const result = await listRepoFiles(repo);

    expect(result.files.sort()).toEqual(['index.ts', 'src/app.tsx']);
    expect(result.truncated).toBe(false);
  });

  it('reports truncation when the entry cap is hit', async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x');
    const result = await listRepoFiles(repo, { maxEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeLessThanOrEqual(2);
  });

  it('hard-excludes dependency and generated dirs (node_modules, dist, build, coverage)', async () => {
    fs.writeFileSync(path.join(repo, 'index.ts'), 'x');
    for (const junk of ['node_modules', 'dist', 'build', 'coverage']) {
      fs.mkdirSync(path.join(repo, junk));
      fs.writeFileSync(path.join(repo, junk, 'artifact.js'), 'x');
    }
    const result = await listRepoFiles(repo);
    expect(result.files).toEqual(['index.ts']);
  });

  it('does NOT hard-exclude potentially-tracked dirs — .gitignore is the source of truth', async () => {
    // A perf-default static ignore must not override git-tracked files: a source dir
    // named out/target, or a tracked vendor/venv/__pycache__/Library, stays findable.
    fs.writeFileSync(path.join(repo, 'index.ts'), 'x');
    for (const maybeTracked of ['out', 'target', 'vendor', 'venv', '__pycache__', 'Library']) {
      fs.mkdirSync(path.join(repo, maybeTracked));
      fs.writeFileSync(path.join(repo, maybeTracked, 'src.ts'), 'x');
    }
    const result = await listRepoFiles(repo);
    expect(result.files.sort()).toEqual([
      'Library/src.ts',
      '__pycache__/src.ts',
      'index.ts',
      'out/src.ts',
      'target/src.ts',
      'vendor/src.ts',
      'venv/src.ts',
    ]);
  });

  it('honours the repo-root .gitignore for both files and directories', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n*.log\nsecret.txt\nvendor/\n');
    fs.writeFileSync(path.join(repo, 'index.ts'), 'x');
    fs.writeFileSync(path.join(repo, 'debug.log'), 'x');
    fs.writeFileSync(path.join(repo, 'secret.txt'), 'x');
    fs.mkdirSync(path.join(repo, 'generated'));
    fs.writeFileSync(path.join(repo, 'generated', 'out.ts'), 'x');
    // A gitignored vendor/ IS pruned — .gitignore wins over "keep tracked dirs".
    fs.mkdirSync(path.join(repo, 'vendor'));
    fs.writeFileSync(path.join(repo, 'vendor', 'dep.ts'), 'x');
    const result = await listRepoFiles(repo);
    expect(result.files.sort()).toEqual(['index.ts']);
  });

  it('honours nested per-package .gitignore in a monorepo', async () => {
    // Root source is kept; each package prunes its own build output via its own
    // .gitignore, so generated files never bury source or eat the entry budget.
    fs.mkdirSync(path.join(repo, 'apps', 'web', 'dist-out'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps', 'web', '.gitignore'), 'dist-out/\n');
    fs.writeFileSync(path.join(repo, 'apps', 'web', 'index.ts'), 'x');
    fs.writeFileSync(path.join(repo, 'apps', 'web', 'dist-out', 'bundle.js'), 'x');
    fs.mkdirSync(path.join(repo, 'packages', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'lib', 'main.ts'), 'x');
    const result = await listRepoFiles(repo);
    expect(result.files.sort()).toEqual(['apps/web/index.ts', 'packages/lib/main.ts']);
  });

  it('counts only files toward the entry cap — directories do not consume it', async () => {
    // Old behaviour counted dirs too, so many empty dirs could exhaust the cap
    // before real files were reached. Here 10 dirs + 3 files with a cap of 5 must
    // still surface all 3 files.
    for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(repo, `d${i}`));
    for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, f), 'x');
    const result = await listRepoFiles(repo, { maxEntries: 5 });
    expect(result.files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(result.truncated).toBe(false);
  });

  it('excludes symlinked directories but keeps in-repo symlinked files', async () => {
    fs.mkdirSync(path.join(repo, 'real-dir'));
    fs.writeFileSync(path.join(repo, 'real-dir', 'inner.ts'), 'x');
    fs.writeFileSync(path.join(repo, 'real-file.ts'), 'x');
    fs.symlinkSync(path.join(repo, 'real-dir'), path.join(repo, 'link-dir'));
    fs.symlinkSync(path.join(repo, 'real-file.ts'), path.join(repo, 'link-file.ts'));

    const result = await listRepoFiles(repo);

    expect(result.files.sort()).toEqual(['link-file.ts', 'real-dir/inner.ts', 'real-file.ts']);
    expect(result.files.some((f) => f.startsWith('link-dir'))).toBe(false);
  });

  it('drops a symlink whose target escapes the repo boundary', async () => {
    // A symlink pointing outside the repo must not become a peekable in-repo path.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      fs.writeFileSync(path.join(repo, 'index.ts'), 'x');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'escape.txt'));
      const result = await listRepoFiles(repo);
      expect(result.files).toEqual(['index.ts']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not flag truncation when the file count merely equals the cap', async () => {
    // Off-by-one guard: a fully-walked tree with exactly `maxEntries` files is complete.
    for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, f), 'x');
    const result = await listRepoFiles(repo, { maxEntries: 3 });
    expect(result.files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(result.truncated).toBe(false);
  });

  it('reports an aborted crawl as truncated, never as a complete list', async () => {
    fs.writeFileSync(path.join(repo, 'index.ts'), 'x');
    const controller = new AbortController();
    controller.abort();
    const result = await listRepoFiles(repo, { signal: controller.signal });
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('reports truncation when the wall-clock budget is exceeded', async () => {
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), 'x');
    const result = await listRepoFiles(repo, { timeBudgetMs: 1 });
    expect(result.truncated).toBe(true);
  });

  it('throws when the repo root cannot be read, rather than reporting an empty repo', async () => {
    await expect(listRepoFiles(path.join(repo, 'does-not-exist'))).rejects.toThrow();
  });
});

describe('discoverGitReposCached', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-discovery-cached-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not persist an empty result, so repos appear once the root is populated', async () => {
    expect(await discoverGitReposCached(root)).toEqual([]);
    makeRepo(path.join(root, 'alpha'));
    // Without an explicit refresh: an empty result must not have been cached for
    // the full TTL, or this would still return [].
    expect((await discoverGitReposCached(root)).map((r) => r.name)).toEqual(['alpha']);
  });

  it('serves a non-empty result from cache on the next call', async () => {
    makeRepo(path.join(root, 'beta'));
    expect((await discoverGitReposCached(root)).map((r) => r.name)).toEqual(['beta']);
    // Add a second repo; the cached result should still be served (no refresh).
    makeRepo(path.join(root, 'gamma'));
    expect((await discoverGitReposCached(root)).map((r) => r.name)).toEqual(['beta']);
    // An explicit refresh picks up the new repo.
    expect((await discoverGitReposCached(root, { refresh: true })).map((r) => r.name)).toEqual([
      'beta',
      'gamma',
    ]);
  });
});
