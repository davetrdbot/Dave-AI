# Gestures & Interaction Patterns
Reference for the `apple-design-motion` skill family. Covers the core iOS/iPadOS gesture vocabulary, system interactions (Dynamic Island, home indicator, app switcher), pointer/trackpad behavior on iPad, and faithful web replication strategies including code recipes.

---

## Principles

### Direct Manipulation
Gestures exist to serve _direct manipulation_ — the philosophy that the user's finger IS the tool, not a proxy for a command [documented]. Introduced in the 1983 Xerox Star / early Mac research and fully realized in the original iPhone (2007), direct manipulation means:

- **1:1 tracking during contact.** While a finger is down, the element follows it at pixel-perfect ratio — no lag, no scaling. This is non-negotiable. If the element moves 40 px, the finger moved 40 px [documented, WWDC18 "Designing Fluid Interfaces"].
- **Velocity is state.** At the moment of release, the finger carries a velocity vector. That vector must be handed off into the resulting spring animation so the motion _continues_ through the transition rather than resetting [documented].
- **Interruptibility.** Any in-flight animation must be interruptible by a new touch. Capturing velocity from the interrupted state and launching a new spring from that point is what separates native feel from web approximations [documented].
- **Redirectability.** Mid-gesture, intent can change (pan starts vertical, user curves horizontal). The system interprets evolving intent by watching acceleration spikes, not just distance [inferred from WWDC18 session 803].

### Discoverability vs. Hidden Gestures
Gestures are learnable affordances, not assumed knowledge [documented, HIG Gestures]. Design rules:

- **Standard gestures are free.** Users bring an existing mental model for tap, swipe, pinch. Leverage them; never redefine them to do the opposite.
- **Custom gestures need a visible entry point.** A gesture with no visual affordance must have a fallback UI element (button, menu item, etc.). Gesture-only paths violate WCAG 2.5.1 (Pointer Gestures criterion) [documented].
- **Teach through results, not tutorials.** The first time a gesture succeeds, the spring feedback rewards the user. Over-explanation (coach marks at launch) is a symptom of a discoverability problem in the design itself [inferred].

### Velocity Handoff into Springs
The unifying mechanism of Apple's gesture system [documented, WWDC18]:

```
Gesture ends → capture velocity (px/ms) →
pass as initialVelocity to UISpringTimingParameters →
spring animates from current value toward target,
beginning at that velocity, decelerating naturally
```

