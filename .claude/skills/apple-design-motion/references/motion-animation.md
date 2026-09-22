# Apple Motion & Animation — Design & Engineering Reference
**Scope**: Spring physics first-principles, Apple's fluid-interface rules, SwiftUI presets & transitions, and faithful web replication recipes.

---

## 1. Principles

### 1.1 Why springs, not duration/easing

Apple's interface motion is built on damped harmonic oscillator physics rather than fixed-duration cubic-bezier curves. The distinction is architectural, not cosmetic.

**Response over duration** [documented — WWDC23 "Animate with springs"]
A cubic-bezier curve requires a fixed duration; swap the duration and the feel changes entirely. A spring runs until the physics say it's done — the duration emerges from the physics. This means the same spring applied to a 40 px shift and a 400 px shift both feel natural, because travel distance scales the energy, not the feel.

**Instant launch** [documented — WWDC18 "Designing Fluid Interfaces"]
Spring displacement is maximal at t=0 and decays asymptotically toward the target. An ease-in starts slow; a spring starts at peak velocity. Interfaces feel sluggish whenever the first 50 ms show near-zero motion. Springs eliminate that lag perceptually.

**Interruptibility** [documented — WWDC18]
Because a spring's state is fully described by (position, velocity) at any moment, you can interrupt at any point and start a new spring from those exact initial conditions. The new animation inherits momentum. A cubic-bezier transition cannot do this cleanly — interrupting mid-transition and reversing produces an abrupt velocity discontinuity unless you manually compute the midpoint velocity.

**Momentum preservation (gesture handoff)** [documented — WWDC18]
When a user releases a drag, the gesture has a velocity vector. Passing that velocity as `initialVelocity` to a spring means the animation literally continues the hand's motion and then settles. The energy the user injected is preserved and naturally dissipated. This is why flicking feels satisfying on iOS and stiff on apps that ignore release velocity.

**No animation blocking input** [documented — WWDC18]
Apple's rule is: user input must never wait for an animation to complete. Animations must yield. Springs make this natural because any in-flight spring can absorb a new target + velocity at any frame.

**Naturalness heuristic** [observed — HIG Motion]
Apple's broader principle: motion should feel purposeful and grounded in the physical world, not arbitrary. Springs are the most direct approximation of real-world objects with mass, elasticity, and friction. Users have lifelong physical intuitions for these behaviors; springs exploit those intuitions.

---

### 1.2 The three characteristics of fluid interfaces [documented — WWDC18]

1. **Responsive** — The interface reacts the instant the finger contacts the screen; no perceptible latency before motion begins. If a network operation is required, the visual response starts immediately and the data loads into already-moving UI.
2. **Interruptible** — Any animation can be stopped at any point in its arc without jarring the user. Tapping the home button during a launch animation, or re-tapping a button during its press animation, must work cleanly.
3. **Redirectable** — Mid-flight animations can change course. Swiping back part-way and then forward again re-targets the spring; velocity is preserved, not reset.

---

### 1.3 Choreography & hierarchy [inferred from HIG + WWDC18]

- Related elements move together as a unit (shared-element / hero transition).
- Independent elements move independently, but in temporal harmony — slight staggering (~20–40 ms offset between items) communicates list membership without looking disconnected.
- Avoid simultaneous full-screen motion across multiple independent regions; the eye cannot track competing focal points.

---

## 2. Apple Specifics

### 2.1 Spring physics parameters

A spring is defined by three physical quantities [documented — WWDC23]:

| Parameter | Role | Effect on feel |
|---|---|---|
| **Mass (m)** | Inertia of the object | Higher mass → slower start, more overshoot |
| **Stiffness (k)** | Tensile strength of the spring | Higher k → snappier, faster initial pull |
| **Damping (c)** | Frictional braking force | Higher c → less bounce, settles faster |

**Damping regimes** [documented — physics]:
- `c < 2√(km)` → underdamped (oscillates, "springy")
- `c = 2√(km)` → critically damped (fastest settle, no overshoot)
- `c > 2√(km)` → overdamped (slow, sluggish — avoid in UI)

**Design-friendly re-parameterization** [documented — WWDC18, SwiftUI]:
Apple exposes springs in two ways that are easier to reason about:

**Option A — response + dampingFraction (iOS 14+)**
```
response    → period of one full oscillation (seconds); lower = faster
dampingFraction → ratio of actual/critical damping (0 = infinite bounce, 1 = no bounce)
```
Conversion from physics parameters [documented — WWDC23 notes]:
```
stiffness  = (2π / response)²
damping    = 4π × dampingFraction / response
```

**Option B — duration + bounce (iOS 17+)** [documented — WWDC23]
```
duration  → perceptual duration in seconds (when the bulk of motion is done)
bounce    → -1.0 (overdamped) to 1.0 (highly underdamped); 0 = no overshoot
```
Conversion:
```
stiffness = (2π / duration)²              [when bounce ≥ 0]
damping   = 1 – 4π × bounce / duration
damping   = 4π / (duration + 4π × bounce) [when bounce < 0]
```

---

### 2.2 SwiftUI spring presets [documented — Apple Developer Documentation, iOS 17+]

All three presets share `duration: 0.5` as default and accept `(duration: TimeInterval, extraBounce: Double)`.

| Preset | Default bounce character | Practical use |
|---|---|---|
| `.smooth` | No bounce (critically damped or near) | Modal sheet dismiss, background transitions |
| `.snappy` | Small bounce (~15%) | Button press, chip select, quick state toggles |
| `.bouncy` | Medium bounce (~30%+) | App icon press, notification banner arrive, rewarding feedback |

```swift
// iOS 17+ — duration + bounce API (preferred)
.smooth                          // 0.5s, no bounce [documented]
.smooth(duration: 0.35)          // faster smooth
.snappy                          // 0.5s, small bounce [documented]
.snappy(duration: 0.3, extraBounce: 0.05)
.bouncy                          // 0.5s, medium bounce [documented]
.bouncy(duration: 0.6, extraBounce: 0.15)

// Explicit spring(duration:bounce:) — iOS 17+
.spring(duration: 0.4, bounce: 0.2)

// Legacy response/dampingFraction — iOS 14+
.spring(response: 0.55, dampingFraction: 0.825) // SwiftUI default [documented]
.spring(response: 0.3,  dampingFraction: 0.8)   // snappy-interactive feel [observed]
.spring(response: 0.32, dampingFraction: 0.72)  // Apple Music card feel [observed]

// Interactive spring (gesture-driven, very snappy)
.interactiveSpring(response: 0.15, dampingFraction: 0.86, blendDuration: 0.25) // [documented]

// Low-level — stiffness/damping directly (iOS 17+)
.interpolatingSpring(stiffness: 170, damping: 15) // baseline bouncy [observed community]
.interpolatingSpring(stiffness: 200, damping: 20) // snappier
```

**initialVelocity note** [documented]: Pass gesture release velocity (in units/second, normalized to the animation range [0,1]) to `initialVelocity:` on `.interpolatingSpring` to achieve gesture handoff.

---

### 2.3 Standard durations — where Apple uses fixed timing [documented — HIG + UIKit]

Springs are preferred for interactive elements. Fixed-duration curves are appropriate for:

| Context | Duration | Curve |
|---|---|---|
| Micro-interaction (button tap feedback) | 100–200 ms | ease-out or spring |
| Quick state transition (chip, toggle) | 200–300 ms | spring (snappy) |
| Sheet/modal present | 300–400 ms | spring (smooth) |
| Full-screen navigation push | 350–450 ms | spring (smooth) |
| Large content reveal | 400–500 ms | ease-in-out or spring (smooth) |
| System alert appearance | ~300 ms | spring |

Rule of thumb: micro-interactions < 250 ms to feel instant; full-screen transitions < 500 ms to avoid feeling slow. [inferred from HIG guidance + community observation]

---

### 2.4 Hero / continuity transitions [documented — iOS 18 SwiftUI]

**matchedGeometryEffect (iOS 14+)** — shared-element within the same view hierarchy:
- Links source and destination views by `id` + `@Namespace`
- SwiftUI interpolates frame, corner radius, and composited appearance
- Wrap state change in `withAnimation(.spring(...))` for spring-driven geometry morphing

**zoom navigationTransition + matchedTransitionSource (iOS 18)** — shared-element across navigation pushes and sheets:
- Cleaner than `matchedGeometryEffect` for push/pop; handles sheet presentation natively
- System handles spring parameters (not user-configurable at this API level) [observed]
- Works correctly with interactive back swipe (velocity preserved)

---

### 2.5 Reduce Motion [documented — HIG, Apple Accessibility]

`@Environment(\.accessibilityReduceMotion)` / `UIAccessibility.isReduceMotionEnabled`

Rules:
1. Never disable animation entirely for meaningful transitions — information conveyed by motion (hierarchy, spatial relationship) is lost.
2. Replace large spatial movement (translate, scale) with a dissolve or cross-fade.
3. Retain brief functional animations (< 100 ms indicator flash, focus ring).
4. Do not use `prefers-reduced-motion: reduce` to simply set `transition: none` — replace with opacity transitions.

```swift
@Environment(\.accessibilityReduceMotion) var reduceMotion

var animation: Animation {
    reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.4, dampingFraction: 0.8)
}
```

---

## 3. Recipes

### 3.1 SwiftUI spring animations

