---
name: apple-design-foundations
description: "Use when choosing colors, typography, or layout/spacing for an Apple-style interface — semantic & dynamic system colors, Display P3 wide gamut, dark mode, the San Francisco type family, Dynamic Type, the 8-point grid, safe areas, and bento layouts. Part of the apple-design family. Keywords: apple color, semantic colors, system colors, label color, systemBlue, P3 wide gamut, dark mode, SF Pro, San Francisco font, New York serif, dynamic type, type scale, tracking, 8pt grid, 4pt, spacing, safe area, layout margins, bento grid, readable content width."
---

# Apple Design — Foundations (color · typography · layout)

The visual fundamentals Apple builds every surface on. Depth lives in the three
reference files; this is the map + the rules you must not get wrong.

## When to use
- Picking a color palette, dark-mode strategy, or wide-gamut color.
- Setting a type scale (in-app Dynamic Type **or** apple.com marketing headlines).
- Establishing spacing, grid, safe-area, or bento layout.

## Non-negotiable rules
- **Semantic over literal color.** Use system roles (`label`, `systemBackground`, `systemBlue`); never hardcode hex that can't adapt to light/dark/contrast.
- **Dark mode = dimming, not inverting.** Elevated surfaces get *lighter*, not pure-inverted. True-black only where it serves OLED.
- **System font stack.** `font-family: -apple-system, system-ui, "SF Pro", ...` — SF is **not** licensed as an arbitrary webfont; rely on the stack. Match optical size (SF Text < ~20pt, SF Display ≥ ~20pt).
- **Dynamic Type must reflow.** Layouts grow/wrap; never truncate body text at large sizes.
- **8-point grid** (4pt half-steps for tight gaps). Min **44×44pt** tap target. Respect `env(safe-area-inset-*)`.

## References
| File | Use for |
|---|---|
| `references/color-systems.md` | Semantic/system color tables, P3, dark-mode staircase, contrast, CSS tokens |
| `references/typography.md` | SF family, optical sizes, Dynamic Type table, tracking, marketing clamp() scale |
| `references/layout-grid-spacing.md` | 8pt system, margins/insets, apple.com breakpoints, bento grid recipes |

## Common mistakes
- Hardcoded hex instead of adaptive tokens; pure inversion for dark mode.
- Wrong optical size / faux-bold; tracking too tight on body.
- Off-grid spacing; ignoring safe areas; cramped bento with no hero tile.

**Related:** glass/vibrancy color → apple-design-materials · type-in-motion → apple-design-motion · contrast/Dynamic Type as accessibility → apple-design-tactics.
