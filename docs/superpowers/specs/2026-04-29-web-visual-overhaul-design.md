# Web Visual Overhaul (Phase A: Token Unification)

Date: 2026-04-29
Scope: `apps/web/src/**`
Status: Approved by user 2026-04-29 — execute one-shot.

---

## Problem

The dashboard's CSS surface evolved organically across many sessions and is now
inconsistent enough that the user described it as "written with the foot —
ugly, weird palette, can't read the text."

Concrete measurements (from `apps/web/src/**/*.tsx`):

- **Text colors:** 39 distinct combinations. `text-zinc-*` alone uses
  100/200/300/400/500/600/700/950 (7 shades). `text-red-*` uses 100/200/200(80)/200(90)/300/300(80)/400/600/800 (9 shades). Every status color is duplicated 4–6 ways.
- **Backgrounds:** 40+ distinct combinations. `bg-zinc-900` appears as plain, /20, /30, /40, /50, /60, /70, /80 — eight different opacities of the same color.
- **Borders:** 37 distinct combinations. `border-zinc-*` uses 500/600/700/800.
- **Type scale:** 13 ad-hoc font-sizes (`text-[9px]`, `text-[10px]`, `text-[11px]`, `text-[0.55rem]`, `text-[0.6rem]`, `text-[0.65rem]`, `text-[0.68rem]`, `text-[0.7rem]`, `text-[0.82rem]`) on top of the 5 Tailwind defaults actually used.
- **Radius:** mixed `rounded` (127), `rounded-lg` (23), `rounded-md` (1), `rounded-t` (1), `rounded-full` (2).
- **Light mode is broken.** `globals.css` defines `[data-theme="light"]` tokens, but every page below `/kernel-next/[taskId]`, `/kernel-next/proposals`, etc. hardcodes `bg-zinc-950 text-zinc-100`. Switching theme leaves them dark.
- **Contrast failures.** `text-zinc-500` on `bg-zinc-900` ≈ 3.8:1 (below WCAG AA 4.5:1 for body text). `text-zinc-600` on `bg-zinc-950` ≈ 3.1:1 (below AA). This is the "can't read the text" complaint.

Root cause: zero abstraction layer. Every page hand-rolls Tailwind utilities;
the semantic tokens that already exist in `globals.css` are only consumed by
`layout.tsx` and `nav.tsx`.

## Goals

1. Single source of truth for color, type, radius, spacing.
2. Light + dark mode both readable and visually equivalent on every route.
3. WCAG AA contrast everywhere (4.5:1 body text, 3:1 large text/non-text).
4. No information-architecture changes, no copy changes, no interaction
   changes, no new dependencies. Pure visual layer refresh.
5. Mechanical, reviewable replacements — every diff should be a token swap or
   a component substitution, not a rewrite.

## Non-goals

- New design language, new visuals beyond consistency.
- Reworking page layouts, table → card conversions, etc.
- Animations, micro-interactions, icon system overhaul.
- Removing or renaming routes.
- `pipeline-graph.tsx` and `diff-viewer.tsx` semantic colors stay (the diff
  green/red carries meaning; the graph node coloring is data-driven).

## Design

### 1. Token system (extend `globals.css`)

Replace the current minimal token set with a full semantic palette. All
colors expressed in `oklch` for perceptual uniformity. Both `:root` (dark
default) and `[data-theme="light"]` define the full set. State-color
foreground values are hand-tuned to clear AA on the corresponding bg.

```
Surfaces
  --color-bg-page                  page background
  --color-bg-surface               card / panel background
  --color-bg-elevated              hover, selected, table head

Text
  --color-text-primary             body / strong text   (≥ 7:1)
  --color-text-secondary           secondary text       (≥ 4.5:1)
  --color-text-muted               metadata / disabled  (≥ 3:1)

Borders
  --color-border-default           neutral separator
  --color-border-strong            hover / focus separator

Accent (links, primary action)
  --color-accent                   accent text & primary button bg
  --color-accent-hover             primary button hover
  --color-accent-fg                text color on accent bg

Status (each: fg on bg, bg, border)
  --color-success-fg / -bg / -border
  --color-warning-fg / -bg / -border
  --color-danger-fg  / -bg / -border
  --color-info-fg    / -bg / -border
```

