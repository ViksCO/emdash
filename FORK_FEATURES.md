# Fork feature contract

Downstream inventory for the `ViksCO/emdash` fork of `generalaction/emdash`. Every custom behavior the fork carries lives in one row here. **When syncing upstream, walk this table and verify each row is still present in the merged tree.** A cleanly-deleted event handler leaves no git conflict — only an explicit checklist catches that.

Each row's outcome after a sync is one of:
- **carried** — still present, behavior verified
- **retired** — deliberately dropped (record why)
- **upstreamed** — merged upstream, no longer needed in fork
- **reimplemented** — behavior kept but code shape had to change against new upstream

Never let a row silently disappear.

| ID | Commit | Behavior | Manual smoke | Automated check |
|---|---|---|---|---|
| ADE-0 | `e19991f22` | Selectable WebStorm New UI dark theme in Settings → Color mode. `isDarkTheme()` treats WebStorm as dark alongside `emdark`. | Settings → Color mode → WebStorm New UI → app repaints; terminals, editor accents, selection look right. | none |
| ADE-1 | `63886a131` | Diff toolbar shows `filename` + `directory` + Copy-path button; changes-list rows show a truncation tooltip when the path overflows; `TooltipContent` is `pointer-events-none` project-wide. | Open a diff → toolbar shows file path with copy button (click → checkmark); hover a long path in the changes panel → tooltip appears with the full path. | none |
| ADE-2 | `008b22c2f` | Vertical mouse-wheel scrolls the task tab bar horizontally when it overflows (imperative `wheel` listener with `passive:false`, `deltaY !== 0 && deltaX === 0`). | Open many tabs so the strip overflows → plain-mouse vertical wheel scrolls the tab strip left/right; trackpad horizontal swipe still works unchanged. | none |
| ADE-3 | `81e1c7725` | Hover-only ↗ button on sidebar conversation rows to open the conversation in a persistent (non-preview) tab; skips the auto-rename side effect of the existing double-click path. | Hover a conversation row → arrow icon appears at the right → click → conversation opens in a stable tab (non-italic), no rename triggered. | none |
| ADE-4 | `ef49a80da` | Read jail widened to `homedir + os.tmpdir() + /tmp + /private/tmp` (`resolveJailedPath` + `assertWithinJail` in `main/core/app/service.ts`, shared by `openPath`, `readUserFile`, `readAudioFileDataUrl`). External file tabs render with a `FileSymlink` icon (`view/tab-bar/file-tab-item.tsx`). | ⌘K a temp-dir file (e.g. `/tmp/foo.md`) → opens; tab shows the symlink icon; `/etc/passwd` still blocked. | jail tests in `service.test.ts` |
| ADE-5 | `1a7ba4fad` | Preview scroll offset persists per tab (markdown preview keyed by file path); Monaco source view state persists per model URI. Both survive tab switches and app restarts. | Open `.md`, scroll to bottom, switch tab, return → still at bottom; restart app → still at bottom. Repeat in source (edit) mode with cursor position. | none |
| ADE-6 | `8c148f3ec` | Sidebar conversations panel visually marks rows that already have a tab open (background tabs, not just the currently-focused one). Three states: focused / open-in-background / not-open. | Open 3 conversation tabs, switch to a fourth surface (say a file) → in the sidebar, the 3 conversation rows are visually distinguished as "in a background tab" separately from the currently-focused row (if any). | none |
| ADE-8 | `58934ddcd` | ⌘K → file result → opens the file in a read-only peek modal (in-place cross-fade under the same scrim, no page nav). Uses Monaco's `colorize()` for highlighting; `.md` renders via the existing markdown renderer; images/binaries handled correctly. | ⌘K → type a filename → select a file result → peek modal opens with syntax-highlighted content; Escape closes; focus returns to the palette. | none |
| ADE-9 | `0f141f8bf` | ⌘K palette lists file matches from the current project's local repo (not just db-indexed sources). Opens in the peek modal (see ADE-8). Scoped to current project after the 2026-07-15 scope pivot. | ⌘K → type a filename that lives only in the current project's repo (not workspace-indexed) → the file appears in the "Files" group → select → peek opens. | none |

## Sync procedure

1. **Read this file.** For each row above, know what "carried" looks like before the merge.
2. **Merge upstream in a worktree.** Never in the primary checkout while `pnpm dev` is running.
3. **Resolve conflicts** aiming to keep every row above `carried`. If upstream restructured code a row depended on, port the behavior to the new location and record the outcome as `reimplemented`.
4. **Smoke-check every row** before advancing `main`. Manual smoke is fine for UI-heavy rows; add tests where cheap.
5. **Preserve the merge commit's ancestry.** Never squash the upstream sync merge — that flattens the parent link that keeps the *next* sync small. Fast-forward or merge into `main`; don't `reset --hard`.
6. **Record outcomes.** After the sync, update the "outcome" column for the release you synced to (rows are `carried` by default; anything else needs an entry).

## Recovery: `git rerere`

`git config rerere.enabled true` at the fork level. Conflict resolutions get recorded and offered back on the next similar conflict — useful for repeated lockfile churn, imports, and identical patches that keep re-conflicting. `autoUpdate` intentionally left `false`: rerere writes the suggested resolution to the working tree but leaves it unstaged, so you still review before committing.

## Housekeeping

- Every new ADE-N feature gets a row here in the same PR that introduces it.
- Removed features (`retired` / `upstreamed`) stay in the table with the outcome recorded, don't delete rows.
- Keep this file at repo root so a `git status`-only reader can see it exists.