```swift
import SwiftUI

// --- Basic spring state toggle ---
struct SpringToggle: View {
    @State private var expanded = false

    var body: some View {
        RoundedRectangle(cornerRadius: expanded ? 24 : 12)
            .fill(.blue)
            .frame(
                width:  expanded ? 280 : 80,
                height: expanded ? 160 : 80
            )
            .onTapGesture {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.75)) {
                    expanded.toggle()
                }
            }
    }
}

// --- Gesture-velocity handoff (drag → spring release) ---
struct DraggableCard: View {
    @GestureState private var dragOffset = CGSize.zero
    @State          private var position  = CGSize.zero

    var body: some View {
        RoundedRectangle(cornerRadius: 20)
            .fill(.white)
            .shadow(radius: 12)
            .frame(width: 200, height: 120)
            .offset(
                x: position.width  + dragOffset.width,
                y: position.height + dragOffset.height
            )
            .gesture(
                DragGesture()
                    .updating($dragOffset) { value, state, _ in
                        state = value.translation
                    }
                    .onEnded { value in
                        // Snap-back with gesture velocity injected
                        let velocity = CGSize(
                            width:  value.predictedEndTranslation.width  - value.translation.width,
                            height: value.predictedEndTranslation.height - value.translation.height
                        )
                        // Normalize velocity to [0,1] range for initialVelocity
                        withAnimation(
                            .interpolatingSpring(
                                stiffness: 200,
                                damping: 20,
                                initialVelocity: velocity.width / 200  // rough normalization
                            )
                        ) {
                            position = .zero
                        }
                    }
            )
    }
}

// --- matchedGeometryEffect hero (iOS 14+) ---
struct HeroGrid: View {
    @Namespace private var heroNS
    @State      private var selectedID: String? = nil

    let items = ["A", "B", "C"]

    var body: some View {
        ZStack {
            if let id = selectedID {
                // Detail view
                RoundedRectangle(cornerRadius: 24)
                    .fill(.blue)
                    .matchedGeometryEffect(id: id, in: heroNS)
                    .frame(width: 320, height: 400)
                    .onTapGesture {
                        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                            selectedID = nil
                        }
                    }
            } else {
                // Grid
                HStack {
                    ForEach(items, id: \.self) { item in
                        RoundedRectangle(cornerRadius: 12)
                            .fill(.blue.opacity(0.7))
                            .matchedGeometryEffect(id: item, in: heroNS)
                            .frame(width: 80, height: 80)
                            .onTapGesture {
                                withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                                    selectedID = item
                                }
                            }
                    }
                }
            }
        }
    }
}

// --- iOS 18 zoom navigationTransition ---
// (Requires iOS 18+, NavigationStack)
struct ZoomHeroExample: View {
    @Namespace private var zoomNS

    let items = ["Alpha", "Beta", "Gamma"]

    var body: some View {
        NavigationStack {
            List(items, id: \.self) { item in
                NavigationLink(value: item) {
                    Text(item)
                        .padding()
                        .background(.blue.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                        // Mark as transition source
                        .matchedTransitionSource(id: item, in: zoomNS)
                }
            }
            .navigationDestination(for: String.self) { item in
                Text(item)
                    .font(.largeTitle)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.blue.opacity(0.08))
                    // Apply zoom transition on destination
                    .navigationTransition(.zoom(sourceID: item, in: zoomNS))
            }
        }
    }
}

// --- Reduce motion guard ---
struct ReduceMotionAwareCard: View {
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @State private var show = false

    var transition: AnyTransition {
        reduceMotion
            ? AnyTransition.opacity
            : AnyTransition.scale(scale: 0.85).combined(with: .opacity)
    }

    var body: some View {
        Button("Toggle") {
            withAnimation(
                reduceMotion
                    ? .easeInOut(duration: 0.2)
                    : .spring(response: 0.4, dampingFraction: 0.78)
            ) {
                show.toggle()
            }
        }
        if show {
            RoundedRectangle(cornerRadius: 16)
                .fill(.purple.opacity(0.3))
                .frame(height: 120)
                .transition(transition)
        }
    }
}
```

---

### 3.2 CSS spring via `linear()` easing

The `linear()` function (Chrome 113+, Firefox 112+, Safari 17.2+) can approximate spring physics by encoding sampled spring positions as keyframe stops.

**Smooth spring** — response ≈ 0.5s, no bounce (~critically damped):
```css
:root {
  /* Generated via kvin.me/css-springs: 500ms perceptual duration, 0% bounce */
  --spring-smooth-easing: linear(
    0, 0.0037, 0.0142, 0.031, 0.0534, 0.0804, 0.1108,
    0.1438, 0.1784, 0.2135, 0.2484, 0.3145, 0.3746,
    0.4283, 0.4755, 0.5562, 0.6215, 0.6726, 0.7112,
    0.7735, 0.8196, 0.854, 0.8793, 0.9185, 0.9458,
    0.9647, 0.9779, 0.9921, 1
  );
  --spring-smooth-duration: 500ms;
}

.card {
  transition: transform var(--spring-smooth-duration) var(--spring-smooth-easing);
}
```

**Bouncy spring** — response ≈ 0.83s, ~30% bounce (from kvin.me default output) [documented — kvin.me/css-springs]:
```css
:root {
  --spring-bouncy-easing: linear(
    0, 0.0018, 0.0069 1.15%, 0.026 2.3%, 0.0637,
    0.1135 5.18%, 0.2229 7.78%, 0.5977 15.84%,
    0.7014, 0.7904, 0.8641, 0.9228,
    0.9676 28.8%, 1.0032 31.68%, 1.0225,
    1.0352 36.29%, 1.0431 38.88%, 1.046 42.05%,
    1.0448 44.35%, 1.0407 47.23%,
    1.0118 61.63%, 1.0025 69.41%,
    0.9981 80.35%, 0.9992 99.94%
  );
  --spring-bouncy-duration: 833ms;
}
```

**Snappy spring** — short duration, minimal bounce:
```css
:root {
  /* Approximation for ~250ms, 10% bounce */
  --spring-snappy-easing: linear(
    0, 0.012, 0.049, 0.107, 0.185, 0.278, 0.383,
    0.493, 0.601, 0.702, 0.791, 0.865, 0.924,
    0.967, 0.995, 1.013, 1.019, 1.016,
    1.009, 1.003, 1
  );
  --spring-snappy-duration: 280ms;
}
```

**Progressive enhancement pattern with cubic-bezier fallback**:
```css
:root {
  /* Fallback — approximate with cubic-bezier */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-spring-duration: 400ms;
}

@supports (animation-timing-function: linear(0, 1)) {
  :root {
    /* Enhanced — true spring approximation */
    --ease-spring: linear(
      0, 0.0069 1.15%, 0.026 2.3%, 0.1135 5.18%,
      0.2229 7.78%, 0.5977 15.84%, 0.9228,
      0.9676 28.8%, 1.0032 31.68%, 1.046 42.05%,
      1.0118 61.63%, 1.0025 69.41%, 0.9992 99.94%
    );
    --ease-spring-duration: 500ms;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --ease-spring: linear(0, 1);  /* instant — effectively no motion */
    --ease-spring-duration: 0ms;
  }
}

.button {
  transition: transform var(--ease-spring-duration) var(--ease-spring);
  will-change: transform;
}

.button:active {
  transform: scale(0.96);
}
```

---

### 3.3 JavaScript spring helper (vanilla, gesture-velocity-aware)

```javascript
/**
 * Minimal physics spring. Integrate with requestAnimationFrame.
 * Usage: create once, set .target, call .tick(dt) each frame.
 *
 * Based on damped harmonic oscillator: F = -kx - cv
 */
class Spring {
  constructor({
    stiffness   = 200,   // k — higher = snappier
    damping     = 20,    // c — higher = less bounce
    mass        = 1,     // m — lower = more responsive
    initialValue = 0,
  } = {}) {
    this.k       = stiffness;
    this.c       = damping;
    this.m       = mass;
    this.value   = initialValue;
    this.target  = initialValue;
    this.velocity = 0;
  }

  /** Inject gesture release velocity (same units as value) */
  setVelocity(v) {
    this.velocity = v;
  }

  /** Step simulation by dt seconds. Returns current value. */
  tick(dt = 1 / 60) {
    const force      = -this.k * (this.value - this.target);
    const damping    = -this.c * this.velocity;
    const accel      = (force + damping) / this.m;
    this.velocity   += accel * dt;
    this.value      += this.velocity * dt;
    return this.value;
  }

  get settled() {
    return (
      Math.abs(this.velocity) < 0.01 &&
      Math.abs(this.value - this.target) < 0.01
    );
  }
}

// --- Usage with gesture velocity handoff ---
const xSpring = new Spring({ stiffness: 200, damping: 20 });
let   lastPointerX = 0;
let   lastTimestamp = 0;
let   pointerVelocityX = 0;
let   rafId = null;

function onPointerMove(e) {
  const now = performance.now();
  const dt  = (now - lastTimestamp) / 1000;
  if (dt > 0) pointerVelocityX = (e.clientX - lastPointerX) / dt;
  lastPointerX  = e.clientX;
  lastTimestamp = now;
  xSpring.value = e.clientX;   // Track finger directly (no animation during drag)
}

function onPointerUp() {
  xSpring.target = 0;                            // Snap-back to origin
  xSpring.setVelocity(pointerVelocityX);         // Inject release velocity
  if (!rafId) animate();
}

function animate() {
  const x = xSpring.tick(1 / 60);
  element.style.transform = `translateX(${x}px)`;
  if (!xSpring.settled) {
    rafId = requestAnimationFrame(animate);
  } else {
    rafId = null;
  }
}

element.addEventListener('pointermove', onPointerMove);
element.addEventListener('pointerup',   onPointerUp);
```

---

### 3.4 Motion.dev spring (recommended for production JS) [documented — motion.dev]

```javascript
import { animate, spring } from "motion"

// Smooth card expand — Apple Music-like
animate(
  card,
  { scale: [1, 1.04] },
  {
    type: "spring",
    stiffness: 300,
    damping: 25,
    mass: 1,
  }
)

// With gesture velocity handoff
function onRelease(velocityX) {
  animate(
    el,
    { x: 0 },
    {
      type:     "spring",
      stiffness: 200,
      damping:   20,
      velocity:  velocityX,   // pixels/sec from gesture tracking
    }
  )
}

// Using bounce shorthand (Motion v11+)
animate(
  button,
  { scale: [0.95, 1] },
  { type: "spring", duration: 0.3, bounce: 0.15 }
)
```

---

## 4. Faithful Replication — Making Web Motion Feel Apple-Fluid

### 4.1 Gesture velocity handoff [documented principle, web implementation inferred]

Capture `pointermove` velocity in the final ~5 frames before `pointerup`. Average or use LERP to smooth jitter. Pass to the spring's `initialVelocity`. Libraries like `@use-gesture/react` expose `velocity` directly on the gesture event.

```javascript
// @use-gesture/react + Framer Motion
import { useSpring, animated } from "@react-spring/web"
import { useDrag } from "@use-gesture/react"

function DraggableCard() {
  const [{ x }, api] = useSpring(() => ({ x: 0 }))

  const bind = useDrag(({ last, velocity: [vx], direction: [dx], offset: [ox] }) => {
    if (last) {
      // Snap back with gesture velocity
      api.start({ x: 0, config: { velocity: vx * dx, tension: 200, friction: 20 } })
    } else {
      api.start({ x: ox, immediate: true })  // Direct tracking — no animation during drag
    }
  })

  return <animated.div {...bind()} style={{ x }} />
}
```

### 4.2 Interruptible transforms [documented principle, CSS behavior]

Always animate `transform` and `opacity` only — never `width`, `height`, `top`, `left`, `margin`, or `padding`. The compositor thread handles `transform`/`opacity` without involving layout or paint, making interruptions seamless.

