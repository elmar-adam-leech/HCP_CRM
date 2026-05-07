---
version: alpha
name: Multi-Tenant CRM
description: Visual design tokens and rules for the multi-tenant CRM (Pipedrive-inspired, shadcn/ui-based).
colors:
  background: "#f9fafb"
  foreground: "#282c34"
  border: "#e5e7eb"
  card: "#ffffff"
  card-foreground: "#282c34"
  card-border: "#dfe2e7"
  popover: "#ffffff"
  popover-foreground: "#282c34"
  popover-border: "#dadce2"
  primary: "#2b6cee"
  primary-foreground: "#ffffff"
  secondary: "#eaedf0"
  secondary-foreground: "#282c34"
  muted: "#edf0f2"
  muted-foreground: "#5d636f"
  accent: "#f1f2f4"
  accent-foreground: "#282c34"
  destructive: "#ef4343"
  destructive-foreground: "#fafafa"
  input: "#d4d7de"
  ring: "#2b6cee"
  chart-1: "#1152d4"
  chart-2: "#16a249"
  chart-3: "#f59f0a"
  chart-4: "#6211d4"
  chart-5: "#d44211"
  sidebar: "#f3f5f7"
  sidebar-foreground: "#282c34"
  sidebar-border: "#ebecef"
  sidebar-primary: "#2b6cee"
  sidebar-primary-foreground: "#ffffff"
  sidebar-accent: "#e7ebef"
  sidebar-accent-foreground: "#282c34"
  sidebar-ring: "#2b6cee"
typography:
  h1:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  h2:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  h3:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.35
  h4:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: Menlo
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
    height: 36px
  button-sm:
    height: 32px
    rounded: "{rounded.md}"
    typography: "{typography.body-sm}"
  button-lg:
    height: 40px
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
  button-icon:
    height: 36px
    width: 36px
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
    height: 36px
  button-destructive:
    backgroundColor: "{colors.destructive}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
    height: 36px
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
    height: 36px
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
    height: 36px
  badge:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.caption}"
  badge-muted:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.caption}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.md}"
    padding: 16px
  card-divider:
    backgroundColor: "{colors.card-border}"
    height: 1px
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  popover-divider:
    backgroundColor: "{colors.popover-border}"
    height: 1px
  separator:
    backgroundColor: "{colors.border}"
    height: 1px
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
    height: 36px
    padding: 12px
  input-border:
    backgroundColor: "{colors.input}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.ring}"
    rounded: "{rounded.md}"
  destructive-surface:
    backgroundColor: "{colors.destructive-foreground}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 12px
  chart-series-1:
    backgroundColor: "{colors.chart-1}"
  chart-series-2:
    backgroundColor: "{colors.chart-2}"
  chart-series-3:
    backgroundColor: "{colors.chart-3}"
  chart-series-4:
    backgroundColor: "{colors.chart-4}"
  chart-series-5:
    backgroundColor: "{colors.chart-5}"
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.sidebar-foreground}"
    padding: 12px
  sidebar-divider:
    backgroundColor: "{colors.sidebar-border}"
    height: 1px
  sidebar-menu-active:
    backgroundColor: "{colors.sidebar-primary}"
    textColor: "{colors.sidebar-primary-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
  sidebar-menu-hover:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.body-md}"
  sidebar-focus-ring:
    backgroundColor: "{colors.sidebar-ring}"
    rounded: "{rounded.md}"
---

# Multi-Tenant CRM Design System

This document is the canonical description of the visual identity for the multi-tenant CRM. It consolidates the tokens defined in `client/src/index.css`, the Tailwind theme in `tailwind.config.ts`, and the prose rules previously split between `design_guidelines.md` and the agent's universal design guidelines.

## How to Use This File

- Validate the file: `npx @google/design.md lint DESIGN.md`
- Sanity-check the Tailwind export against `client/src/index.css`: `npx @google/design.md export --format tailwind DESIGN.md` (the `dtcg` format is also supported). **Do not** replace `index.css` with the export. `index.css` remains the source of truth; the export is only a diff-check tool.
- When tokens change, update both `client/src/index.css` and `DESIGN.md` in the same change, then re-lint.
- The YAML front matter documents **light mode** as the canonical scale. Dark-mode counterparts are listed in prose under "Colors → Dark mode" and live alongside the light tokens in `:root` / `.dark` in `index.css`.

