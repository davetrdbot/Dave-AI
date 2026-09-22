# Apple Typography Reference
**Scope:** San Francisco font family, Dynamic Type system, New York serif, SF Symbols integration, marketing type scale, and faithful web replication patterns. Current era (2019–present) with historical context.

---

## Principles

These are the transferable design lessons Apple's type system encodes — applicable beyond Apple platforms.

### 1. Optical correctness over mathematical correctness
A font that is mathematically the same size across contexts is not optically the same. Apple splits SF Pro into Display and Text optical sizes so that the spacing, apertures, and stroke contrast are each tuned for the physical rendering context — not just scaled up or down. [documented]

### 2. Legibility is a function of size AND context
Helvetica Neue failed Apple not because it is a bad typeface but because no single grotesque can serve a 38mm watch face AND a 5K iMac. Apple's solution: multiple optical variants that share a common visual identity but have different underlying geometry. [documented]

### 3. Hierarchy communicates before content does
The Apple marketing page grabs attention with headline weights and sizes (~80–96px on desktop) that are 5–6x larger than body. This ratio communicates priority before a word is read. [observed — from devtools inspection of apple.com]

### 4. Trust the system, don't fight it
Dynamic Type is not a constraint — it is the contract. Apple's text style system automatically manages size, weight, leading, and tracking per user preference. Fighting it with hardcoded point sizes removes accessibility guarantees. [documented]

### 5. Tracking (letter-spacing) is inversely proportional to size
Large type needs tighter tracking to feel solid; small type needs looser tracking to preserve legibility. Apple encodes this as a continuous function, not a manual per-case decision. This is the single most commonly violated principle in third-party apps. [documented]

### 6. Spacing and rhythm over decoration
Apple's type layouts rely on generous line-height, careful spacing ratios, and optical margin alignment — not color or decoration — to create visual order. The "Apple feel" in text is 80% spacing discipline. [observed]

---

## Apple Specifics

### The San Francisco Family

Apple retired Lucida Grande (Mac system font 2001–2014) and Helvetica/Helvetica Neue (iPhone 2007 → iOS 6; Mac Yosemite 2014–2015) because neither could scale across the product range — from the original Apple Watch at 38mm to the 27" iMac — without legibility degradation. San Francisco was introduced at WWDC 2015, debuting on watchOS and iOS 9, then Mac with OS X El Capitan. [documented]

The family today comprises:

| Variant | Primary use | Key characteristic |
|---|---|---|
| **SF Pro** | iOS, iPadOS, macOS, tvOS | 9 weights, 4 widths, rounded variant |
| **SF Compact** | watchOS | Flat vertical strokes on round glyphs (o, e, s) — widens character spacing at small sizes |
| **SF Mono** | Xcode, code editors, terminals | 6 weights, fixed pitch |
| **New York** | Reading, editorial, display | Serif companion; 4 optical sizes, 6 weights |
| **SF Arabic / Hebrew / Armenian / Georgian** | Multilingual | Script-specific optical tuning |

[documented — apple.com/fonts]

---

### SF Pro: Display vs. Text Optical Sizes

**The crossover is 20pt.** [documented]

- **SF Pro Text** — used at 19pt and below. Wider apertures (more open counters), looser tracking, slightly different glyph geometry (e.g., dot of lowercase "i" positioned closer to the stem body). 6 weights (Ultralight through Bold).
- **SF Pro Display** — used at 20pt and above. Tighter tracking, closed forms optimized for large rendering, more refined contrast. 9 weights (Ultralight through Black, including the extreme weights not available in Text).

On Apple platforms, this switch is **automatic** when you use `systemFont(ofSize:)` or any Dynamic Type text style API. [documented]

In the 2020 variable font consolidation, a single `SF Pro.ttf` variable font was introduced where the transition is a **smooth interpolation between 17pt and 28pt** rather than a hard switch at 20pt. The system still makes the call — you do not manually select Text vs. Display. [documented — WWDC20 session 10175]

**Width variants added WWDC22:** [documented]
- **Condensed** — space-efficient, still comfortable for body use
- **Compressed** — the densest variant; flat-sided shapes; display use only
- **Expanded** — wide and open; display and secondary content
- All widths share identical vertical metrics — only horizontal proportions change, so mixing widths in a layout stays vertically aligned.

**SF Pro Rounded:** shares the underlying metrics but all terminals are rounded. Used in UI for approachable, friendly contexts (e.g., the App Store ratings pill, weather app temperatures). [observed]

---

### SF Compact (watchOS)

