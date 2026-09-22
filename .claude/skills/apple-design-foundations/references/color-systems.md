# Apple Color Systems
Scope: semantic/adaptive color, Display P3 wide gamut, dark-mode strategy, accessibility, and CSS/SwiftUI replication — current iOS 26 / Liquid Glass era with historical rationale.

---

## Principles

### 1. Semantic over literal — the single most important rule [documented]
Apple's entire color system is built around *purpose*, not appearance. A color token describes *what a thing is* (label, background, separator) rather than *what it looks like* (#000000, #FFFFFF). This means:

- Every semantic color token is a dynamic pair (or quad: light / dark / high-contrast-light / high-contrast-dark).
- Switching appearance mode, enabling Increase Contrast, or elevating a surface automatically delivers the right resolved value with zero developer intervention.
- Hard-coding `#007AFF` instead of `.systemBlue` / `--color-system-blue` is a contract violation — you get a static value where you should have a living one.

### 2. Color recedes; content leads [documented]
Apple's HIG states that color should enhance communication, never overpower content. Backgrounds are deliberately muted (near-white in light, near-black in dark). Tints and accent colors are used sparingly to direct attention, not decorate. Fills and separators use low-opacity values so they virtually disappear, leaving the content hierarchy to speak.

### 3. Adaptive by construction [documented]
System colors are not just light/dark pairs. They respond to:
- **Appearance mode** (light / dark)
- **Elevation layer** (base / elevated in dark mode)
- **Accessibility: Increase Contrast** (automatic via system color assets, or custom xcasset "High Contrast" variant)
- **Accessibility: Reduce Transparency** (vibrancy/blur collapses to an opaque fallback)

### 4. Wide gamut is the default hardware story [documented]
Every iPhone since iPhone 7 (2016), every MacBook Pro since 2016, iPad Pro since 2017, and Apple displays ship with P3-capable panels. Apple designs system accent colors natively in Display P3, which are then tone-mapped for sRGB devices. The most saturated blues, greens, and pinks are simply *not representable* in sRGB at their intended vividness.

