# Iconography & SF Symbols — Apple Design Reference

**Scope:** Squircle mathematics, app icon grid, iOS 26 Liquid Glass icon treatment, SF Symbols 7 library (weights / scales / rendering modes / effects), and faithful replication on the web.

---

## 1. Principles

### Why continuous corners — not simple rounded rectangles

A standard CSS `border-radius` creates a *tangent join*: the radius circle meets the straight edge at a single point, causing an abrupt curvature jump from 0 (flat) to 1/r (arc) [observed in curvature-comb visualisations]. The eye registers this as a subtle kink, especially under raking light or on high-DPI screens.

Apple's squircle uses *continuous curvature*: the rate of bending itself is a smooth curve that eases in from zero, reaches a maximum at the corner apex, and eases back to zero on the next side. No discontinuity exists anywhere on the outline [documented in Apple ID-team curvature-comb demonstrations cited in Hackernoon 2016, verified by reverse-engineering with zero-pixel error — liamrosenfeld.com 2021].

This is the same principle Apple's Industrial Design team applies to physical product surfaces (MacBook edges, iPhone frames). The software icon shape is *software-as-hardware* — a deliberate unification of material language across the full product ecosystem. [documented in Apple design communications cited in HackerNoon analysis]

### Why a system symbol library (SF Symbols)

Before SF Symbols (introduced WWDC 2019), each app team drew its own inline icons, producing weight-mismatch against San Francisco text. SF Symbols solves this at the type-system level: every symbol is constructed from the same stroke vocabulary as SF font, ships in nine weights, three scales, and automatically aligns to the text baseline in any Dynamic Type size. [documented, Apple WWDC 2019 session 206]

---

## 2. Apple Specifics

### 2a. The Squircle Shape — Mathematics

#### What it is NOT

A superellipse with n=4 (the classic Lamé squircle equation `|x/a|^n + |y/b|^n = 1`) produces a visually similar shape but **does not match Apple's path**. Multiple researchers tested n=4, n=5, n=5.2 and found residual pixel error versus Apple's actual mask. [observed, liamrosenfeld.com 2021 reverse-engineering study]

#### What it actually is — "continuous rounded rectangle"

Apple's path is best described as a *continuous rounded rectangle* constructed with cubic Bézier splines whose control-point ratios create G2 (curvature-continuous) corner transitions. Liam Rosenfeld reverse-engineered the macOS icon mask from Apple's shipped `.icns` file and achieved **zero pixel error** using a corner radius of exactly 45% of the half-width, with control-point offsets (normalised to 1.0 = corner radius) of: `1.528665, 1.088493, 0.868407, 0.631494, 0.374824, 0.169060, 0.074911`. [observed/documented, liamrosenfeld.com]

These ratios are applied symmetrically per quadrant. The resulting shape is sometimes characterised as Figma's "corner smoothing 60%" applied to a ~22% `border-radius`. [observed approximation]

#### Corner radius percentage (platform reference)

| Platform | Canvas | Icon shape | Corner radius | Approx % of shape width |
|---|---|---|---|---|
| iOS (all) | system-applied mask | full bleed | ~22.37% of width | ~22% [observed community measurement] |
| macOS (Big Sur+) | 1024 × 1024 px | 824 × 824 px centered (100 px gutter each side) | 185.4 px (of 824 px) | ~22.5% [documented, Apple forums / community reverse-engineering] |

The 100 px gutter on macOS is the canvas breathing room; the mask itself follows the same proportional curvature as iOS. [documented, Apple Developer Forums thread 670578]

#### Figma approximation

In Figma, set rectangle to full canvas, `border-radius = 22%`, corner smoothing slider = **60%**. This visually matches the Apple mask at display resolution. It is an approximation; the exact Bézier control points differ. [observed, Figma community]

---

### 2b. iOS App Icon Grid

Apple published a design grid (retrievable from WWDC 2017 session 822 PDF, page 55) derived from golden-ratio and root-two proportions. Apple does NOT publish exact pixel measurements as an open spec, but community analysis and the vector grid reveal: [documented source: WWDC 2017 session 822; measurements inferred from community grid analysis]

