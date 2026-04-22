/**
 * Brand color helpers shared between server (SSR) and client.
 *
 * Contractors store their brand color as a hex string (e.g. `#3366ff`).
 * For CSS variables we need the "H S% L%" space-separated format used by
 * the rest of the design system in `index.css`.
 */

export const BRAND_COLOR_HEX_RE = /^#([0-9a-fA-F]{6})$/;

export interface HslTriple {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): HslTriple | null {
  const m = BRAND_COLOR_HEX_RE.exec(hex.trim());
  if (!m) return null;
  const intVal = parseInt(m[1], 16);
  const r = ((intVal >> 16) & 0xff) / 255;
  const g = ((intVal >> 8) & 0xff) / 255;
  const b = (intVal & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function hslToCssTriple(hsl: HslTriple): string {
  return `${hsl.h} ${hsl.s}% ${hsl.l}%`;
}

/**
 * Pick a readable foreground (white or near-black) for a given brand
 * background using the standard relative-luminance formula.
 */
export function pickForegroundTriple(hsl: HslTriple): string {
  // Convert HSL back to RGB to compute luminance.
  const h = hsl.h / 360;
  const s = hsl.s / 100;
  const l = hsl.l / 100;
  const hueToRgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  // Standard relative luminance.
  const channel = (c: number) => {
    const v = c;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.55 ? "220 13% 18%" : "210 20% 98%";
}

/**
 * Build the CSS that themes the public booking page with a brand color.
 * Returns null if the hex is invalid so callers can fall back to defaults.
 *
 * The CSS targets `:root` (and `.dark`) and overrides the design tokens that
 * drive the primary button, focus ring, and other accent surfaces.
 */
export function buildBrandColorCss(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const triple = hslToCssTriple(hsl);
  const fg = pickForegroundTriple(hsl);
  return `:root,.dark{--primary:${triple};--primary-foreground:${fg};--ring:${triple};--sidebar-primary:${triple};--sidebar-primary-foreground:${fg};--sidebar-ring:${triple};}`;
}
