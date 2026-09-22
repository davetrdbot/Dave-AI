# Perceived Performance + Input / Focus / Keyboard / Pointer

**Scope:** Functional/technical interaction behavior for Apple-idiomatic interfaces. Covers
(A) making an interface *feel* fast regardless of raw speed, and (B) correct focus, keyboard,
and pointer handling. Color, motion aesthetics, and brand are out of scope here — see
`apple-design-motion.md` and `nets-design-system` skill.

---

## Principles

1. **Instant acknowledgement is non-negotiable.** Every input must produce a visible response
   within 100 ms. Beyond that, the human nervous system registers lag. [documented — WWDC18/803;
   web.dev INP ≤200 ms "good" threshold]

2. **Responsiveness > raw speed.** A skeleton that appears in 16 ms feels faster than a polished
   result that appears in 300 ms without any intermediate feedback. [observed — Apple engineering,
   WWDC18/803]

3. **Optimism by default.** Commit the visual state change immediately; reconcile with the server
   after. Roll back only on confirmed failure. [documented — common UI pattern; Apple Notes,
   Reminders, and iMessage all demonstrate this]

4. **The visual response is the critical path; everything else is background work.** Spell-check,
   analytics, sync, and secondary renders are all deferred until after the frame paints. [documented
   — web.dev optimize-inp; WWDC18/803]

5. **Input modality shapes affordances.** An interface that works with a coarse finger must equally
   serve a precise mouse pointer and a keyboard. Each modality gets its own affordance layer —
   hover states only for precise pointers, visible focus rings only for keyboard, large tap targets
   for fingers. [documented — Apple HIG Inputs; MDN pointer media feature]

6. **Focus is navigation.** For users who rely on keyboard or switch access, focus order IS the
   interface. Logical order, visible indicator, and no traps are baseline requirements, not
   enhancements. [documented — Apple HIG Accessibility; WCAG 2.1 SC 2.4.3 / 2.4.7]

7. **Hit targets encode trust.** A target smaller than ~44 pt signals that the designer expects
   you to fail. Expand the hit area invisibly before shrinking the visual glyph. [documented —
   Apple HIG; Apple Design Tips page: "Create controls that measure at least 44 × 44 points"]

---

## Apple Specifics

### Responsiveness Model (native + web)

- Apple re-engineered Touch ID and display sampling on the iPhone specifically to eliminate
  perceptible input latency. The hardware target is "detect all nuances of your gestures as
  instantly as possible." [documented — WWDC18/803]
- **Hysteresis distance:** 10 pt of movement before a touch is classified as a swipe vs. a tap.
  This is intentional slack so the user can touch down and think. [documented — WWDC18/803]
- **Double-tap costs ~500 ms** on every normal tap in any flow where double-tap is registered.
  Avoid double-tap unless the interaction warrants it. [documented — WWDC18/803]
- **One-to-one tracking** is mandatory for drag and scroll: the content must move with the finger
  pixel-for-pixel. Any slip is immediately noticed. [documented — WWDC18/803]
- **Detect all possible gestures in parallel from touch-down.** Cancel competing recognizers once
  intent is clear. Never use gesture recognizers that only resolve at the end (like
  `UISwipeGestureRecognizer` for complex cases). [documented — WWDC18/803]
- **Project momentum.** Use velocity + deceleration rate, not just final position, when snapping
  or settling content. Reusing UIScrollView's deceleration rate preserves muscle memory.
  [documented — WWDC18/803]

### Input / Focus / Pointer Model

**Focus (all platforms)**
- macOS: Full Keyboard Access (System Settings → Keyboard → Keyboard Navigation) enables
  tab-focus on all controls. When off, only text fields and lists focus by default. [documented —
  Apple HIG Keyboards]
- iOS / iPadOS: Hardware keyboard users expect the same logical tab order. `UIFocusEnvironment`
  and `UIFocusGuide` route focus around non-standard layouts. [documented — Apple HIG]
- tvOS: Focus engine is the primary navigation model — the entire UI is driven by the remote's
  directional pad through `UIFocusSystem`. [documented — Apple HIG]