```css
/* CORRECT — compositor path */
.card {
  transform: translateX(0);
  transition: transform 300ms var(--ease-spring);
  will-change: transform;   /* hint compositor to promote to own layer */
}

.card.shifted {
  transform: translateX(60px);
}

/* WRONG — triggers layout recalc, cannot be interrupted cleanly */
.card {
  margin-left: 0;
  transition: margin-left 300ms ease;
}
```

### 4.3 `will-change` discipline [documented — MDN, observed Apple platform behavior]

- Apply `will-change: transform` only to elements about to animate. Do not apply globally.
- Remove `will-change` after animation completes (memory cost of layer promotion persists).
- Prefer `transform: translateZ(0)` as a legacy compositor promotion trigger on older Safari.

```javascript
el.addEventListener('mouseenter', () => { el.style.willChange = 'transform' })
el.addEventListener('animationend', () => { el.style.willChange = 'auto' })
```

### 4.4 Immediate visual response [documented — WWDC18 principle, web implementation]

The frame a user taps/clicks must show visible change. Do not defer the visual response to a `setTimeout` or async callback. Use `requestAnimationFrame` at most as a one-frame defer for layout reads, then update immediately.

```javascript
button.addEventListener('pointerdown', () => {
  // Scale down instantly on the very next paint
  requestAnimationFrame(() => {
    button.style.transform = 'scale(0.96)'
  })
})

button.addEventListener('pointerup', () => {
  // Spring back with release velocity ≈ 0
  button.style.transition = `transform ${var(--spring-snappy-duration)} var(--spring-snappy-easing)`
  button.style.transform   = 'scale(1)'
})
```

### 4.5 Spring from interrupted mid-state [inferred — physics, Framer Motion pattern]

When a user re-triggers an animation before the previous one finishes, read current `transform` via `getComputedStyle` or library state, use it as the new `from` value, and set the in-flight velocity as `initialVelocity`.

```javascript
// With Motion.js (motion.dev)
import { animate, spring } from "motion"

let currentAnimation = null

button.addEventListener("click", () => {
  // Cancel previous animation, capture current position
  if (currentAnimation) currentAnimation.stop()

  const currentX = parseFloat(getComputedStyle(el).transform.split(",")[4] ?? 0)

  currentAnimation = animate(
    el,
    { x: targetX },
    { type: "spring", stiffness: 200, damping: 20, from: currentX }
  )
})
```

### 4.6 Reduced motion — web [documented — MDN prefers-reduced-motion]

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

For meaningful transitions (navigation, state change), replace with cross-fade rather than disabling entirely:

```javascript
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

function transitionTo(newState) {
  if (reduceMotion) {
    // Opacity crossfade — conveys change without spatial motion
    animate(el, { opacity: 0 }, { duration: 0.15 }).then(() => {
      applyNewState(newState)
      animate(el, { opacity: 1 }, { duration: 0.15 })
    })
  } else {
    animate(el, { scale: 0.95, opacity: 0 }, { type: "spring", duration: 0.2 })
      .then(() => {
        applyNewState(newState)
        animate(el, { scale: 1, opacity: 1 }, { type: "spring", duration: 0.35, bounce: 0.15 })
      })
  }
}
```

---

---

## 4.7 Entry / materialize motion (recipe) [inferred from observed Apple apps + iOS 26 API]

This covers the specific case of an element appearing **for the first time** — newly unlocked content, an achievement card, a just-revealed station, a downloaded-app confirmation. This is distinct from a toggle or a navigation push: there is no "from" state the user ever saw.

### How Apple brings brand-new content in [inferred from observed patterns]

Across Apple Fitness achievement overlays, App Store "Get" → download completion badges, widget additions, and system notification banners, the consistent observed recipe is:

| Property | Entry start | Settled |
|---|---|---|
| `scale` | ~0.88–0.92 | 1.0 |
| `opacity` | 0 | 1 |
| `spring` | `.bouncy` or `response: 0.4, dampingFraction: 0.72–0.80` | — |
| Optional glow | shadow radius 0 → brief expand → settle | shadow at rest value |

The scale-from-below (not from 0) is deliberate: the element feels like it **rises into place** from slightly behind, rather than popping from nothing. Combined with the spring's natural overshoot, the net effect is a brief scale-to-~1.03 before settling at 1.0 — the "settle" communicates weight and reality.

**iOS 26 note** [documented — iOS 26 SDK]: For glass-material elements, Apple adds `.glassEffectTransition(.materialize)` — "elements appear by gradually modulating light bending." On non-glass surfaces, the scale + opacity recipe below is the direct analogue.

### SwiftUI recipe

```swift
// New element appearing for the first time — toggle via @State isVisible
struct MaterializeView: View {
    @State private var isVisible = false
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        VStack {
            if isVisible {
                AchievementCard()
                    // Scale-from-below + opacity entry
                    .transition(
                        reduceMotion
                            ? .opacity                              // reduced: crossfade only
                            : .scale(scale: 0.92).combined(with: .opacity)
                    )
            }

            Button("Reveal") {
                withAnimation(
                    reduceMotion
                        ? .easeInOut(duration: 0.2)
                        : .spring(response: 0.4, dampingFraction: 0.76)  // slight bounce
                ) {
                    isVisible = true
                }
            }
        }
    }
}

// Optional glow-and-settle effect layered on top (decoration only, not structural)
struct AchievementCard: View {
    @State private var glowRadius: CGFloat = 18

    var body: some View {
        RoundedRectangle(cornerRadius: 20)
            .fill(.blue.gradient)
            .shadow(color: .blue.opacity(0.55), radius: glowRadius, y: 4)
            .onAppear {
                // Glow breathes out then settles — purely decorative
                withAnimation(.easeOut(duration: 0.45).delay(0.15)) {
                    glowRadius = 6   // settle to resting shadow
                }
            }
    }
}
```

**Spring parameter guide for entry context:**

| Feel | SwiftUI | Bounce character |
|---|---|---|
| Rewarding (achievement, unlock) | `.bouncy` or `.spring(response: 0.4, dampingFraction: 0.72)` | Visible overshoot ~5–8% |
| Confident (downloaded, added) | `.spring(response: 0.38, dampingFraction: 0.82)` | Tiny overshoot |
| Calm (settings reveal, new section) | `.smooth` or `.spring(response: 0.45, dampingFraction: 1.0)` | No bounce |

### CSS / JS recipe (web)

Uses the existing `--spring-bouncy-easing` and `--spring-smooth-easing` tokens from §3.2.

```css
/* Entry keyframe — uses bouncy spring token from §3.2 */
@keyframes materialize-in {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.new-element {
  /* Hardware-accelerated path: transform + opacity only */
  animation: materialize-in var(--spring-bouncy-duration) var(--spring-bouncy-easing) both;
  will-change: transform, opacity;
}

/* Resting glow — set on the element, not animated on the main path */
.new-element--achievement {
  box-shadow: 0 0 0 0 rgba(99, 102, 241, 0);  /* start collapsed */
  animation:
    materialize-in var(--spring-bouncy-duration) var(--spring-bouncy-easing) both,
    glow-settle 450ms ease-out 150ms both;
}

@keyframes glow-settle {
  from { box-shadow: 0 0 24px 6px rgba(99, 102, 241, 0.55); }
  to   { box-shadow: 0 4px 12px 0   rgba(99, 102, 241, 0.18); }
}

/* Reduced motion — opacity crossfade only, no spatial movement */
@media (prefers-reduced-motion: reduce) {
  .new-element,
  .new-element--achievement {
    animation: none;
    /* Replace with brief opacity crossfade */
    opacity: 0;
    transition: opacity 200ms ease-in-out;
  }
  .new-element.is-visible,
  .new-element--achievement.is-visible {
    opacity: 1;
  }
}
```

```javascript
// Trigger with JS — toggle class after inserting element to DOM
function materializeElement(el) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reduceMotion) {
    // requestAnimationFrame defers so transition fires after display:block
    requestAnimationFrame(() => el.classList.add('is-visible'))
    return
  }

  // For CSS keyframe approach: element already has .new-element class on insert
  // For JS spring approach, use Motion.dev:
  // import { animate } from "motion"
  // animate(el, { scale: [0.92, 1], opacity: [0, 1] },
  //   { type: "spring", duration: 0.4, bounce: 0.2 })
}
```

**Reference patterns** [observed]:
- **Apple Fitness** — achievement overlay: scale-up + opacity, bouncy spring, brief radial glow that dissipates
- **App Store** — download completion badge transition: scale from ~0.9 + opacity, smooth spring
- **iOS widget add** — widget materializes into grid at ~0.9 scale + opacity, snappy spring
- **System notification banner** — slides in from top with slight scale, `response ≈ 0.4, dampingFraction ≈ 0.8` [observed]

---

## 4.8 Progress connector / journey transition (recipe) [inferred from observed Apple apps]

When a UI represents sequential steps connected by a visible path or line (onboarding flows, step-by-step guides, learning paths), Apple's approach is to animate the connector's **fill progress** rather than any positional movement — keeping all animation on the compositor thread.

### Pattern description [inferred]

The connector between step N and step N+1 goes from an **unlit / muted** state to a **filled / tinted** state when step N is completed. This is the only animation on the connector itself. No spatial movement occurs. The destination step node simultaneously runs the entry materialize motion (§4.7) to signal arrival.

### CSS recipe — vertical connector line

```css
/* Connector line — vertical, between two step nodes */
.step-connector {
  width: 2px;
  background: #e5e5ea;           /* iOS separator colour — "locked" state */
  position: relative;
  overflow: hidden;
  border-radius: 1px;
}

/* Fill overlay — animates via transform: scaleY, not height */
.step-connector__fill {
  position: absolute;
  inset: 0;
  background: #007aff;           /* tint colour — "completed" state */
  transform-origin: top center;
  transform: scaleY(0);          /* start: no fill */
  transition:
    transform var(--spring-smooth-duration) var(--spring-smooth-easing),
    background-color 200ms ease;
  will-change: transform;
}

/* Completed state */
.step-connector.is-complete .step-connector__fill {
  transform: scaleY(1);          /* full fill — compositor-thread only */
}

/* Reduced motion — instant recolor, no spatial movement */
@media (prefers-reduced-motion: reduce) {
  .step-connector__fill {
    transition: background-color 200ms ease;
    transform: scaleY(1);        /* always fully drawn; color does the work */
    background: #e5e5ea;
  }
  .step-connector.is-complete .step-connector__fill {
    background: #007aff;
  }
}
```

### SVG path connector variant

