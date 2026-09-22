# Apple-Style Scroll-Driven Storytelling Techniques
Scope: the six signature scroll techniques Apple uses on product pages — canvas/video frame scrubbing, sticky-pinned scenes, parallax layering, IntersectionObserver reveals, horizontal scroll galleries, and word/text reveal — with full working code recipes, trade-off analysis, performance guidance, and `prefers-reduced-motion` guards.

---

## The apple.com/iphone interaction inventory (commit to motion on flagship pages)

**On a flagship / marketing / product surface, motion IS the substance — a page with only static one-shot fades is a dead template, not an Apple-grade page.** The aliveness comes from binding things *continuously* to scroll (every pixel matters), not from sprinkling reveals. Commit to a real motion budget here. (This is the *flagship* end of the surface axis — keep it disciplined, not slop: see `apple-design`'s `references/restraint-and-antislop.md` → "The surface axis (how much motion is correct)". A flagship page needs BOTH aliveness AND restraint; utility surfaces get far less.)

> The reusable scroll engine — `mapRange`, the damped/lerped shadow-scroll value, and the pointer-reactive lerp loops — lives in the **MOTION** skill (`apple-design-motion/references/motion-animation.md`). Don't redefine the primitive here; this file composes it into page-level scenes. The damped-rAF lerp is the same physics as the springs documented there, applied to scroll instead of gesture.

**The signature "alive" behaviors, ranked by contribution to perceived liveliness** (from the apple.com/iphone interaction inventory, 2026-05-22):

| Rank | Behavior | Tier | This file |
|---|---|---|---|
| 1 | **Continuous damped scroll-progress transforms** — `opacity`/`translateY`/`scale`/`blur`/`clip-path` bound to a continuous 0→1 progress through a lerped *shadow* scroll value (`α ≈ 0.08–0.12`). The #1 differentiator vs a dead template. | **CORE — must consider** | engine in MOTION; composed throughout |
| 2 | **Sticky-pinned choreographed scenes** — one full-viewport scene held while many child layers animate through staggered sub-ranges of 0→1. | **CORE — must consider** | Recipe 2 |
| 3 | **Scroll-scrubbed hero** — image-sequence flipbook or `video.currentTime`, scroll-driven, never autoplay; product-detail flagship benchmark. | **CORE — must consider** (when content exists) | Recipe 1 |
| 4 | **Cross-section theme / background morph** — light↔dark chapter transitions driven by scroll; the macro effect that changes the page's emotional register. | **CORE — must consider** | NEW Recipe below |
| 5 | **Ambient / idle float** — slow looping CSS `animation` (6–12px, 4–7s, `alternate`) so the page breathes when scrolling stops. Cheap; its absence reads as "dead." | **CORE — must consider** | §10 params below |
| 6 | **Clip-path text wipe** — `clip-path: inset(0 0 100% 0)` → `inset(0)` per line, scroll-driven; reads as purposeful revelation, not a generic fade. | optional flourish (high value, low cost) | Recipe 3 / §7 |
| 7 | **Parallax depth layering** — `translateY` layers at 0.3–0.85× scroll; conservative (≤40–80px differential), always paired with a fade. | optional flourish | technique §3 below |
| 8 | **Horizontal snap gallery** — native `overflow-x` + `scroll-snap`, never wheel-hijacked; peeking card as the affordance. | optional flourish | Recipe 5 |
| 9 | **Pointer-reactive motion** — magnetic buttons (±8–12px), card tilt (±6–10°), spotlight-follow; desktop-only, `hover:hover` + `pointer:fine` gated. | optional flourish (desktop polish, do last) | engine in MOTION |

**Build sequence** (P0 first): damped scroll-progress primitive → sticky-pinned scene with progress-mapped children → cross-section theme morph → clip-path text wipe → image/video scrub hero → ambient float → pointer-reactive. Implement the CORE four-to-five before reaching for the flourishes.

**Confirmed *absent* on apple.com (absence is also Apple-grade):** no `scroll-behavior: smooth` on `<html>` (they lerp instead), no vertical page-level `scroll-snap`, no `perspective`/`rotateX` on the scroll axis (only in hover tilt), no scroll-jacking, no blanket `will-change`, no spring/overshoot on scroll reveals (scroll motion is always ease-out; springs are for gesture only).

---

## Principles

### Scroll as narrative pacing — not decoration
Apple treats the scrollbar as a timeline scrubber. The user's downward progress maps 1:1 to the story's progress: a product emerges from darkness, a chip shrinks to atomic scale, text crystallises word by word. Motion that cannot be cut without losing meaning earns its place; motion that is purely decorative is cut. [documented — multiple Apple HIG sources and design retrospectives corroborate this as an intentional editorial principle]

### Motion tied to user control
All heavy graphical sequences are scroll-locked, never auto-playing. The user can reverse, pause, or re-scrub at will. This satisfies `prefers-reduced-motion` at a design level (the user IS in control), while CSS/JS guards handle the accessibility layer. Auto-playing video loops are used only for ambient hero sections that carry no narrative information. [observed — inspecting apple.com product pages confirms scroll-driven canvas/video rather than auto-play for information-bearing sequences]

### Restraint and performance hierarchy
Apple separates two categories of motion:

- **Content motion**: opacity fades, gentle `translateY` slides on text and icons. Lightweight, CSS-transition-driven, no frame payload.
- **Graphical motion**: canvas image sequences or video scrubs. Heavy; reserved for 1–3 hero moments per page, never used for ambient decoration.

The split means a page can host a 148-frame JPEG sequence without feeling gratuitous — the sequence IS the content, not a garnish. [inferred from CSS-Tricks teardown + Brad Holmes analysis + observed page structure]

### Prefers-reduced-motion is a first-class citizen
Apple's product pages historically render a static keyframe (usually the "rest" state of the animation — mid-reveal or fully-assembled product) when `prefers-reduced-motion: reduce` is set. Frame sequences are not preloaded at all under reduced-motion. [documented — Apple developer accessibility guidelines; speculative on their exact implementation but consistent with best-practice and page-weight evidence]

---

## Apple Specifics

### 1. Canvas Image-Sequence Scroll Scrubber ("flipbook")

**How it works** [observed]:
- Hundreds of sequential JPEG frames (commonly 148–250+ frames per sequence, sometimes multiple per page) are hosted on `apple.com`'s CDN at paths like `/v/airpods-pro/q/images/meta/airpods-pro__..._{index}.jpg`.
- A `<canvas>` element is set `position: fixed` and centered. The page body height is artificially extended (e.g., `500vh`) to create a long scroll zone that drives the animation.
- On scroll, JavaScript maps `scrollTop / maxScrollTop` → `[0, 1]` → frame index. `requestAnimationFrame` calls `ctx.drawImage(img, 0, 0)` with the decoded frame.
- All frames are preloaded eagerly at page load into `Image` objects (which the browser caches in memory), so there is no network latency during scrubbing.

**Preloading strategy** [observed]:
- A tight loop instantiates `new Image()` for every frame, sets `.src`, and lets the browser's HTTP/2 multiplexing pipeline pre-fetch all frames. On fast connections this completes before the user reaches the first sticky section.
- On slow connections, Apple's pages fall back to displaying a static mid-sequence JPEG rather than a half-loaded animation. [inferred — consistent with observed mobile behavior but exact server-side detection mechanism unconfirmed]

**Evolution — video scrub** [documented — Brad Holmes analysis]:
- Newer pages (post-2022 era) increasingly use a compressed MP4/WebM instead of a JPEG sequence. A `<video>` element is placed off-screen or as a canvas source; `video.currentTime` is driven by scroll position.
- This reduces payload by ~60–80% vs. equivalent JPEG frames.
- Trade-off: `currentTime` seeking is unreliable on mobile — the browser's decoder may not surface a new frame before the next paint, producing dropped updates. Canvas + `ImageBitmap` decoded from video is the more robust hybrid.

**Performance** [documented]:
- Canvas `drawImage` with pre-decoded `Image` objects runs on the GPU compositing pipeline — no layout, no style recalc.
- Passive scroll listeners (`{ passive: true }`) prevent blocking the main thread.
- `requestAnimationFrame` debouncing ensures at most one draw per paint cycle (typically 60fps), not one per scroll event (which fires far faster).
- `will-change: transform` on the canvas signals the GPU to promote it to its own compositing layer.

### 2. Sticky Pinned Sections

**How it works** [observed + documented]:
- Each storytelling "chapter" is a tall `div` (typically `300vh`–`500vh` tall). Inside it, the visual content (canvas, hero image, product illustration) uses `position: sticky; top: 0; height: 100vh`.
- The sticky element appears to freeze in place while the parent scrolls past, giving JS a window of `200–400vh` of scroll travel to animate within.
- Text callouts inside the sticky container use `position: absolute` or separate sticky elements with offset `top` values; they slide in/out at specific scroll sub-thresholds.
- Sections chain: when one sticky chapter exhausts its parent scroll budget, the element unsticks and the next chapter's sticky element takes over. This creates the illusion of a continuous, scene-changing narrative.

**Key CSS pattern**:
```css
.chapter {
  height: 400vh;             /* scroll budget for this scene */
  position: relative;
}
.chapter__scene {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden;
}
```

### 3. Parallax Layering

**How it works** [observed]:
- Multiple `position: absolute` layers within a section move at different speeds: background at `0.2×` scroll, midground at `0.5×`, foreground product at `1×`.
- Apple applies `transform: translateY(scrollOffset * speedMultiplier)` to each layer on scroll, NOT `background-position` (which triggers paint) and NOT `top`/`margin` (which trigger layout). Transform is GPU-composited.
- Depth is augmented by scale: background layers scale down slightly as the user scrolls, simulating camera recession.

**Performance** [documented]:
- Only `transform` and `opacity` should be used. Animating `top`, `left`, `width`, `height`, `background-position` triggers layout or paint passes and causes jank.
- `will-change: transform` per layer; keep the count of promoted layers low (each consumes VRAM).

### 4. Scroll-Triggered Reveals / Fades

**How it works** [observed + documented]:
- Text lines, feature icons, and specification rows fade/slide in as they enter the viewport. Apple uses two implementation strategies in parallel:
  - **Classic JS**: `IntersectionObserver` with `threshold: 0.15` adds a `.is-visible` class, triggering a CSS `transition: opacity 0.6s ease, transform 0.5s ease`.
  - **Modern CSS**: `animation-timeline: view()` with `animation-range: entry 0% entry 60%` for browsers that support it (Chrome 115+, Safari 26+).
- Staggered children use `animation-delay` or sequential `IntersectionObserver` callbacks to create a cascade.

**Word/character reveal** [inferred]:
- Apple's headline reveals wrap each word (or sometimes each character) in a `<span>`. Each span has `opacity: 0; transform: translateY(12px)` initially.
- `IntersectionObserver` on the parent line fires once; JS then iterates spans with increasing delay offsets (e.g., `i * 40ms`), toggling `.revealed` which applies `opacity: 1; transform: translateY(0)`.
- Pure-CSS word reveal is achievable with `view()` timeline + `animation-delay` per span, but the JS approach gives finer control over the stagger curve.

### 5. Horizontal Scroll Galleries

**How it works** [observed]:
- Feature comparison rows or color-option galleries use `overflow-x: scroll; scroll-snap-type: x mandatory` on a flex container. No JavaScript needed.
- Apple suppresses the scrollbar (`scrollbar-width: none` / `::-webkit-scrollbar { display: none }`) to maintain the clean aesthetic while preserving native scroll momentum.
- On desktop, these sections are often static grids; on mobile they become horizontally scrollable with `scroll-snap-align: center` per item.

### 6. Text / Word Reveal on Scroll

**How it works** [inferred from observed page structure + documented IO patterns]:
- Large marketing headlines are split into word-level `<span>` elements. Initial state: `opacity: 0`.
- An `IntersectionObserver` on the containing `<h2>` triggers, then JS iterates spans adding a `.revealed` class with incremental delays.
- CSS handles the animation: `transition: opacity 0.5s ease, transform 0.4s ease`.
- Apple often pairs this with a color-shift (white → product color at mid-scroll) using `animation-timeline: view()` on the headline element's `color` property.

---

## Recipes

All recipes include `prefers-reduced-motion` guards. Copy-paste ready.

---

### Recipe 1: Canvas Image-Sequence Scroll Scrubber

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  html { height: 100vh; }

  body {
    background: #000;
    /* Tall enough to drive the full sequence */
    height: 500vh;
  }

  canvas {
    position: fixed;
    left: 50%;
    top: 50%;
    max-width: 100vw;
    max-height: 100vh;
    transform: translate(-50%, -50%);
  }

  /* Reduced-motion: show a static mid-frame, no JS scrubbing */
  @media (prefers-reduced-motion: reduce) {
    canvas { display: none; }
    .static-fallback { display: block; }
  }

  .static-fallback {
    display: none;
    position: fixed;
    inset: 0;
    background: url('/frames/0074.jpg') center/contain no-repeat;
  }
</style>
</head>
<body>

<canvas id="hero-canvas" width="1280" height="720"></canvas>
<div class="static-fallback" aria-hidden="true"></div>

<script>
  // ─── Configuration ────────────────────────────────────────────────
  const FRAME_COUNT = 148;
  const FIRST_FRAME = 1;

  // Build frame URL — replace with your CDN path
  const frameUrl = (index) =>
    `/frames/${String(index).padStart(4, '0')}.jpg`;

  // ─── Abort entirely if user prefers reduced motion ────────────────
  const prefersReduced = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  if (!prefersReduced) {
    const canvas = document.getElementById('hero-canvas');
    const ctx    = canvas.getContext('2d');

    // ─── Preload all frames ────────────────────────────────────────
    const frames = [];

    function preload(onDone) {
      let loaded = 0;
      for (let i = FIRST_FRAME; i <= FRAME_COUNT; i++) {
        const img = new Image();
        img.src = frameUrl(i);
        img.onload = () => {
          loaded++;
          if (loaded === FRAME_COUNT) onDone();
        };
        frames[i] = img;
      }
    }

    // Draw initial frame before preload completes
    const seed = new Image();
    seed.src = frameUrl(FIRST_FRAME);
    seed.onload = () => ctx.drawImage(seed, 0, 0, canvas.width, canvas.height);

    // ─── Scroll → frame mapping ────────────────────────────────────
    let rafPending = false;
    let currentFrameIndex = FIRST_FRAME;

    function getTargetFrame() {
      const scrollTop    = document.documentElement.scrollTop;
      const maxScrollTop = document.documentElement.scrollHeight
                         - window.innerHeight;
      const progress     = Math.max(0, Math.min(1, scrollTop / maxScrollTop));
      return FIRST_FRAME + Math.floor(progress * (FRAME_COUNT - 1));
    }

    function drawFrame(index) {
      const img = frames[index];
      if (!img || !img.complete) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      currentFrameIndex = index;
    }

    // rAF-throttled scroll handler — fires at most once per paint cycle
    window.addEventListener('scroll', () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        drawFrame(getTargetFrame());
        rafPending = false;
      });
    }, { passive: true });

    // Kick off preload after initial paint
    preload(() => {
      // Ensure current position is rendered with full-quality frames
      drawFrame(getTargetFrame());
    });
  }
