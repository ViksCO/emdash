import { describe, expect, it } from 'vitest';
import { fuzzyFilterFiles, scoreFilePath, subsequenceScore } from './fuzzy-match';

describe('subsequenceScore', () => {
  it('scores an empty query as 0 (matches anything)', () => {
    expect(subsequenceScore('', 'anything')).toBe(0);
  });

  it('returns null when the query is not an ordered subsequence', () => {
    expect(subsequenceScore('zzz', 'command')).toBeNull();
    expect(subsequenceScore('dc', 'command')).toBeNull(); // right chars, wrong order
  });

  it('matches an ordered subsequence', () => {
    expect(subsequenceScore('cmd', 'command')).not.toBeNull();
  });

  it('rewards contiguous runs over scattered matches', () => {
    const contiguous = subsequenceScore('cmd', 'cmdlet')!;
    const scattered = subsequenceScore('cmd', 'c_m_d_x')!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('rewards matches at segment boundaries', () => {
    const boundary = subsequenceScore('cp', 'command-palette')!; // c…p at word starts
    const inline = subsequenceScore('cp', 'scalps')!;
    expect(boundary).toBeGreaterThan(inline);
  });
});

describe('scoreFilePath', () => {
  it('ranks a basename match above a path-only match', () => {
    const basenameHit = scoreFilePath('app', 'src/app.tsx')!;
    const pathOnlyHit = scoreFilePath('app', 'apps/deep/other.ts')!;
    expect(basenameHit).toBeGreaterThan(pathOnlyHit);
  });

  it('returns null when neither the basename nor the path matches', () => {
    expect(scoreFilePath('zzz', 'src/app.tsx')).toBeNull();
  });
});

describe('fuzzyFilterFiles', () => {
  const files = [
    'src/command-palette/command-palette-modal.tsx',
    'src/command-palette/fuzzy-match.ts',
    'src/app.tsx',
    'README.md',
    'package.json',
  ];

  it('returns the head of the list (capped) for an empty query', () => {
    expect(fuzzyFilterFiles('', files, 3)).toEqual(files.slice(0, 3));
  });

  it('surfaces the best basename match first', () => {
    const results = fuzzyFilterFiles('fuzzy', files);
    expect(results[0]).toBe('src/command-palette/fuzzy-match.ts');
  });

  it('drops files that do not match at all', () => {
    const results = fuzzyFilterFiles('readme', files);
    expect(results).toEqual(['README.md']);
  });

  it('respects the result limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => `file-${i}.ts`);
    expect(fuzzyFilterFiles('file', many, 50)).toHaveLength(50);
  });
});