### 5. Dark mode is dimming, not inverting [documented]
Dark mode does not invert light-mode colors. Backgrounds dim from white toward black, and accent colors brighten slightly to maintain perceived contrast against the darker field. Pure black (#000000) is used as the *primary* app background on OLED devices to deliver true-black pixels (zero power draw, perfect contrast). Elevated surfaces step upward in gray (never downward) to suggest depth through luminance layering.

### 6. Liquid Glass and the material color era (iOS 26+) [documented]
iOS 26 introduces Liquid Glass as a first-class material. Its color is **context-derived** — it refracts and reflects surrounding content rather than being statically defined. Text is *never placed directly on glass* in Apple's own patterns; it always sits on a solid backing layer, preserving WCAG-level contrast. Semantic color tokens remain the underlying layer; Liquid Glass sits on top as a translucency material that inherits them.

---

## Apple specifics

### System semantic colors (UI element colors) [documented]

All values: iOS 13+ / UIKit. Light mode first, dark mode second. Alpha-encoded values (e.g. `#3C3C4399`) mean the hex includes an 8-digit RGBA form; the last two digits are the alpha channel in hex.

#### Labels
| Token | Light | Dark | Role |
|---|---|---|---|
| `.label` | `#000000` | `#FFFFFF` | Primary text |
| `.secondaryLabel` | `#3C3C4399` (60% alpha) | `#EBEBF599` (60% alpha) | Supporting text |
| `.tertiaryLabel` | `#3C3C434C` (30% alpha) | `#EBEBF54C` (30% alpha) | Placeholder-tier text |
| `.quaternaryLabel` | `#3C3C432D` (18% alpha) | `#EBEBF52D` (18% alpha) | Disabled / ghost text |
| `.placeholderText` | `#3C3C434C` | `#EBEBF54C` | Input placeholder |
| `.link` | `#007AFF` | `#0984FF` | Tappable links |

Note: the secondary/tertiary/quaternary labels use a *single opaque base color* (`#3C3C43` in light, `#EBEBF5` in dark) at different alpha levels, not different gray values. This means they blend cleanly over any background without leaving halo artifacts.

#### Backgrounds (standard content)
| Token | Light | Dark | Role |
|---|---|---|---|
| `.systemBackground` | `#FFFFFF` | `#000000` | Primary view canvas |
| `.secondarySystemBackground` | `#F2F2F7` | `#1C1C1E` | Inset panels, table header fill |
| `.tertiarySystemBackground` | `#FFFFFF` | `#2C2C2E` | Cards inside panels (elevated) |

#### Backgrounds (grouped / inset tables)
| Token | Light | Dark | Role |
|---|---|---|---|
| `.systemGroupedBackground` | `#F2F2F7` | `#000000` | Grouped table view canvas |
| `.secondarySystemGroupedBackground` | `#FFFFFF` | `#1C1C1E` | Row fill inside grouped section |
| `.tertiarySystemGroupedBackground` | `#F2F2F7` | `#2C2C2E` | Third level — e.g., sub-header |

The dark-mode hierarchy `#000000 → #1C1C1E → #2C2C2E` encodes the **base / elevated / elevated-2** depth model. Each step is +14–16 lightness points, just enough to be distinguishable without being garish. [documented]

#### Fills (control backgrounds, highlight overlays)
| Token | Light | Dark | Role |
|---|---|---|---|
| `.systemFill` | `#78788033` (20% alpha) | `#7878805B` (36% alpha) | Thin overlay — slider track, refresh tint |
| `.secondarySystemFill` | `#78788028` (16% alpha) | `#78788051` (32% alpha) | Thicker overlay |
| `.tertiarySystemFill` | `#7676801E` (12% alpha) | `#7676803D` (24% alpha) | Subtle badge/pill fill |
| `.quaternarySystemFill` | `#74748014` (8% alpha) | `#7676802D` (18% alpha) | Hairline wash |

Dark-mode fills use *higher* alphas to achieve the same perceived contrast against the darker background. [documented]

#### Separators
| Token | Light | Dark | Role |
|---|---|---|---|
| `.separator` | `#3C3C4349` (29% alpha) | `#54545899` (60% alpha) | Default hairline |
| `.opaqueSeparator` | `#C6C6C8` | `#38383A` | Use where blending not possible |

#### Gray scale (6-step)
| Token | Light | Dark |
|---|---|---|
| `.systemGray` | `#8E8E93` | `#8E8E93` |
| `.systemGray2` | `#AEAEB2` | `#636366` |
| `.systemGray3` | `#C7C7CC` | `#48484A` |
| `.systemGray4` | `#D1D1D6` | `#3A3A3C` |
| `.systemGray5` | `#E5E5EA` | `#2C2C2E` |
| `.systemGray6` | `#F2F2F7` | `#1C1C1E` |

Note: `.systemGray` is the only token whose hex value is *identical* in light and dark. This is intentional — mid-gray reads neutrally against both fields. All other gray tokens invert in value-direction (lighter-in-light → darker-in-dark). [documented]

### System tint / accent colors [documented]

These represent a *semantic intent* (error, confirmation, info) more than a named color. The dark-mode variant is always slightly lighter and more saturated to compensate for the darker field.

| Token | Light | Dark | P3 note |
|---|---|---|---|
| `.systemBlue` | `#007AFF` | `#0A84FF` | Native P3 display: more electric, narrowly representable in sRGB |
| `.systemGreen` | `#34C759` | `#30D158` | P3 version noticeably more vivid green |
| `.systemRed` | `#FF3B30` | `#FF453A` | P3 shifts to deeper saturated red |
| `.systemOrange` | `#FF9500` | `#FF9F0A` | |
| `.systemYellow` | `#FFCC00` | `#FFD60A` | |
| `.systemPink` | `#FF2D55` | `#FF375F` | |
| `.systemPurple` | `#AF52DE` | `#BF5AF2` | |
| `.systemTeal` | `#5AC8FA` | `#64D2FF` | |
| `.systemIndigo` | `#5856D6` | `#5E5CE6` | |
| `.systemMint` (iOS 15+) | `#00C7BE` | `#63E6E2` | [inferred from community measurement] |
| `.systemCyan` (iOS 15+) | `#32ADE6` | `#65D1FA` | [inferred from community measurement] |
| `.systemBrown` (iOS 15+) | `#A2845E` | `#AC8E68` | [inferred from community measurement] |

The iOS 15+ trio (mint, cyan, brown) was added to fill gaps in the spectrum and to support SwiftUI's `Color.mint / .cyan / .brown`. Exact hex for mint/cyan/brown are *not* officially published as static values by Apple; [inferred] from community runtime extraction.

### Display P3 wide-gamut colors [documented]

Apple specifies system accent colors in the Display P3 color space internally. The sRGB hex values above are the *gamut-clipped approximations* you get when reading them on an sRGB display. On P3 hardware:

- `systemBlue` in P3: approximately `color(display-p3 0.0 0.478 1.0)` [inferred — reverse-engineered from #007AFF sRGB]
- `systemGreen` in P3: approximately `color(display-p3 0.204 0.780 0.349)` [inferred]
- `systemRed` in P3: approximately `color(display-p3 1.0 0.231 0.188)` [inferred]

Display P3 has a gamut ~25% larger than sRGB (the spec says 50% larger by volume; ~25% larger by displayable colors in practice). The expansion is most pronounced in saturated greens and reds; blue expansion is minimal. [documented]

### Vibrancy materials [documented]

iOS provides UIVisualEffectView (UIKit) / `.ultraThinMaterial` etc. (SwiftUI) which composite foreground content over a blurred, tinted background. Vibrancy is a *secondary* effect applied on top of blur materials that brightens or desaturates the foreground to make it "glow" through the blur.

Material thicknesses (light → dark adaptation):
- `.ultraThinMaterial` — near-transparent blur, minimal tinting
- `.thinMaterial` — slight tint
- `.regularMaterial` — standard system sheets, control centers
- `.thickMaterial` — heavy frosted glass
- `.ultraThickMaterial` — near-opaque

Each material has vibrancy label styles (`.primary`, `.secondary`, `.tertiary`, `.quaternary`) and vibrancy fill styles (`.primary`, `.secondary`, `.tertiary`) that are applied *on top of* the material to achieve the blended look. These cannot be meaningfully replicated in CSS without `backdrop-filter`. [documented]

---

## Recipes

### CSS semantic color palette (light + dark, faithful to Apple values)

```css
/* ─────────────────────────────────────────────────────────────
   Apple-faithful semantic color tokens
   Usage: pin data-theme="light" to <html> if you need to override
   OS preference (e.g. the NETS light-theme constraint).
   ───────────────────────────────────────────────────────────── */

:root,
[data-theme="light"] {
  color-scheme: light;

  /* Labels */
  --color-label:              #000000;
  --color-label-secondary:    rgba(60, 60, 67, 0.60);
  --color-label-tertiary:     rgba(60, 60, 67, 0.30);
  --color-label-quaternary:   rgba(60, 60, 67, 0.18);
  --color-placeholder:        rgba(60, 60, 67, 0.30);
  --color-link:               #007AFF;

  /* Standard backgrounds */
  --color-bg:                 #FFFFFF;
  --color-bg-secondary:       #F2F2F7;
  --color-bg-tertiary:        #FFFFFF;

  /* Grouped backgrounds */
  --color-bg-grouped:         #F2F2F7;
  --color-bg-grouped-secondary: #FFFFFF;
  --color-bg-grouped-tertiary:  #F2F2F7;

  /* Fills (translucent overlays) */
  --color-fill:               rgba(120, 120, 128, 0.20);
  --color-fill-secondary:     rgba(120, 120, 128, 0.16);
  --color-fill-tertiary:      rgba(118, 118, 128, 0.12);
  --color-fill-quaternary:    rgba(116, 116, 128, 0.08);

  /* Separators */
  --color-separator:          rgba(60, 60, 67, 0.29);
  --color-separator-opaque:   #C6C6C8;

  /* Gray scale */
  --color-gray:               #8E8E93;
  --color-gray-2:             #AEAEB2;
  --color-gray-3:             #C7C7CC;
  --color-gray-4:             #D1D1D6;
  --color-gray-5:             #E5E5EA;
  --color-gray-6:             #F2F2F7;

  /* System accents */
  --color-blue:               #007AFF;
  --color-green:              #34C759;
  --color-red:                #FF3B30;
  --color-orange:             #FF9500;
  --color-yellow:             #FFCC00;
  --color-pink:               #FF2D55;
  --color-purple:             #AF52DE;
  --color-teal:               #5AC8FA;
  --color-indigo:             #5856D6;
  --color-mint:               #00C7BE;
  --color-cyan:               #32ADE6;
  --color-brown:              #A2845E;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;

    /* Labels */
    --color-label:              #FFFFFF;
    --color-label-secondary:    rgba(235, 235, 245, 0.60);
    --color-label-tertiary:     rgba(235, 235, 245, 0.30);
    --color-label-quaternary:   rgba(235, 235, 245, 0.18);
    --color-placeholder:        rgba(235, 235, 245, 0.30);
    --color-link:               #0984FF;

    /* Standard backgrounds — true-black base for OLED */
    --color-bg:                 #000000;
    --color-bg-secondary:       #1C1C1E;
    --color-bg-tertiary:        #2C2C2E;

    /* Grouped backgrounds */
    --color-bg-grouped:         #000000;
    --color-bg-grouped-secondary: #1C1C1E;
    --color-bg-grouped-tertiary:  #2C2C2E;

    /* Fills — higher alpha needed on dark field */
    --color-fill:               rgba(120, 120, 128, 0.36);
    --color-fill-secondary:     rgba(120, 120, 128, 0.32);
    --color-fill-tertiary:      rgba(118, 118, 128, 0.24);
    --color-fill-quaternary:    rgba(118, 118, 128, 0.18);

    /* Separators */
    --color-separator:          rgba(84, 84, 88, 0.60);
    --color-separator-opaque:   #38383A;

    /* Gray scale — inverted value direction */
    --color-gray:               #8E8E93;
    --color-gray-2:             #636366;
    --color-gray-3:             #48484A;
    --color-gray-4:             #3A3A3C;
    --color-gray-5:             #2C2C2E;
    --color-gray-6:             #1C1C1E;

    /* System accents — brightened for dark field */
    --color-blue:               #0A84FF;
    --color-green:              #30D158;
    --color-red:                #FF453A;
    --color-orange:             #FF9F0A;
    --color-yellow:             #FFD60A;
    --color-pink:               #FF375F;
    --color-purple:             #BF5AF2;
    --color-teal:               #64D2FF;
    --color-indigo:             #5E5CE6;
    --color-mint:               #63E6E2;
    --color-cyan:               #65D1FA;
    --color-brown:              #AC8E68;
  }
}

/* Force light theme regardless of OS (e.g. NETS v2 pinned-light pattern) */
[data-theme="light"] {
  color-scheme: light;
  /* already defined in :root block above */
}
```

### Display P3 progressive enhancement

```css
/* Pattern 1: cascading property (non-supporting browsers silently ignore
   the color() declaration and fall through to the sRGB value above it) */
.accent-blue {
  color: #007AFF;                          /* sRGB fallback */
  color: color(display-p3 0.000 0.478 1.000); /* P3 — visibly more electric */
}

/* Pattern 2: @supports query (recommended for custom properties) */
:root {
  --color-blue-vivid: #007AFF;             /* sRGB baseline */
}

@supports (color: color(display-p3 1 1 1)) {
  :root {
    --color-blue-vivid:  color(display-p3 0.000 0.478 1.000);
    --color-green-vivid: color(display-p3 0.204 0.780 0.349);
    --color-red-vivid:   color(display-p3 1.000 0.231 0.188);
    --color-pink-vivid:  color(display-p3 1.000 0.176 0.333);
  }
}

/* Pattern 3: media query (use when you can't rely on @supports) */
@media (color-gamut: p3) {
  .vivid-green { background: color(display-p3 0.204 0.780 0.349); }
}
```

### CSS light-dark() function (modern shorthand, Chrome 123+ / Safari 17.5+)

```css
/* Requires color-scheme: light dark declared on :root */
:root { color-scheme: light dark; }

.card {
  background: light-dark(#FFFFFF, #1C1C1E);
  color:       light-dark(#000000, #FFFFFF);
  border-color: light-dark(rgba(60,60,67,0.29), rgba(84,84,88,0.60));
}
```

### CSS meta tag for fast first-paint

```html
<!-- Prevents flash of wrong theme before CSS loads -->
<meta name="color-scheme" content="light dark">
```

Or, to opt out of OS dark mode entirely (e.g. NETS pinned-light pattern):

```html
<meta name="color-scheme" content="light">
```

### SwiftUI semantic color usage

```swift
// CORRECT — token-based, automatically adapts
Text("Hello")
    .foregroundStyle(.primary)              // = .label

VStack { ... }
    .background(Color(.systemBackground))   // or Color(.secondarySystemBackground)

Divider()
    .overlay(Color(.separator))

// CORRECT — system accent
Button("Confirm") { ... }
    .tint(.systemBlue)                      // .blue in SwiftUI ≈ systemBlue

// WRONG — hardcoded, breaks dark mode and Increase Contrast
Text("Hello")
    .foregroundColor(Color(hex: "#000000")) // never do this for UI text

// CORRECT — P3 accent when you need it
Color(displayP3Red: 0.0, green: 0.478, blue: 1.0, opacity: 1.0)

// Custom color asset respecting Increase Contrast
// In Assets.xcassets: create Color Set with "Any Appearance", "Dark",
// "High Contrast", and "High Contrast Dark" slots
Color("BrandAccent")  // SwiftUI reads the active trait slot automatically
```

### UIKit adaptive color (iOS 13+)

```swift
// Dynamic color that resolves at render time per trait collection
let adaptiveColor = UIColor { traitCollection in
    switch (traitCollection.userInterfaceStyle, traitCollection.accessibilityContrast) {
    case (.dark, .high):   return UIColor(red: 0.0,  green: 0.55, blue: 1.0, alpha: 1.0)
    case (.dark, _):       return UIColor(red: 0.04, green: 0.52, blue: 1.0, alpha: 1.0)
    case (_, .high):       return UIColor(red: 0.0,  green: 0.4,  blue: 0.9, alpha: 1.0)
    default:               return UIColor(red: 0.0,  green: 0.478,blue: 1.0, alpha: 1.0)
    }
}
```

---

## Faithful replication

### Replicating the Apple light-mode surface feel

1. **Canvas**: pure `#FFFFFF`. No warmth, no cool tint — stark neutral white.
2. **Inset panels / grouped sections**: `#F2F2F7` — a whisper of cool blue-gray. This is *not* a warm gray; the RGB is (242, 242, 247), blue channel is the highest.
3. **Cards inside panels**: back to `#FFFFFF`. The card lifts off the panel through the white-on-light-gray contrast alone.
4. **Separators**: `rgba(60, 60, 67, 0.29)`. Never a solid gray — always semi-transparent so they read correctly on any background.
5. **Text hierarchy**: pitch-black primary, then two alpha-modulated layers at 60% / 30% / 18%. Use opacity, not lighter grays.

### Replicating the Apple dark-mode depth model

The dark hierarchy is a 3-step gray staircase going *up* in luminance:

```
Base (furthest)     #000000  — true black, OLED-efficient
Elevated (+1)       #1C1C1E  — cards, sheets, nav bars
Elevated (+2)       #2C2C2E  — controls inside cards, toolbars
```

Anything that "pops forward" gets a lighter value; anything that "recedes" uses a darker value. Never go below `#000000`; never jump more than ~16 luminance points per step. [documented]

### Replicating dark-mode accent color behavior

In dark mode, system accents *increase* in lightness by roughly 4–6 points and increase slightly in saturation. The visual motivation: a pure `#007AFF` against `#000000` looks fine but reads slightly dim; `#0A84FF` is fractionally lighter and registers as the correct perceived blue weight against black. [documented]

Never simply use the same hex accent in both light and dark modes.

### Replicating the Liquid Glass material (CSS approximation)

The Liquid Glass aesthetic requires:
1. `backdrop-filter: blur(20px) saturate(180%)` as the foundational blur.
2. A near-transparent white fill: `background: rgba(255, 255, 255, 0.55)` (light); `rgba(28, 28, 30, 0.65)` (dark).
3. A specular highlight edge: `box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 3px rgba(0,0,0,0.12)`.
4. **Text must sit on a solid backing, never directly on the glass layer.** [documented — Apple's own Liquid Glass spec states this for accessibility.]

### Increase Contrast — what changes

When the user enables Settings → Accessibility → Display & Text Size → Increase Contrast: [documented]

- System semantic colors automatically shift to higher-contrast variants. `.label`, `.secondaryLabel`, separators all become more opaque / darker.
- Semi-transparent fills and backgrounds become more opaque.
- For custom colors, you must provide High Contrast variants in your `.xcassets` Color Set, or respond to `traitCollection.accessibilityContrast == .high` programmatically.
- CSS equivalent: `@media (prefers-contrast: more)` — override your custom property tokens to higher-contrast values.

```css
@media (prefers-contrast: more) {
  :root {
    --color-label-secondary: rgba(60, 60, 67, 0.80);  /* up from 0.60 */
    --color-separator:       rgba(60, 60, 67, 0.55);  /* up from 0.29 */
    --color-fill:            rgba(120, 120, 128, 0.35); /* up from 0.20 */
  }
}
```

---

## Anti-patterns

### 1. Hardcoding literal hex for text and backgrounds [documented]
```css
/* WRONG */
color: #000000;            /* invisible in dark mode */
background: #FFFFFF;       /* sears eyes in dark mode */

/* RIGHT */
color: var(--color-label);
background: var(--color-bg);
```

### 2. Pure color inversion for dark mode [documented]
Inverting light values produces browns, yellows, and washed-out greens instead of the carefully calibrated dark-mode accents Apple ships. `#007AFF` inverted is `#FF8000` (orange) — the correct dark-mode equivalent is `#0A84FF` (brighter blue).

### 3. Using a single uniform dark gray for everything [documented]
A single `#1C1C1E` for backgrounds, cards, separators, and controls collapses the depth model. The three-step hierarchy (`#000 → #1C1C1E → #2C2C2E`) is load-bearing.

### 4. Low-contrast gray-on-gray label stacks [documented]
Placing `.secondaryLabel` (`rgba(60,60,67,0.60)`) over `.secondarySystemBackground` (`#F2F2F7`) reduces contrast to approximately 3.5:1 — below WCAG AA 4.5:1 for normal text. Use this combination only for text at 18pt+ (large text has a 3:1 minimum). For smaller text, step up to a darker gray or boost alpha.

### 5. Ignoring Increase Contrast [documented]
Not providing High Contrast variants means your custom colors fail the accessibility contract. System colors handle this automatically; custom colors do not.

### 6. Color as the sole differentiator [documented]
Never distinguish UI states purely by color (e.g., red vs. green for error/success). Add shape, iconography, or text label as a redundant signal — ~8% of males have red-green color vision deficiency (deuteranopia/protanopia).

### 7. Skipping the `color-scheme` meta tag on web [documented]
Without `<meta name="color-scheme" content="light dark">` or the CSS `color-scheme` property, the browser's default form controls, scroll bars, and canvas background remain the browser's default (often white), causing a visible flash before your CSS loads and failing to adapt system UI elements.

### 8. Treating sRGB #007AFF as Display P3 #007AFF [documented]
These are different physical colors. An sRGB `#007AFF` on a P3 display is gamut-expanded and will appear slightly desaturated compared to what Apple intends. On CSS/web, always use `color(display-p3 ...)` inside `@supports` for the intended vividness, with the sRGB value as the fallback — not as an equivalent.

### 9. Placing text directly on Liquid Glass / blur layers [documented]
Glass surfaces refract their background. On a light background the glass might appear dark; on a dark background, light. Text placed directly on glass will have unpredictable contrast — fails WCAG at an indeterminate rate. Always keep text on solid semantic-color backing.

### 10. Not testing on OLED at minimum brightness [inferred]
`#1C1C1E` against `#000000` provides about 4–5% luminance difference — barely visible on LCD, fine on OLED. On OLED at low brightness or with automatic brightness, this can become imperceptible. Test the three-step hierarchy on real hardware.

---

## Sources

- [Color | Apple Developer Documentation (HIG)](https://developer.apple.com/design/human-interface-guidelines/color)
- [Dark Mode | Apple Developer Documentation (HIG)](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [Dark Color Cheat Sheet — Sarunw](https://sarunw.com/posts/dark-color-cheat-sheet/)
- [Backwards Compatibility for iOS 13 System Colors — Noah Gilmore](https://noahgilmore.com/blog/dark-mode-uicolor-compatibility)
- [Wide Gamut Color in CSS with Display-P3 — WebKit Blog](https://webkit.org/blog/10042/wide-gamut-color-in-css-with-display-p3/)
- [Wide Gamut Color in CSS with Display-P3 — CSS-Tricks](https://css-tricks.com/wide-gamut-color-in-css-with-display-p3/)
- [color-gamut CSS media feature — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/color-gamut)
- [Improve Dark Mode with color-scheme — web.dev](https://web.dev/articles/color-scheme)
- [iOS Semantic Colors — Medium / Wegener](https://pangea25.medium.com/ios-semantic-colors-9cf0fa995df1)
- [iOS Color Contrast Best Practice: Increase Contrast — Deque](https://www.deque.com/blog/ios-color-contrast-best-practice-increase-contrast/)
- [Use High Contrast for Legibility — UseYourLoaf](https://useyourloaf.com/blog/use-high-contrast-for-legibility/)
- [Apple Introduces Liquid Glass Design — Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
- [Liquid Glass 2026 Developer Guide — Medium](https://medium.com/@expertappdevs/liquid-glass-2026-apples-new-design-language-6a709e49ca8b)
- [50 Shades of Dark Mode Gray — Karen Ying](https://blog.karenying.com/posts/50-shades-of-dark-mode-gray)
- [Color Management Across Apple Frameworks — JuniperPhoton](https://juniperphoton.substack.com/p/color-management-across-apple-frameworks)
- [displayP3 | Apple Developer Documentation](https://developer.apple.com/documentation/coregraphics/cgcolorspace/displayp3)
- [Standard Colors | Apple Developer Documentation (UIKit)](https://developer.apple.com/documentation/uikit/standard-colors)
- [Implementing Dark Mode on iOS — WWDC 2019 Session 214](https://developer.apple.com/videos/play/wwdc2019/214/)

---

CONFIDENCE: 82% — Core semantic color values, dark-mode depth model, P3 principles, and accessibility rules are well-documented; exact P3 decimal values for individual system accent colors and iOS 15+ mint/cyan/brown hex values are [inferred] from community extraction rather than from Apple's published spec, and the iOS 26 Liquid Glass color-token spec was not publicly detailed at research time (WWDC 2026 is June 8–12).
