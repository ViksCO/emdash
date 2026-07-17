import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverGitRepos, listRepoFiles } from './repo-discovery';

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
});
