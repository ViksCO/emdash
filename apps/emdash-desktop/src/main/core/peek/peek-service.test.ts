import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandRoot, peekService } from './peek-service';

// Builds a temp directory tree with git repos emdash has never provisioned, so
// these tests exercise the real on-demand discovery + crawl path.
describe('peek-service', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'peek-root-'));

    // Repo at depth 1.
    const repoA = join(root, 'alpha');
    await mkdir(join(repoA, '.git'), { recursive: true });
    await mkdir(join(repoA, 'src'), { recursive: true });
    await writeFile(join(repoA, 'src', 'local-fs.ts'), 'export const x = 1;\n');
    await writeFile(join(repoA, 'README.md'), '# alpha\n');
    // Noise that must be skipped.
    await mkdir(join(repoA, 'node_modules', 'junk'), { recursive: true });
    await writeFile(join(repoA, 'node_modules', 'junk', 'local-fs.js'), 'nope');

    // Non-JS dependency dir that must be pruned (Go vendor tree).
    await mkdir(join(repoA, 'vendor', 'pkg'), { recursive: true });
    await writeFile(join(repoA, 'vendor', 'pkg', 'zzvendored.go'), 'package pkg\n');

    // Repo nested deeper (depth 3), to prove bounded-depth discovery.
    const repoB = join(root, 'work', 'group', 'beta');
    await mkdir(join(repoB, '.git'), { recursive: true });
    await writeFile(join(repoB, 'main.go'), 'package main\n');
  });

  it('discovers git repos at varying depths under a root', async () => {
    const repos = await peekService.discoverRepos([root]);
    const names = repos.map((r) => r.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('finds files across repos, skipping node_modules', async () => {
    const hits = await peekService.searchFiles('localfs', { roots: [root] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('local-fs.ts');
    expect(hits.every((h) => !h.relPath.includes('node_modules'))).toBe(true);
  });

  it('fuzzy-ranks a basename match above unrelated files', async () => {
    const hits = await peekService.searchFiles('maingo', { roots: [root] });
    expect(hits[0]?.name).toBe('main.go');
    expect(hits[0]?.repoName).toBe('beta');
  });

  it('returns files from an empty query capped to the limit', async () => {
    const hits = await peekService.searchFiles('', { roots: [root], limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('prunes non-JS dependency dirs (vendor)', async () => {
    const hits = await peekService.searchFiles('zzvendored', { roots: [root] });
    expect(hits).toHaveLength(0);
  });
});

describe('expandRoot', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(expandRoot('~')).toBe(homedir());
    expect(expandRoot('~/WebstormProjects')).toBe(join(homedir(), 'WebstormProjects'));
  });

  it('leaves absolute paths untouched', () => {
    expect(expandRoot('/abs/path')).toBe('/abs/path');
  });
});
