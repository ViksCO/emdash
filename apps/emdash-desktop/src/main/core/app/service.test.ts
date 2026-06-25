import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getVersion: vi.fn(() => '1.1.27'),
  openExternal: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => ''),
    getVersion: mocks.getVersion,
    quit: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openExternal: mocks.openExternal,
    openPath: mocks.openPath,
  },
}));

vi.mock('@main/app/window', () => ({
  getMainWindow: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('@main/db/schema', () => ({
  sshConnections: {},
}));

vi.mock('@main/lib/events', () => ({
  events: {
    on: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/childProcessEnv', () => ({
  buildExternalToolEnv: () => ({}),
}));

const { appService } = await import('./service');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatform,
    value: platform,
  });
}

describe('AppService.openIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('win32');
    mocks.openPath.mockResolvedValue('');
    mocks.exec.mockImplementation(
      (_command: string, _options: object, callback: (error: Error | null) => void) => {
        callback(null);
      }
    );
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('opens the platform file manager with Electron shell.openPath instead of a shell command', async () => {
    const target = 'C:/Users/Qwenzy/Desktop/ees_ams';

    await appService.openIn({ app: 'finder', path: target });

    expect(mocks.openPath).toHaveBeenCalledWith(target);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('throws when Electron shell.openPath returns an error message', async () => {
    const target = 'C:/Users/Qwenzy/Desktop/missing';
    mocks.openPath.mockResolvedValueOnce('Path does not exist');

    await expect(appService.openIn({ app: 'finder', path: target })).rejects.toThrow(
      'Path does not exist'
    );
    expect(mocks.openPath).toHaveBeenCalledWith(target);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});

describe('AppService file jail', () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeTempFile(root: string, name: string, content: string): Promise<string> {
    const dir = await mkdtemp(join(root, 'emdash-jail-'));
    tempDirs.push(dir);
    const filePath = join(dir, name);
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  it('reads a file under the OS temp directory', async () => {
    const filePath = await writeTempFile(tmpdir(), 'note.md', 'temp content');
    await expect(appService.readUserFile(filePath)).resolves.toEqual({ content: 'temp content' });
  });

  it.skipIf(process.platform === 'win32')('reads a file under /tmp', async () => {
    const filePath = await writeTempFile('/tmp', 'note.md', 'tmp content');
    await expect(appService.readUserFile(filePath)).resolves.toEqual({ content: 'tmp content' });
  });

  it('reads a file under the user home directory', async () => {
    const filePath = await writeTempFile(homedir(), 'note.md', 'home content');
    await expect(appService.readUserFile(filePath)).resolves.toEqual({ content: 'home content' });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a path outside the home and temp directories',
    async () => {
      await expect(appService.readUserFile('/etc/hosts')).rejects.toThrow(
        'Path must be inside the user home or a temporary directory'
      );
    }
  );

  it('reads an audio file under the OS temp directory', async () => {
    const filePath = await writeTempFile(tmpdir(), 'clip.wav', 'RIFFfake');
    const dataUrl = await appService.readAudioFileDataUrl(filePath);
    expect(dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an audio file outside the home and temp directories',
    async () => {
      await expect(appService.readAudioFileDataUrl('/etc/hosts')).rejects.toThrow(
        'Audio file must be located within the user home or a temporary directory'
      );
    }
  );
});
