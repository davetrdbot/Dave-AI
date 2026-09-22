# Media Assets & Delivery — apple.com hero media, sourcing, encoding

Scope: how current apple.com actually delivers scroll-driven hero media (reverse-spec), the technique decision tree updated to that reality, licensed code patterns to reimplement clean, an IP/sourcing may/may-not table, and the delivery+encoding engineering (formats, caching, frame-sequence decode, video scrub). Synthesised 2026-05-24 from four research findings (live Playwright capture of apple.com/iphone/, /iphone-16-pro/, /iphone-17-pro/ + JS bundle analysis; harvested code examples; sourcing/legal map; delivery/encoding research).

**Confidence labels:** `[observed]` = captured live from apple.com network/DOM · `[documented]` = public spec / verbatim from JS source / library README · `[inferred]` = reasoned from evidence.

> This is the engineering + provenance companion to `scrollytelling-techniques.md` (the technique recipes) and `apple-design-backend/references/web-delivery-infra.md` (the general CDN/image story). When you need *which* hero mechanism to build and *how to ship it without IP risk*, start here.

---

## 1. How current apple.com delivers hero media (reverse-spec)

The headline correction to older write-ups: **as of 2025–2026, apple.com product pages do NOT use a canvas image-sequence "flipbook" for the hero.** The flipbook was the circa-2020–2022 Mac/AirPods era. Current pages have migrated to `<video>` for scroll-driven animation, and to a real WebGL scene for the interactive 3D product viewer. `[observed]`

### 1.1 The hero is VIDEO-first

On `apple.com/iphone-17-pro/`, the hero (`section-welcome`) is a single `<video id="welcome-video">` — `muted playsinline preload="none" role="img"` — driven by Apple's **InlineMedia** plugin framework, not a canvas. `[observed]`

The lifecycle that makes it feel fast:
- **`preload="none"` + no `src` in initial HTML.** The `AnimLoad` plugin injects `src` only when scroll enters the element's `data-inline-media-load-keyframe` window (~100vh above viewport). `ViewportSourceOnce` ensures the src is set once — re-scrolling never re-fetches. This lazy, scroll-triggered load is *the* reason the page feels fast despite heavy video use. `[documented]`
- **`AnimPlay` plays on viewport enter** (driven by `data-inline-media-play-keyframe`), then `data-inline-media-unload-at-end="true"` + the `UnloadVideo` plugin clear the src to reclaim memory. Most heroes play once through, they do not loop. `[observed]`
- **Static start-frame + end-frame JPEG fallback chain.** `.start-frame` and `.end-frame` `<img>` (JPEG) sit as siblings to the `<video>`, eager-loaded; shown before play and after end. The `LoadTimeout` plugin (`data-load-timeout="3000"`) swaps to the static JPEG if the video has not loaded within 3s — a slow-connection user never sees a blank box. `[documented + observed]`
- **Reduced-motion → static frame.** `prefers-reduced-motion: reduce` is checked at init; `AnimPlay` bails without `play()`, and the `ReplayOnlyAX` plugin shows the static start-frame, exposing a Replay affordance to assistive tech. `[documented]`
- **`currentTime` scrub exists but is the exception.** Some sections (those with `data-video-progress-kf-*` keys) DO scrub the video via `videoEl.currentTime = duration * progress`, mapped from `scrollY` on every rAF tick. The marquee hero itself is play/pause, not scrub. `[documented]`

Plugin chain (comma-separated in `data-inline-media-plugins`): `LoadTimeout, ReplayOnlyAX, UnloadVideo, AnimLoad, AnimPlay, PictureToggleSource, ViewportSourceOnce`. `PictureToggleSource` swaps the src to the breakpoint-appropriate quality tier (`small`/`large`/`xlarge`). `[documented]`

### 1.2 The interactive product viewer is WebGL-3D (three.js + "Lotus")