</script>
</body>
</html>
```

**Key decisions**:
- `{ passive: true }` on scroll listener — cannot call `preventDefault`, but browser can parallelize scroll on a worker thread.
- `rafPending` flag ensures at most one `requestAnimationFrame` is queued per scroll burst.
- Preload loop fires all `Image` requests immediately; HTTP/2 pipeline handles concurrency.
- Under `prefers-reduced-motion`, the canvas is hidden; a single static JPEG covers the fixed viewport.

---

### Recipe 2: Sticky Pinned Scene

```html
<style>
  .chapter {
    /* Scroll budget — how long the scene stays pinned */
    height: 400vh;
    position: relative;
  }

  .chapter__scene {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chapter__callout {
    position: absolute;
    bottom: 15%;
    left: 10%;
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.6s ease, transform 0.5s ease;
  }

  .chapter__callout.is-visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Reduced motion: show all callouts statically */
  @media (prefers-reduced-motion: reduce) {
    .chapter__callout {
      opacity: 1 !important;
      transform: none !important;
      transition: none !important;
    }
  }
</style>

<section class="chapter" data-scene>
  <div class="chapter__scene">
    <!-- Heavy visual goes here: canvas, img, video poster -->
    <canvas id="scene-canvas" width="1280" height="720"></canvas>

    <!-- Callouts that appear at scroll sub-thresholds -->
    <div class="chapter__callout" data-threshold="0.3">
      <p>48MP Fusion camera</p>
    </div>
    <div class="chapter__callout" data-threshold="0.65">
      <p>Photographic Styles, evolved</p>
    </div>
  </div>
</section>

<script>
  const prefersReduced = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  if (!prefersReduced) {
    const scene      = document.querySelector('[data-scene]');
    const callouts   = scene.querySelectorAll('[data-threshold]');
    let   rafPending = false;

    window.addEventListener('scroll', () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        const rect     = scene.getBoundingClientRect();
        const traveled = -rect.top;              // px scrolled into this chapter
        const budget   = scene.offsetHeight - window.innerHeight;
        const progress = Math.max(0, Math.min(1, traveled / budget));

        callouts.forEach((el) => {
          const thresh = parseFloat(el.dataset.threshold);
          el.classList.toggle('is-visible', progress >= thresh);
        });

        rafPending = false;
      });
    }, { passive: true });
  }
