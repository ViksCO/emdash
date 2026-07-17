import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { fuzzyFilterFiles, subsequenceScore } from './fuzzy-match';

export interface RepoScope {
  name: string;
  path: string;
}

const REPO_PICK_LIMIT = 50;
const FILE_RESULT_LIMIT = 50;

/**
 * Cross-repo file-peek state for the command palette. Drives two modes off the
 * single palette query:
 *
 * - **Repo pick** (`@…`, no scope yet): the query's `@`-prefix opens a picker
 *   over git repos discovered under the dev root (lazily, cached for the session).
 * - **File find** (a scope is set): one bounded file list is fetched for the
 *   scoped repo and fuzzy-filtered client-side per keystroke.
 *
 * The caller owns the query string and the chip UI; this hook owns discovery,
 * the per-repo file list, and the filtered results.
 */
export function useRepoScope(query: string) {
  const [scope, setScope] = useState<RepoScope | null>(null);

  const atMode = !scope && query.startsWith('@');
  const repoFilter = atMode ? query.slice(1) : '';

  // Discover repos lazily — the query only runs once the user reaches `@`.
  const { data: discovery, isFetching: reposLoading } = useQuery({
    queryKey: ['cmdk-repos'],
    queryFn: () => rpc.app.discoverRepos(),
    enabled: atMode,
    staleTime: 5 * 60_000,
  });

  const repoResults = useMemo(() => {
    if (!atMode) return [];
    const repos = discovery?.success ? discovery.repos : [];
    if (!repoFilter) return repos.slice(0, REPO_PICK_LIMIT);
    return repos
      .map((repo) => ({
        repo,
        score: subsequenceScore(repoFilter.toLowerCase(), repo.name.toLowerCase()),
      }))
      .filter((entry): entry is { repo: RepoScope; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score || a.repo.name.length - b.repo.name.length)
      .slice(0, REPO_PICK_LIMIT)
      .map((entry) => entry.repo);
  }, [atMode, repoFilter, discovery]);

  // One bounded file crawl per scoped repo; result cached and filtered in memory.
  const { data: fileList, isFetching: filesLoading } = useQuery({
    queryKey: ['cmdk-repo-files', scope?.path],
    queryFn: () => rpc.app.listRepoFiles({ repoPath: scope!.path }),
    enabled: scope != null,
    staleTime: 5 * 60_000,
  });

  const filesTruncated = fileList?.success ? fileList.truncated : false;

  const fileResults = useMemo(() => {
    if (!scope) return [];
    const allFiles = fileList?.success ? fileList.files : [];
    return fuzzyFilterFiles(query, allFiles, FILE_RESULT_LIMIT);
  }, [scope, query, fileList]);

  return {
    scope,
    setScope,
    atMode,
    repoResults,
    reposLoading,
    fileResults,
    filesLoading,
    filesTruncated,
  };
}