| Grid element | Approximate size (relative to 1024 canvas) |
|---|---|
| Full canvas | 1024 × 1024 px |
| Primary circle (keyline) | ~820 px diameter (~80% of canvas) |
| Square keyline | ~740 × 740 px |
| Portrait rectangle keyline | ~560 × 740 px |
| Landscape rectangle keyline | ~740 × 560 px |
| Safe zone / content margin | ~10% from each edge (~100 px) |
| Optical centre | Slightly above geometric centre |

**Key design rule:** Visual mass should be optically centred. Round forms need to extend slightly beyond the keyline circle to feel equal in weight to square forms. This is Gestalt correction for the "circle appears smaller than same-area square" illusion. [documented in Material Design keylines doc and HIG; principle is cross-platform standard]

**Icon delivery spec (iOS 26 / current):**
- Single 1024 × 1024 px PNG, fully opaque (no transparency — system applies mask)
- Color space: sRGB or Display P3
- No embedded effects (shadows, corner rounding, gloss) — system handles all of this

---

### 2c. iOS 26 Liquid Glass App Icon Treatment

Introduced at WWDC 2025. This is the largest icon visual overhaul since iOS 7. [documented, Apple Newsroom June 2025]

#### Architecture: multi-layer composition

Instead of a single flat PNG, icons are now built as layered compositions inside **Icon Composer** (Xcode → Open Developer Tool → Icon Composer). [documented, MobileAction / Apple toolchain 2025]

| Layer | Role |
|---|---|
| Background | Low-contrast backdrop; receives translucency/blur to pick up wallpaper colours |
| Mid-layers (optional) | Depth elements |
| Foreground | Primary symbol / brand mark; **must be opaque** across all variants |
| Accents (optional) | Highlights or secondary graphic elements |

#### Six appearance variants

| Variant | Characteristic |
|---|---|
| Default Light | Starting point; opaque palette |
| Default Dark | Darker background tones |
| Clear Light | High translucency; wallpaper shows through background layer |
| Clear Dark | High translucency + dark cast |
| Tinted Light | Elevated opacity, system tint colour applied |
| Tinted Dark | Elevated opacity tint + dark |

Design rule: **start in Default Light, then adjust** per variant. Silhouette identical across all six; only background treatment changes. Supply all six in Icon Composer. [documented, Apple Icon Composer tooling 2025]

#### Liquid Glass material parameters (in Icon Composer)

| Parameter | Purpose | Guidance |
|---|---|---|
| Specular | Glass-like highlight reflections | Keep enabled for native look |
| Blur | Frosted texture | Adjust slightly per design |
| Translucency | Background layer opacity | Apply primarily to background; keep foreground opaque |

**Do NOT bake in:** drop shadows, border glow, reflections, or corner masks. The system renders all of these. [documented]

#### Foreground design rules

- Bold, high-contrast primary shape
- Avoid thin elements near the mask edge (clipping risk)
- Keep essential shapes inside central ~70% of canvas
- Opaque in all appearance modes

#### Export format

`.iconset` multilayer file via Icon Composer → Xcode asset catalog. iOS, iPadOS, macOS (Tahoe) all support this format. tvOS and visionOS retain the traditional AppIcon catalog approach. [documented 2025]

---

### 2d. macOS Icon Style

macOS icons sit on a *visible* squircle background — designers draw the canvas content including the background, unlike iOS where iOS applies the mask over your image. The macOS icon drop shadow specification [documented/community reverse-engineered]:

- Shadow blur: 28 px
- Shadow Y-offset: 12 px downward
- Shadow color: black, 50% opacity
- Perspective tilt: slight forward-lean (3D effect)

macOS icons may show rich depth, lighting gradients, and materials as the system does **not** apply automatic Liquid Glass layering (the Liquid Glass treatment is primarily a Home Screen / iOS / iPadOS feature). [inferred from toolchain; macOS Tahoe details as of 2025 beta]

---

### 2e. SF Symbols — Library

**Current version:** SF Symbols 7 (WWDC 2025). Library size: **6,900+ symbols**. [documented, Apple WWDC25 session 337]