The product-viewer section is a true `<canvas data-engine="three.js r165">` inside `.product-viewer-canvas` — a 3D scene that rotates/zooms with scroll, **not** a flipbook and **not** a scrubbed video. `[observed]`
- Apple's internal **"Lotus"** framework wraps three.js; scene files use a `.lsd` (Lotus Scene Description) extension. `[documented]`
- Textures are **KTX** (Khronos Texture, GPU-compressed ASTC) on WebGL2 contexts that expose `WEBGL_compressed_texture_astc`, with **AVIF/WebP** as the fallback texture set when ASTC is unavailable. The runtime appends `_ktx` or `_avif` to the scene name accordingly. 88 KTX files observed, ~12 MB total. `[observed + documented]`
- Scroll interaction is anchored via `data-inline-media-play-keyframe` to `.product-viewer-component`; the model transform is scroll-position-aware, not `currentTime`-based. `[observed]`
- ⚠ **Gotcha:** vendoring the UMD three.js build (r150+) logs one benign deprecation warning per load ("build/three.min.js is deprecated → use ES Modules"); vendor the ESM build (import map / `<script type=module>`) to ship a silent console. `[observed — 3D-hero dogfood]`

### 1.3 Asset URL grammar — content-hash fingerprinting, NOT query-param transforms

apple.com product pages do **not** use `mzstatic.com` query-param image transforms (that CDN is for App Store / iTunes imagery). Product-page assets are served from apple.com's own origin with **content-hash fingerprinted paths**: `[observed]`

```
static image:  /v/{product}/{version}/images/overview/{section}/{name}__{hash}_{tier}.jpg
video:         /105/media/{locale}/{product}/{year}/{uuid}/anim/{name}/{tier}.mp4
WebGL texture: /v/{product}/{version}/static//uploads/{opaque-hash}.ktx   (.webp = AVIF fallback)
```
- `{hash}` is a 12-char content fingerprint in the filename (double-underscore separates semantic name from hash); `{tier}` ∈ `small | large | xlarge`. No query params on product pages. `[observed]`
- Video lives under `/105/media/…` (`Server: Apple`), cache-busted by rotating the `{uuid}`. HTTP 206 byte-range on all MP4s. `[observed]`
- Breakpoints: xsmall (<481px), small (<735px), medium (<1068px), large (<1441px), xlarge (≥1441px). `[documented]`

### 1.4 Per-page summary

| Page | Hero mechanism | Canvas | Videos |
|---|---|---|---|
| apple.com/iphone/ | static images + guided-tour widget; `StaggeredFadeIn` CSS only | none | 1 |
| apple.com/iphone-16-pro/ | static images + `ac-video-player` widget | none | 1 |
| apple.com/iphone-17-pro/ | MP4 video (play-once on viewport enter) + WebGL-3D viewer | 1 (3D, separate section) | 17 |
`[observed]`

---

## 2. Technique decision tree (UPDATED to current reality)

The older tree led with "many crisp frames → canvas image-sequence." That now mis-states what Apple ships. Lead with video; treat the canvas flipbook as the classic alternative. Pick by *what the hero must do*:

```
What does the hero need to do?
├─ Cinematic clip, motion compresses well (camera move, lighting, product reveal)
│   → VIDEO currentTime-scrub  ← PRIMARY for a cinematic hero (what apple.com ships)
│     preload=none + lazy src on scroll-enter + static start/end JPEG fallback;
│     dense keyframes for scrub (§5); reduced-motion → static frame.
│     Mobile-Safari scrub flaky → ImageBitmap hybrid (§3, §5).
│
├─ Interactive 3D product the user rotates/zooms with scroll
│   → WebGL-3D scroll viewer (three.js + GLTF; KTX/Basis textures, AVIF fallback)
│     Apple's own product viewer. Heaviest; gate on WebGL2 + capability, fps fallback.
│
├─ Frame-exact pixel fidelity at low frame count, or you already have a JPEG set
│   → CANVAS image-sequence flipbook  ← CLASSIC ALTERNATIVE (the pre-2022 pattern)
│     Preload + draw on rAF; sliding-window decode + createImageBitmap (§3).
│     Still valid — just no longer how apple.com builds its marquee hero.
│
├─ Simple element motion / progress / parallax (no media payload)
│   → CSS scroll-driven  (animation-timeline: scroll()/view()) + @supports + IO fallback
│
└─ 2G / Save-Data / prefers-reduced-motion
    → Static poster image. No sequence, no scrub, no WebGL. Freeze at a rest frame.
```