</script>
```

---

### Recipe 3: IntersectionObserver Reveal (+ Word Stagger)

```html
<style>
  /* Default: elements start hidden */
  .reveal-block {
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.6s ease, transform 0.5s ease;
  }

  .reveal-block.is-visible {
    opacity: 1;
    transform: translateY(0);
  }

  /* Word-level spans */
  .word-reveal .word {
    display: inline-block;
    opacity: 0;
    transform: translateY(16px);
    transition: opacity 0.45s ease, transform 0.4s ease;
  }

  .word-reveal.is-visible .word {
    opacity: 1;
    transform: translateY(0);
  }

  /* Reduced motion: skip everything, show immediately */
  @media (prefers-reduced-motion: reduce) {
    .reveal-block,
    .word-reveal .word {
      opacity: 1 !important;
      transform: none !important;
      transition: none !important;
    }
  }
</style>

<h2 class="word-reveal">
  <!-- JS will split this into .word spans; provide a fallback -->
  <noscript>iPhone 16 Pro. Forged in titanium.</noscript>
</h2>

<div class="reveal-block">
  <p>The most powerful iPhone ever.</p>
</div>

<script>
  const prefersReduced = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  // ─── Word splitting ───────────────────────────────────────────────
  document.querySelectorAll('.word-reveal').forEach((el) => {
    const text = el.textContent.trim();
    el.innerHTML = text
      .split(/\s+/)
      .map((w, i) =>
        `<span class="word" style="transition-delay:${i * 45}ms">${w}</span>`
      )
      .join(' ');
  });

  if (!prefersReduced) {
    // ─── IntersectionObserver ────────────────────────────────────────
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            // Unobserve once revealed — no need to toggle back
            io.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.15,
        rootMargin: '0px 0px -60px 0px', // trigger slightly before viewport bottom
      }
    );

    document.querySelectorAll('.reveal-block, .word-reveal').forEach((el) => {
      io.observe(el);
    });
  }
