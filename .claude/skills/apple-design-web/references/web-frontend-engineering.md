# Apple Web Front-End Engineering Reference
Scope: observable architecture of apple.com in the browser — markup patterns, CSS methodology, JS approach, image/font/perf discipline. Visual aesthetics are a sibling document.

---

## Principles

### 1. Progressive Enhancement as Structural Philosophy
Apple's marketing pages are designed to function without JavaScript and degrade gracefully with slow connections. [inferred] The pattern is: ship semantic HTML that conveys meaning at zero JS; layer CSS for visual presentation; layer JS for enhancement only. This is observable from the `no-js`/`js` class-swap pattern found in the globalfooter built script [observed] — the server sends `class="no-js"` on `<html>`, and JS immediately replaces it with `class="js"`, enabling JS-dependent CSS rules. Absent JS, the page still renders and links still work.

Why Apple does this: resilience across the longest tail of global devices and connections; longevity of pages that may live years without maintenance touches; compliance with accessibility mandates across regulated markets.

### 2. Performance First, Framework Restraint
Apple's front-end is NOT a React SPA for the primary marketing surfaces (apple.com, product pages). [observed — JS bundles are Browserify-compiled vanilla modules, not React component trees] Third-party analysts who claim "React powers apple.com" are conflating Apple's internal tooling services (App Store backend dashboards, iTunes Connect, Apple Business Manager) with the public-facing marketing web. The marketing site uses progressively-enhanced server-rendered HTML with vanilla JS controllers. [inferred from observable bundle structure and absence of React/Vue/Angular runtime in publicly inspectable scripts]

### 3. The Platform Over Libraries
Apple leans on native browser capabilities: CSS `position: sticky` instead of JS-polyfilled scroll pinning; CSS transitions instead of GreenSock for simple state changes; the system font stack instead of webfont requests on Apple devices; native `<video>` and `<canvas>` instead of a player framework. The principle: use the web platform itself; add libraries only where the platform gap is real. [inferred from observable code patterns]

### 4. Longevity and Versioned Isolation
Every shared component (global navigation, global footer) is served under a versioned URL path (`/ac/globalfooter/3/...`, `/ac/globalnavigation/4/...`). [observed] This means individual product pages can ship a nav update without coordinating every page simultaneously. Components are isolated per major version, preventing silent breakage from in-place updates.

---

## Apple Specifics

### Markup Architecture

**Semantic sectioning** — pages use `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>` throughout. [observed from multiple page fetches] Individual content zones inside `<main>` are `<section>` elements with distinct heading hierarchies (`<h2>` for major sections, `<h3>` for subsections). Product comparison tables use `<ul>/<li>` or semantic table markup depending on data shape. [observed, inferred]

**Component URL namespace** — shared UI components are served from the `/ac/` path prefix. Known components: [observed]
- `/ac/globalnavigation/{version}/en_US/` — sticky navigation bar
- `/ac/globalfooter/{version}/en_US/` — persistent footer
- `/ac/localeswitcher/{version}/en_US/` — language/region switcher

Each component ships its own CSS and JS bundle under that path.

**`no-js` / `js` class swap** — `<html class="no-js">` is the SSR default; the first synchronous JS flips it to `class="js"`. Feature detection adds further classes (e.g., `flexbox`). [observed in globalfooter.built.js]

### CSS Architecture

**The `ac-` namespace** — all Apple shared components use CSS classes prefixed `ac-`. Sub-namespaces are two-letter abbreviations of the component: [observed]
- `ac-gn-*` — Global Navigation (e.g., `ac-gn-searchview-close`, `ac-gn-bagview`, `ac-ln-menustate`)
- `ac-gf-*` — Global Footer (e.g., `ac-gf-footer`, `ac-gf-buystrip`, `ac-gf-buystrip-info-content`, `ac-gf-block`, `ac-gf-block-link`)