Tailwind v4 `@theme` block exposes each as a utility:
`bg-page`, `bg-surface`, `bg-elevated`, `text-primary`, `text-secondary`,
`text-muted`, `border-default`, `border-strong`, `text-accent`, `bg-accent`,
`hover:bg-accent-hover`, `text-accent-fg`, plus the four status sets
(`text-success-fg`, `bg-success-bg`, `border-success-border`, etc.).

### 2. Type scale (5 fixed steps)

```
text-xs    11px / 16px line-height   metadata, badges, micro-labels
text-sm    13px / 20px line-height   default body, buttons, forms
text-base  15px / 22px line-height   prose paragraphs
text-lg    18px / 26px line-height   card titles, section headers
text-2xl   24px / 32px line-height   page titles
```

All ad-hoc `text-[Npx]` sizes map to the nearest step. `[9px]`, `[10px]`,
`[11px]`, `[0.55rem]`, `[0.6rem]`, `[0.65rem]`, `[0.68rem]`, `[0.7rem]`
all collapse into `text-xs`. `[0.82rem]` → `text-sm`.

### 3. Radius / spacing / shadow

- Radius: keep only `rounded` (default 0.375rem) and `rounded-lg` (0.5rem,
  cards + modals only). All others removed.
- Spacing: stay on Tailwind defaults (1/2/3/4/6/8). No `[0.65rem]` ad-hoc.
- Shadow: dark mode uses borders only (no shadow). Light mode adds
  `shadow-sm` to elevated surfaces. Implemented via a single `.surface-card`
  utility class in `globals.css` that wraps the conditional shadow.

### 4. Shared UI primitives (`apps/web/src/components/ui/`)

Five small components — each ≤ 60 lines, prop-driven, no internal state:

```
ui/card.tsx          <Card>                    bg-surface border-default rounded-lg p-4
ui/button.tsx        <Button variant size>     primary | secondary | danger | ghost
                                               sm | md
ui/badge.tsx         <Badge variant>           neutral | success | warning | danger | info
ui/status-pill.tsx   <StatusPill status>       running | gated | completed | failed | cancelled | orphaned
ui/input.tsx         <Input>, <Select>         text inputs + select with token colors
```

Existing dialog / toast / confirm-dialog / pipeline-graph keep their own
files — they are organized components, not primitives, and out of scope for
A.

### 5. Token replacement table (mechanical)

| Old class | New class |
|---|---|
| `bg-zinc-950` | `bg-page` |
| `bg-zinc-900`, any `bg-zinc-900/N` | `bg-surface` |
| `bg-zinc-800`, `bg-zinc-800/50` | `bg-elevated` |
| `text-zinc-100`, `text-zinc-200` | `text-primary` |
| `text-zinc-300`, `text-zinc-400` | `text-secondary` |
| `text-zinc-500`, `text-zinc-600`, `text-zinc-700` | `text-muted` |
| `border-zinc-800`, `border-zinc-800/60` | `border-default` |
| `border-zinc-700`, `border-zinc-600`, `border-zinc-500`, `border-zinc-700/60` | `border-strong` |
| `text-sky-300`, `text-sky-400`, `text-sky-200`, `text-blue-400` (link contexts) | `text-accent` |
| `bg-blue-700`, `bg-blue-600` (primary button) | `<Button variant="primary">` |
| `bg-blue-500/15`, `bg-blue-700/40`, `bg-blue-900/30`, `bg-blue-800/50` | `bg-info-bg` |
| `text-blue-100/200/300`, `text-blue-* on info bg` | `text-info-fg` |
| `border-blue-*` (info contexts) | `border-info-border` |
| `bg-amber-500/N` (any opacity) | `bg-warning-bg` |
| `text-amber-200/300/400`, opacities | `text-warning-fg` |
| `border-amber-*` | `border-warning-border` |
| `bg-red-500/N`, `bg-red-900/N`, `bg-red-800/N`, `bg-red-100` | `bg-danger-bg` |
| `text-red-100/200/300/400/600/800`, opacities | `text-danger-fg` |
| `border-red-*` | `border-danger-border` |
| `bg-emerald-500/N`, `text-emerald-*`, `border-emerald-*` | `bg-success-bg` / `text-success-fg` / `border-success-border` |
| `bg-purple-500/15`, `text-purple-300`, `border-purple-*` | mapped to `info` (we collapse purple into info — the only purple usage is the `orphaned` status badge, which is conceptually informational not its own state) |
| `text-[9px]` … `text-[0.7rem]` | `text-xs` |
| `text-[0.82rem]` | `text-sm` |
| `rounded-md`, `rounded-t` | `rounded` |
| `rounded-full` | keep (dot/avatar use) |