Previously: SF Symbols 6 (WWDC 2024) introduced Wiggle, Rotate, Breathe animations. SF Symbols 5 introduced variable color. This document covers the cumulative current state.

#### Weights — 9 levels

All parallel San Francisco font weight vocabulary:

`Ultralight` → `Thin` → `Light` → `Regular` → `Medium` → `Semibold` → `Bold` → `Heavy` → `Black`

SwiftUI weight modifier on `Image(systemName:)` automatically matches the weight of surrounding text when used inline. Always match symbol weight to adjacent text weight; mismatches read as typographic noise. [documented, Apple HIG SF Symbols]

Symbols are constructed from **outlined filled paths**, not stroked paths. This gives the designer precise control over stroke-end shapes and interior counter proportions at every weight. [documented, WWDC25 session 337]

#### Scales — 3 levels

`small` / `medium` (default) / `large`

Scales adjust optical size independently of point size — useful for placing a symbol alongside body text (medium) vs. as a decorative element (large). All three scales share the same weight and align to the text baseline. [documented, Apple HIG]

#### Rendering Modes — 4 modes

| Mode | Behaviour | Best for |
|---|---|---|
| **Monochrome** | Single flat colour | Icon buttons, toolbars, any context needing colour control |
| **Hierarchical** | Single hue, multi-opacity layers (primary / secondary / tertiary) | Depth without colour complexity |
| **Palette** | 2–3 independently specified colours mapped to layers | Branded icons, coloured states |
| **Multicolor** | Fixed semantic colours baked by Apple (e.g. folder = blue, heart = red) | Communication/notification contexts |

New in SF Symbols 7: **Gradient** rendering — a linear gradient is generated from a single source colour, adding depth/lighting simulation. Particularly effective at large sizes. [documented, WWDC25 session 337]

**Default priority:** The system picks a rendering mode in this order: Multicolor (if symbol supports it) → Hierarchical → Monochrome. Override explicitly with `.symbolRenderingMode()`. [documented]

#### Variable Color

Applies a 0.0–1.0 value to progressively fill symbol layers (e.g. `wifi` signal bars, `cellularbars`). Works independently from rendering mode. SF Symbols 7 adds **Variable Draw**: layers render at a fractional percentage over a reduced-opacity background — useful for download progress, temperature. [documented, WWDC25 session 337]

#### Symbol Effects / Animations — Cumulative SF Symbols 5–7

| Effect | Type | Description |
|---|---|---|
| `.bounce` | Discrete | One-shot vertical spring; clears automatically |
| `.pulse` | Indefinite | Opacity oscillation; good for "active/live" state |
| `.variableColor` | Indefinite | Sequential/cumulative/iterative layer colour fill |
| `.scale` | Indefinite | Scale up/down by layer or whole symbol |
| `.appear` / `.disappear` | Indefinite | Opacity-based show/hide |
| `.replace` | Content transition | Morphs between two symbol names |
| `.wiggle` | Discrete (SF6) | Side-to-side shake |
| `.rotate` | Indefinite (SF6) | Continuous rotation |
| `.breathe` | Indefinite (SF6) | Subtle scale pulse for "recording/live" |
| `.draw.on` / `.draw.off` | Discrete + Transition (SF7) | Calligraphic path draw-in / draw-out |

**Draw animation playback modes (SF Symbols 7):**
- `.byLayer` (default) — paths stagger
- `.wholeSymbol` — all paths simultaneously
- `.individually` — each layer waits for previous to finish [documented, WWDC25 session 337]

#### Text Baseline Alignment

SF Symbols automatically cap-height-align to adjacent `Text` in a SwiftUI `HStack` or `Label`. For manual UIKit layout, use `UIImage.SymbolConfiguration(textStyle:)` to tie the symbol size to the same Dynamic Type style as the label. Never use fixed-point symbol sizes next to Dynamic Type text. [documented, Apple HIG]

---

## 3. Recipes

### 3a. CSS Continuous Squircle — Three Approaches (Web)

#### Approach A: CSS `corner-shape: squircle` (Chrome 139+ only, 2026)