- SwiftUI: `@FocusState` + `.focused()` is the canonical focus-management API; it works
  bidirectionally (read where focus is, write to move it). [documented — Apple WWDC21/10023]

**Pointing devices**
- Apple distinguishes "precise" (mouse/trackpad) from "indirect/coarse" (finger) pointing.
  Hover effects (`.hoverEffect` in SwiftUI; `:hover` + `@media (hover: hover)` on web) must
  only activate for precise pointers. [documented — Apple HIG Pointing Devices]
- On iPadOS and macOS Catalyst, `.hoverEffect(.highlight)` adds the system pointer highlight;
  `.hoverEffect(.lift)` levitates the element. Use `.automatic` and let the system decide for
  standard controls. [documented — Apple HIG Pointing Devices]
- Pointer cursor shape: use `UIPointerStyle` (UIKit) or `.pointerStyle()` (SwiftUI) to set
  context-appropriate cursors (e.g., `resizeLeftRight` for resize handles, `link` for tappable
  cards). [documented — Apple HIG]

**Hit targets**
- **Minimum: 44 × 44 pt** on iOS/iPadOS/watchOS. visionOS raises this to **60 × 60 pt**.
  macOS accepts smaller targets because pointer accuracy is high. [documented — Apple HIG
  Accessibility; Apple Design Tips]
- The visual element can be smaller; expand the hit area via padding, `contentShape()` in
  SwiftUI, or invisible overlay views. [documented — Apple HIG; observed in system controls]
- Maintain ≥8 pt spacing between adjacent tap targets to prevent mis-taps. [inferred from
  HIG layout guidance; exact number not published but widely cited as practitioner rule]

**Keyboard**
- Every action reachable by touch must be reachable by keyboard. Standard shortcuts
  (`⌘N`, `⌘W`, `⌘,`, `⌘Z`, `Delete`) must not be overridden with non-standard behaviour.
  [documented — Apple HIG Keyboards]
- Add custom shortcuts with `.keyboardShortcut(_, modifiers:)` in SwiftUI; document them
  in the app's `Help` menu. [documented — Apple HIG]

**Virtual keyboard (iOS)**
- Match the keyboard type to the content: `inputmode="numeric"` for PINs, `inputmode="decimal"`
  for prices, `inputmode="email"` for emails. [documented — MDN inputmode; Apple HIG onscreen
  keyboards]
- `enterKeyHint` / `enterkeyhint` labels the submit key: `go`, `done`, `next`, `search`, `send`.
  [documented — MDN; Apple HIG]
- Autofill: annotate fields with `UITextContentType` (native) or `autocomplete` (web). This is
  quality-of-life — Apple's Password AutoFill, address fill, etc., only trigger on annotated
  fields. [documented — Apple HIG; MDN autocomplete]

---

## Recipes

### Web — Perceived Performance

#### 1. Speculation Rules: prefetch on hover intent (200 ms)
```html
<!-- Moderate eagerness: prefetch triggers after 200ms hover or on pointerdown -->
<script type="speculationrules">
{
  "prefetch": [{
    "where": { "href_matches": "/*" },
    "eagerness": "moderate"
  }]
}
</script>
```
[documented — Chrome Prerender Pages docs; Speculation Rules API, MDN]

#### 2. `content-visibility: auto` for long pages / off-screen sections
```css
/* Applied to section containers — browser skips rendering until near viewport */
.section-chunk {
  content-visibility: auto;
  /* Prevent layout shift by declaring approximate rendered height */
  contain-intrinsic-size: auto 600px;
}
```
Measured improvement: ~7× initial render speedup on long-form pages; up to 250 ms navigation
improvement in SPA cached-view scenarios. [documented — web.dev content-visibility article]

#### 3. Priority hints for above-the-fold resources
```html
<!-- Hero image: fetch at high priority even if below a lazy boundary -->
<img src="hero.webp" fetchpriority="high" loading="eager" alt="…">

<!-- Below-fold image: defer -->
<img src="card.webp" loading="lazy" alt="…">
```
[documented — web.dev fetchpriority]

