# Apple Materials & Liquid Glass — Design Language Reference
**Scope:** Comprehensive technical reference for Apple's translucency material system, culminating in the Liquid Glass design language (iOS/iPadOS/macOS/watchOS 26+, WWDC25). Covers native principles, SwiftUI APIs, and the web-reproducible subset.

---

## Principles

### Why Translucency Creates Hierarchy and Spatial Sense

Translucent materials solve a fundamental UI layering problem: they communicate *depth and relationship* without hard visual breaks. When a surface is partially see-through, the human visual system instantly understands it as *floating above* whatever is behind it. [documented]

Apple's long-standing rationale (HIG > Materials):

- **Depth without separation.** A frosted surface keeps the user spatially oriented — they can see the content below is still there, they're just operating at a higher layer (navigation, toolbars). This reduces cognitive load from context switching. [documented]
- **Hierarchy from material, not color.** Navigation lives on glass; content lives beneath. You don't need a solid dark bar killing the wallpaper; the material itself signals "this is controls, that is content." [documented]
- **Vibrancy as depth cue.** Vibrancy pulls hue from behind the blur surface and pushes it forward into labels and icons. The result: text adapts its luminosity to whatever is scrolling under it, reading as consistently legible without hard-coded dark/light values. [documented]
- **Living background = living interface.** Materials sample in real-time, so as content scrolls or wallpaper shifts, the chrome visually *reacts*. The interface feels grounded in the same temporal moment as the user's content — not painted over it. [documented]

### The Blur–Vibrancy–Material Stack

The prior system (iOS 7–18) used a three-layer mental model [documented]:

```
[ Foreground content (text, icons)  ]  ← Vibrancy applied here
[ Material surface (blur + tint)    ]  ← Backdrop blur + rgba tint
[ Background content / wallpaper    ]  ← Source pixels sampled
```

Blur defocuses the background, giving the material layer distinctness. Vibrancy re-introduces a filtered echo of the background color *into* the foreground layer, creating coherence instead of opacity-flatness.

### Liquid Glass: Refraction over Scattering

Liquid Glass (2025) replaces the "scatter/diffuse" metaphor of frosted glass with a "bend/concentrate" metaphor of optically curved glass. [documented]

The shift matters conceptually:
- **Old frosted glass:** blur destroys structure, turns background into a color wash.
- **Liquid Glass:** the surface *refracts* — it bends the background image like a curved lens, preserving structure while adding distortion. You see *recognizable* content through it, just warped at edges. [documented — Apple WWDC25 session 219]

This is why Apple describes the primary mechanism as **lensing**: the material acts like a physical lens, concentrating and bending light rather than scattering it. [documented]

---

## Apple Specifics

### Prior Material System (iOS 7–18) — The Lineage

Understanding the pre-Liquid Glass vocabulary matters because these concepts are still architecturally present underneath Liquid Glass. [documented]

**System Materials (UIBlurEffect.Style / SwiftUI .background(.thinMaterial) etc.):**