- Designed for narrow circular and rectangular watch displays.
- Round letters (o, e, s, c) have **flattened vertical strokes** — this increases the white space at the sides of each glyph and prevents letterforms from bleeding into each other at high pixel density.
- Spacing is more generous than SF Pro Text at equivalent sizes.
- Also available as SF Compact Rounded.
[documented]

---

### New York

Apple's serif companion to SF Pro, introduced at WWDC 2019. Designed to serve as both a reading face (body text in long-form apps like Books) and a graphic display face at large sizes. [documented]

**Four optical sizes:**
| Optical Size | Optimized for |
|---|---|
| Small | Body text, compact UI |
| Medium | General body text, standard UI |
| Large | Subheadings |
| Extra Large | Headlines, display text |

Each optical size has different stroke modulation, serif prominence, and internal spacing. The exact point-size thresholds for automatic switching are not publicly documented by Apple. [documented name/count; thresholds: inferred — the forum thread asking this question went unanswered by Apple]

**6 weights:** Regular through Black, plus matching italics. Variable font technology underlies this, but Apple distributes fixed-instance fonts to developers. [documented]

---

### SF Mono

6 weights (Regular through Heavy). Designed for code and terminal contexts. Fixed-pitch — each glyph occupies identical horizontal advance. Used in Xcode, the terminal, and code blocks in Apple documentation. Not suitable for UI body text. [documented]

---

### Dynamic Type — Text Styles

Dynamic Type is Apple's system for user-adjustable type scaling. Users set a preferred text size in Settings → Display & Brightness (7 standard levels) or Settings → Accessibility → Display & Text Sizes (5 additional larger levels). Text styles are the primary contract: you pick a semantic role and the system handles size, weight, leading, and tracking. [documented]

**11 standard text styles (iOS/iPadOS):** [documented]

| Style | Weight | Default (Large) size |
|---|---|---|
| Large Title | Regular | 34pt |
| Title 1 | Regular | 28pt |
| Title 2 | Regular | 22pt |
| Title 3 | Regular | 20pt |
| Headline | Semibold | 17pt |
| Body | Regular | 17pt |
| Callout | Regular | 16pt |
| Subheadline | Regular | 15pt |
| Footnote | Regular | 13pt |
| Caption 1 | Regular | 12pt |
| Caption 2 | Regular | 11pt |

[documented — Apple HIG; confirmed by multiple secondary sources]

**Emphasis variants:** When a bold trait is applied (`.bold` symbolic trait or `.fontWeight(.semibold)` in SwiftUI), the system bumps the weight up — not to the next weight, but to the next legible emphasis weight: [documented — WWDC20 10175]
- Body Regular → Semibold
- Title 1 Regular → Bold
- Footnote Regular → Semibold
- Large Title Regular → Bold