#### 4. Optimistic update + rollback pattern
```js
async function toggleLike(itemId) {
  // 1. Update UI immediately — zero-latency feedback
  setLiked(prev => !prev);

  try {
    await api.post(`/items/${itemId}/like`);
    // server confirmed — nothing to do
  } catch {
    // 2. Roll back only on confirmed failure
    setLiked(prev => !prev);
    showToast("Couldn't save — check connection");
  }
}
```
[documented — standard pattern; Apple Notes / Reminders exemplify this]

#### 5. Defer background work after the visual response
```js
inputEl.addEventListener('input', (e) => {
  // Critical: update visible text immediately (this frame)
  updateDisplayText(e.target.value);

  // Non-critical: run after browser paints the frame
  requestAnimationFrame(() => {
    setTimeout(() => {
      runSpellCheck(e.target.value);
      saveToLocalStorage(e.target.value);
    }, 0);
  });
});
```
[documented — web.dev optimize-inp]

#### 6. Skeleton sized to real content
```css
.skeleton-line {
  height: 1em;        /* Match actual text line height */
  border-radius: 4px;
  background: linear-gradient(90deg, #e8e8e8 25%, #f4f4f4 50%, #e8e8e8 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}
```
Skeleton must match the real layout's line count, width, and spacing to prevent layout shift
on load. A skeleton that doesn't match dimensions breaks the perception illusion. [observed —
iOS system skeleton pattern; inferred from CLS / layout shift research]

---

### Web — Focus / Keyboard / Pointer

#### 7. `:focus-visible` — show ring only for keyboard, not mouse
```css
/* Remove default ring on all focus (pointer + keyboard) */
:focus {
  outline: none;
}

/* Re-add ring only when UA determines keyboard navigation */
:focus-visible {
  outline: 2px solid #0a72e0;  /* brand blue, ≥3:1 contrast on white */
  outline-offset: 3px;
  border-radius: 4px;
}
```
`:focus-visible` fires on keyboard/tab and programmatic focus; suppressed for mouse clicks and
touch. Baseline widely available since March 2022. [documented — MDN :focus-visible]

#### 8. Logical focus order via DOM order (no `tabindex` hacks)
```html
<!-- Good: DOM order = visual order = tab order -->
<form>
  <label for="name">Name</label>
  <input id="name" type="text" autocomplete="name">

  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" inputmode="email">

  <label for="amount">Amount</label>
  <input id="amount" type="text" inputmode="decimal">

  <button type="submit">Continue</button>
</form>

<!-- Never do this: positive tabindex breaks natural flow -->
<!-- <input tabindex="3"> <input tabindex="1"> -->
```
[documented — WCAG 2.4.3; MDN tabindex guidance]

#### 9. Pointer / hover media queries — adaptive affordances
```css
/* Hover effects: only for precise pointers (mouse/trackpad) */
@media (hover: hover) and (pointer: fine) {
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  }
}

/* Touch target expansion: coarse pointer (finger) */
@media (pointer: coarse) {
  .icon-button {
    min-width: 44px;
    min-height: 44px;
    /* visual glyph can be 24px; padding makes up the rest */
    padding: 10px;
  }
}

/* Fine pointer: tighter sizing acceptable */
@media (pointer: fine) {
  .icon-button {
    min-width: 32px;
    min-height: 32px;
  }
}
```
[documented — MDN pointer media feature; Apple HIG 44 pt rule]