## Overview

The product is a Pipedrive-inspired CRM for service-based contractors. The interface is **professional, data-dense, and utility-first**. Visual flourish is restrained; clarity, hierarchy, and scanability win every tradeoff. The system is mobile-first and ships in both light and dark modes via a `class`-based toggle (`darkMode: ["class"]` in `tailwind.config.ts`).

Every component in the app is built on **shadcn/ui** primitives (`client/src/components/ui/`) layered over Radix UI. Agents and contributors must reuse those primitives rather than re-implement equivalents.

## Colors

The palette is rooted in a single brand blue, neutral grays, and a small set of semantic accents. Tokens are referenced via Tailwind classes (`bg-background`, `text-foreground`, `border-border`, `bg-card`, etc.) and resolve to the HSL custom properties declared in `client/src/index.css`.

- **Primary (#2b6cee):** Brand blue. Used for the single most important action per screen, links, focus rings, and selected sidebar state. Reserved — do not use `text-primary` for body text outside of hero/branding contexts.
- **Foreground (#282c34) / Muted-foreground (#5d636f):** Three-tier text hierarchy, see "Typography → Text hierarchy".
- **Background (#f9fafb) / Card (#ffffff) / Sidebar (#f3f5f7):** The surface stack. Cards sit on background; sidebars are a slightly cooler neutral.
- **Destructive (#ef4343):** Errors, delete confirmations, overdue states only.
- **Chart 1–5:** Reserved for data viz. Do not reuse for general UI accents.

### Dark mode

Dark mode is class-based. The `.dark` class on `<html>` swaps every token in parallel. Equivalents:

| Token | Light | Dark |
| --- | --- | --- |
| `background` | `#f9fafb` | `#14161a` |
| `foreground` | `#282c34` | `#f9fafb` |
| `border` | `#e5e7eb` | `#282c34` |
| `card` | `#ffffff` | `#1f2228` |
| `card-foreground` | `#282c34` | `#f9fafb` |
| `card-border` | `#dfe2e7` | `#31363f` |
| `popover` | `#ffffff` | `#23272e` |
| `popover-foreground` | `#282c34` | `#f9fafb` |
| `popover-border` | `#dadce2` | `#353b45` |
| `primary` | `#2b6cee` | `#2b6cee` |
| `primary-foreground` | `#f9fafb` | `#f9fafb` |
| `secondary` | `#eaedf0` | `#2c313a` |
| `secondary-foreground` | `#282c34` | `#f9fafb` |
| `muted` | `#edf0f2` | `#262931` |
| `muted-foreground` | `#5d636f` | `#9ba0ab` |
| `accent` | `#f1f2f4` | `#282c34` |
| `accent-foreground` | `#282c34` | `#f9fafb` |
| `destructive` | `#ef4343` | `#ef4343` |
| `destructive-foreground` | `#fafafa` | `#fafafa` |
| `input` | `#d4d7de` | `#353b45` |
| `ring` | `#2b6cee` | `#2b6cee` |
| `chart-1` | `#1152d4` | `#5a8cf2` |
| `chart-2` | `#16a249` | `#3ae478` |
| `chart-3` | `#f59f0a` | `#f9c56c` |
| `chart-4` | `#6211d4` | `#995af2` |
| `chart-5` | `#d44211` | `#f2805a` |
| `sidebar` | `#f3f5f7` | `#181b20` |
| `sidebar-foreground` | `#282c34` | `#f9fafb` |
| `sidebar-border` | `#ebecef` | `#2a2e37` |
| `sidebar-primary` | `#2b6cee` | `#2b6cee` |
| `sidebar-primary-foreground` | `#f9fafb` | `#f9fafb` |
| `sidebar-accent` | `#e7ebef` | `#23272e` |
| `sidebar-accent-foreground` | `#282c34` | `#f9fafb` |
| `sidebar-ring` | `#2b6cee` | `#2b6cee` |

When you must reach for a literal Tailwind color (e.g. `bg-yellow-400`), you **must** also pair it with a `dark:` variant for every visual property (background, border, foreground). Prefer semantic tokens whenever possible.

## Typography

The product uses **Inter** for sans-serif UI text, **Georgia** for the rare serif accent, and **Menlo** for monospaced data. The font stack is wired via `--font-sans`, `--font-serif`, `--font-mono` in `index.css` and surfaced through `font-sans`, `font-serif`, `font-mono` Tailwind classes.

### Text hierarchy

Three tiers, used consistently across the app:

- **Default** (`text-foreground`): primary content — record titles, table cells, body copy.
- **Secondary** (`text-muted-foreground`): supporting metadata — timestamps, helper copy, "X items" counters.
- **Tertiary**: least important content — render with `text-muted-foreground` plus a smaller size (`text-xs`) or reduced weight. Avoid inventing a fourth gray.

`text-primary` is reserved for hero and branding contexts. Do not use it for body or link text inside the app shell — links inherit `text-foreground` and rely on underline/hover affordances.

### Sizes

The typography tokens above (`h1`–`h4`, `body-lg/md/sm`, `caption`, `mono`) describe the de facto scale derived from Tailwind defaults plus the app's overrides. Headings always use `font-semibold` (600); body and labels stay at 400 unless emphasized.

## Layout

Spacing follows the Tailwind 4px step (`--spacing: 0.25rem`). The five named scale levels in the `spacing` token map onto the gap utilities the codebase actually uses:

| Token | px | Tailwind utility |
| --- | --- | --- |
| `xs` | 4 | `gap-1`, `p-1` |
| `sm` | 8 | `gap-2`, `p-2` |
| `md` | 12 | `gap-3`, `p-3` |
| `lg` | 16 | `gap-4`, `p-4` |
| `xl` | 24 | `gap-6`, `p-6` |

Pick a small set of spacing values per surface and stay consistent. Card interiors should share padding within a screen. Two elements that both have visible borders or elevated hover states must never touch — there must be spacing between them.

Layouts use `flex` and `grid` from Tailwind. Horizontal flex rows that use `justify-start`/`justify-end` (or rely on the default) must include `flex-wrap`. Rows using `justify-between`/`justify-around`/`justify-evenly` must also include a `gap-*` or `space-x-*` to handle narrow viewports.

`display: table` (and the `table` utility) is forbidden — it ignores width constraints.

## Elevation & Depth

The system is **flat**. Depth is conveyed through **tonal layers** (background → sidebar → card) and through the elevate utilities, not heavy drop shadows.

The two interaction utilities, defined in `index.css`, are mandatory for hover/active feedback on any custom interactive element:

- `hover-elevate`: subtle background brightening on hover. Compose with any background color, including transparent.
- `active-elevate-2`: stronger brightening on press. Stacks with `hover-elevate`.
- `toggle-elevate` + `toggle-elevated`: turn any element into a two-state toggle without inventing custom selected colors.
- `no-default-hover-elevate` / `no-default-active-elevate`: opt out of the built-in elevation on `Button`/`Badge` when you need a custom interaction (rare).

`Button` and `Badge` already have `hover-elevate` and `active-elevate-2` baked in. **Never** override their hover/active background or text colors with `hover:bg-*` etc.

The elevate utilities require `overflow: visible`. They will not work on elements with `overflow-hidden` or `overflow-scroll`.

Drop shadows are used sparingly: only on floating surfaces (modals, popovers, toasts) or when a surface shares the exact background color of its parent and needs a boundary.

## Shapes

Border radii are **small**. The shadcn `--radius` token is `.5rem` (8px); Tailwind utilities map `rounded-sm` (3px), `rounded-md` (6px), and `rounded-lg` (9px) on top. The DESIGN.md tokens above are the canonical conceptual scale; use the matching Tailwind class in code.

Use `rounded-full` only for perfect circles (avatars, dot indicators) or perfect pills (status badges where height is fixed).

**One-, two-, or three-sided borders on a rounded element are forbidden.** A `border-l-4` accent on a `rounded-md` `Card` looks broken. Use a full border, no border, or convey emphasis with a leading icon / colored bar implemented as a separate child element with its own corners.

## Components

All components must be composed from shadcn primitives in `client/src/components/ui/`. Reuse before re-implementing.

### Button

- Variants: `default`, `secondary`, `outline`, `ghost`, `destructive`, `link`.
- Sizes (height contract): `default` `min-h-9` (36px), `sm` `min-h-8` (32px), `lg` `min-h-10` (40px), `icon` `h-9` `w-9`.
- Never set explicit `h-*`, `w-*`, or `px-*` on a `Button`. Use the size variant.
- An icon-only button **must** use `size="icon"`. Do not stretch a `size="sm"` button to fit an icon, and never override icon button width/height.
- A `Button` placed next to another interactive control on the same horizontal line must share its height. Default-size buttons pair with `h-9` siblings.
- Never apply custom `hover:bg-*` or `active:bg-*` on a `Button`. The built-in elevate utilities adapt to whatever background variant is selected.

### Badge

- Badges are **non-interactive tokens** and are intentionally smaller than buttons. Place them on the same line as buttons only when the line has room.
- Badges never wrap their contents. Place them somewhere the line has horizontal room to grow.
- Same hover/active rule as Button: do not override interaction colors.

### Card

- Use the `Card` component for grouped content. Never reproduce the look with a raw `div` plus `bg-card`.
- Do not nest a `Card` inside another `Card` (or inside any element with `bg-card`).
- A `Card` placed inside a sidebar, header, or other non-default surface must keep enough contrast against the surrounding surface to stay distinguishable. The surrounding container must have padding so the `Card`'s rounded corners never touch the container's edge.

### Input / Textarea

- Use the shadcn `Input`, `Textarea`, and `Form` (`useForm` + `zodResolver`) primitives.
- Do not reset `Textarea` padding to zero (`p-0`).
- Inputs with embedded icons must include the small spacing token (`px-2`/`gap-2`) on each side of the icon.

### Sidebar

- The application sidebar must use `@/components/ui/sidebar`. Do not re-implement.
- Width is controlled via CSS variables on `SidebarProvider`, never on `<Sidebar>`:
  ```tsx
  const style = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  } as React.CSSProperties;
  <SidebarProvider style={style}>...</SidebarProvider>
  ```
- The immediate child of `SidebarProvider` **must** carry `w-full` so the layout fills the viewport.
- For "currently selected" sidebar items, use `data-[active=true]:bg-sidebar-accent` plus `hover-elevate active-elevate-2`. Do not invent a custom hover color.

### Containers (panels, panes)

Pick **one** containment method per surface and stay consistent:

- **A. Whitespace + headings.** No backgrounds, no borders.
- **B. Subtle background tint.** Container uses a slightly elevated background vs. its parent.
- **C. Border or shadow only.** Container shares its parent's background; a thin border or subtle shadow draws the boundary.
- **D. Background tint + border.** Both at low contrast.

Mixing methods in adjacent panels feels noisy. When in doubt, prefer A or B.

## Do's and Don'ts

- **Do** use `Button`, `Badge`, `Card`, and the rest of `client/src/components/ui/` instead of styling raw elements to look like them.
- **Do** rely on `hover-elevate` and `active-elevate-2` for every custom interactive surface.
- **Do** include a `dark:` variant for every literal color (`bg-white dark:bg-black`, etc.) when you cannot use a semantic token.
- **Do** keep interactive controls on the same horizontal line at the same height (`min-h-9` is the default contract).
- **Do** use icons from `lucide-react` for actions and `react-icons/si` for company logos.
- **Don't** use emojis anywhere — UI, mock data, fixtures, comments shown to users. Use icons instead.
- **Don't** apply one-, two-, or three-sided borders to a rounded element.
- **Don't** override hover/active background or text colors on `Button` or `Badge`.
- **Don't** set width or height on a `Button` with `size="icon"`.
- **Don't** set width on `<Sidebar>`; set `--sidebar-width` on `SidebarProvider`.
- **Don't** use `text-primary` for body text or links outside hero/branding surfaces.
- **Don't** use `display: table` (or the Tailwind `table` utility) — it ignores `width: 100%`.
- **Don't** introduce new ad-hoc grays for a fourth tier of text. Reach for size/weight instead.