**macOS equivalents** (smaller baseline — designed for 14-inch laptops at arm's length, not a held 6-inch device):
- Body: 13pt
- Headline: 14pt (tight leading)
[documented — WWDC20 10175]

**Leading adjustments** (platform-specific): [documented — WWDC20 10175]
| Platform | Tight variant | Loose variant |
|---|---|---|
| iOS / macOS | -2pt from default | +2pt from default |
| watchOS | -1pt from default | +1pt from default |

Example: Body at 17pt has a default line height of 22pt. Tight variant = 20pt. Loose variant = 24pt.

**Scaling behavior across Dynamic Type categories:** [documented — range; exact intermediate values inferred from Apple HIG tables not directly fetchable]
- Smallest supported: xSmall (Caption 2 stays at 11pt minimum — does not scale below this)
- Largest accessibility: AX5
- At AX5, Large Title can reach approximately 56pt; Body approximately 53pt [inferred from multiple documented secondary sources describing the scale range]
- Caption 2 at 11pt is the hard floor for the entire system — it stops scaling down at xSmall

**Complete scaling table with all 12 size categories** is published in Apple HIG at `developer.apple.com/design/human-interface-guidelines/typography` under "iOS-iPadOS Dynamic Type sizes" — these are behind JavaScript rendering and were not directly fetchable; the default (Large) values above are the confirmed anchor. [documented anchor values; full table: observed in HIG but not directly extracted here]

---

### Tracking (Letter-Spacing) by Size

Apple's tracking is a **continuous function of size** baked into the font's optical size axis (and previously into two separate font files). The system applies it automatically. [documented]

The directional rule: **Positive (loose) tracking at small sizes, negative (tight) tracking at large sizes.** [documented]

For web/design work where you must apply tracking manually (e.g., using the downloaded SF Pro fonts in Figma or a design tool), approximate values derived from Apple's design resources and community inspection: [observed — Sketch SF UI Font Fixer project; inferred for intermediate values]

| Size | Approximate tracking (per 1000em units) | CSS `letter-spacing` approximate |
|---|---|---|
| 11pt (Caption 2) | +150 | +0.06em |
| 12pt (Caption 1) | +130 | +0.05em |
| 13pt (Footnote) | +60 | +0.025em |
| 15pt (Subhead) | +20 | +0.008em |
| 16pt (Callout) | +12 | +0.005em |
| 17pt (Body) | 0 | 0 |
| 20pt (Title 3) | -20 | -0.008em |
| 22pt (Title 2) | -26 | -0.01em |
| 28pt (Title 1) | -36 | -0.014em |
| 34pt (Large Title) | -41 | -0.016em |
| 40pt+ (marketing) | -48 or tighter | -0.02em to -0.04em |

These values are approximations from reverse-engineering and community tracking tables. The system handles this automatically on-device; only apply manually in Figma/CSS. [inferred — exact Apple-internal values not publicly published in a table]

---

### SF Symbols Integration with Type

SF Symbols are vector symbols designed as a first-class typographic element — they live in the same weight/size namespace as SF Pro. [documented — WWDC19 session 206; WWDC20 session 10207]

Key integration properties:
- Symbols are **baseline-aligned** with adjacent text by default. The baseline is the same imaginary line the text rests on.
- When placed next to text, they are **vertically centered on cap height** rather than the full em square — this matches visual center of Latin uppercase characters.
- Weight is **inherited from surrounding text** — a `.semibold` label makes adjacent SF Symbols symbols automatically semibold.
- Size is **inherited from font point size** — a 17pt label gets 17pt symbols by default, which you can then multiply using `.imageScale()`.
- A `baselineOffsetFromBottom` property on `UIImage` exposes the exact offset for programmatic alignment.
- The "frame" concept is explicitly NOT how you spec SF Symbols — you specify them typographically (weight + scale) and let the system lay them out as glyphs. [documented]
- As of SF Symbols 5 (WWDC23), symbols also support variable rendering (fill levels via a numeric value) and multiple rendering modes (monochrome, hierarchical, palette, multicolor). [documented]

---

### The Apple.com Marketing Type Scale

The apple.com marketing scale is **fundamentally different from in-app type** — it is optimized for visual impact at large viewport widths, not for information density or accessibility scaling. [observed — from devtools inspection of apple.com]

Key observed characteristics: [observed]
- Hero headlines: ~80–96px on desktop (≈60–72pt equivalent), font-weight 700–800, tracking around -0.04em to -0.05em
- Product name type (e.g., "iPhone 16 Pro"): often 40–56px at tablet widths, tightly tracked
- Subheadline / deck: 21–28px, Regular weight, looser leading (~1.4–1.5)
- Body / legal: 17px, Regular, line-height 1.47 (~25px)
- Navigation: 12–14px, Regular/Medium, sparse tracking

The marketing scale uses a **fluid type approach** — font-size scales continuously between mobile and desktop breakpoints, not in discrete steps. [observed]

Observed fluid scale anchors (mobile 390px → desktop 1440px): [observed — from community devtools reconstructions]
| Role | Mobile | Desktop |
|---|---|---|
| Hero headline | 56px | 80–96px |
| H1 / Product title | 48px | 64–80px |
| H2 / Feature title | 40px | 56px |
| H3 / Section title | 34px | 48px |
| Body / Deck | 17px | 17–19px |

Apple does NOT use fluid scaling for body text — only for display/headline type. Body remains at a fixed 17px with a line-height of approximately 1.47 (25px). At wider viewports the measure (column width) changes, not the font size. [observed]

---

## Recipes

### CSS: System Font Stack

```css
/* Modern — preferred. system-ui resolves to SF Pro on Apple, Segoe UI on Windows */
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

/* ⚠ Do NOT use -apple-system with the font shorthand — some parsers treat it as invalid.
   Always use font-family explicitly. */

/* For monospaced contexts */
code, pre {
  font-family: ui-monospace, "SF Mono", "Cascadia Code", "Fira Code",
    Consolas, "Courier New", monospace;
}

/* For serif contexts (New York feel — no direct web equivalent exists) */
.reading-mode {
  font-family: ui-serif, "New York", Georgia, "Times New Roman", serif;
}
```

The `ui-monospace`, `ui-serif`, and `ui-sans-serif` CSS generic families resolve to the platform's native system font in their category — SF Mono, New York, and SF Pro respectively on Apple platforms. These are the closest legal web-font approximations. [documented — CSS Fonts Level 4 spec; system support: documented]

---

### CSS: In-App Type Scale Tokens (mirroring Dynamic Type defaults)

```css
:root {
  /* Matches iOS Dynamic Type defaults at "Large" content size */
  --type-large-title:  34px;  /* Regular, line-height ~41px */
  --type-title-1:      28px;  /* Regular, line-height ~34px */
  --type-title-2:      22px;  /* Regular, line-height ~28px */
  --type-title-3:      20px;  /* Regular, line-height ~25px */
  --type-headline:     17px;  /* Semibold, line-height ~22px */
  --type-body:         17px;  /* Regular, line-height ~22px */
  --type-callout:      16px;  /* Regular, line-height ~21px */
  --type-subhead:      15px;  /* Regular, line-height ~20px */
  --type-footnote:     13px;  /* Regular, line-height ~18px */
  --type-caption-1:    12px;  /* Regular, line-height ~16px */
  --type-caption-2:    11px;  /* Regular, line-height ~13px */

  /* Tracking (letter-spacing) mirroring Apple's size-tracking relationship */
  --track-caption-2:   0.06em;
  --track-caption-1:   0.05em;
  --track-footnote:    0.025em;
  --track-body:        0em;
  --track-title-3:    -0.008em;
  --track-title-2:    -0.01em;
  --track-title-1:    -0.014em;
  --track-large-title:-0.016em;
}

.type-large-title {
  font-size: var(--type-large-title);
  font-weight: 400;
  line-height: 41px;
  letter-spacing: var(--track-large-title);
}

.type-headline {
  font-size: var(--type-headline);
  font-weight: 600; /* semibold */
  line-height: 22px;
  letter-spacing: var(--track-body); /* 0 at 17px */
}

.type-body {
  font-size: var(--type-body);
  font-weight: 400;
  line-height: 22px;
  letter-spacing: 0;
}

.type-caption-1 {
  font-size: var(--type-caption-1);
  font-weight: 400;
  line-height: 16px;
  letter-spacing: var(--track-caption-1);
}
```

---

### CSS: Fluid Marketing Headlines (clamp-based)

```css
/* Apple-style marketing hero — fluid between 390px and 1440px viewports */
/* These clamp values produce the approximate apple.com mobile→desktop range  */

:root {
  --headline-hero:  clamp(3.5rem,  5.6vw + 1.7rem,  6rem);   /* 56px → 96px */
  --headline-h1:    clamp(3rem,    3.8vw + 1.5rem,  5rem);   /* 48px → 80px */
  --headline-h2:    clamp(2.5rem,  2.6vw + 1.2rem,  4rem);   /* 40px → 64px */
  --headline-h3:    clamp(2.125rem,1.6vw + 1.2rem,  3rem);   /* 34px → 48px */
  --headline-h4:    clamp(1.75rem, 1.2vw + 1.0rem,  2.5rem); /* 28px → 40px */
}

.marketing-hero {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: var(--headline-hero);
  font-weight: 700;               /* Bold — apple.com typically 700–800 for hero */
  line-height: 1.05;              /* Tight leading at display sizes — apple.com observed ~1.04–1.08 */
  letter-spacing: -0.04em;       /* Apple marketing tight tracking at hero sizes */
  color: #1d1d1f;                 /* Apple's near-black for light backgrounds */
}

.marketing-h1 {
  font-size: var(--headline-h1);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.03em;
}

.marketing-h2 {
  font-size: var(--headline-h2);
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.marketing-body {
  /* NOT fluid — stays at 17px, Apple's canonical body size */
  font-size: 17px;
  font-weight: 400;
  line-height: 1.47;             /* Apple uses ~1.47 leading ratio for body = ~25px */
  letter-spacing: 0;
  color: #1d1d1f;
}

.marketing-secondary {
  font-size: 17px;
  font-weight: 400;
  color: #6e6e73;                /* Apple's secondary gray — confirmed from devtools [observed] */
}
```

---

### SwiftUI: Text Style Usage

```swift
// Use semantic text styles — never hardcoded point sizes in production UI
Text("Hello")
    .font(.largeTitle)           // 34pt Regular, scales with Dynamic Type
    .font(.title)                // 28pt Regular
    .font(.title2)               // 22pt Regular
    .font(.title3)               // 20pt Regular
    .font(.headline)             // 17pt Semibold
    .font(.body)                 // 17pt Regular
    .font(.callout)              // 16pt Regular
    .font(.subheadline)          // 15pt Regular
    .font(.footnote)             // 13pt Regular
    .font(.caption)              // 12pt Regular
    .font(.caption2)             // 11pt Regular

// Custom font scaling WITH Dynamic Type
Text("Custom")
    .font(.custom("YourFont-Regular", size: 17, relativeTo: .body))
    // This scales at the same rate as .body when the user changes Dynamic Type size

// SF Mono
Text("let x = 42")
    .font(.system(.body, design: .monospaced))  // SF Mono at body size

// New York serif
Text("Chapter 1")
    .font(.system(.title, design: .serif))       // New York at title size

// Rounded
Text("99")
    .font(.system(.largeTitle, design: .rounded)) // SF Pro Rounded at large title

// Apply tracking manually (use sparingly — system tracking is already optimal)
Text("OVERLINE")
    .font(.caption)
    .tracking(1.5)    // positive = loose, negative = tight; in points not em

// Tight tightening for truncation (do NOT use for creative effect)
Text("Long label that might truncate")
    .allowsTightening(true)
```

---

### UIKit: Text Style + Optical Sizing

```swift
// Preferred font for text style — picks SF Pro Text or Display automatically
let label = UILabel()
label.font = UIFont.preferredFont(forTextStyle: .body)
label.adjustsFontForContentSizeCategory = true   // ← REQUIRED for Dynamic Type

// System font at explicit size — optical size automatically chosen
label.font = UIFont.systemFont(ofSize: 28, weight: .semibold)
// At 28pt, this is SF Pro Display Semibold automatically

// Monospaced numbers (for timers, scores — prevents layout shift)
label.font = UIFont.monospacedDigitSystemFont(ofSize: 17, weight: .regular)

// Allow tight tracking on truncation
label.allowsDefaultTighteningForTruncation = true
```

---

## Faithful Replication on the Web

### The Licensing Nuance

SF Pro, SF Compact, SF Mono, and New York are available to **registered Apple Developers** under a license that **explicitly prohibits:**
- Use on non-Apple operating systems
- Embedding in software programs distributed to end-users
- Network distribution (serving as web fonts)
- Sublicensing or transfer

This means: **you cannot legally @font-face embed SF Pro as a web font** for general audiences. [documented — Apple Font License agreement]

However: **on Apple devices themselves**, any webpage rendered in Safari or WebKit that uses `-apple-system` or `system-ui` will render in SF Pro. The font is available to the page — it is simply the operating system's system font, loaded by the system itself, not your server. [documented — WebKit behavior]

On non-Apple devices, `system-ui` will resolve to: Segoe UI (Windows), Roboto (Android), and equivalent native system fonts — which is fine for UI contexts but differs visually from SF Pro.

### Practical Replication Strategy

**For system UI on Apple platforms:** Use `system-ui` or `-apple-system` — you get genuine SF Pro for free on Apple devices without any licensing issue. [documented]

**For non-Apple browsers:** Accept the system font gracefully. The design rationale for using system fonts is: use what the user's OS considers readable. Do not shim SF Pro for Chrome on Windows.

**For marketing/brand pages that need visual SF-Pro feel on all platforms:** [inferred — observed from third-party practice]
- Use Inter (closest open-source geometric grotesque to SF Pro — similar x-height, aperture philosophy, variable weight axis)
- Or use Plus Jakarta Sans / Geist for similar optical characteristics
- Apply the tracking table above to compensate for Inter's slightly different default spacing
- These are approximations, not substitutes. Label them [inferred/speculative] in any design spec.

**Letter-spacing compensation:** Because SF Pro Display tightens tracking automatically above 20pt, when using Inter at display sizes on non-Apple platforms you should manually set negative tracking to approximate what SF Pro Display would do — use the table in the Apple Specifics section. [inferred]

**CSS `font-optical-sizing: auto`:** Modern browsers support this property, which tells the engine to use the optical size axis of a variable font automatically. If your chosen web font is a variable font with an `opsz` axis (e.g., Inter v4), this property will trigger similar Text→Display transitions. Set it in your base styles: [documented — CSS spec; Inter opsz support: documented for Inter v4]

```css
* {
  font-optical-sizing: auto; /* uses opsz axis if font supports it */
}
```

**Dynamic Type support in web content rendered inside WKWebView:** Use the `-apple-system-body` font family in CSS — this resolves to the system's current Dynamic Type body size inside an Apple web view, allowing web content to respond to the user's preferred text size setting. [documented — Apple WebKit extension]

```css
/* Inside WKWebView / Apple web view only */
body {
  font: -apple-system-body;
}
```

---

### CSS: Gradient-text accent (recipe)

Apple uses gradient-filled text on **single accent words or short phrases** inside marketing headlines — never entire paragraphs or whole headlines [observed — apple.com iPad Pro 2024 page, Apple Intelligence pages, WWDC banners; corroborated by community devtools reconstructions]. The technique is `background-clip: text` with a transparent text color.

**Real Apple usage pattern** [observed]:
- iPad Pro 2024 headline: "Thin. Light. **Mind‑blowing.**" — "Mind‑blowing" rendered in a warm purple-to-indigo gradient
- Apple Intelligence pages: the word "Intelligence" or a descriptor in a soft purple‑blue sweep
- WWDC keynote slide treatments: product names in a brand-gradient accent
- The gradient is **always on one phrase**, not the full sentence; surrounding words are solid `#1d1d1f` or `#f5f5f5`

**When Apple uses it vs. when it doesn't:**
- USE: One emotionally charged word or product name in a headline, on a light (white/near-white) or dark background where the gradient has contrast
- SKIP: Body copy, captions, navigation, any interactive element label, multi-line text blocks
- CONTEXT: Almost exclusively marketing/product pages; never in-app system UI

```css
/* ─────────────────────────────────────────────────────────────
   Gradient-text accent — Apple marketing pattern
   [observed — apple.com iPad Pro 2024, Apple Intelligence pages;
    technique confirmed documented — Safari background-clip:text
    first shipped Safari 3.2 (2008), Chrome 120+ unprefixed (Dec 2023)]
   ───────────────────────────────────────────────────────────── */

/* ── Core technique — always use both prefixed and unprefixed ── */
.gradient-text {
  /* Define the gradient on the element's background */
  background: linear-gradient(
    135deg,
    #bf5af2 0%,    /* Apple purple — matches system purple on Apple platforms [observed] */
    #6e6aee 50%,   /* indigo mid-point */
    #0a84ff 100%   /* Apple blue — system blue [observed] */
  );

  /* Clip the background to the text glyphs only */
  -webkit-background-clip: text; /* required for Safari [documented — Safari-first origin] */
  background-clip: text;         /* standard; Chrome 120+, Firefox, Edge [documented] */

  /* Make the text fill transparent so the background shows through */
  -webkit-text-fill-color: transparent; /* Safari/WebKit */
  color: transparent;                   /* standard fallback + Chromium */

  /* Prevent background from bleeding outside the text bounding box */
  background-size: 100%;
  display: inline;               /* block/inline-block also work; inline is safest for
                                    mid-sentence accent words */
}

/* ── Apple Intelligence / WWDC palette variant (warm-cool sweep) ── */
.gradient-text--intelligence {
  background: linear-gradient(
    120deg,
    #c686ff 0%,    /* soft violet [observed — Apple Intelligence glow palette] */
    #8d9fff 40%,   /* periwinkle blue */
    #f5b9ea 80%,   /* blush pink accent */
    #c686ff 100%   /* loop back to violet for a smooth sweep */
  );
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  background-size: 200% 100%;    /* oversized for animation potential */
}

/* ── Light-on-dark variant (white headlines with a color accent word) ── */
.gradient-text--warm {
  background: linear-gradient(
    90deg,
    #ff9f0a 0%,    /* Apple orange [observed] */
    #ff6b6b 100%   /* warm red */
  );
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

/* ── @supports guard — browser compatibility ──
   background-clip:text has broad support (Chrome 120+ unprefixed,
   Firefox 91+, Safari 3.2+) but the @supports guard ensures
   browsers that DON'T support it still render legible text. [documented] */
@supports not ((-webkit-background-clip: text) or (background-clip: text)) {
  .gradient-text,
  .gradient-text--intelligence,
  .gradient-text--warm {
    /* Fallback: render as a solid color — choose the gradient midpoint
       or your brand primary. NEVER leave color:transparent without this. */
    color: #6e6aee;                /* solid indigo — mid-point of the default gradient */
    -webkit-text-fill-color: initial;
  }
}
```

**HTML pattern — one accent word in a headline:**

```html
<!-- Correct: gradient on ONE phrase; surrounding text is solid -->
<h1 class="marketing-hero">
  Thin. Light. <span class="gradient-text">Mind&#8209;blowing.</span>
</h1>

<!-- Wrong: gradient applied to the entire headline -->
<!-- <h1 class="marketing-hero gradient-text">Thin. Light. Mind-blowing.</h1> -->
```

**Accessible fallback guidance** [documented — WCAG 2.1]:
- Gradient text does NOT have a single computable contrast ratio — browsers treat the text as transparent and evaluate the underlying background color against the page background.
- To pass WCAG AA: ensure the `color` fallback value (used when `@supports` fires) meets 4.5:1 against the page background. `#6e6aee` on white (#ffffff) is approximately 3.9:1 — borderline; use a darker value such as `#4c46c8` (≈7:1) in the fallback [inferred — WCAG contrast calculation; the live gradient rendering is browser/OS-dependent].
- In practice, Apple uses gradient text only at large display sizes (48px+) where WCAG AA large-text threshold (3:1) applies, which the gradient midpoints typically satisfy [observed + inferred].
- Do not apply gradient text to interactive elements (`<a>`, `<button>`) — focus rings and active states interact unpredictably with `color: transparent` [documented — known CSS pitfall].

**Vendor-prefix notes** [documented]:
- `-webkit-background-clip: text` was Apple's invention, shipped in Safari 3.2 (2008) — always include it.
- `-webkit-text-fill-color: transparent` is needed alongside `-webkit-background-clip` in older WebKit; `color: transparent` alone is not sufficient there.
- Chrome/Edge: unprefixed `background-clip: text` supported since Chrome 120 (December 2023). Include BOTH prefixed and unprefixed for full coverage.
- Firefox: unprefixed `background-clip: text` supported since Firefox 91 (2021). Does NOT need `-webkit-background-clip`.
- Minimum safe stack: `-webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent` — all four lines together.

---

## Anti-Patterns

### 1. Using SF Pro Display at small sizes (or SF Pro Text at large sizes)
If you manually load the font files in a design tool and use SF Pro Display below 20pt, you get tighter tracking than the text is designed for — characters feel cramped and apertures feel closed. Conversely, SF Pro Text above 20pt has excess spacing that makes headlines look airy and weak. The system switches for a reason. [documented]

### 2. Ignoring Dynamic Type — hardcoding point sizes in native apps
```swift
// WRONG
label.font = UIFont(name: "SFProText-Regular", size: 17) // ignores user preference
label.adjustsFontForContentSizeCategory = false           // explicitly opt-out is worse

// RIGHT
label.font = UIFont.preferredFont(forTextStyle: .body)
label.adjustsFontForContentSizeCategory = true
```
This shuts out users who depend on Large Text accessibility settings. Accessibility audits catch this. [documented]

### 3. Too-tight tracking on body text
Applying negative `letter-spacing` to text at 17px or smaller is an extremely common mistake that destroys legibility. Apple's tracking at 17pt is exactly 0. For anything at caption or footnote sizes (11–13pt), tracking should be **positive** (loosened). [documented]

```css
/* WRONG — makes 13px captions illegible */
.caption { letter-spacing: -0.02em; }

/* RIGHT */
.caption { letter-spacing: 0.025em; } /* positive at small sizes */
```

### 4. Faux-bold (CSS `font-weight: 800` on SF Pro)
SF Pro has defined weight instances. Requesting `font-weight: 800` when your system font has no 800 weight causes the browser/OS to synthesize bold by stroke-widening — which looks blurry and uneven. Use the available weights: 100 (Ultralight), 200 (Thin), 300 (Light), 400 (Regular), 500 (Medium), 600 (Semibold), 700 (Bold), 800 (Heavy), 900 (Black). When using `-apple-system`, all 9 weight stops are available on Apple devices. [documented]

### 5. Applying marketing tracking to body text
Apple's -0.04em hero headline tracking is appropriate at 80–96px. At 17px, that same tracking becomes approximately -0.68px — enough to make body text illegible. The tracking table is **not a flat ratio** — it is size-specific. [documented principle; inferred that applying flat ratio is wrong]

### 6. Line-height below 1.4 on body text
Apple's body text uses approximately 1.47 line-height (22px line-height at 17px size). Going tighter than 1.3 on any body or paragraph text — regardless of which font — sacrifices readability. [observed — apple.com devtools]

### 7. Using `font: -apple-system` shorthand
The `-apple-system` font family keyword behaves incorrectly in some browsers when used in the CSS `font` shorthand property (it can be parsed as a vendor prefix rather than a font name). Always use `font-family: -apple-system` separately, or replace with the standardized `system-ui`. [documented — CSS-Tricks]

### 8. Ignoring the optical size crossover in Figma
When designing in Figma using downloaded SF Pro fonts, Figma does not automatically switch between Text and Display. You must:
- Manually select SF Pro Text for type set at 19pt or smaller
- Manually select SF Pro Display for type at 20pt or larger
Failing this, your Figma file will have incorrect spacing that does not match the device render. [documented — design community practice]

---

## Sources

- [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography) — primary reference for Dynamic Type system, text styles, font families [documented]
- [Apple Fonts — developer.apple.com/fonts](https://developer.apple.com/fonts/) — licensing terms, font downloads, family overview [documented]
- [Apple System Fonts](https://developer.apple.com/fonts/system-fonts/) — platform-by-platform font availability [documented]
- [WWDC20 — The details of UI typography (session 10175)](https://developer.apple.com/videos/play/wwdc2020/10175/) — leading tables, emphasis weights, variable font transition range, macOS sizes [documented]
- [WWDC22 — Meet the expanded SF font family (session 110381)](https://developer.apple.com/videos/play/wwdc2022/110381/) — width variants (Condensed/Compressed/Expanded), Arabic system fonts [documented]
- [WWDC19 — Introducing SF Symbols (session 206)](https://developer.apple.com/videos/play/wwdc2019/206/) — baseline alignment, cap-height centering, typographic symbol spec [documented]
- [WWDC19 — WWDC Recap SF Symbols notes](https://erenkabakci.github.io/WWDC-Recap/WWDC19/Technical_Sessions/introducing_sf_symbols.html) — supplementary [documented]
- [The Secret of Apple's SF Fonts — Akinori Machino, Medium](https://medium.com/@amachino/the-secret-of-san-francisco-fonts-4b5295d9a745) — 20pt crossover, compact flat strokes [documented]
- [What should designers know about SF — Jan Marek, INLOOPX](https://medium.com/inloopx/what-should-mobile-designers-know-about-the-san-francisco-typeface-1faf5fa5d74f) — tracking references, Text vs Display 20pt [documented; specific tracking numbers: observed/inferred]
- [Why San Francisco — MartianCraft](https://martiancraft.com/blog/2015/10/why-san-francisco/) — design principles, x-height, aperture philosophy [documented]
- [Design Principles Applied to the SF Fonts — Jim Nielsen](https://blog.jim-nielsen.com/2019/design-principles-applied-to-sf-fonts/) — SF Text/Display weight availability [documented]
- [How to make typography right for every screen — Jagadeesh, Medium](https://medium.com/@iam.hari/how-to-make-typography-effortlessly-right-for-every-screen-size-1a82ece4926d) — fluid clamp() values, letter-spacing by scale [observed — reconstructed from devtools]
- [System Font Stack — CSS-Tricks](https://css-tricks.com/snippets/css/system-font-stack/) — font-family shorthand warning, browser support notes [documented]
- [New York font — Wikipedia](https://en.wikipedia.org/wiki/New_York_(2019_typeface)) — 4 optical sizes, 6 weights, variable font basis [documented]
- [SF Pro tracking — Sketch SF UI Font Fixer](https://github.com/kylehickinson/Sketch-SF-UI-Font-Fixer) — tracking values for design tool use [observed; approximate]
- [Apple Typography — Wikipedia](https://en.wikipedia.org/wiki/Typography_of_Apple_Inc.) — historical font timeline [documented]
- [iOS Dynamic Type complete — SwiftUI Prototyping](https://www.swiftuiprototyping.com/article/how-dynamic-type-sizes-work-in-swiftui/) — confirmed default (Large) values [documented]
- [Supporting Dynamic Type — Use Your Loaf](https://useyourloaf.com/blog/supporting-dynamic-type/) — API patterns, style enumeration [documented]
- [How to Create Gradient Titles With CSS Like Apple's iPad Pro Page — RayRay, Better Programming](https://betterprogramming.pub/how-to-create-gradient-titles-like-apples-ipad-pro-page-a0647ec83e51) — CSS background-clip:text recreation of Apple's iPad Pro 2024 page [observed/inferred]
- [CSS: How to get the masked text effect from Apple's iPhone XR promo pages — Tommy George](https://www.tommygeorge.com/blog/css-how-to-apple-iphone-xr-masked-text/) — earliest documented recreation of Apple's gradient-text promo technique [observed]
- [Apple Intelligence Gradient — Magic Gradient](https://magicgradient.com/gradient/apple-intelligence/69ef1dc78caad39cf9fc353d) — extracted Apple Intelligence gradient palette [observed]
- [Apple Intelligence Glow Effects — GitHub / jacobamobin](https://github.com/jacobamobin/AppleIntelligenceGlowEffect) — hex values used in Apple Intelligence glow animation (BC82F3, F5B9EA, 8D9FFF, AA6EEE, etc.) [observed]
- [WebKit blog — background-clip border-area (WWDC25)](https://webkit.org/blog/16214/background-clip-border-area/) — confirms WebKit background-clip evolution; technique origin Safari 3.2 (2008) [documented]

---

**CONFIDENCE: 82% — Core Dynamic Type default values, optical size crossover, font licensing terms, and system font stack behavior are well-documented; the complete Dynamic Type scaling table across all 12 size categories and the exact SF Pro tracking numbers were not directly fetched (Apple's HIG requires JS rendering) and are represented as approximate/inferred values with explicit labels. Gradient-text section: technique is well-documented (Safari-origin, cross-browser support timeline); specific gradient color stops are observed from community devtools analysis + Apple Intelligence glow palette extraction — treat exact hex values as [observed/inferred], not canonical Apple design tokens.**