</script>
```

---

### Recipe 4: Pure-CSS Scroll-Driven Animation (`animation-timeline: scroll()` / `view()`)

```css
/* ─── Browser support gate ──────────────────────────────────────────
   Chrome 115+, Edge 115+, Safari 26+. Firefox needs a flag.
   Wrap in @supports so unsupported browsers get no animation (graceful). */

/* ── 1. Page-progress bar using scroll() ────────────────────────── */
@supports (animation-timeline: scroll()) {
  #progress-bar {
    position: fixed;
    top: 0;
    left: 0;
    height: 3px;
    width: 100%;
    background: #0071e3; /* Apple blue */
    transform-origin: left center;

    animation: grow-bar linear;
    animation-timeline: scroll();   /* root scroller */
    /* animation-timeline must come AFTER animation shorthand */
  }

  @keyframes grow-bar {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
  }

  /* Reduced motion: hide the bar entirely */
  @media (prefers-reduced-motion: reduce) {
    #progress-bar { display: none; }
  }
}

/* ── 2. Element fade-in using view() ────────────────────────────── */
@supports (animation-timeline: view()) {
  .feature-card {
    /* Without this media guard, animation fires even under reduce */
    @media not (prefers-reduced-motion: reduce) {
      animation: fade-up linear both;
      animation-timeline: view();
      /* Animate during the first 40% of the element's viewport journey */
      animation-range: entry 0% entry 40%;
    }
  }

  @keyframes fade-up {
    from {
      opacity: 0;
      transform: translateY(32px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}

/* ── 3. Named scroll timeline (parent → child) ───────────────────── */
@supports (scroll-timeline: --named) {
  .pinned-chapter {
    overflow-y: scroll;
    height: 100vh;
    scroll-timeline: --chapter-scroll block;
  }

  .pinned-chapter .product-spin {
    @media not (prefers-reduced-motion: reduce) {
      animation: spin360 linear;
      animation-timeline: --chapter-scroll;
    }
  }

  @keyframes spin360 {
    from { transform: rotateY(0deg); }
    to   { transform: rotateY(360deg); }
  }
}
```

**Browser support summary** [documented — caniuse.com, MDN, WebKit blog 2025]:
| Feature | Chrome | Edge | Safari | Firefox |
|---|---|---|---|---|
| `animation-timeline: scroll()` | 115+ | 115+ | 26+ | Behind flag |
| `animation-timeline: view()` | 115+ | 115+ | 26+ | Behind flag |
| Named `scroll-timeline` | 115+ | 115+ | 26+ | Behind flag |

Use `@supports (animation-timeline: scroll())` as a feature gate. The polyfill `@scroll-timeline/polyfill` covers older browsers for production use.

---

### Recipe 5: Horizontal Snap Gallery (CSS only)

```html
<style>
  .gallery-track {
    display: flex;
    overflow-x: scroll;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;   /* iOS momentum */
    overscroll-behavior-x: contain;
    gap: 20px;
    padding: 0 5vw;

    /* Hide scrollbar but keep functionality */
    scrollbar-width: none;
  }
  .gallery-track::-webkit-scrollbar { display: none; }

  .gallery-card {
    flex: 0 0 80vw;
    max-width: 380px;
    scroll-snap-align: center;
    border-radius: 18px;
    overflow: hidden;
    background: #f5f5f7;
  }

  /* Reduced motion: disable snap momentum (still scrollable) */
  @media (prefers-reduced-motion: reduce) {
    .gallery-track { scroll-behavior: auto; }
  }
</style>

<div class="gallery-track" role="list" aria-label="Feature gallery">
  <article class="gallery-card" role="listitem">…</article>
  <article class="gallery-card" role="listitem">…</article>
  <article class="gallery-card" role="listitem">…</article>
</div>
```

---

### Recipe: Scroll-linked cross-section theme/background morph

The macro "aliveness" effect — light↔dark chapters that morph as you scroll, changing the page's emotional register (inventory §5; ranked #4). Three variants, in order of robustness. **All read the real scroll passively — none scroll-jack.**

**Variant A — IO discrete snap (most robust, recommend by default).** Flip a `data-theme` attribute when a chapter crosses the viewport center line; a short CSS `transition` does the ~400ms morph. Survives every browser; degrades to an instant theme swap.

> **⚠ Trigger on a center-line band, NOT `threshold: 0.5` (the easy silent-dead-morph bug).** A section taller than the viewport never reaches 50% visible — a **300–500vh PINNED chapter (which this file's Recipe 2 recommends)** peaks at `intersectionRatio ≈ viewportH / sectionH ≈ 0.28` and a `threshold: 0.5` observer **never fires** (the morph is dead, and it reads fine on a static screenshot). Observe a **zero-height band at viewport center** (`rootMargin: '-50% 0px -50% 0px', threshold: 0`) so it flips when the chapter crosses mid-screen **regardless of height**. `threshold: 0.5` is only safe when every themed section is ≤ viewport height.

```html
<section data-theme-section="light">…light chapter…</section>
<section data-theme-section="dark">…dark chapter…</section>
<section data-theme-section="light">…light chapter…</section>
```

```css
:root[data-theme="light"] { --page-bg: #f5f5f7; --page-text: #1d1d1f; }
:root[data-theme="dark"]  { --page-bg: #121212; --page-text: #f5f5f7; }

body {
  background-color: var(--page-bg, #f5f5f7);
  color: var(--page-text, #1d1d1f);
  /* CSS transition drives the morph (~400ms is Apple's feel) */
  transition: background-color 0.4s ease, color 0.4s ease;
}

/* Reduced motion: snap discretely, no fade between themes */
@media (prefers-reduced-motion: reduce) {
  body { transition: none; }
}
```

```js
// Center-line band: a 0-height observation strip at mid-viewport. A section is
// "intersecting" exactly while it crosses the center line — works for ANY height,
// including the 300–500vh pinned chapters this doc recommends (threshold:0.5 would
// silently never fire on those — see the ⚠ note above).
const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      document.documentElement.setAttribute(
        'data-theme', entry.target.dataset.themeSection
      );
    }
  });
}, { rootMargin: '-50% 0px -50% 0px', threshold: 0 });

document.querySelectorAll('[data-theme-section]').forEach((el) => io.observe(el));
```

**Variant B — continuous rAF lerp on CSS custom properties (smooth, widest compat).** Interpolate RGB toward the active chapter's theme each frame. Use the MOTION skill's damped shadow-scroll value to decide the target theme + boundary progress; lerp the *color* a touch slower than transforms (`α ≈ 0.05–0.12`). No CSS `transition` on the color here — it would fight the JS lerp.

```js
const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const THEMES = {                       // [r,g,b]
  light: { bg: [245, 245, 247], text: [29, 29, 31] },
  dark:  { bg: [18, 18, 18],    text: [245, 245, 247] },
};
const lerpColor = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

let curBg   = [...THEMES.light.bg];
let curText = [...THEMES.light.text];
const COLOR_LERP = 0.08;               // 0.05–0.12; lower = more lag

function activeTheme() {
  // Pick the chapter whose midpoint is nearest viewport center.
  let best = 'light', bestDist = Infinity;
  document.querySelectorAll('[data-theme-section]').forEach((el) => {
    const r = el.getBoundingClientRect();
    const dist = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
    if (dist < bestDist) { bestDist = dist; best = el.dataset.themeSection; }
  });
  return THEMES[best];
}

function tick() {
  const target = activeTheme();
  const t = motionOK ? COLOR_LERP : 1;   // reduced motion → snap (t=1)
  curBg   = curBg.map((v, i)   => v + (target.bg[i]   - v) * t);
  curText = curText.map((v, i) => v + (target.text[i] - v) * t);
  const r = document.documentElement.style;
  r.setProperty('--page-bg',   `rgb(${curBg.map(Math.round).join(',')})`);
  r.setProperty('--page-text', `rgb(${curText.map(Math.round).join(',')})`);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```
*(`body` reads `var(--page-bg)`/`var(--page-text)` as in Variant A, but with NO CSS `transition` on those properties.)*

**Variant C — CSS-native typed-color scroll timeline (Chrome 115+ / Safari 26+).** Zero JS, off-main-thread on Chrome. `@property` with `syntax: '<color>'` is REQUIRED — without a typed custom property the browser can't interpolate `rgb()` in scroll-driven keyframes. Gate behind `@supports` + `@media` so unsupported browsers and reduced-motion fall through to Variant A's discrete snap.

```css
@property --page-bg-c {
  syntax: '<color>';
  inherits: true;
  initial-value: #f5f5f7;
}

@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .chapter-dark {
      view-timeline-name: --dark-chapter;
      view-timeline-axis: block;
    }
    body {
      animation: theme-morph linear both;
      animation-timeline: --dark-chapter;
      /* morph as the dark chapter enters, completing by 30% in */
      animation-range: entry 0% entry 30%;
      background-color: var(--page-bg-c);
    }
    @keyframes theme-morph {
      from { --page-bg-c: #f5f5f7; }
      to   { --page-bg-c: #121212; }
    }
  }
}
```

**Nav coordination:** the sticky nav's text/logo color should flip with the active chapter (inventory §11) — drive it off the same `data-theme` attribute (Variant A) or the same active-chapter read (Variant B/C).

**Reduced motion (all variants):** snap to discrete themes — never morph through intermediate colors. Variant A drops its `transition`; Variant B sets the lerp factor to `1` (instant); Variant C falls through the `@media (prefers-reduced-motion: no-preference)` gate and you keep Variant A as the baseline.

| Param | Range | Note |
|---|---|---|
| IO trigger (Variant A) | center-line band `rootMargin:'-50% 0 -50%'` | height-independent; `threshold:0.5` only if sections ≤ viewport tall |
| Transition duration (A) | 300–500ms | ~400ms is Apple's feel; longer = sluggish |
| Color lerp `α` (B) | 0.05–0.12 | lower than transform lerp — color reads better slightly behind |
| `animation-range` (C) | entry 0% → entry 25–40% | controls how gradual the morph is |

---

### Recipe: Sticky-stacked cards (chaptered pinning)

A "deck of cards" stack — each card pins at a staggered `top`, earlier cards recede (scale + opacity) as later ones slide over them (inventory §6). Distinct from Recipe 2's sticky-pinned *scene*: there one container holds one scene with animating children; here the cards are **siblings**, each its own chapter. **Pure-CSS-first; the JS is an enhancement only.**

**Pure-CSS base (works with no JS):**

```html
<section class="card-stack">
  <article class="stack-card" style="--i: 0">Chapter 1</article>
  <article class="stack-card" style="--i: 1">Chapter 2</article>
  <article class="stack-card" style="--i: 2">Chapter 3</article>
</section>
```

```css
/* iOS Safari caveat: position:sticky is SILENTLY ignored if ANY ancestor has
   overflow: hidden / clip / auto / scroll. Keep the whole sticky chain free of it. */
.card-stack {
  isolation: isolate;          /* ensures z-index stacking context for the cards */
}

.stack-card {
  position: sticky;
  /* staggered pin — each card rests N px lower so the deck depth is visible */
  top: calc(16px + var(--i) * 14px);   /* ~12–24px stagger is Apple's range */
  z-index: calc(var(--i) + 1);          /* later cards sit on top */
  min-height: 80vh;                     /* cards ~70–90vh fill the viewport */
  margin-bottom: 24px;                  /* scroll budget between chapters */
  border-radius: 20px;                  /* Apple standard ~16–28px */
  background: #fff;
  transform: scale(1);
  /* snap when scrolling STOPS; while scrolling, JS drives transform directly */
  transition: transform 0.3s ease-out, opacity 0.3s ease-out;
  will-change: transform;
}

/* Reduced motion: drop the recede enhancement; cards still stack (that's layout, not motion) */
@media (prefers-reduced-motion: reduce) {
  .stack-card {
    transform: none !important;
    opacity: 1 !important;
    transition: none !important;
  }
}
```

**JS enhancement (recede buried cards) — strict read-then-write rAF batch:**

```js
const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const cards    = [...document.querySelectorAll('.stack-card')];

function tick() {
  if (!motionOK) return;   // CSS media query already shows the flat, stacked state

  // ─── READ phase — every getBoundingClientRect first (no interleaved writes) ───
  const rects = cards.map((c) => c.getBoundingClientRect());
  const tops  = cards.map((c) => parseFloat(getComputedStyle(c).top) || 0);

  // ─── WRITE phase — no layout reads here, so no thrash ───
  const SLOP = 4; // px: a card counts as "reached its pinned rest" within SLOP
  cards.forEach((card, i) => {
    const stuck = rects[i].top <= tops[i] + SLOP;             // card i has reached its pin
    let buried = 0;
    if (stuck) {
      // INVARIANT: detect burial RELATIVE to each card's own sticky top — never a
      // fixed pixel tolerance. A later card buries card i once it too has pinned (it
      // then sits on top via higher z-index). A fixed tolerance smaller than the
      // sticky-top stagger makes `buried` unreachable → the recede is dead code.
      for (let j = i + 1; j < cards.length; j++) {
        if (rects[j].top <= tops[j] + SLOP) buried++;         // later card pinned on top of i
      }
    }
    // scale(0.95 - 0.03*buriedLevels), clamped; opacity steps down per level
    const scale   = Math.max(0.85, 0.95 - 0.03 * Math.max(0, buried - 1) - (buried ? 0.05 : 0));
    const opacity = Math.max(0.6, 1 - buried * 0.12);          // floor 0.6 (OLED safety)
    card.style.transform = `scale(${(buried ? scale : 1).toFixed(3)})`;
    card.style.opacity   = (buried ? opacity : 1).toFixed(3);
  });

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

**Notes:**
- **iOS Safari sticky caveat (the #1 silent failure):** no `overflow: hidden`/`clip`/`auto`/`scroll` on *any* ancestor of a sticky card — Safari ignores the stickiness without error. The scroll container (the page) is the only place overflow may live.
- Keep the deck to **≤6–8 cards** — each sticky element adds compositor work.
- Only `transform`/`opacity` are mutated per frame (compositor-friendly); `will-change: transform` is set in CSS for the active stack rather than blanket-applied.
- The CSS `transition` only fires when scrolling stops (the rAF writes happen faster than 0.3s, so mid-scroll they read as continuous); this gives the "snap to rest" settle.
- **Reduced motion:** the stacking itself is layout and stays; only the scale/opacity recede is disabled. `tick()` early-returns and the CSS media query pins the flat state.
- **⚠ Burial detector invariant (the easy-to-ship-dead bug):** count a later card as burying card `i` **relative to its own sticky top** (`rects[j].top <= tops[j] + SLOP`), never against a fixed pixel tolerance from card `i`. A fixed tolerance smaller than the sticky-`top` stagger (e.g. tolerance `10` with a `14px/level` stagger) makes `buried` mathematically unreachable and the recede silently never fires.
- **Self-check (do this — a flat stack passes a static screenshot):** `console.log` `buried` while scrolling; it MUST climb 0→1→2… as later cards pin. If it stays 0, your tolerance is below the stagger. Walk the scroll, don't just open the first frame.

| Param | Range | Note |
|---|---|---|
| Sticky `top` stagger | 12–24px | visible depth; **burial `SLOP` is stagger-independent — don't tie it to this** |
| Scale per buried level | 0.03–0.06 reduction | floor ~0.85 |
| Opacity per buried level | 0.10–0.18 reduction | floor ~0.6 (OLED) |
| Card min-height | 70–90vh | fill the viewport |
| `margin-bottom` (scroll chapter) | 80–150vh equiv. | more = slower revelation |

---

## Faithful Replication

### Building an Apple-style scroll story end-to-end

**Step 1 — narrative outline first**
Map the product story beats to scroll zones before writing code. Each beat = one sticky chapter. Common structure:
```
[0–100vh]   Hero: product floating on black. Scroll indicator.
[100–500vh] Chapter 1: camera detail animates via frame sequence.
[500–800vh] Chapter 2: chip animation (CSS or lightweight GSAP).
[800–1100vh] Chapter 3: feature callouts, IntersectionObserver reveals.
[1100–1300vh] Chapter 4: horizontal color gallery.
[1300–1400vh] CTA: buy buttons, price, static.
```

**Step 2 — apply the decision tree**

> **Current-reality note (2026):** the live apple.com hero now leads with **`<video>`** (InlineMedia keyframe play + lazy scroll-triggered src + static start/end-frame JPEG fallback) and a **WebGL-3D** scene for the interactive product viewer — the canvas image-sequence "flipbook" below is the **classic pre-2022 alternative**, still valid for frame-exact control at low frame counts but no longer how Apple builds its marquee hero. Full video-first reverse-spec, encoding (`createImageBitmap` sliding-window decode, video `keyint=5`), and asset-sourcing/IP guardrails are in `media-assets-and-delivery.md`.

```
Asset type?
├─ Moving product / hardware detail (camera, chip, folding)
│   └─ Needs frame-by-frame control?
│       ├─ YES → Canvas image-sequence scrubber (Recipe 1)
│       │         Trade-off: ~10–40 MB frames; best quality & control
│       └─ NO  → Video scrub (video.currentTime driven by scroll)
│                 Trade-off: smaller payload; may drop frames on mobile
│                 Hybrid option: extract ImageBitmaps from video into array
│
├─ Text / icon reveal as user scrolls past
│   └─ Need precise stagger / JS control?
│       ├─ YES → IntersectionObserver + CSS transition (Recipe 3)
│       └─ NO  → CSS animation-timeline: view() (Recipe 4, simpler)
│                 BUT: add @supports gate; falls back to static for Firefox
│
├─ Progress indicator / parallax overlay
│   └─ CSS animation-timeline: scroll() (Recipe 4) — no JS needed
│
└─ Color / feature comparison gallery
    └─ CSS scroll-snap (Recipe 5) — zero JS
```

**Step 3 — performance checklist**
- [ ] Only `transform` and `opacity` are animated (no layout triggers).
- [ ] All canvas drawImage calls are inside `requestAnimationFrame`.
- [ ] Scroll listeners use `{ passive: true }`.
- [ ] Frame-sequence images are preloaded before first sticky section.
- [ ] `will-change: transform` applied to promoted layers; remove after animation.
- [ ] Page tested on a mid-tier Android phone, not just MacBook Pro.
- [ ] INP (Interaction to Next Paint) measured — scroll animations must not push INP > 200ms.

**Step 4 — reduced-motion contract**
Every animated element MUST have one of:
1. `@media (prefers-reduced-motion: reduce)` CSS block that shows a static state.
2. A JS `prefersReduced` guard that skips preload and scrubbing entirely.
3. A `@media not (prefers-reduced-motion: reduce)` wrapper around `animation-timeline` rules.

Never show information only inside an animation — the static fallback must be semantically complete.

---

## Anti-Patterns

### Scroll-jacking
Overriding native scroll behavior — intercepting `wheel` events, using `overflow: hidden` on `<html>` and simulating scroll in JS — is the single fastest way to create a broken experience. Browser momentum, trackpad inertia, keyboard navigation, and assistive technologies all depend on native scroll. Apple does NOT scroll-jack; the page scrolls normally, and JS reads the position. [documented — WCAG 2.3.3; observed on apple.com]

### Non-rAF scroll handlers
```js
// BAD: fires hundreds of times per second, paints thrash
window.addEventListener('scroll', () => {
  canvas.style.filter = `blur(${window.scrollY / 100}px)`;
});

// GOOD: one paint per frame
let pending = false;
window.addEventListener('scroll', () => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    canvas.style.filter = `blur(${window.scrollY / 100}px)`;
    pending = false;
  });
}, { passive: true });
```
Tokopedia's CSS scroll-driven animation migration reduced CPU from 50% → 2% by eliminating scroll event handlers entirely. [documented — Chrome for Developers case study]

### Huge unoptimised frame sets
- Serving 300 frames × 200 KB = 60 MB of un-compressed JPEG on mobile is not a performance strategy.
- Frame images must be: resized to canvas display size (not 4K), compressed (quality 60–75 for JPEG is imperceptible in motion), and served from CDN with aggressive cache headers.
- Consider WebP frames (~30% smaller than JPEG at equivalent quality) where Safari 14+ support is acceptable.
- Video scrub with a ~5 MB H.264 MP4 often beats 200 JPEG frames payload-wise; the trade-off is seek reliability on mobile. [documented — ghosh.dev benchmark: server pre-computed frames = 2.5s load vs. direct video currentTime = unreliable on mobile]

### No reduced-motion fallback
Skipping `prefers-reduced-motion` is not just an accessibility failure — it is a vestibular disorder trigger. Users who have set this OS preference can experience nausea from parallax and frame-scrub animations. Apple's own HIG calls out this requirement explicitly. The fix is one media query or one JS guard. There is no acceptable excuse to ship without it. [documented — Apple HIG, WCAG 2.3.3, MDN]

### Animating properties that trigger layout or paint
```css
/* BAD: triggers layout recalculation on every frame */
.parallax { top: calc(var(--scroll) * 0.5px); }

/* GOOD: GPU composited, no layout */
.parallax { transform: translateY(calc(var(--scroll-px) * 0.5)); }
```
Animating `top`, `left`, `margin`, `width`, `height`, `padding` forces the browser to re-run layout for all affected elements. `transform` and `opacity` are composited separately. [documented — MDN, web.dev rendering performance]

### Breaking the native scrollbar / hiding scroll affordance without replacement
Apple suppresses scrollbars on horizontal galleries (`scrollbar-width: none`) only where the horizontal scroll is supplementary and not the primary navigation. They always provide overflow-indicating visual cues (partial card peeking at the edge, dot indicators, or arrow chevrons). Hiding the scrollbar without a visual affordance leaves users unaware that content is scrollable. [observed — apple.com color galleries always show a peeking partial card]

### Content hidden behind animation with no static fallback
If a product feature's description only appears during a frame-sequence animation, users with JS disabled, slow connections, or `prefers-reduced-motion` never see it. The semantic HTML content must always be fully readable in the static DOM; animation is a visual layer on top, not the container of information. [documented — WCAG 1.1.1, Apple HIG content-first principle]

### Promoting too many layers with `will-change`
`will-change: transform` on every div on the page consumes GPU memory per layer. On lower-end devices this causes the opposite of the intended effect — page jank due to VRAM pressure. Apply `will-change` selectively to elements that are actively mid-animation, and remove it when the animation ends:
```js
el.style.willChange = 'transform';
el.addEventListener('transitionend', () => {
  el.style.willChange = 'auto';
}, { once: true });
```
[documented — MDN `will-change` best practices]

---

## Sources

- [CSS-Tricks: Let's Make One of Those Fancy Scrolling Animations Used on Apple Product Pages](https://css-tricks.com/lets-make-one-of-those-fancy-scrolling-animations-used-on-apple-product-pages/) — primary teardown with code
- [Ankit Trehan on Medium: Creating scroll animations similar to Apple's AirPods Pro page](https://ankittrehan2000.medium.com/creating-scroll-animations-similar-to-apples-airpods-pro-page-bc5c1c0814df) — canvas preload implementation
- [Abhishek Ghosh: Playing with video scrubbing animations on the web](https://www.ghosh.dev/posts/playing-with-video-scrubbing-animations-on-the-web/) — benchmark comparison of 6 approaches; ImageBitmap + OffscreenCanvas findings
- [Brad Holmes: Why Most Scroll Animations Miss What Apple Gets Right](https://www.brad-holmes.co.uk/web-performance-ux/why-most-scroll-animations-miss-what-apple-gets-right/) — content motion vs graphical motion split; video scrub payload reduction
- [MDN: CSS Scroll-Driven Animations](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations) — `animation-timeline`, `scroll()`, `view()` specification reference
- [MDN: animation-timeline property](https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline) — property reference
- [WebKit Blog: A Guide to Scroll-Driven Animations with Just CSS](https://webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/) — Safari 26 support confirmation; `prefers-reduced-motion` pattern
- [Chrome for Developers: CSS scroll-driven animation case studies](https://developer.chrome.com/blog/css-ui-ecommerce-sda) — Tokopedia (50% → 2% CPU), redBus, Policybazaar real-world data
- [Can I Use: animation-timeline scroll()](https://caniuse.com/mdn-css_properties_animation-timeline_scroll) — browser support matrix
- [Weiming Wu on Medium: How to jazz up your website like Apple with JavaScript](https://medium.com/geekculture/how-to-jazz-up-your-website-like-apple-with-javascript-eed2bf227fec) — sticky section + progress normalization architecture
- [web.dev: Well-controlled scrolling with CSS Scroll Snap](https://web.dev/articles/css-scroll-snap) — horizontal gallery implementation
- [OpenReplay: Handling Scroll Events Without Killing Performance](https://blog.openreplay.com/handling-scroll-events-performance/) — passive listeners, rAF throttling, 20–30% mobile improvement data
- [Codrops: A Practical Introduction to CSS scroll() and view()](https://tympanus.net/codrops/2024/01/17/a-practical-introduction-to-scroll-driven-animations-with-css-scroll-and-view/) — `animation-range` keyword reference

---

CONFIDENCE: 81% — Core canvas-scrub and sticky-pin techniques are well-documented via reverse-engineering and engineering teardowns; Apple's exact internal implementation (server-side adaptive loading, OffscreenCanvas use, precise frame counts on post-2023 pages) is inferred from network analysis by third parties rather than confirmed source inspection.
