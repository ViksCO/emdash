import type { PeekSearchOptions } from '@shared/core/peek';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { peekService } from './peek-service';

export const peekController = createRPCController({
  discoverRepos: (roots: string[]) => peekService.discoverRepos(roots),
  searchFiles: (args: { query: string; options: PeekSearchOptions }) =>
    peekService.searchFiles(args.query, args.options),
});