| Name | Approximate opacity | Use case | Notes |
|------|-------------------|----------|-------|
| `.ultraThinMaterial` | ~5–10% tint, heaviest blur | Sheets, headers that need to recede | Least opaque, most "airy" [inferred from visual behavior; Apple doesn't publish exact values] |
| `.thinMaterial` | ~10–15% tint | Sidebars, overlays | [inferred] |
| `.regularMaterial` | ~20–25% tint | Default system chrome | Most common; tab bars, alerts [documented] |
| `.thickMaterial` | ~30–40% tint | High-contrast contexts | Rarely needed; overrides vibrancy weight [inferred] |
| `.chromeMaterial` | Opaque or near-opaque | Navigation bars (legacy style) | Designed to completely separate layers [documented] |

**Blur radius:** Apple does not publish specific pixel values for system materials [documented — no official spec]. Third-party reverse-engineering [inferred] estimates range roughly from **10–40 px equivalent** at 3× scale, with ultraThin toward the lower end and thick toward the higher end. Do not hardcode these.

**Vibrancy effects** (applied to foreground content, not the blur layer itself):

- `.label`, `.secondaryLabel`, `.tertiaryLabel`, `.quaternaryLabel` — hierarchy of vibrancy-tinted fills for text [documented — HIG]
- `.fill`, `.secondaryFill`, `.tertiaryFill` — for non-text shapes
- Each pulls hue from behind the material and applies luminosity correction, so the label reads legibly on any background the material might be placed over [documented]

**Light vs Dark variants:** Every system material has automatic light and dark appearances. Light mode materials use a white-tint fill; dark mode uses a near-black tint. Vibrancy adjusts accordingly. [documented]

**Adaptivity — Reduce Transparency:** When the user enables Settings → Accessibility → Reduce Transparency, all materials fall back to their opaque or near-opaque equivalents. The system handles this automatically; developers only need to avoid fighting the fallback by hardcoding colors. [documented]

---

### Liquid Glass (iOS/iPadOS/macOS/watchOS 26, 2025)

**Announced:** WWDC25, June 9 2025. Session 219 "Meet Liquid Glass", Session 356 "Get to know the new design system". [documented]

**Platform coverage:** iOS 26, iPadOS 26, macOS Tahoe 26, watchOS 26, tvOS 26. [documented — Apple Newsroom]

**Minimum hardware:** iPhone 11 or later (Apple GPU with sufficient compute for real-time lensing). Xcode 26+ required to compile. [documented]

#### Core Visual Layers

Liquid Glass is composed of at least three conceptual render layers [documented — WWDC25 session 219, inferred layering from descriptions]:

1. **Lensing / Refraction layer.** The GPU warps background pixels through a curved-glass simulation, bending them near the shape edges. This produces the "lens edge" look — background content visibly shifts at the boundary of the material. [documented]
2. **Specular / Highlight layer.** A geometry-responsive highlight moves around the shape in response to (a) device tilt (gyroscope/accelerometer input), (b) interaction state (touch, focus), and (c) surrounding content brightness. Highlights travel along the silhouette edge on transitions like lock/unlock. [documented]
3. **Shadow / Grounding layer.** Opacity adapts dynamically: shadow increases when material passes over text (needs separation), decreases over solid light areas (less needed). [documented]

Combined, these simulate a glass object that is simultaneously *present* (you see the object shape via highlight + shadow) and *transparent* (background content refracts through it).

#### Material Variants

| Variant | Behavior | When to use |
|---------|----------|-------------|
| `.regular` (default) | All adaptive behaviors active. Automatic light↔dark flip for small elements. Content-aware shadow. | Navigation layer: toolbars, tab bars, sidebars, buttons, menus. **Default choice.** [documented] |
| `.clear` | Permanently more transparent. No adaptive behavior. Requires a dimming layer for legibility. | Only when: (1) over media-rich content, (2) content layer tolerates a dimming overlay, (3) foreground content is bold + bright. Never mix with `.regular`. [documented] |
| `.identity` | Disables the glass effect. Same as no glass. | Use with `isEnabled: Bool` parameter for conditional toggling (e.g. accessibility fallback). [documented] |

#### Sizing / Thickness Behavior

As the glass element grows in size, the rendering adapts to simulate a physically thicker slab [documented — WWDC25 session 219]:
- Deeper, richer drop shadows
- More pronounced lensing and refraction effects at edges
- Softer, wider light scattering

Small controls (buttons, chips) simulate thin glass wafers. Large surfaces (sidebars, sheets) simulate thick glass panes. This is automatic — developers do not configure it manually. [documented]

#### Adaptive Light/Dark Behavior

- **Small elements** (symbols, glyphs, nav bars, tab bars): automatically flip between light and dark appearance based on background brightness. Glass and its content content-items stay in sync. [documented]
- **Large elements** (menus, sidebars): do NOT flip light↔dark — would be visually distracting at scale. Instead, they adjust tint, shadow, and dynamic range subtly. [documented]

#### Tinting

Glass can be tinted with a color. The tinting algorithm:
- Maps the tint hue through the glass material's brightness range
- Changes hue, brightness, and saturation to blend with underlying content
- Maintains legibility and contrast [documented — WWDC25 session 219]

Rules: tint only **primary actions** (e.g., a "Buy Now" button). Do not tint all elements — you lose visual hierarchy. Use `.buttonStyle(.glassProminent)` + `.tint(.blue)` for the primary-action pattern. [documented]

#### Interaction Response

On touch, the material **illuminates from within**: a glow starts at the fingertip contact point and spreads outward. The spread reaches neighboring Liquid Glass elements in the same `GlassEffectContainer`, so a tab-bar tap shimmers across the whole bar. This is automatic with `.regular.interactive()`. [documented — WWDC25 session 219]

Elements can **morph fluidly** between states using `glassEffectID(_:in:)` + shared `@Namespace`. Two buttons can animate into a single pill and back; the glass surface stretches gel-like between states. [documented]

#### Where Liquid Glass Applies — Platform Map

**iOS 26:**
- Tab bars (shrink on scroll to expose content) [documented]
- Navigation bars / toolbars
- Lock Screen time numerals (dynamically scales)
- Home Screen dock, icons (multi-layer glass), widgets
- Notifications, Control Center, sheets, popovers, menus
- Floating action buttons

**iPadOS 26:**
- Floating sidebars + tab bars (single unified navigation surface) [documented]
- Same controls as iOS

**macOS Tahoe 26:**
- Floating sidebars + toolbars
- Menu bar (transparent, expands perceived display space)
- Window focus/unfocus: glass recedes visually when window loses focus (important spatial cue) [documented]

**watchOS 26:**
- Controls and navigation chrome

**visionOS:**
- Liquid Glass vocabulary echoes visionOS's layered spatial materials (pre-existing depth metaphors informed its design) [documented — Apple stated lineage]

#### Accessibility Adaptations (Automatic)

| Setting | Effect |
|---------|--------|
| Reduce Transparency | Glass becomes "frostier" — more opaque, obscures background more [documented] |
| Increase Contrast | Elements become predominantly black or white, with contrasting border ring [documented] |
| Reduce Motion | Elastic/spring properties disabled; effect intensity reduced [documented] |

In iOS 26.1+, an additional Settings → Display & Brightness → Liquid Glass opacity slider gives users direct control. [documented — reported in developer community]

---

## Recipes

### Recipe 1 — CSS Best-Effort Glass Panel (Static, No Refraction)

This replicates: frosted translucency, light tint, specular highlight via pseudo-element, light-edge border, grounding shadow.

```css
/* ─── Liquid Glass approximation — static frosted version ─── */
.glass-panel {
  position: relative;
  /* Frosted fill */
  background: rgba(255, 255, 255, 0.18);
  /* Core blur + saturation boost to simulate vibrancy */
  backdrop-filter: blur(20px) saturate(180%) brightness(105%);
  -webkit-backdrop-filter: blur(20px) saturate(180%) brightness(105%);
  /* Shape */
  border-radius: 20px;
  /* Light-edge border: top/left lighter, bottom/right subtler */
  border: 1px solid rgba(255, 255, 255, 0.55);
  /* Grounding shadow + inner warmth */
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.12),      /* drop shadow */
    0 2px 8px rgba(0, 0, 0, 0.06),       /* tight grounding */
    inset 0 1px 0 rgba(255, 255, 255, 0.6); /* top-edge specular */
  /* Prevent content bleed */
  overflow: hidden;
}

/* Dark-mode variant */
@media (prefers-color-scheme: dark) {
  .glass-panel {
    background: rgba(30, 30, 35, 0.55);
    border-color: rgba(255, 255, 255, 0.12);
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 2px 8px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
}

/* Reduce-transparency fallback — REQUIRED */
@media (prefers-reduced-transparency: reduce) {
  .glass-panel {
    background: rgba(245, 245, 247, 0.96); /* near-solid */
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: rgba(0, 0, 0, 0.12);
  }
}

/* Specular highlight arc — pseudo-element */
.glass-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  /* Radial highlight at top-left, simulating ambient light source */
  background: radial-gradient(
    ellipse 80% 40% at 30% 0%,
    rgba(255, 255, 255, 0.35) 0%,
    transparent 70%
  );
  pointer-events: none;
  z-index: 1;
}
```

**Blur radius guidance [inferred from visual matching]:**
- Minimal/thin: `blur(8px) saturate(120%)`
- Standard controls: `blur(20px) saturate(160%)`
- Heavy panel / sidebar: `blur(32px) saturate(180%)`

Going above ~40px on `backdrop-filter: blur()` gives diminishing returns and measurable GPU cost.

---

### Recipe 2 — Tinted Glass Button (Primary Action)

```css
.glass-btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 22px;
  border-radius: 9999px; /* capsule */
  font-weight: 600;
  font-size: 15px;
  color: #fff;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  /* Tinted glass fill */
  background: rgba(10, 114, 224, 0.55); /* brand blue at 55% */
  backdrop-filter: blur(16px) saturate(200%);
  -webkit-backdrop-filter: blur(16px) saturate(200%);
  border: 1px solid rgba(100, 180, 255, 0.4);
  box-shadow:
    0 4px 16px rgba(10, 114, 224, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.glass-btn-primary::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    ellipse 70% 45% at 50% -10%,
    rgba(255, 255, 255, 0.4) 0%,
    transparent 65%
  );
  pointer-events: none;
}

.glass-btn-primary:hover {
  transform: scale(1.03);
  box-shadow:
    0 6px 24px rgba(10, 114, 224, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.45);
}

.glass-btn-primary:active {
  transform: scale(0.97);
}
```

---

### Recipe 3 — SVG Displacement Map Refraction (Chrome-only, closest to Liquid Glass lensing)

This recipe uses `feDisplacementMap` via SVG filter as `backdrop-filter`. **Only works in Chromium-based browsers.** [documented]

```html
<!-- SVG filter definition (place once in DOM) -->
<svg width="0" height="0" style="position:absolute">
  <defs>
    <filter id="liquid-glass-filter" color-interpolation-filters="sRGB">
      <!-- Slight blur on source before displacement -->
      <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blurred" />
      <!-- Displacement map image (a radial gradient PNG/SVG acting as lens map) -->
      <feImage href="data:image/svg+xml,...displacementmap..." result="dmap" />
      <feDisplacementMap
        in="blurred"
        in2="dmap"
        scale="45"
        xChannelSelector="R"
        yChannelSelector="G"
        result="displaced"
      />
      <!-- Saturation boost (vibrancy-like) -->
      <feColorMatrix in="displaced" type="saturate" values="4" result="saturated" />
      <!-- Specular highlight layer -->
      <feImage href="data:image/svg+xml,...specularmap..." result="specular" />
      <feGaussianBlur in="specular" stdDeviation="1.5" result="specular_soft" />
      <feComposite in="specular_soft" in2="saturated" operator="in" result="specular_clipped" />
      <feBlend in="specular_clipped" in2="saturated" mode="screen" />
    </filter>
  </defs>
</svg>

<style>
/* Apply the SVG filter as backdrop-filter — Chrome only */
.glass-refraction {
  position: relative;
  /* Fallback for non-Chrome */
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.4);
  background: rgba(255,255,255,0.12);
}

/* Chrome-only: override with full SVG displacement pipeline */
@supports (backdrop-filter: url(#x)) {
  .glass-refraction {
    backdrop-filter: url(#liquid-glass-filter) blur(4px) brightness(1.1);
  }
}
</style>
```

**Key SVG parameter values from community experiments [inferred — from open-source reproductions]:**

| Parameter | Light UI controls | Heavy panels |
|-----------|------------------|--------------|
| `feGaussianBlur stdDeviation` | 1.0 | 2.0 |
| `feDisplacementMap scale` | 30–45 | 50–70 |
| `feColorMatrix saturate values` | 3–6 | 8–12 |
| Specular opacity (feBlend mode screen) | 0.3–0.5 | 0.2–0.4 |

The displacement map image should be a radially symmetrical gradient (bright center on R channel, neutral G channel) to simulate edge-lensing without center distortion.

---

### Recipe 4 — SwiftUI Native (iOS 26+)

```swift
import SwiftUI

// ── Basic glass surface ──
struct GlassCard: View {
    var body: some View {
        Text("Content")
            .padding(20)
            .glassEffect()  // .regular by default, capsule shape by default
    }
}

// ── Tinted primary action button ──
Button("Get Started") { }
    .buttonStyle(.glassProminent)
    .tint(.blue)

// ── Secondary glass button ──
Button("Cancel") { }
    .buttonStyle(.glass)

// ── Interactive touch-glow + custom shape ──
Button("Save") { }
    .padding()
    .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 16))

// ── Container: multiple glass elements share a render region ──
// Required when you have adjacent glass elements — prevents each
// from sampling independently (which creates visual inconsistency)
GlassEffectContainer(spacing: 12) {
    HStack(spacing: 12) {
        ForEach(tabs) { tab in
            TabButton(tab: tab)
                .glassEffect(.regular.interactive())
                .glassEffectID(tab.id, in: namespace)
        }
    }
}

// ── Fluid morph between two glass elements ──
@Namespace private var glassNamespace

GlassEffectContainer(spacing: 20) {
    if isExpanded {
        ExpandedView()
            .glassEffect()
            .glassEffectID("panel", in: glassNamespace)
    } else {
        CollapsedButton()
            .glassEffect(.regular.interactive())
            .glassEffectID("panel", in: glassNamespace)
    }
}

// ── Accessibility-aware fallback ──
@Environment(\.accessibilityReduceTransparency) var reduceTransparency

Text("Label")
    .padding()
    .glassEffect(reduceTransparency ? .identity : .regular)

// ── API signature reference ──
// func glassEffect<S: Shape>(
//     _ glass: Glass = .regular,
//     in shape: S = DefaultGlassEffectShape,  // capsule by default
//     isEnabled: Bool = true
// ) -> some View

// func glassEffectID<ID: Hashable>(_ id: ID, in namespace: Namespace.ID) -> some View
// func glassEffectUnion<ID: Hashable>(id: ID, namespace: Namespace.ID) -> some View
```

**Glass modifier chain:** `.regular.tint(.blue).interactive()` — modifiers chain on the `Glass` value, not the view.

**`GlassEffectContainer` requirement:** whenever two or more glass elements are visually adjacent, wrap them in a container. It provides a single shared sampling region, improving both rendering consistency and performance. The `spacing` parameter controls the distance within which elements merge/morph rather than staying separate. [documented]

---

### Recipe 5 — Prior SwiftUI Materials (iOS 15+, still valid)

```swift
// System material backgrounds (still available, now underlays for Liquid Glass content)
.background(.ultraThinMaterial)
.background(.thinMaterial)
.background(.regularMaterial)
.background(.thickMaterial)
.background(.ultraThickMaterial)

// Vibrancy applied to foreground content on a material background
Text("Secondary")
    .foregroundStyle(.secondary)  // picks up vibrancy from background material automatically
```

---

## Living backdrop for glass (recipe)

`backdrop-filter` glass has *nothing to sample* on a plain white or solid-color page — the blur collapses to a flat gray or white wash and the panel loses all depth. Real Liquid Glass needs colorful, spatially varied pixels behind it. This is why Apple places glass over wallpaper, rich photography, or a living-gradient backdrop on every surface. On web you must supply an equivalent. [observed — consistent failure mode in web reproductions; documented pattern in iOS wallpaper and macOS desktop design]

### Why it matters

`backdrop-filter: blur()` samples the pixels **below** the element in the stacking context, then blurs and color-shifts them. If those pixels are uniform (solid `#fff`, `#000`, or a flat brand color), you get a blurred flat color — indistinguishable from `background: rgba(...)` alone. A multi-hue gradient beneath glass gives the blur real tonal variation to work with, so the panel reads as a distinct, refracted surface rather than a smoked rectangle. [documented — Josh W. Comeau "Next-level frosted glass", CSS Studio glassmorphism guide]

### Copy-paste: static color-mesh backdrop

```css
/* ─── Living glass backdrop — multi-layer radial-gradient color mesh ─── */
/* Place on the body or a full-bleed wrapper. Glass panels sit above this. */

.glass-backdrop {
  position: fixed;          /* or absolute on a positioned wrapper */
  inset: 0;
  z-index: 0;

  /* ── Light-theme mesh ── */
  /* Layer order: CSS paints last layer first; gradients composite via alpha */
  background:
    /* Top-right: warm peach/rose accent */
    radial-gradient(ellipse 60% 50% at 80% 5%,
      rgba(255, 180, 140, 0.55) 0%,
      transparent 70%),
    /* Top-left: cool sky-blue anchor */
    radial-gradient(ellipse 55% 45% at 10% 0%,
      rgba(120, 190, 255, 0.5) 0%,
      transparent 65%),
    /* Center-left: violet mid-tone for depth */
    radial-gradient(ellipse 45% 55% at 20% 55%,
      rgba(160, 130, 255, 0.35) 0%,
      transparent 70%),
    /* Bottom-right: mint-green accent */
    radial-gradient(ellipse 50% 40% at 85% 90%,
      rgba(100, 220, 190, 0.4) 0%,
      transparent 65%),
    /* Base: near-white for light theme */
    #f0f2f8;

  /* Optional: very slight blur on the backdrop itself softens mesh seams */
  /* Do NOT use backdrop-filter here — this IS the source layer */
  filter: blur(0px) saturate(110%); /* keep at 0px unless seams are harsh */
}

/* ── Dark-theme mesh ── */
@media (prefers-color-scheme: dark) {
  .glass-backdrop {
    background:
      /* Top-right: deep indigo */
      radial-gradient(ellipse 60% 50% at 80% 5%,
        rgba(80, 60, 180, 0.6) 0%,
        transparent 70%),
      /* Top-left: teal/cyan anchor */
      radial-gradient(ellipse 55% 45% at 10% 0%,
        rgba(30, 130, 160, 0.5) 0%,
        transparent 65%),
      /* Center-left: rose-violet */
      radial-gradient(ellipse 45% 55% at 20% 55%,
        rgba(160, 50, 120, 0.4) 0%,
        transparent 70%),
      /* Bottom-right: gold warmth */
      radial-gradient(ellipse 50% 40% at 85% 90%,
        rgba(180, 130, 40, 0.35) 0%,
        transparent 65%),
      /* Base: near-black */
      #0d0f18;
  }
}
```

### Optional: slow keyframe drift

Add a gentle drift so the backdrop feels alive behind the glass panels. Keep it slow (≥ 30 s) and low-amplitude so it never distracts from content. [observed — common technique in glassmorphism codepens; design reasoning inferred from Apple's "living interface" rationale]

```css
/* ─── Slow mesh drift ─── */
/* Uses transform: translate so no layout reflow; GPU-composited */

.glass-backdrop {
  animation: mesh-drift 40s ease-in-out infinite alternate;
  /* alternate prevents a visible "snap" at loop end */
}

@keyframes mesh-drift {
  0%   { transform: translate(0, 0)    scale(1);    filter: saturate(110%); }
  33%  { transform: translate(-2%, 1%) scale(1.02); filter: saturate(120%); }
  66%  { transform: translate(1%, -2%) scale(1.01); filter: saturate(105%); }
  100% { transform: translate(-1%, 2%) scale(1.03); filter: saturate(115%); }
}

/* REQUIRED: freeze animation for motion-sensitive users */
@media (prefers-reduced-motion: reduce) {
  .glass-backdrop {
    animation: none;
    transform: none;
  }
}
```

**Do NOT** use `background-position` animation for the drift — it re-composites the gradient each frame (CPU). `transform: translate()` on the whole element uses the GPU compositor and has no layout cost. [documented — browser rendering pipeline; CSS Tricks backdrop-filter guide]

### Blur / saturate guidance on the glass panels above this backdrop

| Backdrop richness | Recommended glass `backdrop-filter` |
|---|---|
| Rich multi-hue mesh (this recipe) | `blur(20px) saturate(160%)` — mesh provides enough variety |
| Subtle / near-monochrome backdrop | `blur(12px) saturate(200%)` — crank saturate to rescue faint hue |
| Photographic / full-bleed image | `blur(24px) saturate(140%) brightness(108%)` — image already varied; lower saturate |

**`saturate` at 150–180 % is the practical sweet-spot**: below ~130 % the blur washes colors to near-gray; above ~220 % colors start to clip and look neon-fried. [inferred from visual experiments; no authoritative CSS spec value]

### Stacking note

```
[ Glass panel (backdrop-filter samples below)  ]  z-index: 10+
[ Glass backdrop (.glass-backdrop, no filter)  ]  z-index: 0
[ document body (background: transparent)      ]
```

The glass-backdrop element must be a **backdrop root ancestor of the glass panel**, meaning the glass panel must NOT be a child of any element with a `transform`, `filter`, `will-change`, `clip-path`, or `perspective` property set — those properties create a new backdrop root and make `backdrop-filter` sample only within that subtree, cutting off the color mesh. [documented — MDN backdrop-filter; observed common breakage pattern]

---

## Dark chrome glass + ghost button (values)

Recipe 1's dark variant covers general panels. Two values agents had to interpolate (and often got wrong) are the **dark toolbar/nav glass** and the **ghost/secondary button** (borderless fill, translucent label). Concrete values below. [observed — gap identified in dogfooding test; values derived from community dark glassmorphism implementations and cross-checked against Apple dark-mode chrome screenshots]

### Dark toolbar / nav glass

```css
/* ─── Dark glass toolbar / nav bar ─── */
/* Intended for fixed/sticky chrome: top nav, floating toolbar, bottom tab bar */

.glass-toolbar-dark {
  position: sticky;         /* or fixed */
  top: 0;
  z-index: 100;

  /* Semi-transparent near-black fill.
     Keep opacity 0.55–0.70; below 0.55 content bleeds too strongly;
     above 0.70 the panel looks opaque / defeats the glass effect. */
  background: rgba(18, 18, 22, 0.62);

  /* Blur: 16–20px is the toolbar sweet-spot.
     Heavier than 24px looks milky on dark; lighter than 12px doesn't diffuse enough. */
  backdrop-filter: blur(18px) saturate(160%) brightness(0.95);
  -webkit-backdrop-filter: blur(18px) saturate(160%) brightness(0.95);

  /* Hairline border: top catches specular, bottom grounds it.
     On dark chrome, lower opacity border (0.10–0.14) so it's a hint, not a line. */
  border-bottom: 1px solid rgba(255, 255, 255, 0.10);

  /* Shadows:
     - Outer drop: darker on dark theme (0.5 opacity vs 0.12 light)
     - Inset specular: top edge receives ambient light; keep very subtle on dark */
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.50),         /* drop shadow */
    0 1px 4px  rgba(0, 0, 0, 0.30),         /* tight grounding */
    inset 0 1px 0 rgba(255, 255, 255, 0.06); /* specular top edge */

  padding: 0 16px;
  height: 52px;
  display: flex;
  align-items: center;
}

/* Reduce-transparency fallback — REQUIRED */
@media (prefers-reduced-transparency: reduce) {
  .glass-toolbar-dark {
    background: rgba(22, 22, 26, 0.97);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-bottom-color: rgba(255, 255, 255, 0.15);
  }
}
```

**brightness(0.95) rationale:** On a dark glass toolbar over a bright color-mesh backdrop, without a slight brightness pull-down the blur can cause light colors to "bloom" through the dark panel and make it look lighter than intended. A 0.93–0.97 value counteracts this without crushing the tones. [inferred — from visual testing against color-mesh backdrops; no authoritative reference]

### Ghost / secondary button (dark theme)

A ghost button on dark glass: no fill, label only, subtle border, hover shows a dim fill, active presses down. Never uses another `backdrop-filter` layer (glass-on-glass, see anti-pattern #2). [observed — Apple secondary buttons in dark toolbar contexts; CSS community ghost button patterns]

```css
/* ─── Ghost button — dark glass surface ─── */
/* Use for secondary/cancel actions on dark glass chrome */

.glass-btn-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 16px;
  border-radius: 9999px;       /* capsule — matches Apple button language */
  font-weight: 500;
  font-size: 14px;
  letter-spacing: 0.01em;
  cursor: pointer;

  /* No fill; entirely defined by border + label */
  background: transparent;

  /* Hairline ghost border: slightly brighter than the toolbar border
     to differentiate the button shape from the chrome */
  border: 1px solid rgba(255, 255, 255, 0.22);

  /* Label: white at reduced opacity (not full white — too harsh on dark glass) */
  color: rgba(255, 255, 255, 0.82);

  /* No backdrop-filter — DO NOT add one; this sits ON glass, not below it */
  box-shadow: none;

  transition:
    background 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease,
    transform 0.10s ease;
}

/* Hover: reveal a very subtle fill without going opaque */
.glass-btn-ghost:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.32);
  color: rgba(255, 255, 255, 0.95);
}

/* Active/pressed: slight scale-down + darken */
.glass-btn-ghost:active {
  transform: scale(0.96);
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.18);
}

/* Focus-visible: accessibility keyboard ring */
.glass-btn-ghost:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.55);
  outline-offset: 2px;
}

/* Paired use: ghost button sits next to a primary glass button */
/* Spacing: 8px gap (tight grouping signals they're related actions) */
.glass-toolbar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
```

**Key values rationale:**

| Property | Value | Why |
|---|---|---|
| `border rgba alpha` | 0.22 default / 0.32 hover | Below 0.15 the button outline vanishes on dark glass; above 0.35 it reads as a filled element |
| `color rgba alpha` | 0.82 default / 0.95 hover | Full white (1.0) is harsh and can fail WCAG on near-black glass at some background states |
| `background` hover | `rgba(255,255,255,0.08)` | Enough fill to give haptic confirmation; above 0.12 starts to look like a filled button |
| `transform` active | `scale(0.96)` | Matches Apple's press depth (lighter than the 0.92–0.94 of heavy glass primary buttons) |

---

## Backdrop-hue adaptivity — honest assessment

**Question:** Can `saturate()` or `hue-rotate()` in `backdrop-filter` intelligently adapt when the backdrop behind the glass shifts hue regions (e.g. glass over a warm-orange area reads differently than the same glass over a cool-blue area)?

**Short answer: No robust CSS-native solution exists.** Here is what is and isn't possible: [inferred — from MDN filter function spec and observed CSS behavior; no Apple documentation addresses web hue-adaptivity]

### What `saturate()` and `hue-rotate()` actually do

`backdrop-filter: saturate(N%)` uniformly boosts or reduces saturation of **all** sampled backdrop pixels. It does not know what color the pixels are — it applies the same scalar transform regardless. Similarly, `hue-rotate(Xdeg)` rotates the entire hue wheel of the sampled region uniformly. [documented — MDN CSS filter functions]

The result: the same `saturate(180%)` produces a noticeably different visual on an orange backdrop vs. a blue backdrop — orange becomes hyper-orange, blue becomes hyper-blue — but you cannot use CSS alone to *detect* which region the glass is currently over and compensate. [observed]

### What can be approximated (with significant caveats)

**JS scroll-position heuristic.** If you know your layout (e.g. backdrop has a warm zone in the top 30% and a cool zone below), you can listen to `scroll` events and swap CSS custom properties:

```js
// ⚠ Fragile: only works for known static layout zones — not dynamic content
const toolbar = document.querySelector('.glass-toolbar-dark');
window.addEventListener('scroll', () => {
  const pct = window.scrollY / document.body.scrollHeight;
  if (pct < 0.3) {
    // Warm zone: pull down saturate to avoid orange bloom
    toolbar.style.setProperty('--glass-saturate', '130%');
    toolbar.style.setProperty('--glass-brightness', '0.92');
  } else {
    toolbar.style.setProperty('--glass-saturate', '165%');
    toolbar.style.setProperty('--glass-brightness', '0.96');
  }
}, { passive: true });
```

```css
.glass-toolbar-dark {
  backdrop-filter:
    blur(18px)
    saturate(var(--glass-saturate, 160%))
    brightness(var(--glass-brightness, 0.95));
}
```

This is a **layout-coupled hack**, not adaptivity. It breaks immediately if the background layout changes. [inferred — reasonable engineering observation; not a documented pattern]

**`mix-blend-mode` on the tint fill.** Replacing a fixed `rgba` background with a `background: rgba(18,18,22,0.55)` on `mix-blend-mode: luminosity` or `color` blends the fill relative to the backdrop. This can reduce some hue contamination but does not eliminate it and can produce unexpected results on complex backdrops. [inferred — from CSS blend mode specification behavior; untested at scale]

### What CSS genuinely cannot do

- **Per-pixel hue detection and compensation.** CSS has no way to read the color value of backdrop pixels and conditionally apply different filter parameters to different hue regions. This is what Apple's native vibrancy system does — it operates at the compositor level with per-pixel luminance + hue data. [documented — CSS has no equivalent of UIVibrancyEffect's per-pixel processing]
- **Content-aware tint shift.** CSS `backdrop-filter` functions are applied as a monolithic pass. There is no `if backdrop-hue > 200deg then saturate(130%)` logic available in CSS. [documented — CSS filter spec]

### Practical guidance

For web glass, the most durable approach is to **design the living backdrop so its color regions are broadly similar in saturation and luminance**, and choose a `saturate()` value that works across those regions — typically `saturate(140–170%)` as a middle ground. Accept that glass appearance will vary slightly across the gradient zones. This is honest to the medium; trying to compensate per-region creates more complexity than the visual difference warrants. [inferred — practical engineering recommendation based on CSS limitations]

---

## Faithful Replication

### What CSS Can Achieve

| Effect | CSS method | Fidelity |
|--------|-----------|----------|
| Frosted diffuse blur | `backdrop-filter: blur(20px)` | High — matches pre-LG frosted glass well |
| Vibrancy (color pull-through) | `backdrop-filter: saturate(180%) brightness(1.05%)` | Medium — approximates the saturation boost; not identical to Apple's per-pixel vibrancy |
| Specular highlight | `::before` pseudo with radial-gradient + `mix-blend-mode: screen` | Medium — static, not responsive to device tilt or touch location |
| Light-edge border | `border: 1px solid rgba(255,255,255,0.5)` + `inset box-shadow` | Good |
| Grounding shadow | `box-shadow: 0 8px 32px rgba(0,0,0,0.15)` | Good |
| Adaptive opacity on dark content | `prefers-color-scheme` media query + JS scroll listener | Low — manual, not content-aware at pixel level |
| Reduce-transparency fallback | `@media (prefers-reduced-transparency: reduce)` | Full — supported in all modern browsers |
| Edge lensing / refraction | `backdrop-filter: url(#svg-filter)` with `feDisplacementMap` | Low–Medium; Chrome-only; requires pre-authored displacement map |
| Size-responsive thickness | CSS `clamp()` on blur radius | Crude approximation |
| Fluid morph between elements | CSS `clip-path` animation or View Transitions API | Medium — no shared rendering surface |

### What CSS Cannot Replicate

1. **Real-time GPU lensing.** Apple's Liquid Glass runs a per-frame optical simulation on the GPU, bending background pixel coordinates through a curved-surface model. CSS `feDisplacementMap` can approximate this with a pre-authored static displacement image, but it is not physics-driven, not content-responsive, and produces incorrect results on complex animated backgrounds. [documented — per Apple WWDC25 session; inferred gap]

2. **Specular highlights that respond to device orientation.** Apple reads the gyroscope and accelerometer to shift the specular highlight position in 3D space. On web, `DeviceOrientationEvent` exists but requires permission, has precision limits, and there is no GPU path to apply it to a backdrop-filter highlight in real time. [inferred]

3. **Touch-location glow emanation.** When a user touches a Liquid Glass element, the glow starts *exactly at the fingertip coordinates* and spreads outward. CSS `:active` can trigger an animation, but the starting point is not fingertip-aware in the same render-synchronized way. Possible to approximate with JS `pointermove` + CSS custom properties (`--px`, `--py`) driving a radial-gradient, but not frame-synchronized with the GPU compositor pass. [inferred]

4. **Ambient light spill from nearby content.** macOS Tahoe shows colorful wallpaper content bleeding light onto adjacent glass surfaces. This requires the OS-level compositor reading surrounding pixel luminance and injecting it into the material render. Not possible in a browser sandbox. [inferred]

5. **Cross-element glow propagation.** The glow from a tapped button spreading to adjacent glass elements via `GlassEffectContainer` is a shared-surface composite operation. On web, adjacent DOM elements are independent rendering contexts; achieving the same effect requires canvas or WebGL, not CSS alone. [inferred]

6. **Content-adaptive shadow intensity.** Apple reads background luminance under the material element frame-by-frame and increases/decreases shadow opacity in response. CSS shadows are static values; approximating this requires `IntersectionObserver` + color sampling hacks, at significant performance cost. [inferred]

### Best-Effort CSS Approximation Summary

For a non-Chromium browser, the best approximation is:
```
backdrop-filter: blur(20px) saturate(180%);
background: rgba(255, 255, 255, 0.15);
border: 1px solid rgba(255, 255, 255, 0.5);
box-shadow: 0 8px 32px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.6);
```
This gives ~70% visual fidelity for static UI. Add the radial-gradient pseudo-element specular and you reach ~80%. The remaining ~20% — lensing, motion-responsive highlights, cross-element glow — requires native GPU access. [inferred — no authoritative percentage exists]

For Chromium only, add `feDisplacementMap` SVG backdrop-filter for lensing to reach ~85–90% static fidelity. [inferred]

---

## Anti-Patterns

### 1. Over-blurring Everything

**Problem:** Applying glass to content layers (list rows, cards, table cells, full-screen backgrounds) creates a "glass-on-glass" visual mud. The human eye loses its primary depth cue — the contrast between sharp content and blurred chrome. [documented — Apple HIG + WWDC25 session 219]

**Rule:** Glass belongs on the **navigation layer** only. Content is sharp and unblurred.

```swift
// ❌ Wrong
List {
    ForEach(items) { item in
        Text(item.title)
            .glassEffect()  // applying glass to content rows
    }
}

// ✅ Correct
List { ... }  // content is plain
.toolbar {   // chrome is glass
    Button("Done") { }.glassEffect()
}
```

On web, the equivalent anti-pattern is applying `backdrop-filter: blur()` to every card in a card grid. Each card costs a GPU compositing layer, performance degrades, and the design reads as undifferentiated noise.

### 2. Glass-on-Glass Stacking

**Problem:** Placing a glass element directly on top of another glass element creates double-blur artifacts and illegible content. The lensing effect conflicts — each layer tries to warp the other's already-warped pixels. [documented — WWDC25 session 219 explicitly forbids this]

On web: two stacked `backdrop-filter: blur()` elements do not compound cleanly. The inner element blurs an already-blurred pixel source, producing a milky, low-contrast mess.

**Rule:** Never stack glass. For overlay elements sitting *on* a glass surface, use fills, transparency, and vibrancy instead of another glass layer.

### 3. Illegible Text on Translucent Surfaces

**Problem:** Glass surfaces change appearance based on what scrolls under them. Text that is readable when a white section scrolls under can become invisible when a dark photo appears. Pure CSS glass has no content-adaptive vibrancy; text color is fixed. [documented — accessibility analysis]

**WCAG requirement:** 4.5:1 contrast ratio for normal text; 3:1 for large text. A fixed `color: white` on a glass panel can easily drop below this on light backgrounds. [documented — WCAG 2.2 AA]

**Mitigation on web:**
- Use a sufficiently high contrast text color (not pure white on light glass)
- Add a text-shadow with slight blur as a halo: `text-shadow: 0 0 8px rgba(0,0,0,0.5)`
- Consider a subtle dark vibrancy mask behind text blocks on glass surfaces
- Always test with busy/photographic content behind the glass

### 4. Ignoring Reduce-Transparency

**Problem:** Skipping the `@media (prefers-reduced-transparency: reduce)` fallback means a significant percentage of users with vestibular disorders, low vision, or cognitive sensitivities see a broken, disorienting experience. On mobile Safari, this is a widely used accessibility setting. [documented — Apple HIG]

**Required pattern — always implement:**
```css
@media (prefers-reduced-transparency: reduce) {
  .glass-surface {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: rgba(245, 245, 247, 0.96); /* near-opaque fallback */
    border-color: rgba(0, 0, 0, 0.15);
  }
}
```

In SwiftUI, `@Environment(\.accessibilityReduceTransparency)` is available; however, the system applies the fallback automatically when you use `.glassEffect()` correctly. [documented]

### 5. Performance Cost of backdrop-filter

**Problem:** Every element with `backdrop-filter` creates a new GPU compositing layer, stacking memory and fill-rate cost. On mobile, having more than 2–3 simultaneously active `backdrop-filter` layers causes visible frame drops. [observed — broadly reported in browser devtools analysis]

**Rules:**
- Keep `backdrop-filter` elements to the navigation layer only (matches Apple's design intent)
- Never use `backdrop-filter` inside `will-change: transform` containers — it breaks the backdrop sampling
- Prefer `contain: paint` on parent containers to restrict the compositor layer scope
- On scroll, if the glass element is fixed, it will re-sample on every frame — ensure the blur radius is not excessive (≤ 24px is safer on mobile)
- Test with Chrome DevTools → Rendering → Paint Flashing; glass elements should show minimal re-paint area

### 6. Mixing `.regular` and `.clear` Variants

**Problem:** Per Apple's explicit guidance, `.regular` and `.clear` are never used in the same interface group. `.regular` has full adaptive behavior; `.clear` has none. Mixed in the same toolbar or container they produce visually incoherent chrome — some items visually recede, others don't. [documented — WWDC25 session 219]

### 7. Tinting Every Element

**Problem:** Selective tinting signals hierarchy: the tinted element is the primary action. Tinting all buttons, nav items, and controls simultaneously destroys that signal — everything becomes equal weight, users cannot find the primary path. [documented — WWDC25 session 219]

Rule: at most **one** tinted glass element per visual group.

### 8. Not Testing on Physical Device

**Problem:** Apple's specular highlights and motion-responsive lensing do not render correctly in Xcode Simulator. Performance characteristics also differ significantly. [documented — iOS developer community reports] Shipping Liquid Glass UI that has only been tested in Simulator can produce unexpected visual artifacts on device.

---

## Sources

- [Meet Liquid Glass — WWDC25 Session 219 | Apple Developer](https://developer.apple.com/videos/play/wwdc2025/219/)
- [Get to know the new design system — WWDC25 Session 356 | Apple Developer](https://developer.apple.com/videos/play/wwdc2025/356/)
- [Materials | Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple introduces a delightful and elegant new software design | Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
- [Apple elevates the iPhone experience with iOS 26 | Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-elevates-the-iphone-experience-with-ios-26/)
- [glassEffect(_:in:) | Apple Developer Documentation](https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:))
- [Applying Liquid Glass to custom views | Apple Developer Documentation](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views)
- [Liquid Glass — Wikipedia](https://en.wikipedia.org/wiki/Liquid_Glass)
- [iOS 26 Liquid Glass: Comprehensive Swift/SwiftUI Reference | Medium (conorluddy)](https://medium.com/@madebyluddy/overview-37b3685227aa)
- [The Liquid Glass UI Revolution — iOS Developers Guide | Medium (vikramios)](https://vikramios.medium.com/the-liquid-glass-ui-revolution-everything-ios-developers-need-to-know-right-now-e29144a5e88a)
- [Liquid Glass in Swift: Official Best Practices for iOS 26 & macOS Tahoe | DEV Community](https://dev.to/diskcleankit/liquid-glass-in-swift-official-best-practices-for-ios-26-macos-tahoe-1coo)
- [Recreating Apple's Liquid Glass Effect with Pure CSS | DEV Community](https://dev.to/kevinbism/recreating-apples-liquid-glass-effect-with-pure-css-3gpl)
- [Liquid Glass in the Browser: Refraction with CSS and SVG | kube.io](https://kube.io/blog/liquid-glass-css-svg/)
- [How to create Liquid Glass effects with CSS and SVG | LogRocket](https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/)
- [Apple's New Liquid Glass Design: Practical Guidance for Designers | Designed for Humans](https://designedforhumans.tech/blog/liquid-glass-smart-or-bad-for-accessibility)
- [WWDC25 "Meet Liquid Glass" Session Notes | wwdcnotes.com](https://wwdcnotes.com/documentation/wwdcnotes/wwdc25-219-meet-liquid-glass/)
- [Is Apple's Liquid Glass the Next Material Design? | Telerik Blog](https://www.telerik.com/blogs/is-apple-liquid-glass-next-material-design)
- [Next-level frosted glass with backdrop-filter | Josh W. Comeau](https://www.joshwcomeau.com/css/backdrop-filter/)
- [Glassmorphism in CSS: The Complete Guide | CSS Studio](https://css-studio.com/blog/glassmorphism-css-guide)
- [Dark Glassmorphism: The Aesthetic That Will Define UI in 2026 | Medium](https://medium.com/@developer_89726/dark-glassmorphism-the-aesthetic-that-will-define-ui-in-2026-93aa4153088f)
- [Glassmorphic Nav bar tutorial (+JS dark toggle) | DEV Community](https://dev.to/lensco825/glassmorphic-nav-bar-tutorial-js-dark-toggle-n0l)
- [backdrop-filter CSS property | MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
- [Using CSS backdrop-filter for UI Effects | CSS-Tricks](https://css-tricks.com/using-css-backdrop-filter-for-ui-effects/)
- [Blob Animation And Glassmorphism with CSS | CodePen (thedevenv)](https://codepen.io/thedevenv/pen/JjrXayd)

---

**CONFIDENCE: 78% — Core material behaviors and SwiftUI APIs are well-documented from WWDC25 sessions and Apple developer docs; specific internal blur radii / GPU pipeline details are inferred from community experiments and visual reverse-engineering, and some Liquid Glass internals (exact refraction algorithm, pixel-level lensing math) remain undisclosed. The three new sections (living backdrop, dark chrome values, hue adaptivity) carry `[observed]` and `[inferred]` labels throughout — no Apple-published specification exists for web equivalents of these behaviors.**
