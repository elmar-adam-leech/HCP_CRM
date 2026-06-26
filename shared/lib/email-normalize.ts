/**
 * Shared rich-text block-break normalization for the email composer.
 *
 * Browsers disagree on what tag a contenteditable surface emits for each
 * Enter-separated line: Chrome/Safari commonly wrap new lines in <div>, while
 * other engines emit <p> or a bare <br>. The email allowlist (b/strong/i/em/a/
 * br/p) does NOT include <div>, so a naive sanitize would strip the <div>
 * WITHOUT leaving a line break behind — silently collapsing multiple typed
 * lines into one continuous line for the recipient.
 *
 * `normalizeBlockBreaks` runs BEFORE the allowlist sanitize on BOTH the client
 * editor and the server send path. It rewrites every <div> boundary into an
 * allowlisted <br>, so a line break always survives regardless of which tag the
 * source browser produced. It operates purely on a passed-in DOM element (it
 * never touches globals), so the same code runs against the browser DOM on the
 * client and against the jsdom DOM on the server.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * True when `node` has a previous sibling carrying real content on the same
 * line — i.e. unwrapping this block here would otherwise glue two lines
 * together. An existing <br> already supplies the break, so we report false in
 * that case to avoid stacking a second break (runaway blank lines).
 */
function hasMeaningfulPrevious(node: Node): boolean {
  let prev = node.previousSibling;
  while (prev) {
    if (prev.nodeType === TEXT_NODE) {
      if ((prev.textContent ?? '').trim().length > 0) return true;
    } else if (prev.nodeType === ELEMENT_NODE) {
      // A <br> right before us is already the line break we'd insert.
      if ((prev as Element).tagName === 'BR') return false;
      return true;
    }
    prev = prev.previousSibling;
  }
  return false;
}

/**
 * Rewrites <div> block boundaries inside `root` into allowlisted <br> breaks,
 * in place. Safe to call on markup that has no <div> (no-op) and on nested
 * <div> structures (outer blocks are processed first, so inner content is
 * re-parented and still handled correctly).
 */
export function normalizeBlockBreaks(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;

  // Static snapshot: we mutate the tree while iterating.
  const divs = Array.from(root.querySelectorAll('div'));
  for (const div of divs) {
    const parent = div.parentNode;
    if (!parent) continue; // already detached by an outer unwrap

    if (hasMeaningfulPrevious(div)) {
      parent.insertBefore(doc.createElement('br'), div);
    }
    // Unwrap: lift the div's children into its place, then drop the div.
    while (div.firstChild) {
      parent.insertBefore(div.firstChild, div);
    }
    parent.removeChild(div);
  }
}