```css
/* Progressive enhancement — falls back gracefully */
.icon-squircle {
  border-radius: 22%;
  /* Baseline: decent rounded rect in all browsers */
}

@supports (corner-shape: bevel) {
  .icon-squircle {
    border-radius: 22%;
    corner-shape: squircle; /* True continuous curvature — Chrome 139+ */
  }
}
```

Use `@supports (corner-shape: bevel)` as the feature-detect (the spec uses `bevel` as the test keyword). Not yet supported in Safari or Firefox as of May 2026. [documented, Smashing Magazine March 2026]

---

#### Approach B: SVG `clipPath` with `objectBoundingBox` (all browsers)

Embed once in HTML (e.g., `<body>` or hidden `<svg>` at the root), then apply via CSS:

```html
<!-- Hidden SVG — place once in document -->
<svg width="0" height="0" style="position:absolute">
  <defs>
    <clipPath id="squircle" clipPathUnits="objectBoundingBox">
      <!-- 
        Cubic Bézier approximation of a continuous rounded rect.
        All coordinates are 0–1 (objectBoundingBox units).
        Control-point pairs produce G2 continuous corners.
        Equivalent to ~22% corner radius + 60% smoothing.
      -->
      <path d="
        M 0.500,0.000
        C 0.726,0.000 0.860,0.000 0.933,0.073
        S 1.000,0.274 1.000,0.500
        S 1.000,0.726 0.933,0.800
        S 0.726,1.000 0.500,1.000
        S 0.274,1.000 0.200,0.933
        S 0.000,0.726 0.000,0.500
        S 0.000,0.274 0.067,0.200
        S 0.274,0.000 0.500,0.000 Z
      "/>
    </clipPath>
  </defs>
</svg>
```

```css
.squircle {
  clip-path: url(#squircle);
}

/* IMPORTANT: clip-path clips box-shadow.
   Use filter: drop-shadow() instead. */
.squircle-shadow {
  filter: drop-shadow(0 4px 12px rgba(0,0,0,0.18));
}
```

**Limitation:** The SVG path above is a cubic Bézier approximation — it is visually close but not mathematically identical to Apple's exact control-point ratios. For pixel-perfect reproduction, generate path coordinates from the Rosenfeld constants (see §5). [inferred — exact path requires JS generation or pre-computed points]

**Responsive:** `clipPathUnits="objectBoundingBox"` makes the clip path scale with the element. No JS needed for fixed aspect-ratio icons. [documented, MDN]

---

#### Approach C: CSS `clip-path: shape()` — Modern, pure CSS, no SVG file (Chrome 137+)

```css
.squircle {
  --r: 22%; /* Corner displacement — tune to taste */
  clip-path: shape(
    from 0 var(--r),
    curve to var(--r) 0
      with 0 0 / 0 0,
    hline to calc(100% - var(--r)),
    curve to 100% var(--r)
      with 100% 0 / 100% 0,
    vline to calc(100% - var(--r)),
    curve to calc(100% - var(--r)) 100%
      with 100% 100% / 100% 100%,
    hline to var(--r),
    curve to 0 calc(100% - var(--r))
      with 0 100% / 0 100%,
    close
  );
}
```

This approach produces the characteristic smooth-corner look using CSS `shape()`. It does not require an SVG element or JavaScript. The curvature is a bevel-approximation of the superellipse, not the full multi-control-point G2 curve — visually convincing at icon sizes. [documented, gist.github.com/pouyakary]

---

#### Approach D: JavaScript + SVG path generation (accurate, npm)

For production use requiring high accuracy, use the `squircle.js` library or `html-squircle` package:

```js
// html-squircle (npm i html-squircle)
import { getSquirclePath } from 'html-squircle';

const el = document.querySelector('.icon');
const { width, height } = el.getBoundingClientRect();
const path = getSquirclePath({ width, height, cornerRadius: 0.4472 });
// cornerRadius 0.4472 ≈ 44.72% of half-dimension = ~22.37% of full width

el.style.clipPath = `path('${path}')`;

// Regenerate on resize:
new ResizeObserver(() => { /* re-run above */ }).observe(el);
```

