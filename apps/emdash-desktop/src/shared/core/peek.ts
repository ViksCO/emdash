/** A git repository discovered on disk (not necessarily registered with emdash). */
export interface PeekRepo {
  /** Directory name of the repo (its last path segment). */
  name: string;
  /** Absolute path to the repo root. */
  path: string;
}

/** A file match returned by a cross-repo peek search. */
export interface PeekFileHit {
  /** Absolute path to the file. */
  absPath: string;
  /** Path relative to the repo root. */
  relPath: string;
  /** File basename. */
  name: string;
  /** Name of the repo the file belongs to. */
  repoName: string;
  /** Absolute path to the repo root. */
  repoPath: string;
}

export interface PeekSearchOptions {
  /** Directories to discover git repos under (e.g. ["~/WebstormProjects"]). */
  roots: string[];
  /** Max hits to return. Defaults to 50. */
  limit?: number;
}
