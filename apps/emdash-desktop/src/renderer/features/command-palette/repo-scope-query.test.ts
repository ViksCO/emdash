import { describe, expect, it } from 'vitest';
import { parseRepoScopeQuery } from './repo-scope-query';

describe('parseRepoScopeQuery', () => {
  it('treats a bare `@` as the repo picker with an empty filter', () => {
    expect(parseRepoScopeQuery('@')).toEqual({ isRepoQuery: true, filter: '' });
  });

  it('treats `@name` as a repo-filter query', () => {
    expect(parseRepoScopeQuery('@core')).toEqual({ isRepoQuery: true, filter: 'core' });
  });

  it('leaves ordinary searches alone', () => {
    expect(parseRepoScopeQuery('core')).toEqual({ isRepoQuery: false, filter: '' });
    expect(parseRepoScopeQuery('')).toEqual({ isRepoQuery: false, filter: '' });
  });

  it('keeps `@`-leading text with whitespace as a normal search (not the picker)', () => {
    // Regression: any `@`-leading query used to force the picker, so literal
    // `@`-text and ADE-8 search were unreachable once the query started with `@`.
    expect(parseRepoScopeQuery('@here ping')).toEqual({ isRepoQuery: false, filter: '' });
    expect(parseRepoScopeQuery('@ ')).toEqual({ isRepoQuery: false, filter: '' });
  });

  it('only triggers on a leading `@`', () => {
    expect(parseRepoScopeQuery('email@host')).toEqual({ isRepoQuery: false, filter: '' });
  });
});