For curved or diagonal connectors, use `stroke-dashoffset` — the only SVG property that animates on the compositor thread alongside `transform` and `opacity`:

```css
.path-connector {
  stroke: #e5e5ea;
  stroke-width: 2;
  fill: none;
  stroke-dasharray: 200;         /* set to actual path length via JS: path.getTotalLength() */
  stroke-dashoffset: 200;        /* fully hidden */
  transition: stroke-dashoffset var(--spring-smooth-duration) var(--spring-smooth-easing),
              stroke 200ms ease;
  will-change: stroke-dashoffset;
}

.path-connector.is-complete {
  stroke-dashoffset: 0;           /* fully drawn */
  stroke: #007aff;
}

@media (prefers-reduced-motion: reduce) {
  .path-connector {
    stroke-dashoffset: 0;
    transition: stroke 200ms ease;
  }
}
```

```javascript
// Set dasharray to actual SVG path length at runtime
document.querySelectorAll('.path-connector').forEach(path => {
  const len = path.getTotalLength()
  path.style.strokeDasharray = len
  path.style.strokeDashoffset = len   // start hidden; add .is-complete to fill
})
```

### Choreography rule [inferred from Apple Fitness step transitions]

When a step completes:
1. **Connector fills** — smooth spring, ~500 ms
2. **Destination node materializes** — bouncy spring, starts ~150 ms after fill begins (slight stagger)
3. **No other motion** — do not simultaneously translate, rotate, or resize any other element

This ensures the eye can track one focal transition at a time (see §1.3 choreography principle).

---

---

## 4.9 Functional timing rationale — decision table [inferred from HIG Motion + WWDC18 + community observation]

The single most common mistake is applying the same spring or duration to every interaction. Apple differentiates timing by **interaction scale, spatial weight, destructiveness, and frequency**. The governing heuristic is:

> **Smaller, closer, more frequent = faster and snappier. Larger, spatial, destructive, or infrequent = slower and more deliberate.**

The rationale is perceptual: a 400 ms animation on a button tap makes the interface feel unresponsive; a 150 ms animation on a full-screen push makes spatial context switch too abruptly for the brain to anchor. Duration earns the cognitive work it asks the user to do.

### 4.9.1 Decision table

| Action | Element scale | Frequency | Destructive? | Target duration | Spring character | Why |
|---|---|---|---|---|---|---|
| **Tap / press feedback** (scale pulse on button) | micro (< 40 px travel) | very high | no | 120–180 ms | `.snappy` or `spring(response: 0.25, dampingFraction: 0.85)` | Must feel instant; any perceptible lag = sluggish. Small element, minimal physics work needed. |
| **Toggle / switch / chip select** | micro–small | high | no | 200–280 ms | `.snappy` or `spring(response: 0.3, dampingFraction: 0.80)` | State change should confirm without commanding attention. Fast enough to stay invisible; slow enough to be perceptible. |
| **Inline expand / collapse** (accordion, inline reveal) | mid (panel/row grows) | medium | no | 300–380 ms | `spring(response: 0.38, dampingFraction: 0.80)` | Panel travel is visible; user needs a beat to register new layout. Tiny bounce communicates elasticity, signals content is live. |
| **Delete / remove item** (swipe-to-delete, destructive confirm) | mid | low | **yes** | 320–400 ms | `.smooth` or `spring(response: 0.40, dampingFraction: 0.95)` | Destructive = deliberate. Slightly slower pace gives user a cognitive checkpoint; no bounce (would feel celebratory for an error state). |
| **Sheet / modal present** | large (covers 50–100% screen) | medium | no | 350–420 ms | `.smooth` or `spring(response: 0.45, dampingFraction: 0.85)` | Large spatial jump needs time so the brain registers destination before the card lands. Smooth spring avoids bounce on a heavyweight surface. |
| **Sheet / modal dismiss** | large | medium | no | 300–380 ms | `.smooth` or `spring(response: 0.40, dampingFraction: 0.88)` | Dismiss is slightly faster than present — user already knows where they're going (back). Asymmetry is intentional: appear deliberate, disappear brisk. |
| **Navigation push** (new screen slides in) | full-screen | medium | no | 350–450 ms | `.smooth` or `spring(response: 0.50, dampingFraction: 0.90)` | Spatial hierarchy shift — the brain needs ~350 ms to build a new spatial model. Critically damped (no bounce) keeps focus on content, not the chrome. |
| **Navigation pop / back** | full-screen | medium | no | 300–400 ms | `.smooth` — slightly faster than push | "Going back" to a known place; shorter duration exploits familiarity. |
| **Refresh / pull-to-refresh** (spinner settle, content slot-in) | mid–large | low | no | 400–500 ms | `spring(response: 0.5, dampingFraction: 1.0)` (smooth, no bounce) | Content materialising from a network fetch needs to land calmly; a bouncy spring on newly loaded data looks cartoon-like. |
| **Reveal / appear of brand-new content** (unlock, achievement) | mid | very low | no | 350–500 ms | `.bouncy` or `spring(response: 0.4, dampingFraction: 0.72)` | Infrequency earns a richer spring. Visible overshoot (~3–6%) communicates weight and surprise. See §4.7. |
| **Large hero / shared-element expand** (card → full-screen) | macro | low | no | 400–500 ms | `spring(response: 0.45, dampingFraction: 0.82)` | Largest spatial travel in the hierarchy — slowest justified duration. Small bounce (dampingFraction ~0.82) gives the destination a sense of landing. |
| **Micro badge / count update** (unread count changes) | tiny (< 24 px) | very high | no | 100–150 ms | `.snappy` | Badge lives in peripheral vision; update must be near-instant. Use scale-pulse (1.0 → 1.25 → 1.0) rather than a slide. |

**Rule of thumb from §2.3 (restated with rationale)**: micro-interactions < 250 ms so they feel instant; full-screen transitions < 500 ms so they don't feel slow. Everything between is calibrated by distance × weight × frequency × emotional valence.

### 4.9.2 The asymmetry rule [inferred from observed Apple apps]

**Appear is slower than disappear** across nearly all Apple surfaces. The eye must register arrival; departure is automatic. Concrete observations:

- Sheet present: ~380 ms / sheet dismiss: ~320 ms
- Navigation push: ~420 ms / navigation pop: ~360 ms
- Element enter (fade+scale): ~350 ms / element exit (fade only): ~180 ms

For exit-only motion, prefer a pure opacity fade (150–220 ms, ease-in) rather than a spring — exits benefit from brevity, not from announcing themselves.

### 4.9.3 Frequency penalty [inferred from HIG "Don't overuse animation"]

Actions the user may trigger dozens of times per session (list row tap, toggle, chip select) should animate in < 250 ms even if the element is mid-sized. The cumulative weight of slow frequent animations is fatigue. Reserve longer durations for **low-frequency, high-significance** moments: first launch, unlock, achievement, destructive confirm, full-screen navigation.

---

## 4.10 Multi-element choreography [inferred from HIG §1.3 + WWDC18 + iOS 26 motion design observed patterns]

When more than one element moves in a single transition, they must be **coordinated**, not independent. Uncoordinated simultaneous motion across multiple regions competes for foveal attention and reads as chaos. Apple's observed approach is to designate one **lead element** that defines the transition's rhythm, with **followers** settling relative to it.

### 4.10.1 Lead + follower pattern

The **lead element** is the one that defines spatial intent: the card that expands, the header that slides in, the node that materialises. Every other element is a follower:

- Followers start **slightly after** the lead (stagger).
- Followers are typically **slower to reach full opacity** than the lead — their scale/translate can match the lead's timing, but their opacity cross-fade is extended by ~20–30%.
- Followers never overtake the lead: if the lead takes 400 ms, no follower completes visually before the lead does.

### 4.10.2 Stagger intervals [inferred from HIG §1.3 + UX research, corroborated by react-flip-move + Staggered Animation community docs]

**The right stagger for most list/grid reveals: 20–50 ms per item.**

| Item count | Recommended per-item stagger | Total stagger budget | Notes |
|---|---|---|---|
| 2–3 | 40–60 ms | < 120 ms | Can go up to 80 ms before feeling detached |
| 4–6 | 30–50 ms | < 200 ms | Sweet spot for card grids, settings rows |
| 7–12 | 20–35 ms | < 300 ms | Keep total stagger ≤ 300 ms or the last item feels abandoned |
| 13+ | 15–25 ms (with cap) | ≤ 400 ms hard cap | Non-linear (ease-out curve on the stagger itself) prevents tail drag |

**Why 20–50 ms works**: The interval is short enough that the items read as a single animated *unit* rather than a parade; long enough that the eye catches a directional sweep that encodes list membership. Below ~15 ms, stagger is imperceptible and wastes the authoring cost. Above ~80 ms, items feel unrelated.

**Non-linear stagger** (acceleration into the group, deceleration out) is more natural than a fixed interval: `delay = index * BASE * easeOut(index / total)`. This mirrors the spring's own asymptotic settle and avoids the last item arriving noticeably late.

### 4.10.3 When stagger helps vs. hurts

**Stagger helps when:**
- Items are spatially repetitive (list rows, grid cards, tab bar icons on first launch)
- Revealing a collection of equal-hierarchy items simultaneously (e.g., search results appearing)
- Communicating directionality (top-to-bottom or left-to-right reveals encode reading order)

**Stagger hurts when:**
- Items are not peer elements (mixing a header, a hero image, and a row item in one stagger cascade is wrong — they have different visual weight and should move on separate timing tracks)
- The action is frequent and repeated — stagger on every list-row tap is fatiguing
- Total stagger time > ~400 ms — by the time the last item enters, the user has long since focused elsewhere

**Everything-moves-at-once failure mode**: simultaneously animating title, image, body copy, and CTA button at the same timing creates a visual earthquake. The fix is not more stagger — it is fewer moving things. Animate the **structural container** (the card frame), let text reflow naturally, and stagger only the semantically distinct additions.

### 4.10.4 Enter vs. exit ordering [inferred from observed Apple TV, App Store, and Fitness patterns]

**Entry order = visual hierarchy (primary → secondary):**
1. Structural container / background surface (appears first, establishes space)
2. Primary content (hero image, headline) — leads by 0–30 ms after container
3. Secondary content (body text, metadata) — follows by +30–60 ms
4. Tertiary / action elements (buttons, chips, badges) — follows by +50–80 ms

**Exit order = reverse hierarchy (tertiary → primary → container):**
- Buttons and decorative elements fade first (~150 ms)
- Content body fades next (~180 ms)
- Container exits last and fastest (structural surface closing feels clean)

This ordering creates the perceptual effect that content "lifts out" of the container on entry and "dissolves back" into it on exit — matching natural object physics.