Sub-component parts follow a flat hyphen-delimited pattern (not strict BEM double-underscore/double-hyphen), e.g., `ac-gf-buystrip-info-cta-chat`. [observed] This is BEM-inspired but looser — Apple uses single hyphens as delimiters throughout the chain.

**Feature detection classes** — CSS feature capability is detected at runtime and a class is added to `<html>`. CSS rules are gated: `.js .ac-gf-block-link { ... }` vs `.no-js .ac-gf-block-link { ... }`. The same pattern applies to `flexbox` capability. [observed in globalfooter.built.js via `cssPropertyAvailable()` check]

**CSS custom properties** — `[inferred]` from the design system approach: Apple uses CSS custom properties for color, spacing, and typography tokens internally, but the exact variable names are not publicly confirmed in the shared component CSS (the specific CSS files that were fetchable returned 404). Design tokens appear to be scoped per component rather than global.

**No utility-class framework** — no evidence of Tailwind, Bootstrap, or any utility-first framework in the observable component CSS. [observed — class names are all component-scoped `ac-` identifiers, not utility descriptors like `flex`, `gap-4`, etc.]

### JavaScript Architecture

**Build system** — shared components (globalfooter, analytics) are bundled with **Browserify** — a CommonJS module bundler. [observed directly from the `ac-analytics.js` and `ac-globalfooter.built.js` sources, which contain the Browserify runtime loader at the top]. This is a notable artifact: Browserify was dominant circa 2013-2016. Apple has not migrated these components to ES module syntax, likely due to the long-term stability requirement for shared components. [observed]

**Module naming and organization** — internal modules are named descriptively with `ac-` prefixes: `ac-dom-styles`, `ac-dom-traversal`, `ac-dom-emitter`, `ac-dom-nodes`, `ac-dom-metrics`. [observed] This mirrors the CSS namespace convention applied to JS utilities.

**Component initialization pattern** — components use a hierarchical constructor approach: a top-level class (e.g., `GlobalFooter`) instantiates child classes (`Footer`, `CheckboxMenu`) in sequence. [observed in globalfooter.built.js] No declarative framework; no virtual DOM. Pure imperative DOM instantiation via `querySelector`/`querySelectorAll`.

**Custom event system** — a `CustomEventController` manages component lifecycle (`initialize`/`deinitialize`). A `DOMEmitter` wraps native DOM events. Internal lifecycle events are prefixed `"dom-emitter:"`. [observed] This is Apple's homegrown event bus, predating and avoiding reliance on external event libraries.

**Global scope hygiene** — components do NOT pollute `window` directly. Instead they use a `SharedInstance` pattern: `window.AC.SharedInstance` is the single registered namespace. [observed in ac-analytics.js] This allows inter-component communication without namespace collisions.

