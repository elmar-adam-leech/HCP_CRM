---
name: npm audit nested vite vuln
description: how a vulnerable transitive package can survive under a devDependency's node_modules even after bumping the top-level version and its parent to satisfying ranges
---

When `npm audit` flags a vulnerable transitive package (e.g. `vite` pulled in
by `vitest`/`@vitest/mocker`) but bumping the top-level dependency and
aligning the parent package's version still leaves the old vulnerable
version nested under `node_modules/<parent>/node_modules/<pkg>`, a plain
`npm install` of the bumped packages is not enough — npm can leave a stale
nested copy in place instead of deduping to the satisfying top-level
version.

**Why:** npm's installer doesn't always re-evaluate whether an existing
nested install could be replaced by the hoisted version; it just leaves it
if the lockfile already pinned a nested resolution.

**How to apply:** after bumping versions, run `npm dedupe` (or a plain
`npm install --no-audit` after aligning peer versions) and re-run
`npm audit` to confirm the nested copy collapsed into the single top-level
version. Also check `npm ls <pkg> --all` to see if a vulnerable version is
still nested somewhere before declaring an audit fix complete.
