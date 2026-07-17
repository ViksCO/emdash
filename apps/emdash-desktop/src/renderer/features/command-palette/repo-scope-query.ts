// The `@` repo-scope sigil for the command palette. It opens the repo picker only
// as a leading token with no whitespace (`@`, `@core`), the way a mention sigil
// works. Anything else — including ordinary text that merely starts with `@`
// followed by a space (e.g. "@here ping") — is left as a normal search so ADE-8's
// palette search stays reachable and literal `@`-text can still be typed.
const REPO_SCOPE_SIGIL = /^@(\S*)$/;

export interface RepoScopeQuery {
  /** True when the query is a bare `@`-sigil repo filter (leading `@`, no whitespace). */
  isRepoQuery: boolean;
  /** The repo-name filter after `@` (empty for a bare `@`); empty when not a repo query. */
  filter: string;
}

export function parseRepoScopeQuery(query: string): RepoScopeQuery {
  const match = REPO_SCOPE_SIGIL.exec(query);
  return match ? { isRepoQuery: true, filter: match[1] } : { isRepoQuery: false, filter: '' };
}