Note: `clip-path: path()` (unlike `url(#clipPath)`) does **not** auto-scale. Use `ResizeObserver` or the SVG `objectBoundingBox` approach for responsive icons. [documented, squircle.js library docs]

---

### 3b. Icon Grid Template (HTML/CSS — 1024px reference canvas)

```html
<!-- Reference-only: shows keyline circles for icon design review -->
<div class="icon-canvas" aria-hidden="true">
  <div class="keyline keyline--circle"></div>
  <div class="keyline keyline--square"></div>
  <div class="icon-art"><!-- your icon artwork --></div>
</div>
```

```css
:root {
  --canvas: 1024px;
  --icon-circle: 820px;   /* ~80% of canvas — primary keyline */
  --icon-square: 740px;   /* ~72% of canvas */
  --safe-inset: 10%;      /* ~100px each side — keep art inside this */
}

.icon-canvas {
  position: relative;
  width: var(--canvas);
  height: var(--canvas);
  background: #f0f0f0;
  display: grid;
  place-items: center;
}

.keyline {
  position: absolute;
  border: 1px dashed rgba(0,0,255,0.3);
  border-radius: 50%;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.keyline--circle {
  width: var(--icon-circle);
  height: var(--icon-circle);
}

.keyline--square {
  width: var(--icon-square);
  height: var(--icon-square);
  border-radius: 0; /* square keyline */
}

.icon-art {
  width: 100%;
  height: 100%;
  /* Apply squircle clip-path here for preview */
  clip-path: url(#squircle);
}
```

---

### 3c. SwiftUI — SF Symbols Complete Recipe

```swift
import SwiftUI

struct SymbolShowcase: View {
  @State private var bounceCount = 0
  @State private var isActive = true
  @State private var signalStrength: Double = 0.6
  @State private var showHeart = true

  var body: some View {
    VStack(spacing: 24) {

      // 1. Hierarchical rendering — single hue, layered opacity
      Image(systemName: "moon.stars.fill")
        .symbolRenderingMode(.hierarchical)
        .foregroundStyle(.indigo)
        .font(.system(size: 64))

      // 2. Palette rendering — explicit per-layer colours
      Image(systemName: "person.3.sequence.fill")
        .symbolRenderingMode(.palette)
        .foregroundStyle(.blue, .teal, .cyan)
        .font(.system(size: 64))

      // 3. Multicolor — fixed semantic Apple colours
      Image(systemName: "folder.fill.badge.plus")
        .symbolRenderingMode(.multicolor)
        .font(.system(size: 64))

      // 4. Variable color — 0.0–1.0 progressive fill
      Image(systemName: "wifi", variableValue: signalStrength)
        .font(.system(size: 64))
      Slider(value: $signalStrength)

      // 5. Gradient rendering (SF Symbols 7)
      Image(systemName: "flame.fill")
        .symbolRenderingMode(.hierarchical)  // gradient works with all modes
        // Note: .gradient rendering mode is specified via SymbolConfiguration
        // in UIKit; in SwiftUI use hierarchical + foregroundStyle gradient
        .foregroundStyle(
          LinearGradient(colors: [.orange, .red],
                         startPoint: .bottom, endPoint: .top)
        )
        .font(.system(size: 64))

      // 6. Weight matching text
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Image(systemName: "checkmark")
          .font(.system(.body, weight: .semibold))  // matches text weight
        Text("Completed")
          .font(.system(.body, weight: .semibold))
      }

      // 7. Scale variation
      HStack {
        Image(systemName: "star.fill").imageScale(.small)
        Image(systemName: "star.fill").imageScale(.medium)
        Image(systemName: "star.fill").imageScale(.large)
      }
      .font(.title)

      // 8. Bounce (discrete — value-triggered)
      Image(systemName: "cart.fill.badge.plus")
        .symbolEffect(.bounce, value: bounceCount)
        .font(.system(size: 48))
        .onTapGesture { bounceCount += 1 }

      // 9. Pulse (indefinite — continues while isActive)
      Image(systemName: "dot.radiowaves.left.and.right")
        .symbolEffect(.pulse, isActive: isActive)
        .font(.system(size: 48))

      // 10. Variable color iterative (indefinite)
      Image(systemName: "waveform")
        .symbolEffect(.variableColor.iterative.reversing)
        .font(.system(size: 48))

      // 11. Wiggle (discrete — SF Symbols 6)
      Image(systemName: "bell.fill")
        .symbolEffect(.wiggle, value: bounceCount)
        .font(.system(size: 48))

      // 12. Breathe (indefinite — recording state)
      Image(systemName: "record.circle")
        .symbolEffect(.breathe, isActive: isActive)
        .font(.system(size: 48))

      // 13. Replace / content transition between symbols
      Image(systemName: showHeart ? "heart.fill" : "heart")
        .contentTransition(.symbolEffect(.replace.offUp))
        .font(.system(size: 48))
        .onTapGesture { showHeart.toggle() }

      // 14. Draw On / Off (SF Symbols 7) — calligraphic entrance
      if isActive {
        Image(systemName: "wind")
          .transition(.symbolEffect(.drawOn))
          .font(.system(size: 48))
      }

      // 15. Symbol variant + content transition
      Image(systemName: "bell")
        .symbolVariant(isActive ? .none : .slash)
        .contentTransition(.symbolEffect)
        .font(.system(size: 48))
        .onTapGesture { isActive.toggle() }

    }
    .padding()
  }
}
```