### 4.10.5 Avoiding competing focal points [documented — WWDC18]

The WWDC18 "Designing Fluid Interfaces" talk is explicit: "the eye cannot track competing focal points." Operationally:

- **No two regions larger than ~100 px should animate simultaneously** unless they are visually unified (e.g., a pair of columns in a split-view where both resize together make a single visual unit).
- During navigation, the **in-coming view** defines the motion story; the out-going view should **defer** (fade or scale down without its own spring).
- Page-turn and card-flip idioms are exceptions: both halves move together by design and the brain perceives them as one object.

---

## 4.11 Shared-element / continuity timing [documented — iOS 18 SwiftUI; inferred for followers]

When a `matchedGeometryEffect` or `zoom navigationTransition` is the centrepiece, the shared element defines the rhythm for everything else.

### 4.11.1 Hero duration and spring [inferred from observed iOS 18 App Store / Photos]

| Transition type | Observed hero duration | Spring character | Notes |
|---|---|---|---|
| Card → full-screen (App Store-style) | 400–500 ms | `spring(response: 0.45, dampingFraction: 0.82)` | Enough travel to need deliberate pacing; small bounce communicates destination "landing" |
| Grid cell → detail (Photos-style) | 350–420 ms | `spring(response: 0.40, dampingFraction: 0.85)` | Faster because the thumbnail gives strong spatial cue |
| List row → push (zoom transition, iOS 18) | 380–450 ms | System-controlled (not user-configurable) [observed] | Back-gesture velocity preserved; system spring ~0.4 response |
| Sheet with zoom source | 350–420 ms | System-controlled [observed] | Slightly faster than nav push because sheet is modal, not spatial |

### 4.11.2 Follower settling [inferred from App Store and Fitness app observation]

Content that lives **inside** the expanded destination (detail text, action buttons, supplementary images) should NOT animate in simultaneously with the hero:

1. **Hero completes ~60–70% of its travel** before followers start (≈ 220–300 ms into a 400 ms hero).
2. Followers enter with a **quick snappy spring** (0.3–0.35 s, `dampingFraction: 0.80`) — they are subordinate, not co-starring.
3. Followers use **opacity primarily** (scale 0.95 → 1.0 is subtle; avoid large scale deltas that fight the hero visually).
4. If followers stagger against each other (a list of detail rows), use 20–30 ms per item after the collective follower start.

The net timing: hero 0 ms → hero 70% at ~280 ms → followers begin at ~280 ms → followers complete by ~500 ms → overall transition feels done at ~500 ms.

### 4.11.3 Dismissal is the mirror [inferred]

On hero collapse (going back), followers exit **before** the hero starts:
- Followers fade out in ~150 ms (immediately on dismiss trigger)
- Hero begins collapsing at ~80 ms (slight overlap, not full sequential)
- Hero completes by ~380 ms

This sequence prevents the visual clutter of content + chrome all collapsing at once.

---

## 4.12 Orchestration mechanics — sequencing, transactions, and completion [documented — SwiftUI iOS 17+; inferred for CSS/JS patterns]

### 4.12.1 SwiftUI: animation per-property [documented — WWDC23 Session 10156; fatbobman.com transaction deep-dive]

The `.animation(_:value:)` modifier binds a specific animation to a specific state value. Two properties can animate simultaneously with different springs by stacking the modifier:

```swift
// Two independent springs on the same view, triggered by different state
SomeView()
    .scaleEffect(isExpanded ? 1.15 : 1.0)
    .animation(.spring(response: 0.3, dampingFraction: 0.80), value: isExpanded)
    .opacity(isVisible ? 1.0 : 0.0)
    .animation(.easeOut(duration: 0.18), value: isVisible)
```

**Rule**: place `.animation` as close as possible to the modifier it governs. A `.animation` placed above a modifier in the chain does not affect it (SwiftUI applies modifiers bottom-up). [documented — fatbobman transaction post]

### 4.12.2 SwiftUI: withAnimation completion → chain sequencing [documented — iOS 17+]

iOS 17 added a `completionCriteria` parameter to `withAnimation` that fires a callback when the animation is logically complete (`.logicallyComplete`) or fully at rest (`.removed`). Use this to chain dependent animations without guessing `DispatchQueue` delays:

```swift
// Animate A (card flies in), then B (content fades in) — no magic sleep
withAnimation(.spring(response: 0.4, dampingFraction: 0.82),
              completionCriteria: .logicallyComplete) {
    cardIsVisible = true
} completion: {
    // Guaranteed: card spring has completed its perceptual arc
    withAnimation(.easeOut(duration: 0.22)) {
        contentIsVisible = true
    }
}
```

`completionCriteria: .logicallyComplete` fires when the spring has reached ~95% of its target — before the final asymptotic tail — making chained animations feel tighter than `.removed` (which waits for full settle). [documented — Apple Developer Docs: `addAnimationCompletion(criteria:_:)`]

### 4.12.3 SwiftUI: Transaction — override, disable, and propagate [documented — fatbobman transaction deep-dive; WWDC23 Session 10156]

A `Transaction` is the per-update-cycle container for animation context. It is discarded at the end of each update pass.

```swift
// Override a single view's animation without touching others
var transaction = Transaction(animation: .none)
transaction.disablesAnimations = true

withTransaction(transaction) {
    // This state change fires with no animation anywhere in the tree
    navigationPath.append(destination)
}
```

```swift
// Apply per-transaction custom context (iOS 17+ TransactionKey)
struct TriggerSourceKey: TransactionKey {
    static var defaultValue: String = "unknown"
}
extension Transaction {
    var triggerSource: String {
        get { self[TriggerSourceKey.self] }
        set { self[TriggerSourceKey.self] = newValue }
    }
}

withTransaction(\.triggerSource, "user-tap") {
    isExpanded = true
}
// Views can read transaction.triggerSource in their .animation closure to vary spring by cause
```

### 4.12.4 SwiftUI: PhaseAnimator for multi-step choreography [documented — iOS 17+; WWDC23 Session 10157]

`PhaseAnimator` cycles a view through an array of discrete phases, each transition governed by its own animation. It is the right tool when a single element needs to tell a multi-beat story (e.g., press → squish → bounce → settle).

```swift
enum ButtonPhase: CaseIterable {
    case idle, pressed, bouncing
}

struct PhaseButton: View {
    @State private var trigger = false
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(.blue)
            .frame(width: 200, height: 56)
            .phaseAnimator(
                ButtonPhase.allCases,
                trigger: trigger
            ) { content, phase in
                content
                    .scaleEffect(phase == .pressed ? 0.94 : 1.0)
                    .opacity(phase == .idle ? 1.0 : 0.85)
            } animation: { phase in
                // Different spring per phase-to-phase transition
                switch phase {
                case .idle:
                    reduceMotion ? .easeInOut(duration: 0.15)
                                 : .spring(response: 0.35, dampingFraction: 0.75) // bounce back
                case .pressed:
                    reduceMotion ? .linear(duration: 0)
                                 : .spring(response: 0.18, dampingFraction: 0.9)  // instant compress
                case .bouncing:
                    reduceMotion ? .easeOut(duration: 0.1)
                                 : .spring(response: 0.4, dampingFraction: 0.65)  // visible overshoot
                }
            }
            .onTapGesture { trigger.toggle() }
    }
}
```

### 4.12.5 SwiftUI: KeyframeAnimator for fully-scripted tracks [documented — iOS 17+; WWDC23 Session 10157]

When you need simultaneous independent property tracks (scale + offset + opacity on different timelines), `KeyframeAnimator` replaces `PhaseAnimator`. Each `KeyframeTrack` runs on its own timeline; the animator's total duration is the longest track.

```swift
struct AnimValues {
    var scale: CGFloat = 1.0
    var offsetY: CGFloat = 0.0
    var opacity: Double = 1.0
}

SomeCard()
    .keyframeAnimator(initialValue: AnimValues(), trigger: didComplete) { content, v in
        content
            .scaleEffect(v.scale)
            .offset(y: v.offsetY)
            .opacity(v.opacity)
    } keyframes: { _ in

        // Scale track: compress then spring back with overshoot
        KeyframeTrack(\.scale) {
            LinearKeyframe(0.92, duration: 0.08)             // instant compress on trigger
            SpringKeyframe(1.06, duration: 0.22, spring: .bouncy)  // overshoot
            SpringKeyframe(1.00, duration: 0.20, spring: .smooth)  // settle
        }

        // Lift track: rise then fall with gravity feel
        KeyframeTrack(\.offsetY) {
            LinearKeyframe(0,    duration: 0.08)
            SpringKeyframe(-14,  duration: 0.22, spring: .snappy)  // lift
            SpringKeyframe(0,    duration: 0.30, spring: .smooth)  // land
        }

        // Opacity: briefly dim then restore
        KeyframeTrack(\.opacity) {
            LinearKeyframe(0.80, duration: 0.08)
            LinearKeyframe(1.00, duration: 0.22)
        }
    }
```

**Important**: `KeyframeAnimator` does not support `prefers-reduced-motion` internally — wrap the trigger with a reduce-motion check and provide a fallback `.animation`:

```swift
@Environment(\.accessibilityReduceMotion) var reduceMotion

// Fallback for reduce-motion: use a simple opacity flash instead
if reduceMotion {
    SomeCard().animation(.easeInOut(duration: 0.2), value: didComplete)
} else {
    SomeCard().keyframeAnimator(...) { ... } keyframes: { ... }
}
```

---

## 4.13 Recipes — staggered entry, coordinated CSS/JS, FLIP [inferred + documented]

### 4.13.1 SwiftUI staggered list entry [inferred — ForEach + .delay]

The simplest SwiftUI stagger: apply `.delay` to the transition animation, scaled by index. The delay must be inside `withAnimation` or a `.animation(value:)` binding to work correctly.

```swift
struct StaggeredList: View {
    let items = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    // Per-item stagger: 40 ms, non-linear (ease-out over the sequence)
    func delay(for index: Int) -> Double {
        let t = Double(index) / Double(max(items.count - 1, 1))
        // Ease-out curve: fast start, slow tail — feels less like a parade
        let eased = 1 - pow(1 - t, 2)
        return eased * 0.20  // max 200 ms total stagger budget
    }

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.element) { index, item in
                HStack {
                    Text(item).font(.headline)
                    Spacer()
                }
                .padding()
                .background(.white, in: RoundedRectangle(cornerRadius: 12))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 4)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 16)
                .animation(
                    reduceMotion
                        ? .easeInOut(duration: 0.15).delay(delay(for: index))
                        : .spring(response: 0.38, dampingFraction: 0.80)
                             .delay(delay(for: index)),
                    value: appeared
                )
            }
        }
        .padding()
        .onAppear { appeared = true }
    }
}
```