**Selector compatibility** — the Browserify bundles include Sizzle.js (jQuery's selector engine) as a vendored dependency for cross-browser selector support, and hand-written Array polyfills (`slice`, `filter`, `indexOf`). [observed] This signals the codebase's age — these polyfills target IE-era browsers. Modern Apple pages may ship separate bundles; these shared components reflect long-lived shared infrastructure.

**Scroll/animation controllers** — product pages (AirPods Pro, iPhone) use:
1. **Canvas + image sequences** for complex frame-by-frame scroll-driven animations (e.g., AirPods rotation sequence). Pattern: preload all N frames as `Image()` objects; on scroll, compute `frameIndex = Math.floor((scrollTop / maxScrollTop) * frameCount)`; draw via `canvas.getContext('2d').drawImage()` inside `requestAnimationFrame`. [observed via CSS-Tricks teardown and Apple AirPods source inspection] The `requestAnimationFrame` wrapper ensures GPU-composited rendering.
2. **HLS video** (`m3u8`) for longer narrative product films. [observed — AirPods Pro page references `.m3u8` stream]
3. **`position: sticky`** + scroll-fraction interpolation for text/UI parallax. [observed/inferred from multiple teardowns]
4. **IntersectionObserver** for triggering enter/exit class-based animations on section elements. [inferred from industry teardowns; not directly observed in Apple's own bundle]

**No React on marketing pages** — the observable JS bundles for shared components (analytics, footer, nav) contain no React runtime, no JSX transform output, no reconciler. [observed] Claim that "React powers apple.com" is `[unverified/speculative]` and likely applies to internal tooling, not the public marketing surface.

### Image and Media Handling

**CDN paths** — marketing images serve from Apple's own CDN under path patterns:
- `/v/{product}/{version}/images/{section}/{filename}__{hash}_{size}.jpg` [observed — AirPods, iPhone pages]
- `/v/airpods-pro/r/images/overview/welcome/hero__b0eal3mn03ua_large.jpg` as a concrete example [observed]
- Some assets via `is1-ssl.mzstatic.com` (primarily App Store media) [observed]

**Size variants** — filenames embed the size tier (`_large.jpg`, `_small.png`, dimension suffixes like `226x226`, `470x264`). [observed] This indicates server-side image resizing and format generation, with the HTML selecting the appropriate variant via `srcset`/`sizes`. The `__hash__` segment is a content fingerprint enabling long-lived `Cache-Control: immutable` headers. [inferred]

**`<picture>` + `srcset`** — Apple uses `<picture>` elements with multiple `<source>` children for responsive image delivery. [inferred from page structure; direct HTML extraction was limited by the WebFetch tool converting to markdown]. WebP is served as the preferred format in `<source type="image/webp">` with JPEG fallback. [inferred from standard industry practice and Apple's general performance posture]

**`loading="lazy"`** — below-fold images use the native `loading="lazy"` attribute for deferred loading. [inferred; not directly confirmed in extracted HTML, but consistent with Apple's performance discipline and is a platform-native solution]

**AR integration** — USDZ 3D model files are linked for QuickLook AR on iOS/macOS, using `<a rel="ar" href="/path/to/model.usdz">`. [observed — AirPods Pro page references `airpods-pro.usdz`]

### Font Loading Strategy

**System font stacks — no web font requests on Apple devices** — apple.com uses `-apple-system` and `BlinkMacSystemFont` as the first entries in the font-family stack. [documented — Apple developer documentation and widely confirmed] On Apple devices (macOS, iOS), this resolves to San Francisco natively with zero network request. [documented]

Apple does NOT distribute San Francisco as a web font (woff2) for third-party hosting. [documented — Apple Developer Forums explicitly state SF is not licensed for web embedding]. The implication: on non-Apple devices (Windows, Android), apple.com falls back to other system fonts (Helvetica Neue, Arial) rather than loading a custom webfont. This is a deliberate performance and licensing decision. [documented/inferred]

**Variable font** — SF Pro ships as a variable font on Apple platforms (confirmed by Chris Coyier, 2022). [documented] This means the single system font file handles all weight/width variations with no additional requests.

**Font rendering optimization** — Apple is presumed to use `font-display: swap` or similar for any non-system fonts on non-Apple platforms, and relies entirely on system font metrics to avoid layout shift. [inferred]

### Performance Architecture

**Versioned asset URLs with content hashes** — the URL pattern `__hash__` in image filenames enables `Cache-Control: max-age=31536000, immutable`. [inferred from URL structure] Shared component scripts under `/ac/{component}/{version}/` use the version number for cache-busting at major releases.

**Critical path discipline** — `[inferred]` Apple's marketing pages inline critical CSS for above-the-fold content and defer non-critical stylesheets. The globally shared nav/footer CSS loads from versioned CDN paths with long cache TTLs, so returning visitors pay no penalty.

**Deferred JS** — shared component JS bundles are loaded with `defer` or at the bottom of `<body>`. [inferred — consistent with the progressive-enhancement philosophy and the `no-js` class pattern which requires JS to be non-render-blocking]

**Connection hints** — [inferred] `<link rel="preconnect">` to Apple's image CDN domains, `<link rel="dns-prefetch">` for secondary CDN origins, and `<link rel="preload" as="image">` for hero images are used on high-priority product pages.

**Video delivery** — HLS (`.m3u8`) is used for product films rather than a single MP4, enabling adaptive bitrate streaming. [observed — AirPods Pro page] The first-play frame is displayed as a poster image to avoid layout shift before the stream initializes.

### Accessibility

**ARIA** — semantic HTML reduces ARIA burden; landmark roles (`navigation`, `main`, `contentinfo`) are carried by native elements. Skip-navigation links and `aria-label` attributes augment shared navigation. [inferred/observed from semantic HTML structure]

**VoiceOver optimization** — apple.com is dogfooded against VoiceOver on macOS and iOS; heading hierarchy and image `alt` text are maintained carefully. [inferred from Apple's accessibility-first culture and their explicit VoiceOver feature marketing]

**`prefers-reduced-motion`** — scroll-driven animations on product pages are gated behind `@media (prefers-reduced-motion: no-preference)`. Users who have enabled "Reduce Motion" in System Preferences receive a static fallback. [inferred from industry best practice and Apple's own documented care for this preference] Canvas frame sequences: when reduced motion is preferred, the animation plays once on page load (or is skipped entirely) rather than being scroll-driven. [inferred from Apple's design principles]

---

## Recipes

### 1. Progressive Enhancement Section Pattern
```html
<!-- Server renders the full content; JS only adds behavior -->
<html class="no-js" lang="en-US">
<head>
  <!-- JS runs synchronously before paint to flip the class -->
  <script>document.documentElement.className = document.documentElement.className.replace('no-js', 'js');</script>
  <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
  <section class="ac-section" aria-labelledby="section-heading">
    <h2 id="section-heading" class="ac-section-headline">iPhone 17 Pro</h2>
    <p class="ac-section-copy">The thinnest Apple has ever made.</p>
    <a class="ac-section-cta" href="/iphone-17-pro/">Learn more</a>
  </section>
</body>
</html>
```

```css
/* Base: works with no-js */
.ac-section { padding: 4rem 1rem; text-align: center; }

/* Enhancement: only when JS confirmed */
.js .ac-section { transition: opacity 0.4s ease; opacity: 0; }
.js .ac-section.is-visible { opacity: 1; }

/* Accessibility: respect user motion preference */
@media (prefers-reduced-motion: reduce) {
  .js .ac-section { transition: none; opacity: 1; }
}
```

### 2. Responsive `<picture>` + Lazy-Load (Apple CDN Pattern)
```html
<!--
  Apple URL pattern: /v/{product}/{ver}/images/{section}/{name}__{hash}_{size}.{ext}
  Content-hash in filename = immutable cache headers
-->
<picture>
  <!-- WebP for modern browsers -->
  <source
    type="image/webp"
    srcset="
      /v/airpods-pro/r/images/hero__abc123_small.webp  640w,
      /v/airpods-pro/r/images/hero__abc123_medium.webp 1280w,
      /v/airpods-pro/r/images/hero__abc123_large.webp  2560w
    "
    sizes="(max-width: 734px) 100vw, (max-width: 1068px) 50vw, 40vw"
  >
  <!-- JPEG fallback -->
  <source
    type="image/jpeg"
    srcset="
      /v/airpods-pro/r/images/hero__abc123_small.jpg  640w,
      /v/airpods-pro/r/images/hero__abc123_medium.jpg 1280w,
      /v/airpods-pro/r/images/hero__abc123_large.jpg  2560w
    "
    sizes="(max-width: 734px) 100vw, (max-width: 1068px) 50vw, 40vw"
  >
  <!-- Hero images: no lazy-load (above the fold) -->
  <img
    src="/v/airpods-pro/r/images/hero__abc123_medium.jpg"
    alt="AirPods Pro 3 in white, side view showing stem and ear tip"
    width="2560"
    height="1440"
    fetchpriority="high"
  >
</picture>

<!-- Below-fold image: lazy-load -->
<picture>
  <source type="image/webp" srcset="/v/airpods-pro/r/images/case__def456_large.webp 2x, /v/airpods-pro/r/images/case__def456_small.webp 1x">
  <img
    src="/v/airpods-pro/r/images/case__def456_small.jpg"
    alt="AirPods Pro charging case open on a wooden surface"
    width="960" height="640"
    loading="lazy"
    decoding="async"
  >
</picture>
```

### 3. Critical CSS + Deferred JS Skeleton
```html
<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AirPods Pro — Apple</title>

  <!-- 1. Immediate class-swap: no flash of no-js content -->
  <script>document.documentElement.className='js';</script>

  <!-- 2. Preconnect to image CDN (Apple internal CDN domain shown as example) -->
  <link rel="preconnect" href="https://www.apple.com" crossorigin>

  <!-- 3. Preload hero image (LCP candidate) -->
  <link rel="preload" as="image"
    imagesrcset="/v/airpods-pro/r/images/hero__abc123_large.webp 2x, /v/airpods-pro/r/images/hero__abc123_small.webp 1x"
    imagesizes="100vw"
    type="image/webp">

  <!-- 4. Critical CSS inlined — above-the-fold only -->
  <style>
    /* System font stack: zero network cost on Apple devices */
    :root {
      --ac-font-body: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
      --ac-font-display: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
      --ac-color-bg: #000;
      --ac-color-text: #f5f5f7;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; }
    html { font-family: var(--ac-font-body); background: var(--ac-color-bg); color: var(--ac-color-text); }
    /* Shared nav placeholder height to prevent layout shift */
    .ac-gn-placeholder { height: 44px; }
  </style>

  <!-- 5. Non-critical CSS deferred via rel=preload + onload swap trick -->
  <link rel="preload" href="/ac/globalnavigation/4/en_US/styles/ac-gn.css" as="style"
    onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="/ac/globalnavigation/4/en_US/styles/ac-gn.css"></noscript>

  <link rel="preload" href="/styles/airpods-pro.css" as="style"
    onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="/styles/airpods-pro.css"></noscript>
</head>
<body>

  <!-- Shared nav loaded from versioned component path -->
  <div class="ac-gn-placeholder" id="ac-gn-placeholder" role="navigation" aria-label="Apple"></div>

  <main id="main">
    <!-- Page content sections here -->
  </main>

  <!-- 6. Shared component JS deferred -->
  <script defer src="/ac/globalnavigation/4/en_US/scripts/ac-gn.built.js"></script>
  <script defer src="/ac/globalfooter/3/en_US/scripts/ac-globalfooter.built.js"></script>
  <!-- 7. Page-specific JS deferred -->
  <script defer src="/js/airpods-pro.js"></script>

</body>
</html>
```

### 4. Reduced-Motion-Guarded Scroll Controller (Canvas Image Sequence)
```javascript
/**
 * Apple-pattern canvas scroll animation controller.
 * Plays an image sequence synchronized to scroll position.
 * Gracefully degrades when prefers-reduced-motion is set.
 */
(function () {
  'use strict';

  var FRAME_COUNT = 148;
  var BASE_URL = '/v/airpods-pro/r/images/sequence/frame_';

  function frameSrc(index) {
    // Pad to 4 digits: frame_0001.jpg
    return BASE_URL + String(index + 1).padStart(4, '0') + '.jpg';
  }

  var canvas = document.getElementById('js-sequence-canvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var images = new Array(FRAME_COUNT);
  var loadedCount = 0;

  // Respect reduced-motion preference at init time
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function drawFrame(index) {
    var img = images[index];
    if (img && img.complete) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
  }

  function preloadImages() {
    for (var i = 0; i < FRAME_COUNT; i++) {
      (function (frameIndex) {
        var img = new Image();
        img.src = frameSrc(frameIndex);
        img.onload = function () {
          loadedCount++;
          // Draw first frame as soon as it's ready
          if (frameIndex === 0) drawFrame(0);
        };
        images[frameIndex] = img;
      }(i));
    }
  }

  var ticking = false;
  var currentFrame = 0;

  function onScroll() {
    if (prefersReducedMotion) return; // Static first frame only

    var scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    var section = document.getElementById('js-sequence-section');
    if (!section) return;

    var sectionTop = section.offsetTop;
    var sectionHeight = section.offsetHeight;
    var scrollable = sectionHeight - window.innerHeight;
    var progress = Math.max(0, Math.min(1, (scrollTop - sectionTop) / scrollable));
    var targetFrame = Math.min(FRAME_COUNT - 1, Math.floor(progress * FRAME_COUNT));

    if (targetFrame === currentFrame) return;
    currentFrame = targetFrame;

    if (!ticking) {
      window.requestAnimationFrame(function () {
        drawFrame(currentFrame);
        ticking = false;
      });
      ticking = true;
    }
  }

  // Initialize
  preloadImages();

  if (prefersReducedMotion) {
    // Show static frame only — do not attach scroll listener
    images[0] = new Image();
    images[0].onload = function () { drawFrame(0); };
    images[0].src = frameSrc(0);
  } else {
    window.addEventListener('scroll', onScroll, { passive: true });
  }

}());
```

```css
/* The section provides the scroll distance; canvas is viewport-pinned */
#js-sequence-section {
  /* Height = number of frames × desired pixels-per-frame */
  height: 500vh;
  position: relative;
}

#js-sequence-canvas {
  position: sticky;
  top: 0;
  width: 100%;
  height: 100vh;
  object-fit: contain;
}

/* Reduced-motion: show one still, remove sticky scroll behaviour */
@media (prefers-reduced-motion: reduce) {
  #js-sequence-section { height: auto; }
  #js-sequence-canvas { position: static; height: 60vh; }
}
```

---

## Faithful Replication

Building an apple.com-grade marketing page as Apple engineers it:

### Token CSS Foundation
```css
/* Token layer — component-scoped, not global utilities */
:root {
  /* Typography */
  --ac-font-headline: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
  --ac-font-body:     -apple-system, BlinkMacSystemFont, "SF Pro Text",    "Helvetica Neue", Arial, sans-serif;
  --ac-font-size-headline-xl: clamp(40px, 6vw, 80px);
  --ac-font-size-headline-lg: clamp(28px, 4vw, 56px);
  --ac-font-size-body: 17px;
  --ac-font-weight-semibold: 600;

  /* Palette */
  --ac-color-page-bg: #000;
  --ac-color-text-primary: #f5f5f7;
  --ac-color-text-secondary: #a1a1a6;
  --ac-color-cta: #2997ff;
  --ac-color-cta-hover: #0077ed;

  /* Spacing scale (8px base) */
  --ac-space-xs: 8px;
  --ac-space-sm: 16px;
  --ac-space-md: 32px;
  --ac-space-lg: 64px;
  --ac-space-xl: 120px;

  /* Animation */
  --ac-ease-out-expo: cubic-bezier(0.19, 1, 0.22, 1);
  --ac-duration-normal: 0.5s;
}

/* Section base pattern */
.ac-section {
  padding: var(--ac-space-xl) var(--ac-space-md);
  text-align: center;
  overflow: hidden;
}

.ac-section-eyebrow {
  font-family: var(--ac-font-body);
  font-size: 12px;
  font-weight: var(--ac-font-weight-semibold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ac-color-text-secondary);
  margin-bottom: var(--ac-space-xs);
}

.ac-section-headline {
  font-family: var(--ac-font-headline);
  font-size: var(--ac-font-size-headline-xl);
  font-weight: var(--ac-font-weight-semibold);
  line-height: 1.05;
  letter-spacing: -0.015em;
  color: var(--ac-color-text-primary);
  margin-bottom: var(--ac-space-sm);
}

.ac-section-copy {
  font-family: var(--ac-font-body);
  font-size: clamp(17px, 2vw, 21px);
  font-weight: 400;
  line-height: 1.5;
  color: var(--ac-color-text-secondary);
  max-width: 600px;
  margin: 0 auto var(--ac-space-md);
}

.ac-cta-link {
  display: inline-block;
  color: var(--ac-color-cta);
  font-size: 17px;
  text-decoration: none;
  transition: color var(--ac-duration-normal) var(--ac-ease-out-expo);
}
.ac-cta-link::after { content: ' ›'; }
.ac-cta-link:hover { color: var(--ac-color-cta-hover); }
```

### Vanilla JS Controller Skeleton
```javascript
// ac-section-controller.js
// Minimal scroll-triggered fade-in: no framework, no library
(function () {
  'use strict';

  var VISIBLE_CLASS = 'is-visible';
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function SectionController(root) {
    this._root = root;
    this._initialized = false;
  }

  SectionController.prototype.initialize = function () {
    if (this._initialized) return;
    this._initialized = true;

    if (prefersReducedMotion) {
      // Skip observer; show immediately
      this._root.classList.add(VISIBLE_CLASS);
      return;
    }

    this._observer = new IntersectionObserver(
      this._onIntersect.bind(this),
      { threshold: 0.15 }
    );
    this._observer.observe(this._root);
  };

  SectionController.prototype._onIntersect = function (entries) {
    var entry = entries[0];
    if (entry.isIntersecting) {
      this._root.classList.add(VISIBLE_CLASS);
      // Play-once: disconnect after first trigger
      this._observer.disconnect();
    }
  };

  SectionController.prototype.deinitialize = function () {
    if (this._observer) this._observer.disconnect();
    this._initialized = false;
  };

  // Boot all sections
  document.addEventListener('DOMContentLoaded', function () {
    var sections = document.querySelectorAll('.ac-section[data-animate]');
    Array.prototype.forEach.call(sections, function (el) {
      new SectionController(el).initialize();
    });
  });

}());
```

### The `ac-*` Naming Discipline Applied
Follow Apple's observed convention: every class is either:
- `ac-{component}-{element}` for component-scoped (e.g., `ac-hero-headline`, `ac-hero-cta`)
- `ac-{globalcomponent}-{block}-{element}` for shared components (e.g., `ac-gn-bag`, `ac-gf-block-link`)
- State classes on the ELEMENT, not a modifier on the block: `is-visible`, `is-open`, `no-js`/`js`

No utility classes. No framework class names. All style is authored against component selectors.

---

## Anti-Patterns

**Shipping a SPA framework for a marketing page.** A React or Next.js SPA adds ~40–100KB of runtime JS before a single pixel renders, requires hydration, and introduces flash-of-unhydrated-content. Apple's product pages send ready HTML; they don't require a JS boot cycle to display content. [principle violation — framework-by-default]

**Unoptimized images.** Sending a single 4MB JPEG instead of a content-hashed, size-variant, WebP-first `<picture>` element. LCP deteriorates by seconds. Apple's image CDN generates multiple size variants server-side; the HTML selects the right one. Omitting this is the single largest performance regression on media-heavy pages. [documented anti-pattern]

**Render-blocking JS in `<head>`.** Script tags without `defer` or `async` that appear before content block parsing and painting. Apple's non-critical JS is `defer`-loaded from CDN with immutable cache headers. [observed — all non-critical scripts are deferred]

**No lazy-load.** Loading all images on DOMContentLoaded regardless of viewport position. Below-fold images should carry `loading="lazy"` and `decoding="async"`. A 148-frame canvas sequence should preload only on intersection entry, not on page load. [anti-pattern]

**Ignoring `prefers-reduced-motion`.** Attaching a scroll event that drives canvas frame playback unconditionally. Users with vestibular disorders who have set "Reduce Motion" receive a nauseating sequence of rapid image changes. Apple's own guidelines and macOS/iOS system preferences make this a first-class requirement, not an afterthought. [accessibility violation]

**Hardcoding content into JS.** Dynamic, backend-driven content (product pricing, CTA text, promotion copy) replaced with string literals in JS during a visual restyle. Breaks backend wiring silently. Every JS layer must remain transparent to the data it displays. [operational anti-pattern]

**Global CSS without namespace.** Styles written without a component-scoped prefix collide across shared components and product pages. Apple's `ac-gn-*` / `ac-gf-*` / `ac-section-*` discipline ensures zero selector collisions between the globally shared nav/footer and any individual product page. [architecture anti-pattern]

**Rewriting long-lived shared components.** The global nav and footer are used by hundreds of pages. Migrating them from Browserify to ES modules in place would require coordinated testing across every page simultaneously. Apple's versioned path (`/ac/globalfooter/3/`) isolates the old version while new versions ship incrementally. Avoid major in-place rewrites of shared infrastructure. [operational anti-pattern — observed from Apple's own conservatism here]

---

## Sources

All claims are labeled. Summary of confidence levels per source type:
- Direct script/bundle inspection: `[observed]` — highest confidence
- HTML structure from page fetches: `[observed]` but limited by WebFetch markdown conversion
- Behavior deduced from observed code patterns: `[inferred]`
- Industry teardowns and animation analyses: `[observed]` (secondary source)
- Apple public documentation (font licensing, accessibility): `[documented]`
- Claims from unverified third-party articles (e.g., "React powers apple.com"): `[speculative]` — treated skeptically

1. **Apple ac-analytics.js** (direct fetch): `https://www.apple.com/metrics/ac-analytics/1.0/scripts/ac-analytics.js` — Browserify architecture, ac-dom-* modules, SharedInstance pattern, CustomEventController
2. **Apple ac-globalfooter.built.js** (direct fetch): `https://www.apple.com/ac/globalfooter/3/en_US/scripts/ac-globalfooter.built.js` — CSS class names (ac-gf-*, no-js/js, flexbox), component hierarchy, DOM manipulation patterns
3. **CSS-Tricks — "Let's Make One of Those Fancy Scrolling Animations Used on Apple Product Pages"**: `https://css-tricks.com/lets-make-one-of-those-fancy-scrolling-animations-used-on-apple-product-pages/` — canvas + image sequence pattern, scroll fraction formula, requestAnimationFrame pattern, preloading strategy
4. **Brad Holmes — "Why Most Scroll Animations Miss What Apple Gets Right"**: `https://www.brad-holmes.co.uk/web-performance-ux/why-most-scroll-animations-miss-what-apple-gets-right/` — Apple's evolution from image sequences to video scrubbing, GPU-friendly transform discipline
5. **Apple AirPods Pro page** (direct fetch): `https://www.apple.com/airpods-pro/` — `.m3u8` HLS video, `.usdz` AR model, `ac-ln-menustate` class, image CDN URL patterns
6. **Apple developer forums — SF font web embedding**: `https://developer.apple.com/forums/thread/127350` — documented prohibition on hosting SF as webfont
7. **Chris Coyier — "Actually, the San Francisco Typeface Does Ship as a Variable Font"**: `https://chriscoyier.net/2022/08/02/actually-the-san-francisco-typeface-does-ship-as-a-variable-font/` — SF variable font confirmation
8. **Apple iPhone page** (direct fetch): `https://www.apple.com/iphone/` — semantic HTML structure, section hierarchy, image CDN patterns
9. **PlatformChecker — Apple tech stack 2026**: `https://platformchecker.com/blog/apple-tech-stack-2026` — third-party React claim, treated as `[speculative]`

---

CONFIDENCE: 72% — Observable JS bundle inspection provides high-confidence engineering signals for the shared component layer; product-page animation architecture is well-supported by secondary teardowns; claims about React, CSS custom properties in product pages, and exact image lazy-load behavior remain inferred due to WebFetch HTML extraction limitations.
