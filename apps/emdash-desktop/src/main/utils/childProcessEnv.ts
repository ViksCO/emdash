import * as path from 'node:path';

const APPIMAGE_ENV_KEYS = [
  'APPDIR',
  'APPIMAGE',
  'ARGV0',
  'CHROME_DESKTOP',
  'GSETTINGS_SCHEMA_DIR',
  'OWD',
] as const;

const APPIMAGE_PATH_LIKE_ENV_KEYS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS'] as const;

function stripPathLikeAppImageEntries(value: string, appDir?: string): string {
  const separator = process.platform === 'win32' ? ';' : ':';
  const parts = value.split(separator).filter(Boolean);
  if (parts.length === 0) return value;

  const filtered = parts.filter((part) => {
    if (appDir && part.startsWith(appDir)) return false;
    if (part.includes('/tmp/.mount_')) return false;
    return true;
  });

  return filtered.join(separator);
}

// Drop PATH entries that are a `node_modules/.bin` directory belonging to this
// app's own checkout. A dev launcher (pnpm/nx) prepends these ahead of the
// user's global tools, and the app process inherits them; forwarding that PATH
// to spawned agents and terminals lets a workspace shim (e.g.
// `node_modules/.bin/codex`) shadow the user's global binary — and a shim
// installed without its platform-native optional dependency then throws on run.
// Scoped to `appRoot`'s own package roots (the app checkout and its packages),
// so a user's unrelated project bins are left untouched. A packaged app has no
// such entries, so this is a no-op there.
export function stripDevWorkspaceBinDirs(value: string, appRoot: string): string {
  const separator = process.platform === 'win32' ? ';' : ':';
  const marker = `${path.sep}node_modules${path.sep}.bin`;
  const resolvedAppRoot = path.resolve(appRoot);
  const kept = value
    .split(separator)
    .filter(Boolean)
    .filter((part) => {
      if (!part.endsWith(marker)) return true;
      const packageRoot = part.slice(0, -marker.length);
      return !(
        resolvedAppRoot === packageRoot || resolvedAppRoot.startsWith(`${packageRoot}${path.sep}`)
      );
    });
  return kept.join(separator);
}

export function buildExternalToolEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const appDir = typeof baseEnv.APPDIR === 'string' ? baseEnv.APPDIR : undefined;

  for (const key of APPIMAGE_ENV_KEYS) {
    delete env[key];
  }

  for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const cleaned = stripPathLikeAppImageEntries(value, appDir);
    if (cleaned.length > 0) env[key] = cleaned;
    else delete env[key];
  }

  for (const key of ['PYTHONHOME', 'PYTHONPATH'] as const) {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    if ((appDir && value.startsWith(appDir)) || value.includes('/tmp/.mount_')) {
      delete env[key];
    }
  }

  return env;
}