---

### 3d. UIKit — SF Symbols with SymbolConfiguration

```swift
// Weight + scale + rendering mode (UIKit)
let config = UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold, scale: .large)
  .applying(UIImage.SymbolConfiguration(paletteColors: [.systemBlue, .systemTeal]))

let imageView = UIImageView(image: UIImage(systemName: "person.fill.badge.plus",
                                           withConfiguration: config))

// Adding a symbol effect (iOS 17+)
imageView.addSymbolEffect(.bounce)
imageView.addSymbolEffect(.pulse.byLayer)

// Draw On (iOS 26 / SF Symbols 7)
imageView.addSymbolEffect(.draw.on)
```

---

## 4. Faithful Replication on Web

### Producing a credible squircle icon badge (web)

The goal is to match an iOS-style icon appearance without native APIs.

**Step 1 — Shape.** Use Approach C (CSS `shape()`) for Chrome-first products or Approach B (SVG `clipPath`) for cross-browser. Avoid plain `border-radius` — it will look noticeably blockier at display size. [observed at ≥100px icon size]

**Step 2 — Size discipline.** Use `22%` as your border-radius equivalent, not `50%` (circle) and not `10–15%` (generic card). The `22%` value maps to Apple's measured ratio. [observed, community reverse-engineering]

**Step 3 — Shadows.** Clip-path clips `box-shadow`. Route all shadows through `filter: drop-shadow()`:

```css
.app-icon {
  /* shape via clip-path (see §3a) */
  filter: drop-shadow(0 8px 24px rgba(0,0,0,0.20))
          drop-shadow(0 2px 4px rgba(0,0,0,0.12));
}
```

**Step 4 — SF Symbol–style iconography on web.** The SF Symbols font is Apple proprietary and not licensed for web use. Credible alternatives:

| Alternative | Notes |
|---|---|
| [Phosphor Icons](https://phosphoricons.com) | 9 weights, stroke-path system similar to SF Symbols concept |
| [Lucide](https://lucide.dev) | Consistent stroke vocabulary, good weight discipline |
| Custom SVG | Use 2px stroke on 24px canvas, consistent terminal style (round or butt), export outlined at each needed weight |

**Step 5 — Weight matching.** If body text is `font-weight: 400`, use a `Regular` equivalent icon stroke. At `font-weight: 600`, use `Semibold` / heavier stroke. Visual harmony collapses when icon stroke weight diverges from text weight. [observed in Apple HIG guidance]

**Step 6 — Liquid Glass on web.** A CSS approximation of the iOS 26 background layer:

```css
.icon-glass-bg {
  /* Simulate the frosted background layer */
  background: rgba(255, 255, 255, 0.45);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);

  /* Specular top highlight — mimics glass refraction edge */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.70),  /* top specular */
    inset 0 -1px 0 rgba(0,0,0,0.06),       /* bottom depth */
    0 8px 32px rgba(0,0,0,0.18);           /* ambient shadow */

  /* Squircle shape */
  border-radius: 22%;
  corner-shape: squircle; /* Chrome 139+ */
}
```

Note: `backdrop-filter` requires a real composited layer behind the element; on a plain white background, the frosted effect will not be visible. [documented, MDN]

---

## 5. Anti-Patterns

### 5.1 `border-radius: 20%` without corner smoothing [high priority]

Simple circular rounded rectangles have a G1 curvature discontinuity. At large sizes (64px+) on high-DPI screens, the corner kink is perceptible. **Fix:** Add `corner-shape: squircle` for Chrome, or use SVG `clipPath`. Even Figma's 60% corner smoothing slider is preferable to none.

### 5.2 Mismatched symbol weight vs. text weight

Using a `Regular` symbol next to `Bold` text (or vice versa) creates visual inconsistency — one element fights the other for weight. **Fix:** Match weights explicitly: `Image(systemName:).font(.system(.body, weight: .bold))` when adjacent to bold text.

### 5.3 Multicolor rendering everywhere

Multicolor symbols have Apple-defined fixed colours. Overusing them in a custom-branded interface creates a generic / system-default feel. **Fix:** Use palette mode for branded contexts where you need colour control; reserve multicolor for genuinely semantic/communication contexts (e.g., status indicators).

### 5.4 Wrong icon scale for context

Using `.imageScale(.large)` for a symbol inline with body text inflates it above the cap height and pushes text down. **Fix:** Use `.imageScale(.medium)` (default) for inline/body contexts; `.large` only for standalone or display-size usage.

### 5.5 Baking effects into icon artwork

Adding a drop shadow, corner mask, or gloss gradient inside your icon image means it will look wrong when the system renders its own mask, shadow, or Liquid Glass treatment. **Fix:** Submit a flat opaque 1024×1024 PNG; let iOS do its compositing.

### 5.6 Ignoring the safe zone

Placing key elements within 10% of the canvas edge risks clipping under the system squircle mask, especially on older iOS versions with a slightly tighter mask. **Fix:** Keep all essential visual content inside the central ~820×820 region of the 1024×1024 canvas.

### 5.7 Using SF Symbols font files on the web

SF Pro and SF Symbols are Apple-proprietary; redistribution on the web is a licence violation. **Fix:** Use an open-weight icon system (Phosphor, Lucide, Heroicons) and apply the same weight-matching discipline.

### 5.8 Fixed pixel symbol sizes next to Dynamic Type

Hard-coding `font(.system(size: 22))` for symbols next to Dynamic Type text means symbols don't scale when the user increases text size, breaking accessibility. **Fix:** Always tie symbol size to a text style: `.font(.system(.body))` or `.font(.title)`.

### 5.9 Variable Color on non-supporting symbols

Not all symbols support variable color. Applying `variableValue:` to a non-supporting symbol has no visual effect and can confuse future maintainers. **Fix:** Check support in the SF Symbols app by looking for the variable-color preview in the inspector panel before shipping.

### 5.10 `clip-path` with `box-shadow` on squircle

`clip-path` clips the box-shadow along with the element — resulting in no shadow. **Fix:** Use `filter: drop-shadow()` instead, or wrap the element in a container that has the shadow without the clip-path.

---

## 6. Sources

| Source | Type | Notes |
|---|---|---|
| [HIG: App Icons — Apple Developer](https://developer.apple.com/design/human-interface-guidelines/app-icons) | Official | Master spec for icon sizes, format, Liquid Glass guidance |
| [HIG: SF Symbols — Apple Developer](https://developer.apple.com/design/human-interface-guidelines/sf-symbols) | Official | Rendering modes, weights, scales, baseline alignment |
| [SF Symbols — Apple Developer](https://developer.apple.com/sf-symbols/) | Official | Library download, symbol browser |
| [What's new in SF Symbols 7 — WWDC25 session 337](https://developer.apple.com/videos/play/wwdc2025/337/) | Official | Draw animations, Variable Draw, gradients, 6,900+ symbols |
| [What's new in SF Symbols 6 — WWDC24 session 10188](https://developer.apple.com/videos/play/wwdc2024/10188/) | Official | Wiggle, Rotate, Breathe animations |
| [My Quest for the Apple Icon Shape — Liam Rosenfeld](https://liamrosenfeld.com/posts/apple_icon_quest/) | Community / observed | Zero-error reverse-engineering of macOS mask Bézier constants |
| [How Apple Uses Squircles in iOS Design — Squircle.js](https://squircle.js.org/blog/squircles-in-apple-design) | Community | 22.37% corner radius, 60% smoothing parameter |
| [Squircles: Bringing iOS 7's Solution to Rounded Rectangles to CSS — Medium/zubryjs](https://medium.com/@zubryjs/squircles-bringing-ios-7s-solution-to-rounded-rectangles-to-css-9fc35779aa65) | Community | Parametric JS squircle formula, LESS mixin CSS implementation |
| [Apple's Icons Have That Shape for a Very Good Reason — HackerNoon](https://hackernoon.com/apples-icons-have-that-shape-for-a-very-good-reason-720d4e7c8a14) | Community | Curvature-continuity design rationale; industrial design context |
| [Beyond border-radius: CSS corner-shape — Smashing Magazine, March 2026](https://www.smashingmagazine.com/2026/03/beyond-border-radius-css-corner-shape-property-ui/) | Web standards | corner-shape: squircle; Chrome 139+ status; @supports pattern |
| [Responsive Squircles with SVG — Simeon Griggs](https://www.simeongriggs.dev/responsive-extendable-squircles-with-svg-and-css) | Community | objectBoundingBox SVG clip-path approach |
| [CSS Clip-Path shape() Squircle — gist/pouyakary](https://gist.github.com/pouyakary/136fafc75a14abd867e0100856add5a0) | Community | Pure CSS shape() implementation |
| [WWDC 2025 SF Symbols 7 — DEV Community](https://dev.to/arshtechpro/wwdc-2025-sf-symbols-7-advanced-animation-and-rendering-techniques-f7m) | Community summary | Draw On/Off mechanics, Variable Draw, Magic Replace |
| [iOS 26 Liquid Glass — MobileAction](https://www.mobileaction.co/blog/apple-liquid-glass-design/) | Community | Layer architecture, Icon Composer workflow, 6-variant system |
| [iOS 26 Liquid Glass SwiftUI Reference — Medium/madebyluddy](https://medium.com/@madebyluddy/overview-37b3685227aa) | Community | glassEffect() API, .tint(), GlassEffectContainer, .interactive() |
| [Animating SF Symbols in SwiftUI — nilcoalescing.com](https://nilcoalescing.com/blog/AnimatingSFSymbolsInSwiftUI/) | Community | symbolEffect code patterns, breathe/variableColor/replace |
| [SF Symbols — mvolkmann.github.io](https://mvolkmann.github.io/blog/swift/SFSymbols/) | Community reference | Rendering mode code, variable color, all effect types |
| [Apple Developer Forums — iOS App Icon Grid Geometric Specs](https://developer.apple.com/forums/thread/660441) | Official forum | WWDC 2017 session 822 PDF reference; community grid notes |
| [Icon Grids & Keylines Demystified — Helena Zhang / Medium](https://minoraxis.medium.com/icon-grids-keylines-demystified-5a228fe08cfd) | Community | Cross-platform keyline comparison; golden ratio construction note |
| [Apple Design Resources](https://developer.apple.com/design/resources/) | Official | Sketch/Figma templates, SF Symbols app download |

---

**CONFIDENCE: 72% — Core squircle mathematics, SF Symbols weights/modes/effects, and Liquid Glass layer architecture are well-sourced; exact icon grid pixel measurements and macOS Tahoe Liquid Glass icon behaviour are partly inferred from community reverse-engineering and beta-era reporting rather than fully-shipped official documentation.**
