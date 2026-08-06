import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripDevWorkspaceBinDirs } from './childProcessEnv';

// The scrub targets the dev-launcher PATH pollution that only occurs on POSIX
// (resolveUserEnv returns early on win32 before calling it), so these use
// POSIX-shaped paths and are skipped on Windows.
describe.skipIf(process.platform === 'win32')('stripDevWorkspaceBinDirs', () => {
  const sep = path.delimiter;
  const appRoot = '/repo/apps/desktop';

  it("removes the app checkout's own node_modules/.bin entries", () => {
    const input = [
      '/repo/apps/desktop/node_modules/.bin', // the checkout's package
      '/repo/node_modules/.bin', // the checkout root
      '/usr/local/bin',
    ].join(sep);
    expect(stripDevWorkspaceBinDirs(input, appRoot).split(sep)).toEqual(['/usr/local/bin']);
  });

  it("leaves an unrelated project's node_modules/.bin untouched", () => {
    const other = '/somewhere/other-project/node_modules/.bin';
    const out = stripDevWorkspaceBinDirs(
      ['/repo/node_modules/.bin', other, '/usr/bin'].join(sep),
      appRoot
    ).split(sep);
    expect(out).toContain(other);
    expect(out).not.toContain('/repo/node_modules/.bin');
  });

  it('preserves order and every non-checkout entry (globals, corepack node-gyp-bin)', () => {
    const input = [
      '/repo/node_modules/.bin',
      '/opt/corepack/dist/node-gyp-bin',
      '/opt/homebrew/bin',
      '/repo/apps/desktop/node_modules/.bin',
      '/usr/bin',
    ].join(sep);
    expect(stripDevWorkspaceBinDirs(input, appRoot).split(sep)).toEqual([
      '/opt/corepack/dist/node-gyp-bin',
      '/opt/homebrew/bin',
      '/usr/bin',
    ]);
  });

  it('is a no-op when nothing belongs to the app checkout', () => {
    const input = ['/usr/bin', '/opt/homebrew/bin'].join(sep);
    expect(stripDevWorkspaceBinDirs(input, appRoot)).toBe(input);
  });
});
