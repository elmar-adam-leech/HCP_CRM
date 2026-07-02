---
name: jsdom tests for Radix Select + react-day-picker
description: Polyfills and interaction quirks needed to component-test modals using Radix Select / react-day-picker under vitest jsdom
---

# Component-testing Radix Select + react-day-picker modals (vitest jsdom)

Client component tests need `// @vitest-environment jsdom` as the first line
(the global vitest env is `node`).

**Radix Select crashes the whole React tree in jsdom** unless these are
polyfilled BEFORE render (in `beforeAll`): `Element.prototype.scrollIntoView`,
`hasPointerCapture`, `releasePointerCapture`, `setPointerCapture`, plus a
`ResizeObserver` stub and `window.matchMedia`.

**Why:** Radix Select calls `scrollIntoView` in a passive effect when the
listbox mounts; the throw surfaces as an unhandled rejection and unmounts the
root, leaving `document.body` empty and making every later query time out. The
symptom is misleading — the failure shows up at a *later* interaction step, not
where the select opened.

**How to apply:**
- Opening a Radix Select trigger and clicking an option both work with plain
  `fireEvent.click` (no user-event dependency needed).
- react-day-picker (v8) disables past days; the modal here also disables
  today. Navigate to the next month (`getByRole('button',{name:/next month/i})`)
  then click a mid-month day (e.g. `getByText('15')` — 15 never appears as an
  outside/adjacent-month day, so it stays unique).
- Provide date-bearing fixture strings WITHOUT a `Z`/offset when the code
  formats via `Date#getHours()`, so assertions are timezone-independent.