### 4.13.2 CSS staggered entry — transition-delay ladder [documented — MDN transition-delay; web.dev animation guide]

Use CSS custom properties to build a delay ladder. Prefer `--i` data attributes over `:nth-child` for dynamic lists.

```css
/* ─── Design tokens ─── */
:root {
  --stagger-base: 30ms;          /* per-item interval */
  --stagger-max:  240ms;         /* hard cap — last item never waits longer */
  --entry-duration: 380ms;
  --entry-spring: var(--spring-snappy-easing, cubic-bezier(0.34, 1.56, 0.64, 1));
}

/* ─── Item base state ─── */
.list-item {
  opacity: 0;
  transform: translateY(14px);
  transition:
    opacity   var(--entry-duration) var(--entry-spring),
    transform var(--entry-duration) var(--entry-spring);
  will-change: opacity, transform;
}

/* ─── Delay ladder via data attribute ─── */
/* Set data-stagger-index="0","1","2"… on each item from JS/template */
.list-item[data-stagger-index]  { transition-delay: calc(var(--stagger-base) * attr(data-stagger-index number, 0)); }

/* ─── Fallback: nth-child ladder for static lists ─── */
.list-item:nth-child(1)  { transition-delay:   0ms; }
.list-item:nth-child(2)  { transition-delay:  30ms; }
.list-item:nth-child(3)  { transition-delay:  58ms; }   /* eased: 30 * 1.93 */
.list-item:nth-child(4)  { transition-delay:  82ms; }   /* eased curve continues */
.list-item:nth-child(5)  { transition-delay: 100ms; }
.list-item:nth-child(6)  { transition-delay: 112ms; }
.list-item:nth-child(7)  { transition-delay: 120ms; }   /* asymptote toward cap */
.list-item:nth-child(8)  { transition-delay: 124ms; }
.list-item:nth-child(n+9){ transition-delay: 130ms; }   /* clamp: all late items same */

/* ─── Visible state — add class to parent ─── */
.list.is-visible .list-item {
  opacity: 1;
  transform: none;
}

/* ─── Reduced motion ─── */
@media (prefers-reduced-motion: reduce) {
  .list-item {
    transition: opacity 180ms ease-in-out;
    transform: none;  /* no spatial movement */
    /* Keep opacity cross-fade — conveys change without motion */
  }
}
```

```javascript
// Apply stagger index attribute to items; add .is-visible on trigger
function revealList(listEl) {
  const items = listEl.querySelectorAll('.list-item')
  items.forEach((item, i) => item.setAttribute('data-stagger-index', i))
  // One rAF defer so transition fires after display/opacity init
  requestAnimationFrame(() => listEl.classList.add('is-visible'))
}
```

### 4.13.3 CSS coordinated @keyframes — lead + follower pattern [inferred]

When a structural container (lead) and its content (follower) must coordinate, use `animation-delay` on the follower set to the lead's perceptual completion time (~60–70% of lead duration):

```css
/* Lead: card frame expands in */
.card {
  animation: card-enter 420ms var(--spring-smooth-easing) both;
}

@keyframes card-enter {
  from { opacity: 0; transform: scale(0.88) translateY(20px); }
  to   { opacity: 1; transform: none; }
}

/* Follower: content fades in after lead is ~65% done (~270ms in) */
.card__content {
  animation: content-enter 280ms ease-out 270ms both;
}

@keyframes content-enter {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}

/* Tertiary: actions appear last, quickest */
.card__actions {
  animation: content-enter 200ms ease-out 380ms both;
}

@media (prefers-reduced-motion: reduce) {
  .card, .card__content, .card__actions {
    animation: none;
    /* Instant-appear; rely on server-rendered final state */
  }
}
```

### 4.13.4 JS FLIP — minimal implementation with stagger [documented — Paul Lewis FLIP + WAAPI]

FLIP (First, Last, Invert, Play) is the correct technique for animating layout changes where elements change position in the DOM (list reorder, grid → detail, drag-and-drop settle). It works entirely on `transform`, stays on the compositor thread, and is interruptible.

```javascript
/**
 * FLIP a list of elements after a DOM mutation.
 * Call flipElements(items) BEFORE mutating, then mutate, then flip.animate().
 *
 * Based on Paul Lewis' FLIP technique (aerotwist.com/blog/flip-your-animations/)
 * Duration guidance: 300ms for typical list reorder; up to 420ms for grid→detail.
 */

class FlipCollection {
  constructor(elements, { duration = 300, staggerMs = 25, easing = 'cubic-bezier(0,0,0.32,1)' } = {}) {
    this.elements = [...elements]
    this.duration = duration
    this.staggerMs = staggerMs
    this.easing = easing
    this._firstRects = null
  }

  /** Step 1: Record FIRST positions — call BEFORE DOM mutation */
  first() {
    // Batch all getBoundingClientRect reads before any write (avoids forced reflow)
    this._firstRects = this.elements.map(el => el.getBoundingClientRect())
    return this
  }

  /** Step 2+3+4: Compute LAST, INVERT, then PLAY — call AFTER DOM mutation */
  play() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.elements.forEach((el, i) => {
      const first = this._firstRects[i]
      const last  = el.getBoundingClientRect()  // LAST

      const deltaX = first.left - last.left
      const deltaY = first.top  - last.top

      if (deltaX === 0 && deltaY === 0) return  // didn't move — skip

      if (reduceMotion) {
        // Reduced motion: no spatial movement — cross-fade only
        el.animate(
          [{ opacity: 0.6 }, { opacity: 1 }],
          { duration: 180, easing: 'ease-out', fill: 'both' }
        )
        return
      }

      // INVERT + PLAY via Web Animations API
      el.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },  // INVERT: appear at old pos
          { transform: 'none' }                                    // PLAY: spring to new pos
        ],
        {
          duration: this.duration + i * this.staggerMs,   // later items slightly longer (natural)
          delay:    i * this.staggerMs,                    // stagger start times
          easing:   this.easing,
          fill:     'both'
        }
      )
    })
  }
}

// ─── Usage: reorder a list ───
const listItems = document.querySelectorAll('.sortable-item')
const flip = new FlipCollection(listItems, {
  duration:  300,
  staggerMs: 20,           // 20ms stagger per item — imperceptible but humanising
  easing:    'cubic-bezier(0,0,0.32,1)'  // decelerate to target
})

flip.first()                // capture positions BEFORE mutation
reorderDOMItems()           // mutate the DOM (reorder nodes)
requestAnimationFrame(() => flip.play())  // one rAF so browser paints new layout first
```

**Performance note**: all `getBoundingClientRect` reads are batched in `first()` before any DOM write, avoiding repeated forced synchronous layouts. Maximum stagger budget for a 10-item list at 20 ms: 200 ms — still within the "single animated unit" perceptual threshold.

---

## 5. Anti-Patterns

### 5.1 `ease` or `linear` everywhere [observed — antithetical to Apple feel]
`transition: all 0.3s ease` is the default CSS choice and produces identical-feeling motion for every interaction. Apple differentiates motion by physical character, not just duration. Linear easing reads as mechanical; ease-in/out is better but still fixed-duration. Neither can be interrupted with velocity preservation.

### 5.2 Long blocking animations [documented — WWDC18 anti-pattern]
Any animation > 500 ms that does not respond to user input during playback will feel broken to users familiar with iOS. If something takes > 500 ms visually, it should either be a progress indicator or a loading state, not an animation blocking a UI element.

### 5.3 Non-interruptible transitions [documented — WWDC18 anti-pattern]
Using CSS `transition` with pointer-events disabled during animation, or JavaScript logic that queues input until an animation completes (`isAnimating` guards), violates Apple's fluid interface contract. Always accept input; redirect animation.

### 5.4 Animating layout-triggering properties [documented — browser rendering pipeline]
Animating `width`, `height`, `top`, `left`, `padding`, `margin`, `border-width` forces layout recalculation every frame on the main thread. This causes jank on mid-range devices, prevents compositor-thread promotion, and cannot be interrupted cleanly. Use `transform: scale()` + `transform: translate()` for all motion.

### 5.5 Ignoring gesture release velocity [documented — WWDC18 anti-pattern]
Snapping to a target with a fixed-duration animation after a drag, ignoring the user's release velocity, feels jarring. The velocity the user's hand had at release is free kinetic energy; throw it away and the interface feels dead. Always capture `dt`-normalized velocity during the final frames of a gesture.

### 5.6 Same spring for everything [inferred — Apple differentiates by context]
Using a single set of spring values across button presses, modal presentations, list rearrangements, and full-screen hero transitions produces flat, same-feeling motion. Different interaction scales and emotional intents warrant different spring characters:
- Micro (< 40px, button scale): snappy, short duration (0.25–0.3s), very low bounce
- Mid (card expand, list reorder): spring(response: 0.35, dampingFraction: 0.75)
- Macro (full-screen hero, sheet): smooth, longer duration (0.4–0.5s), no/minimal bounce

### 5.7 Applying `will-change` globally [documented — MDN performance guidance]
`* { will-change: transform }` promotes every element to its own GPU layer, exhausting VRAM and degrading performance. Apply surgically, immediately before animation, and remove after.

### 5.8 Using `transform-origin` without accounting for it in spring target [inferred]
If `transform-origin` is not `center center`, scale springs overshoot in unexpected visual directions. Either keep `transform-origin: center` or explicitly account for origin offset in translate calculations.

---

## Continuous scroll-progress motion (the aliveness primitive) [inferred from observed apple.com behavior]

This is the single biggest differentiator between a dead template and an alive Apple page. Apple's flagship product pages (iPhone, Mac, iPad) bind element transforms — `translateY`, `scale`, `opacity`, `rotateY` — to a **continuous 0→1 progress value** derived from how far the user has scrolled through a designated "chapter" (a tall sentinel element). The page feels like the user is physically pulling content through space.

### How this differs from a one-shot reveal [the core distinction]

A one-shot `IntersectionObserver` reveal fires **once** when an element crosses a threshold and **stays fired** — it is a discrete state machine (`has-it-entered? yes/no`). Continuous scroll-progress motion is fundamentally different on three axes:

- **Reversible.** Scroll forward → animate forward; scroll back → animate back. The transform is a pure function of scroll position, so scrubbing up restores the prior visual state. An IO reveal cannot un-reveal.
- **Continuous, not binary.** The element's transform tracks scroll *distance* across its whole range, not a single crossing event. It is bound to a 0→1 value, not a boolean.
- **Multi-rate.** Several elements can map the *same* scroll range to *different* output ranges (e.g. headline slides `0→-40px` while a product image floats `0→-160px` and a caption fades `0→1`), producing parallax depth from one scroll source.