**Why video-first now:** a dense-keyframe H.264/H.265 clip is ~60–80% smaller than the equivalent JPEG sequence `[documented]`, one HTTP request, and Apple's InlineMedia lazy-load makes the payload cost deferred. The flipbook's only remaining edge is exact per-frame control at low counts — choose it deliberately, not by default. `[inferred]`

---

## 3. Licensed code examples (keep provenance + LICENSE per snippet)

Five harvested techniques. **Treat any "reference/study" snippet as a pattern to reimplement clean — do not ship verbatim.** Per-snippet license below; full table at the end.

### 3.1 Canvas image-sequence scrubber — preload + array-cache + rAF
Cache the decoded `Image` in an array; **never** re-set `img.src` on each scroll event (the original CSS-Tricks gotcha). Map `scrollTop/maxScroll → frameIndex`, draw inside a single in-flight `requestAnimationFrame`, `{passive:true}` listener.
- Sources: CSS-Tricks teardown — **CC BY-SA 4.0 (reference)**; lordsean GSAP gist — **unclear SPDX (reference/study)**; jadnco/whirl — **MIT**; anni-platform/canvas-image-scrubber — **MIT**. Confidence HIGH.

### 3.2 `<video> currentTime` scrub + the mobile-Safari ImageBitmap workaround
Naive `video.currentTime = fraction * duration` works on desktop Chrome/FF. On **iOS Safari** seeking snaps to the nearest keyframe → visible jerk. Workaround: pre-extract frames into an `ImageBitmap[]` once (draw the hidden video to an `OffscreenCanvas` per frame via the `seeked` event or `requestVideoFrameCallback`, `createImageBitmap(offscreen)`), then on scroll just `drawImage(bitmaps[i])` — **no seeking at all**. Cross-browser decode helper: Chromium → `createImageBitmap(blob)` (non-blocking); Safari/FF → `img.decode()` then `createImageBitmap(img)`.
- Sources: muffinman.io, ghosh.dev, perfplanet.com 2025, ghepting/javascript-video-scrubber — all **no SPDX / reference-study**. Confidence HIGH for the basic pattern; MEDIUM for the full hybrid (lives in external playgrounds).
- Caveats: extraction itself uses seeking (~30–60s for 150 frames) — run a low-res (≤540p / cap 1280×720) extraction pass and scale up on the display canvas; ImageBitmap extraction ~doubles memory vs JPEG set.

### 3.3 GSAP ScrollTrigger pinned scrub
Build the timeline first, then attach `scrollTrigger: { trigger, pin:true, start:'top top', end:'+=N', scrub:1 }`. `scrub:true` = 1:1; `scrub:N` = N-second catch-up lag (never fully completes on a fast fling — use `true` if completion matters). Gate `snap` to pointer-fine devices. Reduced-motion: `tl.progress(1).pause(); tl.scrollTrigger?.kill()`.
- Source: GSAP official docs — **GSAP Standard License (free for most use; NOT MIT)**. ⚠ **The code patterns are documentation examples — reimplement clean; do not ship GSAP itself without verifying license compliance for your use.** Confidence HIGH.

### 3.4 Lenis smooth-scroll feeding a scrubbed animation
Lenis smooths the *read* value ScrollTrigger receives — it does **NOT** scroll-jack (native scroll stays authoritative). Wire-up (verbatim, MIT): `lenis.on('scroll', ScrollTrigger.update)`, drive `lenis.raf(time*1000)` from `gsap.ticker.add`, `gsap.ticker.lagSmoothing(0)`. `lerp` 0.05–0.15 (below 0.05 fails WCAG 2.3.3 audits). The legacy `ScrollTrigger.scrollerProxy()` bridge is unnecessary as of GSAP 3.11+/Lenis 1.0+. Do not run GSAP `ScrollSmoother` and Lenis together. Reduced-motion: don't instantiate Lenis; let native scroll run.
- Source: darkroomengineering/lenis README — **MIT** (core snippet is verbatim-safe). Confidence HIGH for wire-up, MEDIUM for parallax pattern.