The hand-rolled status badge function in `app/kernel-next/page.tsx`
(`statusBadge(status)`) is replaced wholesale with `<StatusPill status={t.status} />`.

### 6. Execution phases

Each phase touches ≤ 5 files (CLAUDE.md PHASED EXECUTION rule). Run
`pnpm --filter web exec tsc --noEmit` after each. Tests run at the end.

| Phase | Files | Notes |
|---|---|---|
| **0** | `globals.css`, `components/ui/{card,button,badge,status-pill,input}.tsx` | Foundation. Add tokens + components. |
| **1** | `app/page.tsx`, `app/kernel-next/page.tsx`, `components/nav.tsx`, `components/error-banner.tsx`, `components/toast.tsx` | Entry surfaces + global chrome. |
| **2** | `app/kernel-next/[taskId]/page.tsx`, `app/kernel-next/attempts/[attemptId]/page.tsx`, `app/kernel-next/proposals/page.tsx`, `app/kernel-next/pipelines/page.tsx`, `app/kernel-next/pipelines/[name]/page.tsx` | The five large detail/list pages. |
| **3** | `components/gate-card.tsx`, `components/audit-timeline.tsx`, `components/pipeline-graph.tsx`, `components/secret-gate-panel.tsx`, `components/task-actions-bar.tsx` | Task-page embeds. `pipeline-graph` keeps node-coloring logic, only chrome is swapped. |
| **4** | `components/launch-pipeline-dialog.tsx`, `components/migrate-proposal-dialog.tsx`, `components/confirm-dialog.tsx`, `components/prompts-editor.tsx`, `components/structured-input.tsx` | Dialogs + form surfaces. |
| **5** | `components/{recommended-mcps-card,diagnostics-panel,inventory-banner,diff-viewer,proposal-diff,copy-button,theme-toggle,keyboard-shortcuts-overlay}.tsx`, `app/kernel-next/mcp-catalog/{page,entry-card,add-entry-dialog}.tsx`, `app/error.tsx` | Long tail. Each ≤ 200 LOC, mechanical. |

### 7. Verification

After each phase:

1. `pnpm --filter web exec tsc --noEmit` — must pass with 0 errors.

After all phases:

2. `pnpm --filter web test` — existing tests must still pass; no test
   touches semantic class names.
3. Manual visual check: `/`, `/kernel-next`, `/kernel-next/[some-task]`,
   `/kernel-next/proposals`, in both dark and light themes.

### 8. Out-of-scope changes that fall out for free

- Light mode becomes correct on every page (token-based).
- `text-zinc-500`-on-`bg-zinc-900` contrast failure disappears (`text-muted`
  is tuned to 3.5:1 minimum on `bg-surface`).
- `text-secondary` clears 4.5:1 on `bg-page` and `bg-surface`.