> **When to use vs. one-shot reveal:** use scroll-progress when the design needs reversibility, when motion is directly correlated to scroll distance (not a discrete "crossed a threshold" state), or when multiple elements animate at different rates through the same range. A plain `IntersectionObserver` fade-in is sufficient — and cheaper — for simple once-off entrances that never need to play backward.

### The two building blocks [documented patterns]

**`mapRange` — clamp + lerp utility.** Maps a value from an input range to an output range, clamped to the output bounds. This is the workhorse that turns a 0→1 progress into a pixel/degree/opacity value.

```js
/**
 * Map `value` from [inA, inB] → [outA, outB], clamped to the output range.
 * [documented] Standard clamped linear interpolation used across GSAP, motion.dev, Lenis.
 */
function mapRange(value, inA, inB, outA, outB) {
  const t = Math.max(0, Math.min(1, (value - inA) / (inB - inA)));
  return outA + t * (outB - outA);
}

// Usage: translate an element 0px → -120px as progress runs 0 → 1
const ty = mapRange(progress, 0, 1, 0, -120);
el.style.transform = `translateY(${ty}px)`;
```

**Damped/lerped scroll value — the rAF loop.** Read the *real* `window.scrollY` and lerp a shadow value toward it every frame. The shadow value drives the transforms, giving motion a buttery trailing-smoothness without ever touching native scroll.

> **CRUCIAL — this is NOT scroll-jacking.** This pattern smooths the **read** scroll value only. It does **not** call `preventDefault()`, does **not** put `overflow:hidden` on the body, and does **not** move content manually. The native scrollbar, iOS rubber-band inertia, trackpad momentum, keyboard scroll, and assistive tech all stay 100% intact — only your animated transforms lag behind via the lerp. Hijacking the actual scroll event breaks all of those and is an anti-pattern.

```js
let currentSmoothed = 0;  // shadow scroll value that drives transforms
let targetScroll    = 0;  // always tracks the REAL window.scrollY
const DAMPING       = 0.1; // [documented] 0.08–0.12 typical; Lenis default lerp ≈ 0.1
                           //   lower = more lag/cinematic, higher = snappier

// Track real scroll passively — we never preventDefault, never hijack
window.addEventListener('scroll', () => {
  targetScroll = window.scrollY;
}, { passive: true });

// Read element range once via offsetTop/offsetHeight (no per-frame getBoundingClientRect
// reflow). offsetTop reflects document position, not live scroll — pair it with the
// SMOOTHED scroll value, not the real one.
function progressFromOffset(el, smoothedScroll) {
  const start = el.offsetTop;
  const end   = start + el.offsetHeight - window.innerHeight;
  return Math.max(0, Math.min(1, (smoothedScroll - start) / (end - start)));
}

const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function tick() {
  // Lerp the SHADOW value toward real scroll (the only thing being "smoothed")
  currentSmoothed += (targetScroll - currentSmoothed) * (motionOK ? DAMPING : 1);

  const progress = progressFromOffset(chapterEl, currentSmoothed); // 0 → 1
  const ty    = mapRange(progress, 0, 1, 0, -160);   // hero floats up
  const scale = mapRange(progress, 0, 1, 0.9, 1);    // grows to full size
  chapterInner.style.transform = `translateY(${ty.toFixed(2)}px) scale(${scale.toFixed(3)})`;

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

> `{ passive: true }` on the scroll listener is mandatory — without it the browser cannot pipeline scroll handling. Only animate `transform`/`opacity` in the loop; animating `width`/`top`/`box-shadow` per frame janks on mid-range devices. Wrap the chapter in a tall sentinel (`height: 200vh–500vh`) and pin its inner content with `position: sticky` — more sentinel height = slower perceived motion through the same arc. Keep simultaneously-animating layers to ≤ 6–8 on high-DPI mobile.

### Typical parameter ranges

| Parameter | Range | Effect |
|---|---|---|
| `DAMPING` (lerp factor) | 0.05 – 0.15 | 0.05 = laggy/cinematic · 0.1 = Lenis-default buttery · 0.15 = responsive but smooth |
| Chapter sentinel height | 200vh – 500vh | More height → slower perceived motion through the same animation arc |
| `translateY` range | -40px to -200px | Parallax depth; beyond ~200px feels unnatural |
| `scale` range | 0.85 – 1.0 | Cards growing in; beyond this reads as dramatic |
| `opacity` range | 0.0 – 1.0 | Combine with translate; rarely animate opacity alone on scroll |

### CSS-native path (progressive enhancement) [documented — MDN scroll-driven animations]

Where supported, the browser can run the binding off the main thread via `animation-timeline`. Treat it as a **progressive enhancement layered on top of** the rAF baseline — the JS lerp above is the cross-browser baseline that works everywhere in 2026; the CSS path is a perf upgrade where available.

```css
/* Baseline: the rAF lerp above already drives transforms everywhere.
   Enhancement: hand the binding to the compositor where the API exists. */
@supports (animation-timeline: scroll()) {
  @media (prefers-reduced-motion: no-preference) {
    .scroll-chapter {
      view-timeline-name: --chapter;
      view-timeline-axis: block;
    }
    .scroll-chapter-inner {
      animation: chapter-float linear both;
      animation-timeline: --chapter;
      animation-range: entry 0% exit 100%;
    }
    @keyframes chapter-float {
      from { transform: translateY(0)      scale(0.9); }
      to   { transform: translateY(-160px) scale(1);   }
    }
  }
}
```

[documented] CSS scroll-driven animations (`animation-timeline: scroll()` / `view()`) ship in Safari 26+ and Chrome 115+ (Firefox behind a flag as of 2026-05). When enabling the CSS path, gate the JS loop so the two don't fight (e.g. only run the rAF binding when `!CSS.supports('animation-timeline','scroll()')`).

### Reduced motion [documented — skip the binding, show final state]

Honor `prefers-reduced-motion: reduce` by **rendering the final state** — never hide content. Snap the shadow value to the real scroll (set the lerp factor to `1`, as in the loop above) so transforms jump straight to their resolved value with no lag, and/or disable transforms via CSS:

```css
@media (prefers-reduced-motion: reduce) {
  .scroll-chapter-inner {
    transform: none !important;   /* show the resolved/final layout, not hidden */
    opacity: 1 !important;
    animation: none !important;   /* also disables the CSS-native path */
  }
}
```

---

## Pointer-reactive motion (desktop sugar) [inferred from observed apple.com behavior]

Subtle pointer-tracking effects on CTAs and hero cards add desktop polish: a button that nudges toward the cursor, a card that tilts under the pointer, a panel lit by a following spotlight. All are **enhancement-only sugar** — they must add nothing on touch and nothing under reduced motion. Apple's versions are restrained (≤ 8–12px, ≤ 8deg), not the exaggerated 20–40px / 15–25deg seen on agency showcases.

> **HARD gate — wrap every recipe below in this guard.** Pointer-reactive motion runs **only** when the primary input is a fine pointer (mouse/trackpad) **and** the user has not requested reduced motion. Never on touch (no hover/pointer to track); never under reduced motion (it is pure sugar with a zero-motion fallback — elements simply render normally with no transform applied).

```js
const POINTER_OK =
  window.matchMedia('(pointer: fine) and (prefers-reduced-motion: no-preference)').matches;
