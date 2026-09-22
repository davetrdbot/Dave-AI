# apple.com Marketing Page Design Language
Scope: The repeatable formula Apple uses on product landing pages (apple.com/iphone, /macbook-pro, /airpods, homepage) — page anatomy, typography, color, CTA voice, section pacing, and copy-paste code recipes. Era: 2024–2026.

---

## Principles

These are the transferable "why" values that drive every apple.com marketing page. They predate any individual design decision and explain why the formula is remarkably stable.

### 1. Product as sole hero
The product image is never competing with anything. It sits on a pure white or pure black field, lit like a jewel. Every other element — headline, tagline, CTA — is subordinate to it. There are no decorative elements, gradients behind it, or textures. The product earns the page. [observed]

### 2. One idea per section
Each full-bleed section communicates exactly one value proposition: battery life, camera, chip performance, sustainability. Never two. The scroll IS the narrative — it delivers feature beats the way a film delivers plot beats. Users who don't read still absorb the structure. [observed]

### 3. Restraint as premium signal
White space is not empty. It is the physical manifestation of confidence. Apple spends screen real estate the way luxury goods spend physical space — lavishly. A section with a 96px headline, a 20px subhead, and 160px of vertical padding above and below feels expensive because it IS expensive (in pixels). [observed]

### 4. Typography does the heavy lifting
Apple does not rely on color or decoration to create hierarchy. The system is: enormous headline (the claim) → mid-weight supporting copy (the proof) → link-style CTA (the action). No boxes, no borders, no cards in feature sections. Just type and space. [observed]

### 5. Scroll narrative with cinematic pacing
Product pages are structured like 5-act stories: Hero → Highlights reel → Deep feature chapters → Why buy here → Footer. Each chapter is a full-viewport moment. Scroll-driven animations (parallax product images, sticky headlines that animate out, video autoplay) reinforce this rhythm. [observed]

### 6. Why the formula is so stable (2010–2026)
Apple's web design has remained structurally identical for ~15 years because it is tightly coupled to their hardware release cadence: same page template, new product, new copy. Every design team iteration is additive (bento grids were added circa 2022; scroll animations deepened circa 2023) never subtractive. The formula's ROI is proven — it converts. Breaking it would require proving a better conversion rate, which Apple has not needed to do. [documented, inferred]

---

## Apple Specifics

### Page anatomy (section order — product page)

Observed across iphone, macbook-pro, airpods pages [observed]:

```
[0] Global sticky nav
[1] Product sub-nav (secondary, product-scoped)
[2] HERO — full-viewport: product name (H1) + tagline + 2 CTAs + hero image
[3] Highlights bento / feature card grid ("Get the highlights")
[4] Feature chapter 1 — full-bleed (Design / Materials)
[5] Feature chapter 2 — full-bleed (Camera / Performance)
[6] Feature chapter N … (4–8 chapters depending on product)
[7] Software ecosystem section (iOS / macOS integration)
[8] Accessories / ecosystem cross-sell
[9] "Why Apple is the best place to buy [product]" — value props grid
[10] Comparison / upgrade section
[11] Tech specs (linked, or inline at bottom)
[12] Footer
```

### Global nav bar

- **Position:** `position: sticky; top: 0; z-index: 9999` [observed]
- **Height:** ~44px total (line-height on nav links is 44px; padding is minimal) [documented — Apple HIG minimum tap target is 44pt, mirrored on web]
- **Background:** `rgba(255, 255, 255, 0.72)` with `backdrop-filter: saturate(180%) blur(20px)` — the "frosted glass" translucency inherited from iOS. When page is at top, background is fully transparent and fades to frosted as you scroll. [observed, inferred from HIG + community analysis]
- **Dark mode / dark sections:** When the hero section behind the nav is black, the nav background flips to `rgba(29, 29, 31, 0.72)` with the same blur. [observed]
- **Content:** Apple logo (SVG, center or left) · category links · search icon · bag icon. On product pages a secondary sub-nav sits immediately below with product-scoped links (Overview, Tech Specs, Compare, Buy). [observed]
- **Font:** SF Pro Text, ~14px, weight 400 for nav links; 17px weight 600 for active/current. [inferred from HIG + community analysis]
- **Max content width:** ~980–1068px centered, though the nav bar itself spans full viewport width. [inferred from observed layout]
- **Hover mega-menu:** On desktop, hovering a category opens a mega-menu panel with blurred/frosted background behind the links. Transition is ~300ms ease. [observed]

### Hero section