Springs are preferred over duration-based curves because:
1. They start fast (satisfying snap) and spend most time approaching target (no jarring end).
2. The initial velocity parameter absorbs the gesture's momentum — no discontinuity [documented].
3. They are parameterized by `damping` + `response` (Apple's design-friendly terms) rather than raw mass/stiffness [documented].

---

## Apple Specifics

### Core Gesture Vocabulary (iOS / iPadOS)

| Gesture | Fingers | System meaning | App meaning (typical) |
|---|---|---|---|
| **Tap** | 1 | Select / activate | Button press, item select |
| **Double-tap** | 1 | Zoom to fit / zoom in (Maps, Photos) | App-defined secondary action |
| **Long-press** | 1 | Context menu / rearrange trigger | Peek preview; enter edit/drag mode |
| **Swipe** | 1 | Directional: back (right→left = forward, left→right = back in navigation stack) | Reveal swipe actions (list rows) |
| **Pan / Drag** | 1 | Move element; scroll | Reorder list items; custom slider |
| **Pinch open** | 2 | Zoom in (Maps, Photos, Safari) | Expand / zoom |
| **Pinch close** | 2 | Zoom out | Collapse / zoom out |
| **Rotate** | 2 | Rotate (Maps, Photos, PDFs) | App-defined rotation |
| **Two-finger tap** | 2 | Undo (some contexts) | App-defined |
| **Three-finger swipe left** | 3 | Undo (iOS text) | — |
| **Three-finger pinch** | 3 | Copy (text, iOS 13+) | — |
| **Edge swipe (leading edge → right)** | 1 | Navigate back (UINavigationController) | — |

All standard gestures [documented, HIG Touchscreen Gestures]. Custom gestures should not conflict with any of these.

### System-Reserved Screen-Edge Gestures [documented]

These belong to the OS. Apps must not intercept them on first attempt:

- **Swipe up from bottom edge** → Home screen (Face ID devices)
- **Swipe up from bottom + pause** → App Switcher
- **Swipe left/right along bottom edge** → Recent-app switcher (flick between open apps)
- **Swipe down from top-right corner** → Control Center
- **Swipe down from top-center** → Notification Center

Immersive apps (games) may request `preferredScreenEdgesDeferringSystemGestures` to delay the system gesture by one additional swipe; the second swipe always invokes the system [documented].

**iOS 26 note:** The Home indicator now fades when not needed; swipe-from-bottom still works without it being visible [observed, reported June 2025].

### Home Indicator
A short horizontal pill at the bottom of Face ID iPhones/iPads. Tapping it does nothing; its presence signals "swipe here to go home" [documented]. Apps can:
- Hide it temporarily with `prefersHomeIndicatorAutoHidden = true` (automatically shown on first touch)
- Change its color with `preferredScreenEdgesDeferringSystemGestures`

### Dynamic Island Interactions [documented]

Available on iPhone 14 Pro+. The Dynamic Island is a pill-shaped hardware cutout turned interactive.

| Interaction | Result |
|---|---|
| **Tap** | Opens the associated app (or the app that owns the Live Activity) |
| **Long-press** | Expands the Dynamic Island into a larger card showing extended Live Activity content |
| **Long-press + release** | Collapses back to compact state |
| No interaction | Compact/minimal presentation animates automatically on events (alerts, timers, phone calls) |

Live Activities define four regions in the expanded view: **center**, **leading**, **trailing**, **bottom** [documented, ActivityKit]. The system morphs between compact and expanded via a fluid shape animation — the pill _grows_ into the card. Developers cannot override this morphing animation [documented].

Dynamic Island states:
- **Compact** (two separate pill-attached regions: leading = one app, trailing = another)
- **Minimal** (tiny persistent badge, when multiple Live Activities compete)
- **Expanded** (full card on long-press)

### Context Menus (Long-Press Preview + Menu) [documented]

Introduced iOS 13, replacing 3D Touch Peek & Pop (which required hardware pressure sensing, removed iPhone XR onward).

**Interaction flow:**
1. Long-press (≈0.5 s) on supported element
2. Haptic confirmation
3. Background blurs; element lifts into a preview (scaled up slightly, parallax)
4. Menu appears below (or above, based on available space)
5. Tap action in menu → action executes; preview dismisses
6. Tap preview itself → opens the item fully (equivalent to a tap)
7. Drag preview upward → exposes menu without dismissing (discoverability)

**Design rules [documented]:**
- Keep menus under ~6 items. People scan from the top.
- Destructive actions go last, are red, and require `role: .destructive`
- Group related actions with `Divider()` or menu sections
- Never use more than one level of submenus
- Provide a preview that gives meaningful context (don't just repeat the thumbnail)

### Swipe Actions on List Rows [documented]

Familiar from Mail: swipe trailing edge to reveal Delete, Archive, etc.

- **Short swipe** → reveals button(s) with haptic confirmation
- **Full swipe** (crossing threshold) → triggers the first action automatically (if `allowsFullSwipe: true`)
- **Leading edge swipe** → used for positive actions (Flag, Mark as Read)
- **Trailing edge swipe** → typically destructive (Delete, Archive)

### Pull-to-Refresh [documented]

- User drags down past the natural scroll boundary
- Rubber-band overscroll with a spinner indicator
- On release (past threshold), refresh initiates; content springs back
- If not past threshold on release, content snaps back without refresh

### Drag & Drop [documented]

iOS 11+. Works both within-app and cross-app (on iPad).

1. Long-press an element → it "lifts" (scale up, shadow appears, haptic)
2. Begin dragging → element follows finger; other apps can highlight valid drop zones
3. Drop → element animates to destination

Accessibility path: `UIAccessibilityCustomAction` can replicate drag-and-drop for assistive technology users [documented, Apple Accessibility docs].

### Pointer / Trackpad (iPad + Mac Catalyst) [documented, WWDC20]

iPadOS 13.4+ adapts the system pointer to context:

| Element type | Default pointer effect |
|---|---|
| Bar buttons, tabs, segmented controls | **Highlight** — pointer becomes a translucent rounded rect background; subtle parallax |
| App icons, cards, large items | **Lift** — element scales up, shadow appears below, pointer fades out |
| Text | **Beam** — text cursor appears |
| Generic interactive area | **Hover** — custom UIPointerStyle; no default morphing |

The pointer morphs _into_ the element's shape, creating the sensation that the cursor becomes the button. This is `UIPointerInteraction` + `UIPointerStyle` [documented].

Rules:
- Do not add lift to table rows (can't scale without overlapping neighbors) [documented]
- Hover effects that include tint-but-not-scale suit tight-spaced elements
- iPad users fluidly switch between touch and pointer — design for both simultaneously

### Keyboard Interplay [documented]

- Hardware keyboard shortcuts do not replace gestures — they augment them
- `UIKeyCommand` / SwiftUI `.keyboardShortcut()` for menu-bar actions
- All gesture-only workflows must have a keyboard equivalent in iPadOS apps
- Focus navigation (Tab key) must work for any interactive element

---

## Recipes

### SwiftUI: DragGesture with Velocity-Aware Spring Dismiss

```swift
import SwiftUI

struct SwipeToDismissSheet: View {
    @Binding var isPresented: Bool
    @State private var offset: CGFloat = 0
    @State private var lastDragVelocity: CGFloat = 0

    var body: some View {
        VStack {
            // drag handle
            Capsule()
                .fill(Color.secondary.opacity(0.4))
                .frame(width: 36, height: 5)
                .padding(.top, 8)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .offset(y: max(offset, 0))
        .gesture(
            DragGesture()
                .onChanged { value in
                    offset = value.translation.height
                }
                .onEnded { value in
                    let velocity = value.predictedEndTranslation.height
                    // Dismiss if dragged > 40% of screen height OR fast flick downward
                    if offset > UIScreen.main.bounds.height * 0.4 || velocity > 800 {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                            isPresented = false
                        }
                    } else {
                        // Snap back — pass captured velocity into spring
                        withAnimation(.spring(response: 0.4, dampingFraction: 0.8,
                                             blendDuration: 0)) {
                            offset = 0
                        }
                    }
                }
        )
    }
}
```

### SwiftUI: contextMenu with Custom Preview

```swift
import SwiftUI

struct CardView: View {
    let item: Item

    var body: some View {
        ItemThumbnail(item: item)
            .contextMenu {
                Button {
                    shareItem(item)
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                Button {
                    favoriteItem(item)
                } label: {
                    Label("Favorite", systemImage: "heart")
                }
                Divider()
                Button(role: .destructive) {
                    deleteItem(item)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } preview: {
                // Custom preview — gives context before committing
                ItemDetailPreview(item: item)
                    .frame(width: 280, height: 200)
            }
    }
}
```

### SwiftUI: swipeActions on List Rows

```swift
import SwiftUI

struct MessageList: View {
    @State private var messages: [Message] = Message.samples

    var body: some View {
        List {
            ForEach(messages) { message in
                MessageRow(message: message)
                    // Trailing = destructive actions
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            delete(message)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        Button {
                            archive(message)
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                        .tint(.orange)
                    }
                    // Leading = positive quick action
                    .swipeActions(edge: .leading) {
                        Button {
                            toggleRead(message)
                        } label: {
                            Label(message.isRead ? "Unread" : "Read",
                                  systemImage: message.isRead
                                    ? "envelope.badge" : "envelope.open")
                        }
                        .tint(.blue)
                    }
            }
        }
    }
}
```

### SwiftUI: DragGesture Direction Classifier

```swift
import SwiftUI

enum SwipeDirection { case left, right, up, down }

extension View {
    func onSwipe(minimumDistance: CGFloat = 30,
                 perform action: @escaping (SwipeDirection) -> Void) -> some View {
        self.gesture(
            DragGesture(minimumDistance: minimumDistance)
                .onEnded { value in
                    let h = value.translation.width
                    let v = value.translation.height
                    if abs(h) > abs(v) {
                        action(h < 0 ? .left : .right)
                    } else {
                        action(v < 0 ? .up : .down)
                    }
                }
        )
    }
}
```

### SwiftUI: Velocity-to-Spring (UISpringTimingParameters bridge)

```swift
// Convert captured gesture velocity to a relative velocity scalar
// that UISpringTimingParameters / withAnimation can consume.
func relativeVelocity(velocity: CGFloat,
                      from current: CGFloat,
                      to target: CGFloat) -> CGFloat {
    guard current != target else { return 0 }
    return velocity / (target - current)
}

// Usage after DragGesture .onEnded:
let rv = relativeVelocity(velocity: gestureVelocity, from: offset, to: 0)
let params = UISpringTimingParameters(
    damping: 0.8,
    response: 0.4,
    initialVelocity: CGVector(dx: rv, dy: 0)
)
```

### iOS 18: UIGestureRecognizerRepresentable (Bridge UIKit → SwiftUI)

```swift
import SwiftUI
import UIKit

// Lets you use UIKit gesture recognizers directly inside SwiftUI views.
// Introduced WWDC24 — solves gesture conflict resolution that .gesture() can't.
struct TwoFingerTap: UIGestureRecognizerRepresentable {
    var action: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
        let g = UITapGestureRecognizer()
        g.numberOfTouchesRequired = 2
        return g
    }

    func handleUIGestureRecognizerAction(
        _ recognizer: UITapGestureRecognizer, context: Context) {
        if recognizer.state == .ended { action() }
    }
}

// Usage:
someView.gesture(TwoFingerTap { handleTwoFingerTap() })
```

---

### JavaScript: Pointer-Event Swipe/Drag with Velocity

```javascript
/**
 * Attaches a swipe/drag recognizer using Pointer Events API.
 * Returns velocity (px/ms) at end of gesture.
 * touch-action: none must be set on the element via CSS.
 */
function attachSwipeGesture(el, { onSwipe, threshold = 30, velocityThreshold = 0.3 } = {}) {
  let startX, startY, startTime, lastX, lastY, lastTime;

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); // ensures we get all events even if pointer leaves el
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    startTime = lastTime = e.timeStamp;
  });

  el.addEventListener('pointermove', (e) => {
    // Track last position for velocity calculation
    lastX = e.clientX;
    lastY = e.clientY;
    lastTime = e.timeStamp;
  });

  el.addEventListener('pointerup', (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dt = e.timeStamp - lastTime; // time of last movement segment
    const vx = dt > 0 ? (e.clientX - lastX) / dt : 0; // px/ms
    const vy = dt > 0 ? (e.clientY - lastY) / dt : 0;

    const isHorizontal = Math.abs(dx) > Math.abs(dy);
    const distance = isHorizontal ? Math.abs(dx) : Math.abs(dy);
    const velocity = isHorizontal ? Math.abs(vx) : Math.abs(vy);

    if (distance > threshold || velocity > velocityThreshold) {
      const direction = isHorizontal
        ? (dx < 0 ? 'left' : 'right')
        : (dy < 0 ? 'up' : 'down');
      onSwipe?.({ direction, velocity, distance });
    }
  });
}

// Example usage:
attachSwipeGesture(document.querySelector('.card'), {
  onSwipe: ({ direction, velocity }) => {
    if (direction === 'left') dismissCard(velocity);
  }
});
```

### JavaScript: Drag with Momentum + Spring-like Settling

```javascript
/**
 * Momentum drag: on release, projects position based on velocity
 * then decelerates using requestAnimationFrame (no library needed).
 */
function momentumDrag(el) {
  let x = 0, velX = 0;
  let prevX, prevTime, rafId;
  let isDragging = false;

  const DECELERATION = 0.95; // lower = faster stop (0.9 = fast, 0.98 = slow coast)

  el.addEventListener('pointerdown', (e) => {
    isDragging = true;
    cancelAnimationFrame(rafId);
    prevX = e.clientX;
    prevTime = e.timeStamp;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dt = e.timeStamp - prevTime || 1;
    velX = (e.clientX - prevX) / dt;
    x += e.clientX - prevX;
    prevX = e.clientX;
    prevTime = e.timeStamp;
    el.style.transform = `translateX(${x}px)`;
  });

  el.addEventListener('pointerup', () => {
    isDragging = false;
    coast();
  });

  function coast() {
    velX *= DECELERATION;
    x += velX;
    el.style.transform = `translateX(${x}px)`;
    if (Math.abs(velX) > 0.1) {
      rafId = requestAnimationFrame(coast);
    }
  }
}
```

### CSS: touch-action and overscroll-behavior

```css
/* Horizontal carousel — let the browser handle vertical scroll normally,
   but let our JS handle horizontal drag */
.carousel {
  touch-action: pan-y;       /* browser owns vertical; we own horizontal */
  overscroll-behavior-x: contain; /* prevent horizontal swipe triggering back-nav */
  user-select: none;         /* prevent text selection during drag */
}

/* Full custom canvas / map / game — disable all browser gestures */
.canvas-surface {
  touch-action: none;        /* our JS handles everything */
}

/* Remove the 300ms double-tap-zoom delay on interactive UI elements
   without disabling pinch-zoom accessibility */
button,
a,
[role="button"] {
  touch-action: manipulation;
}

/* Prevent pull-to-refresh but keep rubber-band feel at scroll boundaries */
body {
  overscroll-behavior-y: contain;
}

/* Prevent both pull-to-refresh AND boundary glow/rubber-band */
.modal-sheet {
  overscroll-behavior: none;
}
```

---

## Faithful Replication

### What Transfers to the Web

| Native iOS pattern | Web equivalent | Fidelity |
|---|---|---|
| Swipe carousel | `touch-action: pan-y` + `pointermove` velocity tracking | High — feels native with momentum |
| Pull-to-refresh | `overscroll-behavior: contain` + threshold detection on `scroll` | Medium — functional but no haptics |
| Swipe actions (list rows) | `pointermove` drag with reveal; threshold-snap animation | Medium — missing spring physics unless CSS `transition: transform` tuned carefully |
| Context menu long-press | `pointerdown` timeout + `contextmenu` event on desktop | Medium — no backdrop blur or parallax lift |
| Swipe-to-dismiss sheet | `pointermove` + velocity at `pointerup` + CSS transition | High — most convincing web analog |
| Pinch-to-zoom | `wheel` + `Ctrl` key (trackpad pinch) or touch `scale` gesture | Partial — only native on touch browsers |
| Haptic feedback | Web Vibration API (`navigator.vibrate([10])`) | Low — Android only; no iOS Safari support [documented] |
| Dynamic Island | No web equivalent | None |
| Pointer morphing | CSS `cursor` property (limited shapes); no element-morphing | Very low |

### Spring Physics on the Web

CSS `transition` does not support initialVelocity — it always starts from rest. Options:
- **CSS `spring()` function** — proposed but not yet widely supported as of 2025 [speculative status; check caniuse].
- **Web Animations API** with custom easing** — nearest practical option:
  ```javascript
  el.animate(
    [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
    {
      duration: 400,
      easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', // overshoot approximates spring
      fill: 'forwards'
    }
  );
  ```
- **Motion (formerly Framer Motion) / GSAP** with spring presets — best fidelity for velocity handoff [observed in production web apps].

The fundamental gap: iOS springs consume `initialVelocity` from the gesture release. Web CSS `transition` cannot. Bridging requires JavaScript-driven animation (rAF loop or a library) to properly hand velocity into the animation start state.

### Pointer Capture (Critical for Drag)

```javascript
el.setPointerCapture(e.pointerId);
// Ensures pointermove/pointerup fire on this element even when
// the pointer moves outside el's bounds — exactly like UIKit's
// gesture recognizer hitTest behavior [documented, W3C Pointer Events].
```

Without pointer capture, fast drags that exit the element boundary break the gesture. This is a common web bug with no iOS equivalent (UIKit handles it automatically).

---

## Anti-Patterns

### 1. Gesture-Only Actions with No Fallback
**Bad:** Delete only accessible by swiping a list row. Screen reader users, switch-control users, and mouse-only iPad users cannot discover or trigger the action.
**Rule:** Every gesture-triggered action must also exist in a context menu, button, or Edit mode [documented, HIG; WCAG 2.5.1].

### 2. Fighting Native Scroll with `touch-action: none`
**Bad:** Wrapping an entire page with `touch-action: none` to implement custom drag, then manually re-implementing scrolling.
**Result:** Breaks accessibility zoom, breaks browser scroll restoration, performance degrades, and the scroll feel never matches native.
**Rule:** Use `touch-action: pan-x` or `pan-y` directionally. Only disable the axis your gesture controls [documented].

### 3. Undiscoverable Custom Gestures
**Bad:** Rotate gesture to switch themes; three-finger tap to show hidden menu. No affordance, no tutorial, no fallback.
**Result:** Only power users discover it. New users feel the app is broken.
**Rule:** Custom gestures beyond the standard vocabulary need a visible entry point (e.g., a long-press animation showing a "hold to rearrange" label) [inferred from HIG discoverability principle].

### 4. Ignoring Velocity — Snapping Without Momentum
**Bad:** On `pointerup`, immediately snap to nearest target regardless of how fast the user flicked.
**Result:** A swipe that felt fast produces the same result as a slow drag — the gesture feels dead and unresponsive.
**Rule:** Always read velocity at end of gesture. A high-velocity flick should skip past the nearest target or trigger dismiss even if distance threshold wasn't met [documented, WWDC18].

### 5. Blocking the Back Edge Swipe on the Web
**Bad:** `overscroll-behavior-x: none` on a page without checking if the user is at scroll position 0. This silently swallows the browser back gesture.
**Rule:** `overscroll-behavior-x: contain` (not `none`) on scroll containers. Reserve `none` for truly isolated surfaces (modals, full-screen maps) [documented, MDN].

### 6. Redefining Standard Gestures
**Bad:** App uses swipe-left for "next item" in a context where the system or browser uses swipe-left for "back."
**Result:** Conflicts create jarring or accidental navigation. The system gesture wins at the boundary; the app gesture wins in the interior — both fire unpredictably.
**Rule:** Respect system gesture regions. Use `preferredScreenEdgesDeferringSystemGestures` only when genuinely necessary, and always on the correct edge [documented].

### 7. Zero Gesture Feedback During Drag
**Bad:** Element does not move until the user lifts their finger.
**Result:** User thinks touch did not register; performs action multiple times.
**Rule:** Provide live 1:1 visual feedback from the first `pointermove`. Even a 1px shift is enough to confirm contact [documented].

### 8. Gesture Timeout Too Long for Long-Press
**Bad:** 1-second long-press threshold (same as "contextmenu" on some older Android browsers).
**Result:** Users abandon the gesture before it fires; accidental long-presses on legitimate taps increase.
**Rule:** iOS uses ~0.5 s for context menu trigger. For custom long-press on web, target 400–500 ms [observed from UIKit defaults]. Provide a visual cue at ~200 ms (e.g., subtle scale) so the user knows they're on track.

### 9. Missing `setPointerCapture` on Web Drag
**Bad:** Drag implementation loses track when finger/pointer moves outside element boundary.
**Result:** Ghost drags, incomplete gesture recognition, state leaks.
**Rule:** Call `el.setPointerCapture(e.pointerId)` on `pointerdown` for any drag implementation [documented, MDN].

### 10. Haptic Feedback Assumptions on Web
**Bad:** `navigator.vibrate([10])` as haptic feedback assumes Android Chrome. iOS Safari does not support the Vibration API as of 2025 [documented]. Web apps cannot provide haptic feedback on iOS at all from JS.
**Rule:** Design so that haptics are an enhancement only. The gesture must feel complete without them.

---

## Sources

- [Apple HIG — Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures) [documented]
- [Apple HIG — Touchscreen gestures (Inputs)](https://developer.apple.com/design/human-interface-guidelines/inputs/touchscreen-gestures/) [documented]
- [Apple HIG — Pointing devices (iPad pointer)](https://developer.apple.com/design/human-interface-guidelines/inputs/pointing-devices/) [documented]
- [Apple HIG — Drag and drop](https://developer.apple.com/design/human-interface-guidelines/patterns/drag-and-drop/) [documented]
- [WWDC18 Session 803 — Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/) [documented]
- [Building Fluid Interfaces — Nathan Gitter (WWDC18 companion)](https://medium.com/@nathangitter/building-fluid-interfaces-ios-swift-9732bb934bf5) [documented]
- [Gestures in Fluid Interfaces — Christian Schnorr (intent & projection)](https://medium.com/ios-os-x-development/gestures-in-fluid-interfaces-on-intent-and-projection-36d158db7395) [documented]
- [WWDC20 — Design for the iPadOS pointer](https://developer.apple.com/videos/play/wwdc2020/10640/) [documented]
- [WWDC20 — Build for the iPadOS pointer](https://developer.apple.com/videos/play/wwdc2020/10093/) [documented]
- [WWDC23 — Design dynamic Live Activities](https://developer.apple.com/videos/play/wwdc2023/10194/) [documented]
- [WWDC24 — Design Live Activities for Apple Watch](https://developer.apple.com/videos/play/wwdc2024/10098/) [documented]
- [Apple Developer — DynamicIsland (WidgetKit)](https://developer.apple.com/documentation/widgetkit/dynamicisland) [documented]
- [Apple Developer — UIContextMenuInteraction](https://developer.apple.com/documentation/uikit/uicontextmenuinteraction) [documented]
- [Apple Developer — SwiftUI contextMenu(menuItems:preview:)](https://developer.apple.com/documentation/swiftui/view/contextmenu(menuitems:preview:)) [documented]
- [SwiftUI Gestures — fatbobman.com (UIGestureRecognizerRepresentable iOS 18)](https://fatbobman.com/en/posts/swiftuigesture/) [documented]
- [MDN — touch-action CSS property](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action) [documented]
- [MDN — overscroll-behavior CSS property](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior) [documented]
- [MDN — Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) [documented]
- [CSS-Tricks — Simple Swipe with Vanilla JS](https://css-tricks.com/simple-swipe-with-vanilla-javascript/) [documented]
- [WCAG 2.5.1 — Pointer Gestures](https://www.wcag.com/developers/2-5-1-pointer-gestures/) [documented]
- [iOS 26 Home indicator changes — Revert to Saved](https://reverttosaved.com/2025/06/13/the-quiet-exit-of-the-home-indicator-in-ios-26-and-ipados-26/) [observed]

---

CONFIDENCE: 82% — Core gesture vocabulary, WWDC18 fluid-interface principles, and CSS/JS recipes are well-documented; Dynamic Island expansion behavior and iOS 26 Home indicator changes are based on recently published observations and may shift with future OS updates.