if (!POINTER_OK) return; // touch + reduced-motion get the static element, untouched
```

```css
/* Belt-and-suspenders CSS fallback — strip any applied transform off-gate */
@media not all and (pointer: fine), (prefers-reduced-motion: reduce) {
  .btn-magnetic, .card-tilt { transform: none !important; }
}
```

All three recipes are **transform-only** (spotlight tracks a CSS custom property feeding a `radial-gradient`), and all are **rAF-lerped** so motion trails the pointer with spring-like ease rather than snapping.

> **Production note:** each recipe below shows its own `requestAnimationFrame` loop for clarity. In production, **merge them into one shared rAF tick** — N elements × 3 separate loops = N×3 rAF callbacks per frame, which collides on the frame budget. One scheduler iterating a list of registered effects is the correct shape.

### Recipe 1 — Magnetic button (pull ≤ 12px, return-lerp 0.12)

```js
// assumes the POINTER_OK gate above already returned early on touch / reduced-motion
document.querySelectorAll('.btn-magnetic').forEach(btn => {
  const PULL_RADIUS = 80;   // px halo OUTSIDE the button where the pull begins
  const MAX_PULL    = 12;   // px max displacement — [inferred] Apple ~8–12px; >16 feels toy-like
  const RETURN_LERP = 0.12; // spring-back factor per frame [research: 0.10–0.18]

  let tx = 0, ty = 0, rtx = 0, rty = 0;

  btn.addEventListener('mousemove', e => {
    const r  = btn.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width  / 2);
    const dy = e.clientY - (r.top  + r.height / 2);
    const dist     = Math.hypot(dx, dy);
    const maxDist  = Math.max(r.width, r.height) / 2 + PULL_RADIUS;
    const strength = Math.max(0, 1 - dist / maxDist);
    tx = dx * strength * (MAX_PULL / (r.width  / 2));
    ty = dy * strength * (MAX_PULL / (r.height / 2));
  });
  btn.addEventListener('mouseleave', () => { tx = 0; ty = 0; });

  (function loop() {
    rtx += (tx - rtx) * RETURN_LERP;
    rty += (ty - rty) * RETURN_LERP;
    btn.style.transform = `translate(${rtx.toFixed(2)}px, ${rty.toFixed(2)}px)`;
    requestAnimationFrame(loop);
  })();
});
```

### Recipe 2 — Tilt-on-pointer (≤ 8deg, perspective ~800px)

```js
document.querySelectorAll('.card-tilt').forEach(card => {
  const MAX_TILT = 8;   // degrees — [inferred] Apple ~6–8deg; agency sites use 15–25deg (too much)
  let rx = 0, ry = 0, targetRx = 0, targetRy = 0;

  card.parentElement.style.perspective = '800px'; // perspective on the PARENT [600–1000px]
  card.style.transformStyle = 'preserve-3d';

  card.addEventListener('mousemove', e => {
    const r  = card.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width  * 2 - 1; // -1 → +1
    const ny = (e.clientY - r.top)  / r.height * 2 - 1;
    targetRy =  nx * MAX_TILT;  // rotate around Y = left/right
    targetRx = -ny * MAX_TILT;  // rotate around X = up/down (inverted)
  });
  card.addEventListener('mouseleave', () => { targetRx = 0; targetRy = 0; });

  (function loop() {
    rx += (targetRx - rx) * 0.12;  // [research: 0.10–0.14]
    ry += (targetRy - ry) * 0.12;
    card.style.transform = `rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg)`;
    requestAnimationFrame(loop);
  })();
});
```

### Recipe 3 — Spotlight-follow (radial-gradient tracking the pointer)

```js
document.querySelectorAll('.spotlight-panel').forEach(panel => {
  // Feed the pointer position into CSS custom props — the gradient repaint stays
  // GPU-cheap and we never touch layout. (No lerp needed; the gradient itself is soft.)
  panel.addEventListener('mousemove', e => {
    const r = panel.getBoundingClientRect();
    panel.style.setProperty('--spot-x', `${((e.clientX - r.left) / r.width  * 100).toFixed(1)}%`);
    panel.style.setProperty('--spot-y', `${((e.clientY - r.top)  / r.height * 100).toFixed(1)}%`);
  });
  panel.addEventListener('mouseleave', () => {
    panel.style.setProperty('--spot-x', '50%');
    panel.style.setProperty('--spot-y', '50%');
  });
});
```

```css
.spotlight-panel {
  --spot-x: 50%;
  --spot-y: 50%;
  background:
    radial-gradient(circle 400px at var(--spot-x) var(--spot-y),
      rgba(255,255,255,0.07) 0%, transparent 70%),
    #121212; /* spotlight radius 300–500px: larger = softer */
}
```

> **Spotlight perf:** the gradient repaint on `mousemove` is not compositor-promoted. For heavy panels, animate a pseudo-element's `opacity` with `mix-blend-mode: screen` on top of the panel instead of repainting the background, or throttle updates to every other frame. Set `will-change: transform` on tilt/magnetic elements on `mouseenter` and clear it on `mouseleave` to avoid permanent layer overhead.

---

## 6. Sources

- [Animate with springs — WWDC23 Session 10158](https://developer.apple.com/videos/play/wwdc2023/10158/) — primary reference for iOS 17+ duration/bounce API and spring physics exposition
- [WWDC23 Notes: Animate with springs](https://wwdcnotes.com/documentation/wwdcnotes/wwdc23-10158-animate-with-springs/) — condensed session notes
- [Designing Fluid Interfaces — WWDC18 Session 803](https://developer.apple.com/videos/play/wwdc2018/803/) — foundational: interruptibility, responsiveness, gesture handoff
- [Building Fluid Interfaces — Nathan Gitter, Medium](https://medium.com/@nathangitter/building-fluid-interfaces-ios-swift-9732bb934bf5) — implementation walkthrough of WWDC18 principles
- [spring(response:dampingFraction:blendDuration:) — Apple Documentation](https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:))
- [interpolatingSpring(mass:stiffness:damping:initialVelocity:) — Apple Documentation](https://developer.apple.com/documentation/swiftui/animation/interpolatingspring(mass:stiffness:damping:initialvelocity:))
- [Motion HIG — Apple Developer](https://developer.apple.com/design/human-interface-guidelines/motion)
- [SwiftUI Spring Animations Reference — GetStream/GitHub](https://github.com/GetStream/swiftui-spring-animations)
- [The Meaning, Maths, and Physics of SwiftUI Spring Animation — Amos Gyamfi, Medium](https://medium.com/@amosgyamfi/the-meaning-maths-and-physics-of-swiftui-spring-animation-amos-gyamfis-manifesto-0044755da208)
- [CSS Spring Easing Generator — kvin.me](https://www.kvin.me/css-springs) — real linear() output values used in §3.2
- [Springs and Bounces in Native CSS — Josh W. Comeau](https://www.joshwcomeau.com/animation/linear-timing-function/) — linear() mechanics and bundle cost analysis
- [CSS linear() easing — Chrome Developers](https://developer.chrome.com/docs/css-ui/css-linear-easing-function) — bounce example values
- [spring() — Motion.dev documentation](https://motion.dev/docs/spring) — JS spring API parameters and defaults
- [SwiftUI Hero Animations with NavigationTransition — Peter Friese](https://peterfriese.dev/blog/2024/hero-animation/) — iOS 18 zoom transition implementation
- [Demystifying UIKit Spring Animations — Christian Schnorr, Medium](https://medium.com/ios-os-x-development/demystifying-uikit-spring-animations-2bb868446773) — physics parameter relationships
- [SwiftUI Animation Masterclass — DEV Community](https://dev.to/sebastienlato/swiftui-animation-masterclass-springs-curves-smooth-motion-3e4o) — community-observed preset approximations
- [Explore SwiftUI animation — WWDC23 Session 10156](https://developer.apple.com/videos/play/wwdc2023/10156/) — scale-based state toggle with `.bouncy` spring; transition primitives (scale, opacity, combined)
- [Animating views and transitions — Apple Developer Tutorials](https://developer.apple.com/tutorials/swiftui/animating-views-and-transitions) — `.transition(.scale.combined(with:.opacity))` pattern
- [iOS 26 Liquid Glass Reference — madebyluddy/Medium](https://medium.com/@madebyluddy/overview-37b3685227aa) — `.glassEffectTransition(.materialize)` API as named Apple entry-motion concept
- [App Store-Style Card Animations — Medium/charithgunasekara](https://medium.com/@charithgunasekara/crafting-app-store-style-card-animations-with-swiftui-12cc3257928e) — `.spring(response: 0.4, dampingFraction: 0.8)` for card reveal
- [How SVG Line Animation Works — CSS-Tricks](https://css-tricks.com/svg-line-animation-works/) — `stroke-dashoffset` as compositor-thread path fill technique
- [Creating Animated Activity Ring — AppCoda](https://www.appcoda.com/learnswiftui/swiftui-progress-ring.html) — `.spring(response: 0.6, dampingFraction: 1.0)` + shadow for ring completion glow
- [Adaptive Motion for Variable Refresh Displays — Dmytro Hanin, Medium/Bootcamp](https://medium.com/design-bootcamp/adaptive-motion-for-variable-refresh-displays-practical-guidelines-for-designers-a956be276388) — decision table: tap feedback 100–150 ms, button press 120–200 ms, swipe/reorder 250–350 ms, modal 300–500 ms; frame budgets at 30/60/120 Hz
- [iOS 26 Motion Design Guide — Hui Wang, Medium](https://medium.com/@foks.wang/ios-26-motion-design-guide-key-principles-and-practical-tips-for-transition-animations-74def2edbf7c) — layered choreography principle: primary content leads, secondary follows "slightly later"; 100–500 ms ideal range; "slower ≠ sluggish"
- [Mastering Transaction in SwiftUI — fatbobman.com](https://fatbobman.com/en/posts/mastering-transaction/) — deep-dive on `withTransaction`, per-property `.animation`, `disablesAnimations`, `TransactionKey`; per-property stacking pattern
- [SwiftUI withAnimation Completion Callback in iOS 17 — DevTechie, Medium](https://medium.com/devtechie/swiftui-withanimation-completion-callback-in-ios-17-3b7f1c7e81ad) — `completionCriteria: .logicallyComplete` chaining syntax
- [addAnimationCompletion(criteria:_:) — Apple Developer Documentation](https://developer.apple.com/documentation/swiftui/transaction/addanimationcompletion(criteria:_:)) — `.logicallyComplete` vs `.removed` criteria
- [Advanced SwiftUI Animations Part 7: PhaseAnimator — The SwiftUI Lab](https://swiftui-lab.com/swiftui-animations-part7/) — `PhaseAnimator` phase-to-phase animation closure mapping; enum-based phases; phase-offset gotcha
- [Using KeyframeAnimator in SwiftUI — AppCoda](https://www.appcoda.com/keyframeanimator/) — `KeyframeAnimator` with four simultaneous tracks (scale/stretch/translation/opacity); `SpringKeyframe` with `.snappy` preset
- [Explore SwiftUI animation — WWDC23 Session 10156](https://developer.apple.com/videos/play/wwdc2023/10156/) — per-property `.animation(value:)` stacking; `withAnimation` completion handler introduction
- [Wind Your Way Through Advanced Animations in SwiftUI — WWDC23 Session 10157](https://developer.apple.com/videos/play/wwdc2023/10157/) — `KeyframeAnimator`, `PhaseAnimator`, multi-track choreography
- [FLIP Your Animations — Paul Lewis, Aerotwist](https://aerotwist.com/blog/flip-your-animations/) — original FLIP algorithm; 100 ms interaction response window; WAAPI `.animate()` example; `getBoundingClientRect` batching discipline
- [Animating Layouts with the FLIP Technique — CSS-Tricks](https://css-tricks.com/animating-layouts-with-the-flip-technique/) — FLIP four-step algorithm with code; 300 ms standard FLIP duration
- [Staggered Animations in SwiftUI — SwiftUISnippets (2026)](https://swiftuisnippets.wordpress.com/2026/05/20/staggered-animations-in-swiftui/) — smoothstep delay formula `t²(3-2t) × 0.7s`; linear 0.15 s per item; ease-out curve variants
- [Staggered Animations with animation-delay — Handoff.design](https://handoff.design/css-animation/staggered-animations.html) — sweet spot stagger 50–200 ms; when stagger helps (list reveals, grid progressions) vs hurts (overuse, non-peer elements)
- [Mastering UI Animation: The Art of Stagger Techniques — Aninix](https://www.aninix.com/wiki/how-to-create-a-good-stagger-in-the-ui-animation) — lead/follower front-loaded vs end-loaded stagger patterns; visual disintegration above threshold
- [Scroll-driven animations — Motion.dev documentation](https://motion.dev/docs/scroll) — `scroll()` progress binding, `mapRange`-style value mapping, multi-rate parallax patterns; informs the continuous scroll-progress primitive
- [Lenis — smooth-scroll library (Darkroom Engineering)](https://github.com/darkroomengineering/lenis) — damped scroll-value lerp; default lerp ≈ 0.1 used as the `DAMPING` reference; the "smooth the read, never hijack" model
- [Scroll-driven animations — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll-driven_animations) — `animation-timeline: scroll()`/`view()`, `view-timeline`, `animation-range`; the CSS-native progressive-enhancement path and 2026 browser support

---

CONFIDENCE: 78% — Core physics, WWDC-documented principles, and SwiftUI API signatures are high-confidence; exact numeric defaults for .smooth/.snappy/.bouncy and community-observed "Apple-native feel" spring values carry meaningful uncertainty as Apple does not publish all internal system values.