### 3.5 Three.js scroll-driven 3D GLTF (rotate/zoom)
Vanilla three.js: load GLB, map `scrollProgress (0–1)` → `model.rotation.y` / camera FOV, lerp toward target in the rAF loop (`α≈0.06–0.08`), `setPixelRatio(Math.min(dpr,2))`. GSAP variant drives a proxy object in `onUpdate`.
- Sources: three.js — **MIT**; mkhalidh GLTF+HDRI repo — **MIT**; builder.io blog — **reference/study** (rewrite clean). Confidence HIGH for setup; rotation pattern synthesised → reimplement clean.
- Caveats: compress GLTF with KTX2/Basis (textures) + Draco (geometry); production GLB target 2–8 MB (un-optimised Blender exports run 40–200 MB). `alpha:true` disables some GPU optimisations. Add a completion clamp (`|cur−target|<0.001` → snap) so the lerp settles. fps monitor → fall back to a static image below ~20fps.

**Cross-technique reduced-motion guard (all five):**
```js
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!reduceMotion.matches) initScrollAnimation(); else showStaticFallback();
reduceMotion.addEventListener('change', () => location.reload());
```
WCAG 2.3.3 (AAA) requires user control over motion; honour the OS preference at minimum; offer pause/resume for animations >5s.

| # | Source | License |
|---|---|---|
| 1 | css-tricks.com (Apple scrolling animations teardown) | CC BY-SA 4.0 (reference) |
| 2 | gist lordsean/cb33cd… (GSAP image-sequence helper) | Unclear (reference/study) |
| 3 | github.com/jadnco/whirl | MIT |
| 4 | github.com/anni-platform/canvas-image-scrubber | MIT |
| 5 | muffinman.io / ghosh.dev / perfplanet.com / ghepting | No SPDX (reference/study) |
| 6 | gsap.com/docs ScrollTrigger | GSAP Standard License |
| 7 | github.com/darkroomengineering/lenis | MIT |
| 8 | builder.io/blog/webgl-scroll-animation | Reference/study |
| 9 | github.com/mkhalidh/Three.js-3D-Scene-with-GLTF-and-HDRI | MIT |
| 10 | github.com/mrdoob/three.js | MIT |

---

## 4. Asset sourcing + IP may/may-not (not legal advice — a designer's guardrail)

You usually need product media for the hero you do NOT have rights to render verbatim. The clean path:

### 4.1 Device frames / bezels
| Source | License | Suitability |
|---|---|---|
| **PommePlate** (ephread/PommePlate) | **CC0** — public domain, commercial OK, no attribution (project *logo* is CC BY-NC — don't use it) | HIGH — flat SVG, composite your screen content behind the frame layer. 2D only |
| Generic SVG frames (SVG Silhouette **CC0**, Vecteezy, Freepik/Magnific) | CC0 / royalty-free | Best when you don't need a *specific* Apple device — sidesteps trademark entirely |
| Apple Design Resources bezels | **ADR license (restricted, NOT CC)** | App Store / developer mock-ups only. MAY NOT redistribute the bezel art, or use in marketing for non-Apple-platform products. Marketing-in-bezel triggers Apple's marketing guidelines |
| DeviceFrames / MockUPhone / DeviceShots | tiered / free-commercial-output | one-off renders / static fallback; can't script a 360-frame rotation batch |

### 4.2 CC0 3D models for frame rendering
- **Poly Haven** — **CC0**, all assets (strength is environments; device inventory thin). **Sketchfab** — filter Licenses → CC0 / CC-BY (avoid CC-BY-NC and Editorial for shipped work). **Khronos glTF Sample Models** — CC0/MIT (test assets, not heroes).
- For polished commercial shipping: **commission a stylized, non-photorealistic, non-Apple-trademarked model**. This is how non-Apple "Apple-style" pages avoid IP risk.

### 4.3 Render-to-frames pipeline
- **Blender headless:** `blender -b scene.blend -E CYCLES -s 1 -e 120 -t 0 -o /tmp/frames/frame_##### -F PNG -a` (swap `-E BLENDER_EEVEE_NEXT` for 3–10× faster iteration). Orbit camera A→B over N frames; batch-compress PNG→WebP.
- **Three.js OffscreenCanvas capture:** `WebGLRenderer({preserveDrawingBuffer:true})`, advance camera per frame, `canvas.toBlob`/`toDataURL('image/webp',0.85)`; for offline pre-bake use headless Chromium/Puppeteer or node-canvas.
- **Spline** — browser-native Export → Image Sequence (JPG/PNG, choose FPS/duration), no-code, commercial export OK.
- Frame-count guidance: 0°–180° ≈ 60 frames (~4–6 MB WebP 85%); 0°–360° ≈ 120 frames (~8–12 MB); recommend **60–90 frames, WebP 85%, individual files** (sprite-sheet only if HTTP/2 multiplexing is unavailable).

### 4.4 AI-gen + the persistent trademark caveat
- US law (2026): pure AI output has **no copyright** (you can't own it; you also can't be infringed against on training data). The platform's ToS assigns you output rights but disclaims non-infringement warranty.
- **Trademark / trade dress is the live risk and it does not go away.** Apple's distinctive industrial design (shape, finish, form factor) is protected trade dress — you can infringe it with an *original* drawing or AI render. A CC0 3D model of a photorealistic iPhone grants the artist's copyright, **never** Apple's trade dress. Same for an Unsplash/Pexels photo of an iPhone: the photo license ≠ a trademark license.
- **Safe AI-gen:** abstract / stylized "smartphone" shapes NOT recognisable as a specific Apple product, or AI-gen for environment/lighting/texture reference only. Do NOT ship a recognisable AI-gen iPhone in a context implying Apple association/endorsement.

### 4.5 The core may / may-not line
| Action | MAY | MAY NOT |
|---|---|---|
| ADR bezels | App Store / developer mock-ups, client presentations | redistribute the bezel art; ship in a template product; use in non-Apple-platform marketing |
| Your own photo of an Apple device | editorial / compatibility context | imply Apple endorsement/sponsorship |
| Apple's own product photography / video | link to Apple press page on Apple's terms | re-host / reproduce without written permission |
| Apple logo / "iPhone"/"Mac" wordmark | reference in text to state compatibility | use as a graphic/icon/logo without a license |
| CC0 mockup (PommePlate, generic SVG) | any commercial use, freely | (no legal bar) |
| AI-gen / CC0-model photorealistic iPhone | internal mood board / reference | ship where it implies Apple association |

### 4.6 This SKILL's own guardrail (hard rule)
**Ship only: (a) media WE generated ourselves, (b) permissively-licensed assets (CC0 / MIT / Unsplash-Pexels within their terms), or (c) pointers/links to the source. NEVER redistribute Apple's own frames, bezels-as-assets, photography, or video. The `_research/.../reference-only/` captures of Apple media are study material — not shippable, not to be copied into any deliverable.**

Decision tree: *Need a specific Apple device identity?* → if YES + need photorealism+brand recognition → Apple press assets on their terms OR your own photo (avoid AI-gen photorealistic iPhone, scraped Apple images, ADR bezels in marketing); if NO → CC0 generic/stylized frame or your own design (safest, cleanest). *Don't need a specific device?* → CC0 generic frame / Unsplash-Pexels with no endorsement implication.

---

## 5. Delivery + encoding engineering

### 5.1 Formats + responsive srcset
- **AVIF** (~65% < JPEG) for large hero stills; **WebP** (~25–50% <) as the `<picture>` intermediate + for frame sequences; **JPEG** baseline `<img>` fallback; **PNG** only for sharp UI overlays/icons. Apple's *observed* product pages still ship JPEG photography (18–72 KB) + PNG nav thumbs (4–7 KB); no AVIF observed — AVIF is the recommended next step for new builds. `[observed + documented]`
- **Art-directed fixed-size images** (device frames, icons): DPR density descriptors (`_small`, `_small_2x`, `_large`, `_large_2x`) inside `srcset`, two breakpoints (`≤734px` phone + desktop catch-all) — Apple's observed pattern. **Fluid-layout heroes:** width descriptors (`400w 800w 1200w 1920w`) + `sizes`. `[observed + documented]`
```html
<picture>
  <source type="image/avif" srcset="hero-400.avif 400w, …1920.avif 1920w" sizes="(max-width:734px) 100vw, 1440px">
  <source type="image/webp" srcset="hero-400.webp 400w, …1920.webp 1920w" sizes="(max-width:734px) 100vw, 1440px">
  <img src="hero-1200.jpg" width="1920" height="1080" fetchpriority="high" loading="eager" alt="…">
</picture>
```

### 5.2 Content-hash caching (NOT on-the-fly transforms)
- Apple fingerprints the *filename* (`name__{hash}_tier.ext`) + a page version slug (`/v/iphone/home/cj/`) and sets **modest** `Cache-Control: max-age≈300–3018s, no `immutable``. The hash makes long TTLs safe by construction; Apple rotates content often enough to skip a 1-year TTL. `[observed + inferred]`
- For a build pipeline that emits content-hashed filenames, the canonical pattern is `Cache-Control: public, max-age=31536000, immutable`. `[documented]`
- Product pages do **not** route through `mzstatic.com` and do **not** use Cloudinary/Imgix-style query-param transforms. `[observed]`

### 5.3 Frame-sequence delivery — the hard part
The memory math is what kills naive flipbooks: a 1920×1080 RGBA bitmap ≈ **8.3 MB**, so 148 decoded bitmaps ≈ **1.2 GB** → mobile OOM. `[documented + inferred]` The four rules:
1. **Eager first 10–20 frames, lazy the rest.** Preload frames 0–N_eager before interaction; load the remainder in `requestIdleCallback`. On `navigator.connection.effectiveType` `2g`/`slow-2g` or `Save-Data`, skip the sequence entirely → static image (Apple: ~347 KB still vs ~56 MB sequence). `[documented]`
2. **Decode off the main thread with `createImageBitmap(Blob)` in a Worker.** ⚠ `createImageBitmap()` only runs off-thread with a **Blob/ArrayBuffer**, NOT an `HTMLImageElement` — using it with an `<img>` blocks the main thread. `ImageBitmap` is transferable (zero-copy via `postMessage([bitmap])`). `[documented]`
```js
// worker: fetch → blob → createImageBitmap(blob) → postMessage({index,bitmap},[bitmap])
self.onmessage = async ({data:{url,index}}) => {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);     // off main thread (Blob input)
  self.postMessage({index, bitmap}, [bitmap]);      // zero-copy transfer
};
```
3. **Sliding-window decode + `ImageBitmap.close()`.** Keep ≤12–15 decoded bitmaps (~100–125 MB @1080p RGBA, under mobile Safari's ~200–400 MB budget). Evict frames outside `[current−BEHIND, current+AHEAD]` and call **`bmp.close()` explicitly** — GC does NOT free the GPU texture; skipping `.close()` is a silent leak → progressive frame-drop → tab crash. `[documented]`
```js
for (const [idx,bmp] of bitmaps) if (idx < cur-BEHIND || idx > cur+AHEAD) { bmp.close(); bitmaps.delete(idx); }
```
4. **Velocity-scaled window + skip-frame degradation.** On fast flick-scroll the user can jump 30+ frames/tick: grow `WINDOW_AHEAD` with velocity, prioritise the decode queue nearest-first, and if `bitmaps[target]` isn't ready walk back to the last decoded frame (slight stutter beats a blank canvas). Cap pending-decode queue depth (~3) and jump to the latest requested index. Optional two-tier: quarter-res thumbnails decoded for all frames immediately (~0.5 MB/148) + full-res in the sliding window. `[documented + inferred]`

### 5.4 Video scrub encoding — dense keyframes
`currentTime` seeks to the nearest preceding I-frame and decodes forward — sparse keyframes = multi-frame jank. Encode dense keyframes for scrub: `[documented]`
```bash
ffmpeg -i src.mp4 -x264-params keyint=5:scenecut=0 -crf 18 -vf scale=1280:-2 hero-scrub.mp4   # keyint=5
ffmpeg -i src.mp4 -g 5 -crf 18 -vf scale=1280:-2 hero-scrub.webm                              # WebM for Firefox
```
Keyframe density by browser: Safari desktop ~every 5 frames OK; Chrome/Edge ~5 OK; **Firefox needs ~every 2**; **mobile Safari effectively every frame** (defeats compression → use the §3.2 ImageBitmap hybrid instead). Provide both MP4 + WebM (iOS Safari has no WebM). `video.fastSeek(time)` trades sub-keyframe precision for less decode work where exactness isn't needed. For ambient (non-scrub) loops use HLS `autoplay muted loop playsinline` + poster; **never use HLS for scrubbing** (segment boundaries break smoothness). `[documented + inferred]`

### 5.5 Performance budgets + LCP/INP
| Metric | Ceiling |
|---|---|
| Frame count (sequence) | 60–150 (diminishing return past 150) |
| Per-frame JPEG / WebP @1280px | 20–40 KB / 10–25 KB |
| Total sequence (WebP / MP4) | <2 MB pref, <4 MB max / **<400 KB** MP4 |
| Decoded-bitmap window (GPU) | 12–15 frames (~100–125 MB) |
| LCP / hero first-frame / INP | <2.5s / <1.0s / <200ms |

- **LCP:** the first frame / video poster is the LCP element — `fetchpriority="high"`, `loading="eager"` (NEVER `lazy` above the fold), `<link rel="preload" as="image" fetchpriority="high">` frame-0 in `<head>` to break the `HTML→JS→build-URL→request` chain. Apple's own LCP hook: `onload="window.__lp?.(event)"`. `[observed + documented]`
- **INP:** never `drawImage` synchronously in a scroll handler; rate-limit paints to ≤1/frame with rAF; dedupe (skip draw if `scrollY` unchanged); push CSS custom props (`--scroll-progress`) so the CSS engine handles transform/opacity off the JS paint path. `[documented]`
- **Reduced-motion / CLS:** freeze at a rest frame under `prefers-reduced-motion`; always declare `width`/`height` on `<canvas>`/`<img>` to reserve layout (avoid CLS). `[documented]`

### 5.6 Anti-patterns (don't ship)
Shipping unoptimized PNG sequences (180 × 300 KB = 54 MB) · synchronous decode on scroll · holding all bitmaps with no `.close()` (GPU OOM) · no reduced-motion fallback (vestibular trigger; WCAG 2.3.3/2.2.2) · HLS for frame scrubbing · `loading="lazy"` on the hero · missing `width`/`height`. `[documented]`

---

## Sources

Synthesised from `apple-design/_research/media-assets/`: `01-applecom-media-spec.md` (live Playwright + JS bundle reverse-spec), `02-code-examples.md` (harvested licensed snippets), `03-sourcing-and-legal.md` (IP/sourcing map), `04-delivery-engineering.md` (formats/caching/decode/encoding). Apple-copyrighted reference captures live under `_research/media-assets/reference-only/` — study only, never shipped.

CONFIDENCE: 84% — hero mechanism, URL grammar, plugin chain, and delivery numbers are `[observed]` from a live 2026-05-24 capture; the InlineMedia/Lotus internals and code patterns are `[documented]` from JS source / library READMEs / public specs; memory and perf ceilings are `[documented + inferred]`. Legal section is a designer's guardrail, not legal advice.