- **Layout:** Full viewport width, typically 100vh or close to it. Content is centered both horizontally and vertically. [observed]
- **Headline (H1):** Product name only ("iPhone 17 Pro", "MacBook Pro", "AirPods Pro"). Weight: 700–800 (bold/extrabold). Size: approximately 64–96px at desktop viewport (responsive; scales down to ~36–48px on mobile). [observed — exact px values require devtools, range is inferred from visual inspection]
- **Tagline:** Single sentence or fragment beneath the headline. ~24–32px, weight 400–500. Often the defining marketing claim. Examples: "Fast runs in the family. Now with M5, M5 Pro, and M5 Max." / "A big zoom forward." [observed]
- **CTAs:** Exactly two link-style CTAs: "Learn more >" and "Buy >". Styled as inline links with chevron, NOT button boxes. Font ~17px, weight 400, brand blue (#0071e3 or similar). The chevron is the affordance. [observed]
- **Hero image:** Product photography, typically centered below or behind text, no background texture, pure white or black field. At-rest state; scroll may trigger parallax or animation. [observed]
- **Background:** White (#ffffff) or pure black (#000000) — no in-between. The color choice is a product decision (dark = premium/pro, light = accessible/everyday). [observed]

### Feature sections (the "chapters")

Two sub-patterns exist:

**Full-bleed cinematic section:**
- Full viewport width, alternating white and black backgrounds
- Content: one large headline (48–72px bold), 2–4 lines of body copy (~17–19px), optional inline CTA
- Product image or video takes 60–80% of the section, centered or offset to one side
- Vertical padding: approximately 120–160px top and bottom [inferred — exact values require devtools]
- Text and image may be stacked (mobile-first) or side-by-side (desktop)
- Scroll-triggered: content fades/slides in; some sections have sticky pinned headlines while the product image animates in the background

**Bento highlight grid ("Get the highlights"):**
- Introduced circa 2022; appears on iPhone, MacBook Pro, AirPods pages [observed]
- Grid of 4–6 cards on a light gray (#f5f5f7 or similar) background
- Cards: rounded corners (~18–20px radius), white fill, feature title + brief description + illustration/video
- Cards are NOT equal size — the grid uses asymmetric layout (one wide card + two square, or 2×3)
- This section serves as the chapter-select / executive summary before the deep chapters

### Typography scale

Apple's web typography maps closely to the San Francisco / SF Pro system:

| Role | Approx size | Weight | Notes |
|---|---|---|---|
| Hero H1 (product name) | 64–96px | 700–800 | Responsive, centered |
| Hero tagline | 24–32px | 400–500 | Centered, below H1 |
| Chapter headline | 48–72px | 700 | Full-bleed section |
| Chapter subhead | 19–24px | 400 | 2–4 sentences max |
| Body / spec copy | 17px | 400 | Standard read size |
| CTA / nav | 14–17px | 400 | Link style, no box |
| Legal / footnote | 12px | 400 | Gray, footer/bottom |

Font family on web: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif` [observed via known Apple CSS patterns; SF Pro Display activates automatically at larger sizes]

Font sizing is fluid/responsive — Apple uses viewport-relative scaling (likely `clamp()` or vw-based) so headlines scale gracefully from 390px to 1680px viewports. [inferred]

### Color strategy

| Use | Value | Notes |
|---|---|---|
| White section bg | `#ffffff` | Default, most sections |
| Black section bg | `#000000` or `#1d1d1f` | Pro/premium chapters |
| Light gray bg | `#f5f5f7` | Bento grids, specs sections |
| Body text (on white) | `#1d1d1f` | Near-black, not pure black |
| Body text (on black) | `#f5f5f7` | Near-white |
| CTA / link blue | `#0071e3` | Brand blue, universal |
| Secondary text | `#6e6e73` | Descriptive copy, footnotes |

Color is NOT used decoratively. There is no gradient in content areas, no colored card backgrounds, no accent swatches. Color appears only in the product itself (device finishes, displays showing content) and in interactive CTA links. [observed]

### CTA copy voice

Apple's CTA vocabulary is radically constrained [observed]:

**Primary actions:** "Buy" · "Shop [Product]" · "Order now"
**Secondary exploration:** "Learn more >" · "Read more" · "Explore [Feature]"
**Consideration aids:** "Compare models" · "Get help buying" · "Check trade-in value"
**Supportive:** "Get your estimate" · "Find a store"

The ">" chevron after "Learn more" is a signature. It signals continuation, not completion. "Buy" is always the harder/darker/more prominent option. "Learn more" is always secondary/lighter. Never "Click here", never "Get started", never "Discover now". [observed]

### Section pacing rhythm

A product page delivers feature beats like music: loud → quiet → loud → quiet.

- Big hero (loud)
- Bento highlights card grid (quiet — overview)
- Full-bleed design/materials chapter (medium)
- Full-bleed performance chapter with video (loud — spec claims)
- Comparison grid (quiet — functional)
- "Why buy from Apple" (medium — trust signals)
- Footer (quiet — utility)

The page never has two consecutive loud full-bleed sections with the same background color — they alternate white/black to provide visual breathing room and signal a new chapter. [observed]

### Fat footer

Multi-column, dark-background footer [observed]:

- Background: `#f5f5f7` (light) for the content columns, `#d2d2d7` divider line, then a final dark strip with legal text
- 8–9 content columns: Shop and Learn · Apple Wallet · Account · Entertainment · Apple Store · For Business · For Education · For Healthcare · Apple Values / About Apple
- Below columns: legal text, footnote explanations, country/region selector, copyright
- Font: 12px for most footer copy
- No visual decoration — pure text links in a grid

---

## Recipes

### Recipe 1: Sticky translucent nav

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Global Nav ── */
  .ac-gn {
    position: sticky;
    top: 0;
    z-index: 9999;
    width: 100%;
    height: 44px;
    /* Frosted-glass translucency — the Apple signature */
    background: rgba(255, 255, 255, 0.72);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
    transition: background 0.3s ease;
  }

  /* Dark variant — use when hero behind nav is black */
  .ac-gn.dark {
    background: rgba(29, 29, 31, 0.72);
    border-bottom-color: rgba(255, 255, 255, 0.1);
  }

  .ac-gn-inner {
    max-width: 1024px;
    margin: 0 auto;
    padding: 0 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 100%;
  }

  .ac-gn-logo svg {
    width: 14px;
    height: 44px;
    fill: #1d1d1f;
    display: block;
  }
  .ac-gn.dark .ac-gn-logo svg { fill: #f5f5f7; }

  .ac-gn-links {
    display: flex;
    list-style: none;
    gap: 0;
  }

  .ac-gn-links a {
    display: flex;
    align-items: center;
    height: 44px;
    padding: 0 10px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 12px;
    font-weight: 400;
    color: #1d1d1f;
    text-decoration: none;
    letter-spacing: -0.01em;
    white-space: nowrap;
    opacity: 0.85;
    transition: opacity 0.15s ease;
  }
  .ac-gn.dark .ac-gn-links a { color: #f5f5f7; }
  .ac-gn-links a:hover { opacity: 1; }

  .ac-gn-actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .ac-gn-actions a {
    display: flex;
    align-items: center;
    height: 44px;
    font-size: 12px;
    color: #1d1d1f;
    text-decoration: none;
    opacity: 0.85;
  }
  .ac-gn.dark .ac-gn-actions a { color: #f5f5f7; }

  @media (max-width: 768px) {
    .ac-gn-links { display: none; } /* Mobile: hamburger pattern */
  }
</style>
</head>
<body>
<nav class="ac-gn" role="navigation" aria-label="Apple">
  <div class="ac-gn-inner">
    <!-- Apple logo SVG (minimal apple shape) -->
    <a class="ac-gn-logo" href="/" aria-label="Apple">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 44" aria-hidden="true">
        <path d="M13.0729 17.6825c.0392 3.4062 2.9006 4.5394 2.9006 4.5394s-1.9468 5.5534-4.5759 5.5534c-1.2046 0-2.1407-.8112-3.4123-.8112-1.2953 0-2.5273.8355-3.4115.8355C2.0882 27.7596 0 22.4097 0 17.5875 0 12.8477 2.8497 10.3672 5.5508 10.3672c1.2421 0 2.2758.8125 3.0621.8125.7504 0 1.9232-.8605 3.4125-.8605 1.3286 0 3.2793.8091 4.0475 2.9633zm-2.0842-5.3264c.9604-1.2145 1.6029-2.9112 1.4295-4.6082-1.5116.0845-3.3272 1.0604-4.3105 2.2758-.9487 1.1108-1.7516 2.8381-1.5389 4.5001 1.6678.1286 3.3797-.9014 4.4199-2.1677z"/>
      </svg>
    </a>

    <!-- Primary navigation links -->
    <ul class="ac-gn-links" role="list">
      <li><a href="/store/">Store</a></li>
      <li><a href="/mac/">Mac</a></li>
      <li><a href="/ipad/">iPad</a></li>
      <li><a href="/iphone/">iPhone</a></li>
      <li><a href="/watch/">Watch</a></li>
      <li><a href="/vision/">Vision</a></li>
      <li><a href="/airpods/">AirPods</a></li>
      <li><a href="/tv-home/">TV &amp; Home</a></li>
      <li><a href="/entertainment/">Entertainment</a></li>
      <li><a href="/accessories/">Accessories</a></li>
      <li><a href="/support/">Support</a></li>
    </ul>

    <!-- Icon actions -->
    <div class="ac-gn-actions">
      <a href="/search/" aria-label="Search apple.com">
        <svg width="15" height="44" viewBox="0 0 15 44" fill="currentColor" aria-hidden="true">
          <path d="M14.298 27.202l-3.87-3.87c.798-1.145 1.274-2.542 1.274-4.048C11.702 15.6 8.898 12.8 5.351 12.8 1.804 12.8-1 15.6-1 19.284c0 3.684 2.804 6.484 6.351 6.484 1.506 0 2.903-.476 4.048-1.274l3.87 3.87c.196.195.452.293.709.293.257 0 .512-.098.709-.293.39-.39.39-1.024 0-1.162zm-8.947-2.435C3.01 24.767 1 22.756 1 20.284c0-2.47 2.01-4.48 4.48-4.48 2.47 0 4.48 2.01 4.48 4.48 0 2.47-2.01 4.483-4.48 4.483z"/>
        </svg>
      </a>
      <a href="/shop/bag" aria-label="Shopping Bag (0 items)">
        <svg width="14" height="44" viewBox="0 0 14 44" fill="currentColor" aria-hidden="true">
          <path d="M13 13.5h-2c0-2.209-1.791-4-4-4s-4 1.791-4 4H1c-.553 0-1 .447-1 1v16c0 .553.447 1 1 1h12c.553 0 1-.447 1-1v-16c0-.553-.447-1-1-1zm-6 13c-1.105 0-2-.895-2-2s.895-2 2-2 2 .895 2 2-.895 2-2 2zm3-13H4c0-1.657 1.343-3 3-3s3 1.343 3 3z"/>
        </svg>
      </a>
    </div>
  </div>
</nav>
</body>
</html>
```

---

### Recipe 2: Hero section

```html
<style>
  /* ── Hero ── */
  .ac-hero {
    width: 100%;
    min-height: 100svh; /* full viewport, respects mobile browser chrome */
    background: #000; /* or #fff for light hero */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding-top: 80px; /* below sticky nav */
    padding-bottom: 80px;
    text-align: center;
    overflow: hidden;
  }

  .ac-hero--light { background: #fff; }

  .ac-hero__eyebrow {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    font-size: 19px;
    font-weight: 600;
    color: #6e6e73;
    letter-spacing: 0;
    margin-bottom: 8px;
  }
  .ac-hero--light .ac-hero__eyebrow { color: #6e6e73; }

  .ac-hero__headline {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    font-size: clamp(48px, 6vw, 96px);
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: -0.015em;
    color: #f5f5f7;
    margin: 0 auto 12px;
    max-width: 800px;
    padding: 0 20px;
  }
  .ac-hero--light .ac-hero__headline { color: #1d1d1f; }

  .ac-hero__tagline {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    font-size: clamp(19px, 2.5vw, 28px);
    font-weight: 400;
    line-height: 1.3;
    color: rgba(245, 245, 247, 0.8);
    margin: 0 auto 28px;
    max-width: 600px;
    padding: 0 20px;
  }
  .ac-hero--light .ac-hero__tagline { color: rgba(29, 29, 31, 0.72); }

  /* CTA row — two link-style CTAs, NOT button boxes */
  .ac-hero__ctas {
    display: flex;
    gap: 24px;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 48px;
  }

  .ac-cta {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 17px;
    font-weight: 400;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    transition: opacity 0.15s ease;
  }
  .ac-cta:hover { opacity: 0.7; }

  /* Primary CTA — filled pill (used on dark backgrounds) */
  .ac-cta--primary {
    color: #fff;
    background: #0071e3;
    border-radius: 980px; /* Apple's "stadium" radius */
    padding: 12px 22px;
    font-weight: 400;
  }
  .ac-cta--primary:hover { background: #0077ed; opacity: 1; }

  /* Secondary CTA — link style with chevron */
  .ac-cta--secondary {
    color: #2997ff; /* blue on dark */
  }
  .ac-hero--light .ac-cta--secondary { color: #0071e3; }
  .ac-cta--secondary::after { content: " ›"; }

  /* Hero product image */
  .ac-hero__image {
    width: 100%;
    max-width: 980px;
    margin: 0 auto;
    padding: 0 20px;
  }
  .ac-hero__image img {
    width: 100%;
    height: auto;
    display: block;
  }
</style>

<section class="ac-hero ac-hero--light">
  <!-- Optional eyebrow (new product indicator) -->
  <!-- <p class="ac-hero__eyebrow">New</p> -->

  <h1 class="ac-hero__headline">MacBook Pro</h1>

  <p class="ac-hero__tagline">
    Fast runs in the family.<br>Now with M5, M5 Pro, and M5 Max.
  </p>

  <div class="ac-hero__ctas">
    <a href="#" class="ac-cta ac-cta--primary">Buy</a>
    <a href="#" class="ac-cta ac-cta--secondary">Learn more</a>
  </div>

  <div class="ac-hero__image">
    <img
      src="/images/macbook-pro-hero.jpg"
      alt="MacBook Pro Space Black"
      loading="eager"
      width="980"
      height="600"
    >
  </div>
</section>
```

---

### Recipe 3: Alternating full-bleed feature section

```html
<style>
  /* ── Feature Chapter ── */
  .ac-feature {
    width: 100%;
    background: #fff;
    padding: 120px 20px;
    text-align: center;
  }

  .ac-feature--dark {
    background: #000;
  }

  .ac-feature__inner {
    max-width: 980px;
    margin: 0 auto;
  }

  /* Optional category label above headline */
  .ac-feature__label {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-transform: none;
    color: #6e6e73;
    margin-bottom: 8px;
  }
  .ac-feature--dark .ac-feature__label { color: #6e6e73; }

  .ac-feature__headline {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    font-size: clamp(36px, 4.5vw, 64px);
    font-weight: 700;
    line-height: 1.08;
    letter-spacing: -0.01em;
    color: #1d1d1f;
    margin: 0 auto 16px;
    max-width: 700px;
  }
  .ac-feature--dark .ac-feature__headline { color: #f5f5f7; }

  .ac-feature__body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 19px;
    line-height: 1.47;
    font-weight: 400;
    color: rgba(29, 29, 31, 0.72);
    max-width: 560px;
    margin: 0 auto 32px;
  }
  .ac-feature--dark .ac-feature__body { color: rgba(245, 245, 247, 0.72); }

  .ac-feature__cta {
    display: inline-flex;
    align-items: center;
    font-size: 17px;
    font-weight: 400;
    color: #0071e3;
    text-decoration: none;
    transition: opacity 0.15s ease;
  }
  .ac-feature--dark .ac-feature__cta { color: #2997ff; }
  .ac-feature__cta::after { content: " ›"; }
  .ac-feature__cta:hover { opacity: 0.7; }

  .ac-feature__media {
    margin-top: 60px;
    width: 100%;
    border-radius: 0; /* full-bleed images have no radius */
    overflow: hidden;
  }
  .ac-feature__media img,
  .ac-feature__media video {
    width: 100%;
    height: auto;
    display: block;
  }

  /* Stat callout — inline number highlight */
  .ac-feature__stat {
    display: block;
    font-size: clamp(64px, 8vw, 120px);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #1d1d1f;
    line-height: 1;
    margin: 24px 0 8px;
  }
  .ac-feature--dark .ac-feature__stat { color: #f5f5f7; }
  .ac-feature__stat em {
    font-style: normal;
    font-size: 0.45em;
    vertical-align: super;
    letter-spacing: 0;
    font-weight: 600;
  }
</style>

<!-- White section -->
<section class="ac-feature">
  <div class="ac-feature__inner">
    <p class="ac-feature__label">Performance</p>
    <h2 class="ac-feature__headline">New dimensions in power.</h2>
    <p class="ac-feature__body">
      A19 Pro delivers 40 percent better sustained performance
      than the previous generation. For the tasks that matter most.
    </p>
    <a href="#" class="ac-feature__cta">Learn more about the chip</a>

    <div class="ac-feature__media">
      <img src="/images/a19pro-chip.jpg" alt="A19 Pro chip" width="980" height="600" loading="lazy">
    </div>
  </div>
</section>

<!-- Dark section — next chapter -->
<section class="ac-feature ac-feature--dark">
  <div class="ac-feature__inner">
    <p class="ac-feature__label">Battery life</p>
    <h2 class="ac-feature__headline">All-day. And then some.</h2>

    <!-- Big stat callout -->
    <span class="ac-feature__stat">33<em>hrs</em></span>

    <p class="ac-feature__body">
      The longest battery life ever in a MacBook Pro.
      Do more without looking for a plug.
    </p>
    <a href="#" class="ac-feature__cta">See battery testing methodology</a>

    <div class="ac-feature__media">
      <img src="/images/battery-lifestyle.jpg" alt="MacBook Pro in use all day" width="980" height="600" loading="lazy">
    </div>
  </div>
</section>
```

---

### Recipe 4: Fat footer

```html
<style>
  /* ── Footer ── */
  .ac-footer {
    width: 100%;
    background: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }

  /* Legal / footnotes strip */
  .ac-footer__footnotes {
    max-width: 980px;
    margin: 0 auto;
    padding: 24px 20px;
    border-bottom: 1px solid #d2d2d7;
    font-size: 12px;
    line-height: 1.5;
    color: #6e6e73;
  }
  .ac-footer__footnotes p { margin-bottom: 6px; }

  /* Nav columns */
  .ac-footer__nav {
    max-width: 980px;
    margin: 0 auto;
    padding: 32px 20px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 24px 16px;
    border-bottom: 1px solid #d2d2d7;
  }

  .ac-footer__col-title {
    font-size: 12px;
    font-weight: 600;
    color: #1d1d1f;
    margin-bottom: 12px;
  }

  .ac-footer__col-links {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ac-footer__col-links a {
    font-size: 12px;
    font-weight: 400;
    color: #6e6e73;
    text-decoration: none;
    line-height: 1.4;
    transition: color 0.15s ease;
  }
  .ac-footer__col-links a:hover { color: #1d1d1f; }

  /* Bottom legal bar */
  .ac-footer__legal {
    max-width: 980px;
    margin: 0 auto;
    padding: 20px 20px 24px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .ac-footer__copyright {
    font-size: 12px;
    color: #6e6e73;
    flex: 0 0 100%;
    margin-bottom: 8px;
  }

  .ac-footer__legal-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    list-style: none;
  }

  .ac-footer__legal-links a {
    font-size: 12px;
    color: #6e6e73;
    text-decoration: none;
    border-right: 1px solid #d2d2d7;
    padding-right: 16px;
  }
  .ac-footer__legal-links li:last-child a { border-right: none; }
  .ac-footer__legal-links a:hover { color: #1d1d1f; }

  .ac-footer__region {
    font-size: 12px;
    color: #6e6e73;
  }
</style>

<footer class="ac-footer" role="contentinfo">

  <!-- Footnotes / legal fine print above nav -->
  <section class="ac-footer__footnotes" aria-label="Footnotes">
    <p>¹ Testing conducted by Apple in October 2025. See apple.com/macbookpro for methodology and configuration details.</p>
    <p>² Apple Intelligence requires iPhone 16 or later, iPad mini (7th gen) or later with Apple silicon, or Mac with Apple silicon, with Siri and device language set to supported languages.</p>
  </section>

  <!-- Multi-column navigation -->
  <nav class="ac-footer__nav" aria-label="Footer navigation">
    <div>
      <p class="ac-footer__col-title">Shop and Learn</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Store</a></li>
        <li><a href="#">Mac</a></li>
        <li><a href="#">iPad</a></li>
        <li><a href="#">iPhone</a></li>
        <li><a href="#">Watch</a></li>
        <li><a href="#">Vision</a></li>
        <li><a href="#">AirPods</a></li>
        <li><a href="#">TV &amp; Home</a></li>
        <li><a href="#">AirTag</a></li>
        <li><a href="#">Accessories</a></li>
        <li><a href="#">Gift Cards</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">Apple Wallet</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Wallet</a></li>
        <li><a href="#">Apple Card</a></li>
        <li><a href="#">Apple Pay</a></li>
        <li><a href="#">Apple Cash</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">Account</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Manage Your Apple Account</a></li>
        <li><a href="#">Apple Store Account</a></li>
        <li><a href="#">iCloud.com</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">Entertainment</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Apple One</a></li>
        <li><a href="#">Apple TV+</a></li>
        <li><a href="#">Apple Music</a></li>
        <li><a href="#">Apple Arcade</a></li>
        <li><a href="#">Apple Fitness+</a></li>
        <li><a href="#">Apple News+</a></li>
        <li><a href="#">Apple Podcasts</a></li>
        <li><a href="#">Apple Books</a></li>
        <li><a href="#">App Store</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">Apple Store</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Find a Store</a></li>
        <li><a href="#">Genius Bar</a></li>
        <li><a href="#">Today at Apple</a></li>
        <li><a href="#">Group Reservations</a></li>
        <li><a href="#">Apple Camp</a></li>
        <li><a href="#">Apple Trade In</a></li>
        <li><a href="#">Financing</a></li>
        <li><a href="#">Order Status</a></li>
        <li><a href="#">Shopping Help</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">For Business</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Apple and Business</a></li>
        <li><a href="#">Shop for Business</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">For Education</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Apple and Education</a></li>
        <li><a href="#">Shop for K–12</a></li>
        <li><a href="#">Shop for College</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">Apple Values</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Accessibility</a></li>
        <li><a href="#">Education</a></li>
        <li><a href="#">Environment</a></li>
        <li><a href="#">Inclusion &amp; Diversity</a></li>
        <li><a href="#">Privacy</a></li>
        <li><a href="#">Racial Equity and Justice</a></li>
        <li><a href="#">Supply Chain</a></li>
      </ul>
    </div>

    <div>
      <p class="ac-footer__col-title">About Apple</p>
      <ul class="ac-footer__col-links">
        <li><a href="#">Newsroom</a></li>
        <li><a href="#">Apple Leadership</a></li>
        <li><a href="#">Career Opportunities</a></li>
        <li><a href="#">Investors</a></li>
        <li><a href="#">Ethics &amp; Compliance</a></li>
        <li><a href="#">Events</a></li>
        <li><a href="#">Contact Apple</a></li>
      </ul>
    </div>
  </nav>

  <!-- Bottom legal bar -->
  <div class="ac-footer__legal">
    <p class="ac-footer__copyright">Copyright © 2026 Apple Inc. All rights reserved.</p>
    <ul class="ac-footer__legal-links" role="list">
      <li><a href="#">Privacy Policy</a></li>
      <li><a href="#">Terms of Use</a></li>
      <li><a href="#">Sales and Refunds</a></li>
      <li><a href="#">Legal</a></li>
      <li><a href="#">Site Map</a></li>
    </ul>
    <p class="ac-footer__region">United States</p>
  </div>

</footer>
```

---

## Faithful Replication

Assembling a credible apple.com-style marketing page, section by section:

### Step 1: Set the document baseline

```css
:root {
  --apple-black: #1d1d1f;
  --apple-white: #f5f5f7;
  --apple-gray: #6e6e73;
  --apple-blue: #0071e3;
  --apple-blue-dark: #2997ff; /* blue on dark bg */
  --apple-bg-gray: #f5f5f7;
  --apple-divider: #d2d2d7;
  --apple-font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
  --apple-max-w: 980px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  font-family: var(--apple-font);
  font-size: 17px;
  line-height: 1.47;
  color: var(--apple-black);
  background: #fff;
  -webkit-font-smoothing: antialiased;
}
```

### Step 2: Layer sections in the correct order

1. **Sticky nav** (Recipe 1) — always present, always translucent
2. **Sub-nav** (product-scoped) — thin bar, same bg as nav, links to page sections
3. **Hero** (Recipe 2) — 100svh, product name large, tagline, 2 CTAs, hero image
4. **Bento grid** — `#f5f5f7` background, 4–6 asymmetric rounded cards
5. **Feature chapters** (Recipe 3) — alternate white/black, one big claim each
6. **Value props** — contained section, 3–4 column icon grid ("Why Apple")
7. **Comparison table** — gray bg, product model columns, checkmarks
8. **Footer** (Recipe 4)

### Step 3: Apply the whitespace rule

Every full-bleed section needs at minimum `padding-block: 100px` at desktop. Hero needs `min-height: 100svh`. Never reduce these to fit more content — reduce content instead. If something feels too spacious, that is correct. If something feels crowded, remove an element. [observed principle]

### Step 4: Typography discipline

- **H1:** `clamp(48px, 6vw, 96px)` weight 700, letter-spacing `-0.015em`
- **H2 (chapter):** `clamp(36px, 4.5vw, 64px)` weight 700, letter-spacing `-0.01em`
- **Body:** `17px` / `19px` weight 400, `line-height: 1.47`, `color: rgba(29,29,31,0.72)` (not full black — this is a key Apple subtlety)
- **CTAs:** `17px` weight 400, no box, link-style with chevron `›`
- Never use more than 3 type sizes in a single section

### Step 5: CTA discipline

- Maximum 2 CTAs per section
- Primary is always "Buy" (pill button, `#0071e3`) or "Shop [product]"
- Secondary is always "Learn more ›" (link style, no border)
- Never "Sign up", "Get started", "Click here", or double "Buy" buttons
- On dark sections, "Buy" becomes `#fff` pill; "Learn more" becomes `#2997ff` link

### Step 6: Verify the dark/light rhythm

Draw the page as a stack of colored bars: W=white, B=black, G=gray. A healthy apple.com page looks like: `W → G → W → B → W → B → W → G(footer)`. Never W→W consecutive full-bleed sections. Never B→B. Bento and specs sections break the cadence with gray.

### Step 7: Scroll animations (progressive enhancement)

Use `@media (prefers-reduced-motion: no-preference)` to add:
- `opacity: 0; transform: translateY(24px)` on `.ac-feature__inner` → animate to `opacity:1; transform:none` on IntersectionObserver entry, `transition: opacity 0.7s ease, transform 0.7s ease`
- Parallax on hero image: bind to `window.scrollY`, apply `transform: translateY(calc(scrollY * 0.3px))`
- Sticky headline in chapter: `position: sticky; top: 80px` while product video plays underneath

---

## Nav scroll-state adaptation (recipe)

This section closes the gap left by Recipe 1: the static frosted nav code in Recipe 1 is always opaque. The real apple.com nav starts **fully transparent** at the top of the page and **fades into frosted glass as you scroll**. When a dark hero is behind the nav, the entire nav swaps to dark tokens. Done wrong, this produces the "washed-out gray nav over a black hero" defect that motivated this section.

### Behavior summary [observed]

| State | Background | Backdrop filter | Text / icon color | Border |
|---|---|---|---|---|
| At top of page (no scroll) | `transparent` | none | `#f5f5f7` (if dark hero) / `#1d1d1f` (if light hero) | none |
| Scrolled (any hero color) | `rgba(255,255,255,0.72)` | `saturate(180%) blur(20px)` | `#1d1d1f` | `rgba(0,0,0,0.1)` |
| Scrolled, over dark section | `rgba(29,29,31,0.72)` | `saturate(180%) blur(20px)` | `#f5f5f7` | `rgba(255,255,255,0.1)` |

> **Key observation:** Apple's pages use dark-nav tokens ONLY when the hero itself is black. Once the user scrolls past the hero and into a mixed-color page, the nav reverts to the light frosted tokens regardless of what section is currently visible. The nav does NOT track section color as you scroll through the whole page — it only cares about the hero's color and whether you have scrolled at all. [observed, inferred from visual analysis]

### Transparent-at-top → frosted-on-scroll

**Why IntersectionObserver, not a scroll listener:** A scroll listener fires on every pixel of scroll and runs on the main thread — visible jank on lower-end devices. An IntersectionObserver fires once when a sentinel element exits the viewport, which is the correct trigger. [documented — pyk.sh, hweaver.com analysis]

**Step 1 — CSS token sets:**

```css
/* ── Nav scroll-state tokens ── */
.ac-gn {
  position: sticky;
  top: 0;
  z-index: 9999;
  width: 100%;
  height: 44px;

  /* At-top state: fully transparent */
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-bottom: 1px solid transparent;

  /* Smooth transition for all three properties */
  transition:
    background 0.3s ease,
    backdrop-filter 0.3s ease,
    -webkit-backdrop-filter 0.3s ease,
    border-color 0.3s ease,
    color 0.3s ease;
}

/* Scrolled state — light frosted (default) */
.ac-gn.is-scrolled {
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-bottom-color: rgba(0, 0, 0, 0.1);
}

/* Dark nav — two independent triggers:
   (a) hero is black AND we are NOT yet scrolled (transparent dark-tinted at-top state)
   (b) hero is black AND we ARE scrolled (dark frosted) */
.ac-gn.dark-hero {
  /* at-top over dark: give nav items light color so they read on black */
  color: #f5f5f7;
}
.ac-gn.dark-hero .ac-gn-links a,
.ac-gn.dark-hero .ac-gn-actions a,
.ac-gn.dark-hero .ac-gn-logo svg {
  color: #f5f5f7;
  fill: #f5f5f7;
}

/* When scrolled AND hero is dark → dark frosted glass */
.ac-gn.is-scrolled.dark-hero {
  background: rgba(29, 29, 31, 0.72);
  border-bottom-color: rgba(255, 255, 255, 0.1);
  /* text/icon color already set by .dark-hero above */
}

/* When scrolled AND hero is light → override back to dark text */
.ac-gn.is-scrolled:not(.dark-hero) .ac-gn-links a,
.ac-gn.is-scrolled:not(.dark-hero) .ac-gn-actions a,
.ac-gn.is-scrolled:not(.dark-hero) .ac-gn-logo svg {
  color: #1d1d1f;
  fill: #1d1d1f;
}
```

**Step 2 — HTML sentinel element** (placed as the first child of the hero section, before any other content):

```html
<!-- Sentinel: when this element leaves the viewport the nav goes frosted -->
<div id="nav-sentinel" aria-hidden="true" style="
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  pointer-events: none;
"></div>
```

**Step 3 — IntersectionObserver JS:**

```js
// ── Nav scroll-state: transparent-at-top → frosted-on-scroll ──────────────
(function () {
  const nav = document.querySelector('.ac-gn');
  const sentinel = document.getElementById('nav-sentinel');
  if (!nav || !sentinel) return;

  const observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          // Sentinel visible → we're at the top → transparent
          nav.classList.remove('is-scrolled');
        } else {
          // Sentinel out of view → user scrolled → frosted
          nav.classList.add('is-scrolled');
        }
      });
    },
    {
      // No rootMargin or threshold needed — fires the moment the
      // 1px sentinel exits the viewport at the top. [inferred]
      threshold: 0,
    }
  );

  observer.observe(sentinel);
})();
```

**Step 4 — Dark-hero detection JS** (runs once at page load; does not change on scroll):

```js
// ── Nav dark-hero detection ───────────────────────────────────────────────
// Checks whether the page's hero section is dark-background.
// Two strategies depending on how sections are marked up:
//
//   Strategy A: sections carry data-nav-theme="dark" | "light"
//   Strategy B: fallback — read the hero's computed background-color
//
// Apple's real site likely uses an internal data attribute on each section
// that its nav JS reads at load time. [inferred from observed behavior]
(function () {
  const nav = document.querySelector('.ac-gn');
  const hero = document.querySelector('.ac-hero');
  if (!nav || !hero) return;

  // Strategy A: explicit data attribute (preferred — add to your hero markup)
  // e.g. <section class="ac-hero" data-nav-theme="dark">
  var navTheme = hero.getAttribute('data-nav-theme');
  if (navTheme === 'dark') {
    nav.classList.add('dark-hero');
    return;
  }

  // Strategy B: read computed background-color as luminance heuristic
  // Works without markup changes; slightly heavier (forces style recalc once).
  var heroBg = window.getComputedStyle(hero).backgroundColor;
  // Parse rgb(r,g,b) or rgba(r,g,b,a)
  var match = heroBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    var r = parseInt(match[1], 10);
    var g = parseInt(match[2], 10);
    var b = parseInt(match[3], 10);
    // Relative luminance (WCAG formula, simplified) [documented — WCAG 2.1]
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (luminance < 0.25) {
      nav.classList.add('dark-hero');
    }
  }
})();
```

**Usage — hero markup:**

```html
<!-- Dark hero (black bg) — nav will use dark tokens -->
<section class="ac-hero" data-nav-theme="dark">
  <div id="nav-sentinel" aria-hidden="true" style="position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;"></div>
  <!-- … hero content … -->
</section>

<!-- Light hero (white bg) — nav will use light tokens (default) -->
<section class="ac-hero ac-hero--light" data-nav-theme="light">
  <div id="nav-sentinel" aria-hidden="true" style="position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;"></div>
  <!-- … hero content … -->
</section>
```

### Token reference

| Token name | Light nav | Dark nav | Notes |
|---|---|---|---|
| Nav bg (scrolled) | `rgba(255,255,255,0.72)` | `rgba(29,29,31,0.72)` | [observed from HIG + community analysis] |
| Backdrop filter | `saturate(180%) blur(20px)` | same | [observed — Apple signature] |
| Nav text | `#1d1d1f` | `#f5f5f7` | [observed] |
| Nav blue link | `#0071e3` | `#2997ff` | [observed] |
| Border | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.1)` | [inferred] |
| Transition | `0.3s ease` on bg/filter/color | same | [inferred from observed smoothness] |

### Common defect: washed-out nav over dark hero

This is the defect that motivated this section. It occurs when:

1. The nav background is already `rgba(255,255,255,0.72)` at the top of the page (Recipe 1 without this adaptation), OR
2. The `.dark-hero` class is not applied even though the hero is black.

Result: light frosted glass renders over a `#000` hero → the nav appears as a low-contrast gray band with dark text that is unreadable against the black section beneath it.

Fix: ensure the `dark-hero` class is on the nav at load-time, AND that the nav starts `transparent` (not frosted) at scroll position 0. Both conditions must be true simultaneously. [observed from defect analysis]

---

### Dark-default page section pacing

The existing "Section pacing rhythm" subsection documents the light-first `W → G → W → B → W → G(footer)` cadence for pages that are predominantly white. Some product pages (iPhone Pro, MacBook Pro Pro configurations, Mac Pro) are **dark by default throughout** — the majority of sections are black or near-black, with white sections as the exception. [observed]

**Dark-default cadence:**

```
#000000   ← Hero (pure black — maximum contrast for product image)
#1C1C1E   ← First feature chapter (elevated dark — slightly lighter, signals new section)
#000000   ← Second feature chapter (back to pure black)
#1C1C1E   ← Third feature chapter
  ↕  (alternates for remaining dark chapters)
#ffffff   ← ONE bright accent moment (specs callout / comparison / ecosystem)
#1C1C1E   ← Return to dark
#f5f5f7   ← Footer / specs (always light — utility sections stay light)
```

**Key rules for dark-default pages:** [observed + inferred]

- Alternate `#000000` ↔ `#1C1C1E` rather than repeating pure black for every section. The `#1C1C1E` (Apple's "elevated dark") reads as a distinct section break without introducing any bright contrast. A page with ten consecutive `#000000` sections feels like one undifferentiated tunnel. [observed]
- Reserve one `#ffffff` or `#f5f5f7` bright-moment section. This is where the comparison table, the "Why Apple" trust signals, or a key ecosystem integration shot lives. It functions as a palate cleanser and makes the surrounding dark sections feel more intentional rather than merely heavy. [observed]
- The bright-moment section placement is typically after the 4th–6th dark chapter — roughly 60–70% into the page scroll — timed to land when the user's attention needs refreshing before the conversion section. [inferred]
- CTA blue on dark sections shifts from `#0071e3` (light-bg blue) to `#2997ff` (dark-bg blue). Never use `#0071e3` directly over a `#000` or `#1C1C1E` background — it has insufficient luminance contrast. [observed — both values appear consistently on dark vs light sections]
- Text on `#1C1C1E` sections uses `#f5f5f7` (not pure `#ffffff`) as body color — same as on `#000000` sections. The visual difference between sections is achieved by background-color only, not by changing the text color. [observed]
- The footer reverts to `#f5f5f7` (light gray) regardless of the page's dark-default nature. Apple's footer is invariably light. [observed]

**Dark-default `.ac-feature` modifier:**

```css
/* Elevated dark — use to alternate with pure black sections */
.ac-feature--dark-elevated {
  background: #1c1c1e;
}
/* All text/cta colors are inherited from .ac-feature--dark already defined in Recipe 3 */
```

```html
<!-- Dark-default alternating rhythm -->
<section class="ac-feature ac-feature--dark">         <!-- #000 -->
<section class="ac-feature ac-feature--dark-elevated"> <!-- #1C1C1E -->
<section class="ac-feature ac-feature--dark">         <!-- #000 -->
<section class="ac-feature ac-feature--dark-elevated"> <!-- #1C1C1E -->
<section class="ac-feature">                          <!-- #fff — the one bright moment -->
<section class="ac-feature ac-feature--dark-elevated"> <!-- #1C1C1E — return -->
```

---

## Anti-patterns

These are the ways a "trying to look like Apple" implementation fails. Each is observable in poor imitations. [observed + inferred]

### 1. Cluttered hero
Putting a headline, tagline, 4 CTAs, a badge, and a supporting bullet list in the hero. Apple's hero contains: product name + one sentence + 2 links + one image. Full stop. More than this signals insecurity.

### 2. Button-box CTAs everywhere
Replacing "Learn more ›" link-style CTAs with rectangular outlined or filled button boxes. Apple uses filled pill buttons ONLY for the primary "Buy" action. Everything else is a link. Adding button borders around "Learn more" is the single most common off-brand failure.

### 3. Weak whitespace — "filling the void"
Reducing section padding from 120px to 40px because it "feels too empty." The emptiness IS the design. Filling space with decorative dividers, section labels, icon rows, or gradient overlays destroys the premium signal.

### 4. Off-brand type choices
Using system fonts at medium weight (400) for headlines instead of bold (700). Using serif fonts anywhere outside legal/footnote text. Using condensed or display fonts that aren't SF Pro. Apple's web type is always SF Pro / -apple-system, always properly weighted.

### 5. Busy backgrounds behind product
Adding texture, gradient, or ambient glow behind the product hero image. The product must be on pure white or pure black. Any background treatment competes with the product and signals a weaker product design.

### 6. Multiple competing H1s
Treating every section headline as an H1. Apple uses one H1 (the product name in the hero) and H2/H3 for chapter headlines. Search engines and screen readers both suffer when every section screams.

### 7. Color decoration
Adding brand-colored accents, gradient pills, colored section backgrounds, or multi-color text anywhere in the feature sections. Color appears only in the product's own photography and in CTA blue (#0071e3). Nowhere else.

### 8. Dark-mode OS flip without control
Allowing `@media (prefers-color-scheme: dark)` to invert the nav and sections uncontrolled. Apple's web pages explicitly control which sections are black and which are white — they do NOT follow the OS dark-mode toggle blindly. A white hero becoming black in dark OS mode is an anti-pattern.

### 9. Premature responsive collapse
Collapsing the desktop two-column feature layout to single-column at 1024px instead of ~768px. Apple's product pages maintain side-by-side layouts at tablet widths; the generous desktop max-width (~980px) means the layout doesn't need to collapse until genuinely narrow.

### 10. Spec-section overload in the main page flow
Embedding a full 30-row specs table inline in the marketing page instead of linking to a separate /specs/ page. Apple's marketing pages show 2–3 headline specs (the big stat callouts) and link "See tech specs ›" for the rest. Specs in marketing kill momentum.

---

## Sources

- apple.com homepage — fetched live 2026-05-22 [observed]
- apple.com/iphone/ — fetched live 2026-05-22 [observed]
- apple.com/macbook-pro/ — fetched live 2026-05-22 [observed]
- apple.com/airpods/ — fetched live 2026-05-22 [observed]
- apple.com/iphone-17-pro/ — fetched live 2026-05-22 [observed]
- apple.com/iphone-17-pro/specs/ — fetched live 2026-05-22 [observed]
- apple.com/mac/ — fetched live 2026-05-22 [observed]
- [A simple CSS guide to classy Apple-like navigation bar — Jeton Thaçi, Medium](https://jetonthaci.medium.com/a-simple-css-guide-to-classy-apple-like-navigation-bar-982a8dc52f9f) [documented — nav height 44px, font 14px, transition values]
- [Unveiling Apple's Web Design Secrets — doc4design.com](https://doc4design.com/unveiling-apples-web-design-secrets-menu/) [documented — mega-menu structure, nav categories]
- [Building iOS-like transparency effects in CSS — gesteves.com](https://www.gesteves.com/blog/2015/02/17/css-ios-transparency-with-webkit-backdrop-filter/) [documented — backdrop-filter pattern origin]
- [How to design a website like Apple's — DBS Interactive](https://www.dbswebsite.com/blog/how-to-design-a-website-like-apples/) [documented — SF Pro usage, mega-menu behavior, whitespace principles]
- [Apple Human Interface Guidelines — Typography](https://developer.apple.com/design/human-interface-guidelines/typography) [documented — type scale, SF Pro variants]
- [Apple Human Interface Guidelines — Layout](https://developer.apple.com/design/human-interface-guidelines/layout) [documented — 44pt minimum touch target, max-width conventions]
- [8 things I learned analyzing Apple's product pages — UX Planet](https://uxplanet.org/8-things-i-learned-analyzing-apples-product-pages-9a5284681b37) [documented — whitespace, scroll narrative, feature chunking]
- [What I Learned Recreating Apple's Landing Page — Rahul Kumar, Medium](https://medium.com/@roy30211/what-i-learned-recreating-apples-landing-page-a-ui-ux-case-study-86ef61359e41) [documented — design principles, whitespace discipline]
- [Designing a Brand: How Apple Built an Architectural Language — ArchDaily](https://www.archdaily.com/1040779/designing-a-brand-how-apple-built-an-architectural-language-of-glass-and-order) [documented — design language consistency reasoning]
- [Intersection Observer over Scroll Listener — pyk.sh (2025)](https://pyk.sh/blog/2025-10-01-intersection-observer-over-scroll-listener) [documented — IntersectionObserver sentinel pattern, class toggle approach, perf rationale over scroll listeners]
- [Intersection Observer Single Page Navigation — hweaver.com](https://www.hweaver.com/intersection-observer-single-page-navigation/) [documented — threshold 0.45 pattern, IntersectionObserver callback structure, `transition background-color 0.3s ease-in` timing]
- [WCAG 2.1 Relative Luminance formula](https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) [documented — luminance heuristic used in dark-hero detection fallback]
- apple.com/iphone/ — fetched live 2026-05-22 for dark-default pacing observation [observed]
- apple.com/mac/ — fetched live 2026-05-22 for dark-default pacing observation [observed]

---

**CONFIDENCE: 78% — Core page anatomy, CTA voice, section pacing, color strategy, and footer structure are high-confidence from direct live fetches; exact pixel values for nav height, section padding, and headline sizes are inferred/estimated from community analysis and HIG documentation since direct CSS inspection requires devtools access not available via web fetch.**