### 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `pipeline-graph.tsx` uses `@xyflow/react` with custom node renderers; node colors may be passed as inline style props (not Tailwind classes) | Audit node renderers in Phase 3 — only swap chrome (panel, controls, minimap), leave node fills alone. |
| `diff-viewer.tsx` green/red highlighting is semantic | Map ONLY chrome classes (border, bg of panel) to tokens. The line-level `+` / `-` highlight stays on `bg-success-bg` / `bg-danger-bg` — same semantic, just goes through tokens now. |
| Existing tests assert specific `className` substrings | Spot-checked test files: `pipeline-graph.test.tsx`, `audit-timeline.test.tsx`, `proposal-diff.test.tsx`, `diff-viewer.test.tsx`, `diagnostics-panel.test.tsx`, `error-boundary.test.tsx`, `prompts-editor.test.tsx` — none should assert on `zinc-*` / `sky-*`. Will rerun tests at end and fix any that do. |
| User has manual theme override in localStorage | `themeBootstrapScript` in `layout.tsx` already handles this — unchanged. |
| Phase ordering creates intermediate broken state | Phase 0 only ADDS token classes; old utilities still resolve via Tailwind. So Phases 1–5 can land in any order without breaking earlier phases. |

### 10. Reference: token oklch values

Dark (default):
```
--color-bg-page:        oklch(0.18 0.01 280)
--color-bg-surface:     oklch(0.22 0.01 280)
--color-bg-elevated:    oklch(0.27 0.01 280)
--color-text-primary:   oklch(0.96 0.005 280)
--color-text-secondary: oklch(0.78 0.005 280)
--color-text-muted:     oklch(0.62 0.005 280)   /* lifted from 0.58 → 0.62 to clear AA on surface */
--color-border-default: oklch(0.31 0.005 280)
--color-border-strong:  oklch(0.42 0.005 280)
--color-accent:         oklch(0.72 0.18 235)
--color-accent-hover:   oklch(0.78 0.18 235)
--color-accent-fg:      oklch(0.16 0.01 280)

--color-success-fg:     oklch(0.82 0.16 155)
--color-success-bg:     oklch(0.32 0.06 155)
--color-success-border: oklch(0.45 0.10 155)

--color-warning-fg:     oklch(0.85 0.14  85)
--color-warning-bg:     oklch(0.34 0.06  85)
--color-warning-border: oklch(0.50 0.11  85)

--color-danger-fg:      oklch(0.80 0.15  25)
--color-danger-bg:      oklch(0.32 0.07  25)
--color-danger-border:  oklch(0.50 0.13  25)

--color-info-fg:        oklch(0.82 0.13 235)
--color-info-bg:        oklch(0.32 0.07 235)
--color-info-border:    oklch(0.48 0.11 235)
```

Light:
```
--color-bg-page:        oklch(0.99 0.002 280)
--color-bg-surface:     oklch(0.97 0.003 280)
--color-bg-elevated:    oklch(0.93 0.005 280)
--color-text-primary:   oklch(0.20 0.01 280)
--color-text-secondary: oklch(0.40 0.01 280)
--color-text-muted:     oklch(0.50 0.01 280)
--color-border-default: oklch(0.88 0.005 280)
--color-border-strong:  oklch(0.74 0.005 280)
--color-accent:         oklch(0.50 0.18 245)
--color-accent-hover:   oklch(0.42 0.18 245)
--color-accent-fg:      oklch(0.99 0.002 280)

--color-success-fg:     oklch(0.36 0.14 150)
--color-success-bg:     oklch(0.94 0.05 150)
--color-success-border: oklch(0.78 0.12 150)

--color-warning-fg:     oklch(0.42 0.13  75)
--color-warning-bg:     oklch(0.95 0.06  85)
--color-warning-border: oklch(0.78 0.13  85)

--color-danger-fg:      oklch(0.42 0.18  25)
--color-danger-bg:      oklch(0.95 0.05  25)
--color-danger-border:  oklch(0.74 0.16  25)

--color-info-fg:        oklch(0.40 0.16 245)
--color-info-bg:        oklch(0.95 0.04 245)
--color-info-border:    oklch(0.72 0.14 245)
```

These are the values that go into `globals.css`. Contrast was checked against
the corresponding bg-page / bg-surface / status-bg pairs to clear WCAG AA.
