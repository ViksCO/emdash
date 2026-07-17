// Client-side fuzzy matcher for the "enumerate once, filter in memory" file find.
// A subsequence scorer (fzf / "Go to File" style): every query character must
// appear in order, and the score rewards contiguous runs, segment boundaries,
// and matches inside the basename over the directory path. Kept standalone so
// the command-palette ranking redesign can adopt the same scorer.

// Characters that begin a new path/word segment; a match right after one scores
// higher (e.g. "cp" strongly matches "command-palette").
const SEGMENT_SEPARATOR = /[/\-_. ]/;

function isSegmentBoundary(prevChar: string | undefined): boolean {
  return prevChar === undefined || SEGMENT_SEPARATOR.test(prevChar);
}

/**
 * Score `target` against a lowercased `query` as an ordered subsequence.
 * Returns a number where higher is better, or `null` when `query` is not a
 * subsequence of `target`. An empty query scores 0 (matches everything).
 */
export function subsequenceScore(query: string, target: string): number | null {
  if (query.length === 0) return 0;

  const t = target.toLowerCase();
  let score = 0;
  let cursor = 0;
  let prevMatch = -2;

  for (const char of query) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return null;

    if (found === prevMatch + 1) score += 5; // contiguous run
    if (isSegmentBoundary(t[found - 1])) score += 3; // start of a segment
    score -= (found - cursor) * 0.1; // small penalty for gaps

    prevMatch = found;
    cursor = found + 1;
  }

  return score;
}

/**
 * Score a repo-relative file path, favouring matches that land in the basename.
 * A basename hit gets a fixed bonus so filename matches always outrank paths
 * that only match through directory segments.
 */
export function scoreFilePath(query: string, path: string): number | null {
  const q = query.toLowerCase();
  const basename = path.slice(path.lastIndexOf('/') + 1);

  const baseScore = subsequenceScore(q, basename);
  const pathScore = subsequenceScore(q, path);
  if (baseScore === null && pathScore === null) return null;

  const BASENAME_BONUS = 20;
  if (baseScore !== null) return baseScore + BASENAME_BONUS;
  return pathScore as number;
}

/**
 * Rank `files` against `query` and return the top `limit` paths. An empty query
 * returns the head of the list unfiltered so a freshly scoped repo isn't blank.
 */
export function fuzzyFilterFiles(query: string, files: string[], limit = 50): string[] {
  if (query.length === 0) return files.slice(0, limit);

  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const score = scoreFilePath(query, file);
    if (score !== null) scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  return scored.slice(0, limit).map((entry) => entry.file);
}