#### 10. Invisible hit-area padding (touch target without visual bloat)
```css
/* Visual: 24×24px icon; Hit area: 44×44px via padding */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 10px;          /* expands hit area to 44px total */
  margin: -10px;          /* cancel the padding's layout effect on neighbors */
  border: none;
  background: transparent;
  cursor: pointer;
}
```
[observed — common iOS-inspired web pattern; aligns with Apple's HIG invisible-padding guidance]

#### 11. `inputmode` + `enterkeyhint` + `autocomplete` triad
```html
<!-- PIN entry: numeric pad, no suggestions, "Done" key -->
<input
  type="text"
  inputmode="numeric"
  autocomplete="one-time-code"
  enterkeyhint="done"
  pattern="\d{6}"
  maxlength="6"
>

<!-- Price: decimal pad -->
<input
  type="text"
  inputmode="decimal"
  autocomplete="off"
  enterkeyhint="next"
>

<!-- Search field inside a div/contenteditable -->
<div
  role="searchbox"
  contenteditable="true"
  inputmode="search"
  enterkeyhint="search"
></div>
```
[documented — MDN inputmode; MDN enterkeyhint; Apple HIG onscreen keyboards]

#### 12. `touch-action` — prevent browser pan conflicts on custom drag
```css
/* Custom horizontal carousel — allow vertical scroll, prevent horizontal browser pan */
.carousel-track {
  touch-action: pan-y pinch-zoom;
}

/* Custom drawing surface — own all touch events */
.canvas-area {
  touch-action: none;
}
```
[documented — MDN touch-action]

---

### SwiftUI — Focus / Keyboard / Pointer

#### 13. `@FocusState` + enum for multi-field form with auto-advance
```swift
struct CheckoutForm: View {
  @State private var name = ""
  @State private var email = ""
  @State private var card = ""

  enum Field: Hashable { case name, email, card }
  @FocusState private var focus: Field?

  var body: some View {
    VStack(spacing: 16) {
      TextField("Name", text: $name)
        .focused($focus, equals: .name)
        .submitLabel(.next)
        .onSubmit { focus = .email }

      TextField("Email", text: $email)
        .focused($focus, equals: .email)
        .keyboardType(.emailAddress)
        .textContentType(.emailAddress)
        .submitLabel(.next)
        .onSubmit { focus = .card }

      TextField("Card number", text: $card)
        .focused($focus, equals: .card)
        .keyboardType(.numberPad)
        .submitLabel(.done)
        .onSubmit { focus = nil; submitForm() }
    }
    .onAppear { focus = .name }  // auto-focus first field
  }
}
```
[documented — Apple WWDC21/10023; Apple WWDC23/10162; SwiftUI FocusState docs]

#### 14. `.keyboardShortcut` for common actions
```swift
struct DocumentView: View {
  var body: some View {
    Button("Save") { save() }
      .keyboardShortcut("s", modifiers: .command)   // ⌘S

    Button("Find") { showFind() }
      .keyboardShortcut("f", modifiers: .command)   // ⌘F

    Button("Delete") { deleteSelected() }
      .keyboardShortcut(.delete, modifiers: [])     // Delete key, no modifier
  }
}
```
[documented — Apple HIG Keyboards; SwiftUI keyboardShortcut docs]

#### 15. `.hoverEffect` for pointer affordance on iPadOS / macOS
```swift
// Automatic: system picks the appropriate effect for the control type
Button("Open") { open() }
  .hoverEffect(.automatic)

// Lift: floats the element (cards, thumbnails)
Image("cover")
  .resizable()
  .hoverEffect(.lift)

// Highlight: tints the element (list rows, chips)
Text(tag)
  .padding(.horizontal, 8)
  .background(Color.secondary.opacity(0.12))
  .hoverEffect(.highlight)
```
`.hoverEffect` is a no-op on iOS (touch-only devices) — safe to add unconditionally. [documented
— Apple HIG Pointing Devices; SwiftUI hoverEffect docs]

#### 16. `contentShape` to expand hit area in SwiftUI
```swift
// Visual: small icon; tap area: entire row
HStack {
  Image(systemName: "trash")
    .frame(width: 24, height: 24)
  Spacer()
}
.contentShape(Rectangle())  // makes entire HStack tappable, not just the icon
.onTapGesture { delete() }
```
[documented — SwiftUI contentShape docs]

---

## Faithful Replication

When implementing Apple-idiomatic perceived performance + input behavior on web:

1. **Optimistic state is the baseline.** Any interactive element that writes to a server (like, save,
   check off) must update local state before awaiting the response. Show errors inline, not
   pre-emptively. [documented]

2. **INP ≤200 ms at the 75th percentile** is the Core Web Vitals "good" threshold (replaced FID
   on 2024-03-12). Break down interactions into input delay + processing duration + presentation
   delay; each phase should be minimized independently. [documented — web.dev INP]

3. **Skeletons must be structurally accurate.** A skeleton with wrong number of lines or wrong
   widths causes layout shift on load — worse perceived performance than a spinner. [inferred —
   CLS research; observed in Apple's skeleton implementations]

4. **`@FocusState` enum pattern maps 1:1 to HTML `tabindex` and form field ordering.**  The
   mental model is identical: declare which field is focused, drive `.onSubmit` to advance.
   Web equivalent is `form.elements[nextIndex].focus()`. [observed — structural parity]

5. **Pointer / hover gates must layer** — `(hover: hover) and (pointer: fine)` is more reliable
   than `(hover: hover)` alone, because some touch devices with a stylus report `hover: hover`.
   [documented — MDN any-pointer; inferred from device matrix edge cases]

---

## Anti-Patterns

| Anti-pattern | Why it fails | Fix |
|---|---|---|
| **Block on slow work before visual response** | Human lag threshold is ~100 ms; a 300 ms DB write before any feedback feels broken | Optimistic update; do async work after frame paints |
| **No optimistic UI** | User sees the spinner as confirmation that nothing happened; double-taps emerge | Commit visual state immediately, reconcile in background |
| **Hover-only affordances on touch** | `@media (hover: hover)` is false on phones; interactive state invisible | Gate `:hover` styles with `(hover: hover) and (pointer: fine)` |
| **No visible focus ring** | Keyboard users cannot navigate; fails WCAG 2.4.7 | Add `:focus-visible` ring ≥2px, ≥3:1 contrast |
| **Sub-44 pt touch targets** | Mis-tap rate climbs sharply below 44 pt, erodes trust | Use invisible padding to 44 pt; do not shrink visual |
| **Focus trap with no exit** | Keyboard user stuck in a modal with no `Escape` / close button | Bind `Escape` key; manage focus back to trigger on close |
| **Ignoring keyboard entirely** | Click-only handlers; mouse-required interactions | Add `keydown` / `onSubmit` / `.keyboardShortcut`; test tab-only navigation |
| **`tabindex` > 0** | Creates a separate, confusing tab order disconnected from DOM order | Use `tabindex="0"` for custom controls; rely on DOM order |
| **Double-tap for primary action** | Introduces ~500 ms delay on every single tap in that flow | Reserve double-tap for secondary / destructive actions only |
| **Skeleton with wrong dimensions** | Layout shift on real content arrival spikes CLS; perception benefit lost | Measure real rendered dimensions; set `contain-intrinsic-size` |
| **`content-visibility: auto` + DOM reads** | Forcing layout on hidden elements negates the skip; triggers synchronous layout | Audit for `getBoundingClientRect`, `offsetHeight` reads inside skipped subtrees |
| **`inputmode` without `autocomplete`** | Soft keyboard is correct but AutoFill doesn't trigger | Pair `inputmode` with the appropriate `autocomplete` token |

---

## Scroll as a continuous input/affordance

**Scope:** When and how to use scroll-progress as an ongoing input signal — covering the key decision of when cinematic scroll motion helps versus hurts, momentum/inertia expectations, the no-scroll-jack absolute, and pointer-vs-touch degradation.

---

### Scroll is an INPUT, not just a viewport change

Scroll position is a continuous, user-controlled value in `[0, 1]` — the user feels they are *driving* the motion, not watching it. When an interface binds visual properties to this value (opacity, translateY, scale, currentTime, background color) with appropriate damping, the page becomes an instrument the user plays. This is the core reason apple.com's product pages feel "alive": every pixel of scroll produces feedback, and the feedback's lag/momentum communicates physical weight. [Cross-ref: research-findings-inventory §3 — "Continuous scroll-progress transforms"]

Compare to binary in-view reveals (`IntersectionObserver` one-shot): the animation plays identically regardless of scroll speed or direction. It decouples the user's gesture from the result, breaking the input metaphor. Use one-shot reveals on utility surfaces (see decision below); use continuous binding on flagship/narrative surfaces.

---

### Momentum and inertia expectations

- **Project momentum, never fight it.** OS momentum scrolling (iOS rubber-band, macOS inertial trackpad) is a deeply trained user expectation. Any interface that fights or ignores momentum feels broken instantly. Preserve the native deceleration curve; never clamp or floor scroll velocity artificially. [documented — WWDC18/803; "one-to-one tracking is mandatory"]
- **Smooth the read, not the scroll.** Apply a lerp/damping layer to the *read value* (`smoothed += (raw - smoothed) * α`, α ≈ 0.08–0.12) before mapping it to animation properties. This produces the signature "catching up" feel without touching the native scrollbar position. [inferred from apple.com reverse-engineering — research-findings-inventory §3]
- **Never break OS scroll momentum.** Do not call `event.preventDefault()` on `wheel` or `touchmove` to produce a fake scroll or to retime the user's gesture. This is the scroll-jack boundary (see below).

---

### THE KEY DECISION — When cinematic scroll helps vs. hurts

This is the highest-leverage decision in scroll UX. Getting it wrong on either side is expensive: over-applying on utility surfaces slows users; under-applying on flagship surfaces feels cheap.

**Surface axis definition:** See `apple-design` → `restraint-and-antislop.md` for the full surface classification. Summary:

| Surface type | Scroll treatment | Reason |
|---|---|---|
| **Flagship / marketing / product detail / onboarding** | Cinematic scroll-progress motion — commit fully or skip entirely; half-measures look unpolished | Pacing and narrative are the product; the user arrived to be shown something, not to complete a task |
| **Utility / productivity** — lists, dashboards, forms, settings, docs, data-heavy tables | Plain, fast, native scroll — no scroll-driven transforms at all | Every frame of animation delays task completion; muscle memory expects direct scroll-to-content; cinematic motion fights the user |
| **Mixed surfaces** (e.g., an onboarding flow *within* a productivity app) | Cinematic on the onboarding screens only; switch to plain scroll once the user is in the working surface | The boundary should feel like entering a different mode, not a design inconsistency |

**Commit or skip rule:** A weak scroll animation (short pinned zone, small transform range, no damping) reads as a glitch or accident on a flagship surface. If you cannot invest in the full cinematic treatment — damped scroll value, meaningful pin length, choreographed children — use a one-shot IntersectionObserver reveal instead. It is never wrong to use the simpler pattern. [inferred — observed quality threshold on apple.com product pages]

**Pacing is the payoff on flagship surfaces.** The reason sticky-pinned scenes work is that they let the *designer* control how long the user spends with a message. The user retains motor control (scroll speed = pace) but cannot skip the sequence without scrolling past it. This is appropriate only when the content earns the pacing — product reveals, feature demonstrations, narrative onboarding. It is never appropriate for any surface where the user's goal is to find, read, or act on information.

---

### The absolute: never scroll-jack

**Scroll-jacking** means intercepting the user's scroll gesture and changing the scroll distance, direction, or timing that results — stealing control from the OS scroll system. It is an absolute prohibition.

Specifically prohibited:
- `event.preventDefault()` on `wheel` or `touchmove` to disable native scroll and substitute JS-driven scroll position updates
- `overflow: hidden` on `<body>` combined with JS fake-scroll (fake scroll position vs. real viewport)
- Snapping vertical full-page sections (page-level `scroll-snap` that forces the user to land on section boundaries against their momentum)
- Intercepting arrow key scroll to drive cinematic sections while the user expects the page to scroll normally

What is explicitly allowed:
- Smoothing/damping the *read* of `scrollY` before mapping to animation values (does not change what the scrollbar shows)
- Horizontal `scroll-snap` on carousel/gallery containers (separate scroll axis; user intent is explicit)
- `touch-action: pan-y` on custom horizontal drag surfaces (opts out of horizontal browser pan on an element, does not touch vertical scroll)
- `scroll-behavior: smooth` on programmatic `scrollIntoView()` calls (user-initiated navigation, not ambient scroll)

**Always preserve a working native scrollbar and keyboard scroll** (Page Down, Space, arrow keys). Screen-reader users, keyboard users, and users with motor disabilities rely on these. [documented — WCAG 2.1 SC 2.1.1]

---

### Pointer-vs-touch degradation for scroll-driven motion

- **Continuous scroll-progress motion works on both pointer and touch** and is the correct abstraction for multiplatform surfaces — it binds to `scrollY` regardless of input device.
- **Pointer-reactive motion** (magnetic buttons, product tilt, spotlight follow — see `research-findings-inventory §9`) is **desktop-only sugar**: gate it behind `@media (hover: hover) and (pointer: fine)`. Touch users must lose nothing meaningful when this layer is absent.
- **Reduced-motion:** All scroll-driven transforms must respect `prefers-reduced-motion: reduce`. Minimum: suppress transforms, keep opacity fades (opacity changes are acceptable under reduced-motion; spatial movement is not). For pinned-scene sequences, fall back to the one-shot IntersectionObserver pattern. [documented — Apple WWDC; MDN prefers-reduced-motion]

```css
/* Gate continuous-progress transforms under reduced motion */
@media (prefers-reduced-motion: no-preference) {
  .scroll-driven-element {
    /* transform/opacity bound to --scroll-progress JS variable */
    transform: translateY(calc((1 - var(--scroll-progress, 0)) * 40px));
    opacity: var(--scroll-progress, 0);
  }
}

/* Fallback: one-shot reveal for reduced-motion users */
@media (prefers-reduced-motion: reduce) {
  .scroll-driven-element {
    opacity: 1;
    transform: none;
  }
}
```
[documented — MDN prefers-reduced-motion; inferred from Apple's own accessibility guidance]

---

**Cross-links:**
- Surface axis classification → `apple-design` skill → `restraint-and-antislop.md`
- Animation execution (lerp primitives, CSS scroll-driven animation API, sticky-pin structure) → `apple-design-motion` skill
- Research grounding (§1–§8, §14 signature behaviors) → `references/apple-com-interaction-inventory.md` (or `_planning/research-findings-inventory.md`)

---

## Sources

- [Designing Fluid Interfaces — WWDC18 Session 803](https://developer.apple.com/videos/play/wwdc2018/803/)
- [Apple HIG — Inputs overview](https://developer.apple.com/design/human-interface-guidelines/inputs/overview/)
- [Apple HIG — Pointing Devices](https://developer.apple.com/design/human-interface-guidelines/inputs/pointing-devices/)
- [Apple HIG — Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)
- [Apple HIG — Accessibility (Hit targets)](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple UI Design Dos and Don'ts](https://developer.apple.com/design/tips/)
- [SwiftUI FocusState — Apple Developer](https://developer.apple.com/documentation/swiftui/focusstate)
- [The SwiftUI cookbook for focus — WWDC23/10162](https://developer.apple.com/videos/play/wwdc2023/10162/)
- [Direct and reflect focus in SwiftUI — WWDC21/10023](https://developer.apple.com/videos/play/wwdc2021/10023/)
- [Interaction to Next Paint (INP) — web.dev](https://web.dev/articles/inp)
- [Optimize Interaction to Next Paint — web.dev](https://web.dev/articles/optimize-inp)
- [content-visibility: the new CSS property — web.dev](https://web.dev/articles/content-visibility)
- [INP becomes a Core Web Vital — web.dev blog](https://web.dev/blog/inp-cwv-launch)
- [Prerender pages in Chrome — Chrome for Developers](https://developer.chrome.com/docs/web-platform/prerender-pages)
- [Speculation Rules API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API)
- [:focus-visible — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible)
- [pointer media feature — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer)
- [any-pointer media feature — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/any-pointer)
- [inputmode — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode)
- [touch-action — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)

---

CONFIDENCE: 84% — Core INP thresholds, WWDC18 timing numbers (hysteresis 10 pt, double-tap ~500 ms), hit-target 44 pt rule, and all web API recipes are from primary sources; SwiftUI code examples are synthesized from documented APIs and may need testing against current SDK versions; the 8 pt spacing-between-targets figure is widely cited but I could not locate a published Apple number to cite directly.
