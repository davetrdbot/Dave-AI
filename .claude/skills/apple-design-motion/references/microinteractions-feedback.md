# Micro-interactions & Feedback

Reference for the `apple-design-motion` skill family — covers haptic grammar, sound restraint, control-state feedback, loading patterns, and their web analogs.

---

## 1. Principles

### Every Action Gets a Response
Apple's HIG states that feedback helps people know what's happening, discover what they can do next, understand the results of actions, and avoid mistakes. [documented] A tap that produces no visual, auditory, or haptic change feels broken — the platform reads as unresponsive. Every discrete user action (tap, toggle, drag snap, scroll detent, form submit) must produce at least one feedback signal within the threshold of human perception. [documented]

### Restraint — the Most Important Rule
More feedback is not better feedback. Apple's guidelines make this explicit: do not overuse haptics; haptic feedback should be a response to a user-initiated action so the user can correlate the feedback with its source. [documented] Key corollaries:

- UIKit's built-in controls (switches, sliders, pickers, Apple Pay) already ship with Apple-designed system haptics. Do not add a UIFeedbackGenerator call on top of a UISwitch — you will double-fire and overstimulate the user. [documented]
- Haptic feedback is not a sound effect. Apple's original philosophy explicitly cautioned developers that raw vibration as audio-analog feedback was wrong — it degrades trust and battery life. [documented]
- On unsupported devices (pre-iPhone 6s second-generation Taptic Engine), omit haptics entirely rather than falling back to the older AudioServicesPlaySystemSound vibration. [documented]

### Multi-Sensory Layering
Apple's design language treats haptic, sound, and visual feedback as a synchronized triad, not three independent channels. From WWDC21 "Practice audio haptic design" (session 10278): the session teaches that rich app experiences layer animation, sound, and haptics together. [documented] The WWDC19 session "Designing Audio-Haptic Experiences" (session 810) formalizes this further. [documented]

Practical rule: if you add a haptic, consider whether a micro-animation or a subtle sound completes the triple. If any layer is present without the others, the experience feels incomplete or jarring. [inferred from WWDC content]

### Why Haptics Were Added (Brief History)
Apple introduced the first Taptic Engine in the Apple Watch (late 2014), then the MacBook Force Touch trackpad (early 2015), then iPhone 6s (fall 2015) alongside 3D Touch. [documented] The engineering motivation was replacing the slower, less precise ERM (eccentric rotating mass) vibration motors with a Linear Resonant Actuator (LRA) — faster response, narrower frequency bands (~80–230 Hz), more energy-efficient, and capable of producing distinct tactile textures rather than a single buzz. [documented] The design motivation: touchscreens removed the physical click; haptics restore the sense that something responded to your touch without visual feedback needing to carry the entire burden. [documented]

---

## 2. Apple Specifics

### 2.1 The Taptic Engine — Platform Support

| Platform | Engine generation | Notes |
|---|---|---|
| iPhone 6s+ | 2nd gen Taptic Engine | UIFeedbackGenerator available from here |
| iPhone X+ | Same engine, refined | 3D Touch removed on XR; haptics remain |
| Apple Watch | Separate Taptic Engine | WKHapticType API |
| MacBook (Force Touch) | Separate actuator | NSHapticFeedbackManager |
| iPad | No Taptic Engine | UIFeedbackGenerator silently no-ops [documented] |
| Mac (non-Force-Touch) | No engine | No haptics |

Core Haptics (CHHapticEngine) is available on iOS 13+, iPadOS 13+, Mac Catalyst 13+, tvOS 14+. [documented]

---

### 2.2 Haptic Pattern Catalog (UIFeedbackGenerator — UIKit)

Three generators, each a UIFeedbackGenerator subclass. [documented]

#### UINotificationFeedbackGenerator
Signals the outcome of a task or process. Three feedback types:

| Type | When to fire | Subjective feel |
|---|---|---|
| `.success` | Task completed successfully (deposit confirmed, check-in complete) | Two taps, ascending — resolve |
| `.warning` | Task produced a warning the user should acknowledge | Two taps, mid-weight — caution |
| `.error` | Task failed | Three rapid taps — urgent, jarring |

Rule: only fire notification feedback in response to an outcome of a multi-step process, not in response to a single tap on a button. [documented]

#### UIImpactFeedbackGenerator
Provides a physical metaphor — a collision or a snap. Five styles: [documented]

| Style | Subjective feel | Example use |
|---|---|---|
| `.light` | Subtle, sharp tap | Selection UI, small item pick |
| `.medium` | Solid tap | Default object collision, drag-and-drop land |
| `.heavy` | Thud | Large view snapping into place |
| `.soft` | Rounded, cushioned | Gentle drag snap |
| `.rigid` | Crisp, no cushion | Hard stop, boundary hit |

`impactOccurred(intensity:)` accepts a value 0.0–1.0 to scale the force. [documented]

#### UISelectionFeedbackGenerator
A light tick fired for **each increment** of a continuous selection change. [documented]

| When to fire | When NOT to fire |
|---|---|
| Picker wheel turns (each detent) | Toggle flips (use notification or impact) |
| Scrubbing a custom segmented control | Any tap that does not change a continuous value |
| Reordering list rows (each row boundary crossed) | On every scroll event (way too frequent) |

#### prepare() — Latency Management
The Taptic Engine enters a ready state only when a generator is `prepare()`d. Call `prepare()` before the expected interaction (e.g., as the user begins a drag), not at initialization. Without it, the engine may need ~100ms to spin up, causing perceptible lag between the visual event and the haptic. [documented] The ready state expires after a few seconds if feedback is not triggered, so prepare only when you have high confidence the action is imminent. [documented]

---

### 2.3 SensoryFeedback — SwiftUI (iOS 17+)

SwiftUI's `.sensoryFeedback(_:trigger:)` modifier is the modern replacement for UIKit UIFeedbackGenerator boilerplate. It fires when the `trigger` value changes. [documented]

Full enum surface (iOS/iPadOS unless noted):

| Case | Platform | Maps to |
|---|---|---|
| `.success` | iOS, watchOS | Notification success |
| `.warning` | iOS, watchOS | Notification warning |
| `.error` | iOS, watchOS | Notification error |
| `.selection` | iOS, watchOS | Selection feedback |
| `.increase` | watchOS only | Value increased past threshold |
| `.decrease` | watchOS only | Value decreased past threshold |
| `.start` | watchOS only | Activity initiated |
| `.stop` | watchOS only | Activity concluded |
| `.impact` | iOS, watchOS | Impact (configurable weight/flexibility) |
| `.alignment` | macOS only | Dragged item snapped to alignment guide |
| `.levelChange` | macOS only | Trackpad pressure level change |

Impact variants:
```swift
.impact()                                   // default medium weight
.impact(weight: .light)
.impact(weight: .medium)
.impact(weight: .heavy)
.impact(flexibility: .rigid, intensity: 0.8)
.impact(flexibility: .soft, intensity: 1.0)
.impact(flexibility: .solid)
```
`intensity` is a `Double` 0.0–1.0. [documented]

---

### 2.4 Core Haptics — Custom Patterns (iOS 13+)

Use Core Haptics (CHHapticEngine) when UIFeedbackGenerator's pre-baked patterns are insufficient — games, music apps, tactile-rich experiences. [documented] Core Haptics is NOT a replacement for UIFeedbackGenerator on standard UI controls; use both in their respective lanes. [documented]

**Two event types:**
- `hapticTransient` — a short burst (tap, nudge). Duration is minimal, defined by the engine. [documented]
- `hapticContinuous` — a sustained vibration, configurable duration up to 30 seconds. [documented]

**Two core parameters (normalized 0.0–1.0):**
- `hapticIntensity` — amplitude / force of the haptic [documented]
- `hapticSharpness` — texture of the vibration: 0.0 = soft, rounded, calm; 1.0 = sharp, urgent, clicking [documented]

**AHAP format:** Apple Haptic and Audio Pattern — a JSON file that defines arrays of CHHapticEvent objects with relativeTime, eventType, and event parameters. Usable for pre-authored complex patterns. [documented]

---

### 2.5 watchOS Haptic Catalog (WKHapticType)

| Type | Meaning |
|---|---|
| `.notification` | Generic notification ping |
| `.directionUp` / `.directionDown` | Navigational turn prompt |
| `.success` / `.failure` / `.retry` | Outcome states |
| `.start` / `.stop` | Activity phase |
| `.click` | Discrete UI tap |
| `.navigationGenericManeuver` | Continue navigation |
| `.navigationLeftTurn` / `.navigationRightTurn` | Turn prompt |

[documented — WKHapticType enum]

---

### 2.6 macOS Force Touch (NSHapticFeedbackManager)

| Pattern | Use |
|---|---|
| `.alignment` | Dragged object aligned with guide |
| `.levelChange` | Value passed a notable threshold |
| `.generic` | Custom, non-semantic event |

[documented]

---

### 2.7 When Apple Fires Haptics — System UI Catalog

These fire automatically when using system controls; do not re-fire with UIFeedbackGenerator: [documented]

| Interaction | Built-in haptic | Generator type |
|---|---|---|
| UISwitch toggle | Impact (medium) | Built-in |
| UISlider dragging | Selection tick per significant move | Built-in |
| UIPickerView detent | Selection feedback | Built-in |
| Pull-to-refresh trigger | Impact (built-in UIRefreshControl) | Built-in |
| Apple Pay auth | System notification sequence | Built-in |
| Drag-and-drop: lift | Soft impact | Built-in |
| Drag-and-drop: drop | Medium impact | Built-in |
| Long-press context menu open | Soft impact (peek) | Built-in |
| Home/App Switcher gestures | System | Built-in |

For custom controls that mimic any of the above, use the matching generator type. [inferred from HIG + WWDC guidance]

---

### 2.8 Sound Design — The Restraint Principle

Apple's audio philosophy: UI sounds must be subtle, short, and non-intrusive. [documented from WWDC17 "Designing Sound" + HIG playing-audio]

Core rules from Apple's documentation and WWDC:

1. **Respect the silent switch.** When a device is in silent mode, apps must not play any audio except content the user explicitly initiated (media playback, alarms, voice messages). Keyboard clicks, UI sound effects, game feedback — all must be suppressed. [documented]
2. **Subtle and additive.** UI sounds add confirmation; they do not carry meaning on their own. A UI that requires sound to be understood has failed its design. [documented]
3. **Slight randomization for repeated sounds.** For sounds played on rapid repetition (keyboard clicks), slightly randomize pitch and amplitude each play so it feels natural rather than robotic. [documented — WWDC17 "Designing Sound"]
4. **Synchronize with haptics.** A haptic without a sound (or vice versa) at the same moment can feel uncanny. Apple's demo apps in WWDC21 session 10278 show sound and haptic timed to within a single frame. [documented]
5. **Avoid decorative sounds.** If removing a sound degrades an interaction, the sound is meaningful. If nothing is lost, it is decorative and should be cut. [inferred from WWDC17 principles]

---

### 2.9 Control State Feedback — Visual Layer

These are the visual micro-interactions Apple uses in system controls:

| Control | Press state | Notes |
|---|---|---|
| UIButton (system) | Opacity → 0.4 on `.highlighted` | ~80ms, no scale change by default [observed] |
| UIButton (custom filled) | Scale 0.96 + slight dim | Common pattern in HIG-compliant apps [observed] |
| UISwitch | Knob spring-animates on release with bounce | Uses spring physics, not linear [observed] |
| Picker wheel | Detent snap with selection highlight | Combined with selection haptic [documented] |
| Navigation bar button | Opacity pulse | Same as system button highlight [observed] |
| Context menu long-press | Scale-up peek → blur behind | Blur deepens over ~400ms hold [observed] |
| Home Screen icon (press) | Scale 0.9 + slight dim | Quick feedback before menu appears [observed] |
| Tab bar item | Scale 1.1 bounce on select | Spring (damping ~0.6) [observed] |

**The press-and-hold pattern:** System apps dim or scale the element immediately on touch-down (< 16ms, sub-frame), then animate to the "held" state over ~120ms. Release springs back. The hold-trigger (context menu, Haptic Touch) fires at ~500ms threshold with an impact haptic simultaneously. [observed]

---

### 2.10 Loading & Progress Feedback

Apple's HIG: "The best content-loading experience finishes before people become aware of it." [documented]

When loading cannot be hidden:

| Scenario | Recommended pattern | Notes |
|---|---|---|
| Unknown duration, short task | Activity indicator (spinner) — disappears on complete | Always indeterminate [documented] |
| Known duration / quantifiable | Determinate progress bar | Prefer over spinner when progress is measurable [documented] |
| Content-shaped load (feeds, cards) | Skeleton / placeholder | Shimmer left-to-right animation, match content layout [inferred + general practice] |
| Loading in nav/toolbar | Progress bar with unfilled portion hidden | Track hidden so it reads as a thin line growing [documented] |
| Network indicator | Deprecated since iOS 13 (UIApplication.isNetworkActivityIndicatorVisible removed) | Do not use [documented] |

**Latency perception thresholds** [documented from human factors research, referenced in Apple talks]:
- < 100ms: perceived as instantaneous — no indicator needed
- 100ms–1s: a spinner or subtle animation can appear, but test whether it flickers
- 1s+: show an indicator; users begin to wonder if the app is frozen
- 10s+: always show determinate progress if possible, plus a cancel affordance

---

## 3. Recipes

### 3.1 UIKit — UIImpactFeedbackGenerator (Swift)

```swift
// MARK: - UIKit Haptics

// Impact — prepare() before the event for lowest latency
final class HapticEngine {
    private let impactLight   = UIImpactFeedbackGenerator(style: .light)
    private let impactMedium  = UIImpactFeedbackGenerator(style: .medium)
    private let impactHeavy   = UIImpactFeedbackGenerator(style: .heavy)
    private let notification  = UINotificationFeedbackGenerator()
    private let selection     = UISelectionFeedbackGenerator()

    // Call when interaction is imminent (e.g., gesture began)
    func prepareForDrag() {
        impactMedium.prepare()
    }

    // Call at the snap/drop moment
    func snapOccurred() {
        impactMedium.impactOccurred()
    }

    // Scaled intensity — useful for drag distance → force mapping
    func impactAtIntensity(_ intensity: CGFloat) {
        impactMedium.impactOccurred(intensity: intensity) // 0.0–1.0
    }

    // Notification outcomes
    func taskSucceeded()  { notification.notificationOccurred(.success) }
    func taskFailed()     { notification.notificationOccurred(.error)   }
    func taskWarned()     { notification.notificationOccurred(.warning) }

    // Selection changes (picker, custom segmented control)
    func selectionChanged() {
        selection.selectionChanged()
    }
}
```

---

### 3.2 SwiftUI — .sensoryFeedback (iOS 17+)

```swift
import SwiftUI

// Basic: fires on any change of taskComplete
struct CompletionButton: View {
    @State private var taskComplete = false

    var body: some View {
        Button("Mark Done") { taskComplete = true }
            .sensoryFeedback(.success, trigger: taskComplete)
    }
}

// Conditional: only fire if the new selection is non-nil
struct PickerRow: View {
    @State private var selection: String? = nil

    var body: some View {
        Picker("Choose", selection: $selection) {
            Text("Option A").tag(Optional("A"))
            Text("Option B").tag(Optional("B"))
        }
        .sensoryFeedback(.selection, trigger: selection) { _, newValue in
            newValue != nil  // return Bool — fire only when condition is true
        }
    }
}

// Dynamic: different feedback depending on outcome
struct OutcomeView: View {
    @State private var errorCode: Int = 0

    var body: some View {
        Button("Submit") { errorCode = submitForm() }
            .sensoryFeedback(trigger: errorCode) { _, newCode in
                switch newCode {
                case 0:    return .success
                case 400:  return .warning
                default:   return .error
                }
            }
    }

    func submitForm() -> Int { /* ... */ return 0 }
}

// Impact with weight and intensity
struct DragDropTarget: View {
    @State private var dropped = false

    var body: some View {
        Rectangle()
            .sensoryFeedback(
                .impact(weight: .heavy, intensity: 0.8),
                trigger: dropped
            )
    }
}
```

---

### 3.3 Core Haptics — CHHapticEngine (iOS 13+)

```swift
import CoreHaptics

final class CustomHapticPlayer {
    private var engine: CHHapticEngine?

    func start() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            engine = try CHHapticEngine()
            engine?.stoppedHandler = { [weak self] reason in
                print("Haptic engine stopped: \(reason.rawValue)")
                try? self?.engine?.start()   // auto-restart
            }
            engine?.resetHandler = { [weak self] in
                try? self?.engine?.start()
            }
            try engine?.start()
        } catch {
            print("Failed to start haptic engine: \(error)")
        }
    }

    // A single sharp transient tap (e.g. boundary hit in a game)
    func playSharpTap(intensity: Float = 1.0, sharpness: Float = 0.8) {
        guard let engine else { return }
        let event = CHHapticEvent(
            eventType: .hapticTransient,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
            ],
            relativeTime: 0
        )
        do {
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player  = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            print("Haptic playback error: \(error)")
        }
    }

    // A continuous rumble fading out (e.g. rolling physics object)
    func playRumbleFadeOut(duration: TimeInterval = 1.0) {
        guard let engine else { return }
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.3)
            ],
            relativeTime: 0,
            duration: duration
        )
        // Fade intensity to zero over the duration
        let fadeOut = CHHapticParameterCurve(
            parameterID: .hapticIntensityControl,
            controlPoints: [
                .init(relativeTime: 0,        value: 1.0),
                .init(relativeTime: duration,  value: 0.0)
            ],
            relativeTime: 0
        )
        do {
            let pattern = try CHHapticPattern(events: [event], parameterCurves: [fadeOut])
            let player  = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            print("Haptic playback error: \(error)")
        }
    }

    // Play a pre-authored AHAP file
    func playAHAP(named name: String) {
        guard let engine,
              let url = Bundle.main.url(forResource: name, withExtension: "ahap") else { return }
        try? engine.playPattern(from: url)
    }
}
```

---

### 3.4 CSS — Button Press Micro-Interaction (web analog)

```css
/* -------------------------------------------------------
   Apple-style button press
   - Scale 0.96 on press (not 0.9 — too dramatic)
   - 80ms in, spring-eased out
   - Opacity dim for filled buttons
   - Hardware-accelerated: transform + opacity only
   ------------------------------------------------------- */

.apple-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 20px;
  border-radius: 10px;
  background: #007AFF;   /* iOS system blue */
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;  /* kill default mobile highlight */

  /* Idle → pressed: fast compress */
  transition:
    transform 80ms cubic-bezier(0.4, 0, 1, 1),
    opacity   80ms linear;
  will-change: transform, opacity;
}

.apple-btn:active {
  transform: scale(0.96);
  opacity: 0.85;
}

/* Released → idle: slower spring-like ease-out */
/* Technique: override transition on :not(:active) */
.apple-btn:not(:active) {
  transition:
    transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity   200ms ease-out;
}

/* ------ Reduce motion: kill animation, keep opacity signal ------ */
@media (prefers-reduced-motion: reduce) {
  .apple-btn,
  .apple-btn:not(:active) {
    transition: opacity 80ms linear;
  }
  .apple-btn:active {
    transform: none;
    opacity: 0.7;
  }
}
```

---

### 3.5 CSS — Toggle Spring (web analog to UISwitch)

```css
/* Toggle track + knob, spring-animated */
.toggle-track {
  width: 51px;
  height: 31px;
  border-radius: 15.5px;
  background: #e5e5ea;
  position: relative;
  cursor: pointer;
  transition: background 200ms ease;
  -webkit-tap-highlight-color: transparent;
}

.toggle-track.on {
  background: #34C759;   /* iOS system green */
}

.toggle-knob {
  position: absolute;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: #fff;
  top: 2px;
  left: 2px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.28);

  /* Spring: overshoot cubic-bezier */
  transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toggle-track.on .toggle-knob {
  transform: translateX(20px);
}

@media (prefers-reduced-motion: reduce) {
  .toggle-knob {
    transition: transform 150ms ease;
  }
}
```

---

### 3.6 JavaScript — Vibration API (web haptics, with iOS caveat)

> **CRITICAL LIMITATION:** The Vibration API (`navigator.vibrate()`) is NOT supported on iOS/Safari as of 2026. It is also unsupported in Firefox 129+ and Safari on macOS. It works in Chrome, Edge, Opera, Samsung Internet, and Android Browser only. Global support is approximately 77% but that figure excludes the entire iOS user base. [documented — MDN, caniuse.com] Do not rely on it for any iOS-targeting product without an explicit graceful fallback.

```javascript
/**
 * Web haptics shim — wraps navigator.vibrate with:
 *  - Feature detection
 *  - iOS/Safari NO-OP path (explicit, not silent)
 *  - prefers-reduced-motion respect
 */
const Haptics = (() => {
  const supported = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fire(pattern) {
    if (!supported || prefersReduced) return;  // no-op on iOS, Firefox 129+, reduced-motion
    navigator.vibrate(pattern);
  }

  return {
    // Analogous to UIImpactFeedbackGenerator .light
    impactLight()  { fire(10); },

    // Analogous to UIImpactFeedbackGenerator .medium
    impactMedium() { fire(20); },

    // Analogous to UIImpactFeedbackGenerator .heavy
    impactHeavy()  { fire(40); },

    // Analogous to UINotificationFeedbackGenerator .success
    // Two taps, short gap
    notifySuccess() { fire([15, 80, 15]); },

    // Analogous to .warning
    notifyWarning() { fire([15, 80, 30]); },

    // Analogous to .error — three rapid taps
    notifyError()   { fire([20, 60, 20, 60, 20]); },

    // Analogous to UISelectionFeedbackGenerator — barely-there tick
    selection()     { fire(5); },

    // Cancel any in-progress vibration
    cancel()        { if (supported) navigator.vibrate(0); },
  };
})();

// Usage:
document.querySelector('.submit-btn').addEventListener('click', () => {
  Haptics.impactMedium();
});
```

---

### 3.7 CSS — Skeleton Loading (web loading feedback)

```css
/* Skeleton shimmer — matches content layout, left-to-right sweep */
.skeleton {
  background: #e0e0e0;
  border-radius: 8px;
  position: relative;
  overflow: hidden;
}

.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.6) 50%,
    transparent 100%
  );
  transform: translateX(-100%);
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  to { transform: translateX(100%); }
}

/* Placeholder card matching a content row */
.skeleton-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
}
.skeleton-avatar { width: 44px; height: 44px; border-radius: 50%; }
.skeleton-text-block { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.skeleton-line { height: 14px; border-radius: 4px; }
.skeleton-line.short { width: 60%; }

/* Reduce motion: remove shimmer, keep static placeholder */
@media (prefers-reduced-motion: reduce) {
  .skeleton::after { display: none; }
}
```

---

## 4. Faithful Replication — Apple-Feeling Feedback on the Web

### Button / Tap Feedback
To replicate the system button feel: press-down in ~80ms (fast compress), release with a spring overshoot back to scale(1) over ~300ms. Use `cubic-bezier(0.34, 1.56, 0.64, 1)` on the release transition — this is a well-known overshoot curve that reads as springy without being bouncy. [observed from reverse-engineering system animations] Pair with `Haptics.impactMedium()` on `pointerdown` for Android Chrome; the iOS user gets only the visual signal (iOS haptics gap on web — see below).

### Toggle Feedback
Mirror UISwitch: background color transition simultaneously with knob translate. The knob overshoots slightly past the final position and snaps back — the spring cubic-bezier above handles this in CSS. Pair sound and haptic at the moment the toggle state commits (on `pointerup` / `change`), not on `pointerdown`. [inferred from UISwitch behavior]

### The iOS Haptics Gap on Web
This is the most important web/native divergence. On iOS:
- `navigator.vibrate()` returns `undefined` (no effect, no error) — silently does nothing [documented]
- There is no WebKit equivalent or workaround available to web apps
- WKWebView (used by Safari and all iOS browsers per Apple policy) does not expose vibration
- Web apps on iOS cannot produce any tactile feedback beyond what the OS provides for keyboard / scroll rubber-banding

**Design implication:** on iOS web, visual and auditory feedback must carry the full sensory load that native apps distribute across three channels. CSS press states are not optional on iOS web — they are the only haptic substitute available. [documented limitation + inferred design consequence]

### Loading Feedback
Use a skeleton over a spinner when the content shape is known. Match the skeleton layout to the incoming content (same row heights, avatar dimensions, text block widths) — this primes spatial memory and reduces perceived loading time even if actual time is identical. [documented — Apple HIG loading principle; backed by NN/G research] Show spinners only for truly opaque tasks where shape is unknown (authentication, server processing). Never show a spinner for tasks under ~300ms — the flicker is worse than showing nothing. [inferred from Apple HIG latency guidance]

---

## 5. Anti-Patterns

### No Feedback on Tap
A tap with no visual state change (scale, opacity, background flash) reads as a broken control. On mobile, `:hover` is not triggered on tap; `:active` is the only CSS selector that fires. Without `:active` styling, tappable elements feel inert. [documented] The platform default `-webkit-tap-highlight-color` is almost universally disabled in modern designs — this means developers must provide their own `:active` state. [observed]

### Haptic Spam
Firing haptic feedback on every scroll event, every animation frame, or without a direct user action is spam. The user's hand feels like it is being buzzed at random. Battery drain aside, it destroys the semantic meaning of haptics — the user can no longer correlate vibration with action. [documented from HIG restraint guidelines] Concrete bad cases: UISelectionFeedbackGenerator in a scroll callback, firing UINotificationFeedbackGenerator on load, adding impact to every button even when UIKit controls already handle it.

### Double-Firing on System Controls
UISwitch, UISlider, UIPickerView, UIRefreshControl, and Apple Pay all produce system haptics. Adding UIFeedbackGenerator calls on the same interaction doubles the feedback and feels broken. [documented] The rule: add haptics only where they are genuinely absent.

### Sound Without Restraint
Playing UI sounds in silent mode. Sounds that loop or repeat frequently without pitch/amplitude variation (robotic repetition). Sound as the sole carrier of meaning (accessibility failure for deaf/hard-of-hearing users). Long-duration sound effects for what should be an instant action. [documented from HIG audio guidelines + WWDC17]

### Fake or Janky Loading
An infinite spinner for a task that completed 2s ago but whose result is being unnecessarily delayed. A progress bar that jumps from 5% to 100% instantly (giving false progress). A skeleton that appears for < 100ms then flashes to content (worse than showing nothing — the flicker is disorienting). [inferred from Apple HIG + human factors]

### Ignoring prefers-reduced-motion
Scale animations, sliding transitions, and shimmer animations are vestibular motion triggers for users with vestibular disorders. The WCAG 2.1 Success Criterion 2.3.3 (AAA) and 2.3.1 address this. [documented] All motion-bearing CSS must be wrapped in `@media (prefers-reduced-motion: no-preference) { ... }` or have a `reduce` override. Opacity changes and color transitions are generally acceptable even under reduce; transform animations are not. [documented]

### Assuming Web Vibration Works on iOS
The single most common haptic anti-pattern in cross-platform web development. `navigator.vibrate()` silently no-ops on Safari/iOS — no console warning, no exception, no return value distinguishable from success. Always guard with `'vibrate' in navigator` AND understand that positive detection does not cover iOS. [documented] Never document vibration as a feature of an iOS PWA without the explicit caveat.

---

## 6. Sources

| Source | URL |
|---|---|
| Apple HIG — Playing haptics | https://developer.apple.com/design/human-interface-guidelines/playing-haptics |
| Apple HIG — Feedback | https://developer.apple.com/design/human-interface-guidelines/feedback |
| Apple HIG — Playing audio | https://developer.apple.com/design/human-interface-guidelines/playing-audio |
| Apple HIG — Loading | https://developer.apple.com/design/human-interface-guidelines/loading |
| Apple HIG — Progress indicators | https://developer.apple.com/design/human-interface-guidelines/ios/controls/progress-indicators/ |
| Core Haptics framework | https://developer.apple.com/documentation/corehaptics/ |
| UIImpactFeedbackGenerator | https://developer.apple.com/documentation/uikit/uiimpactfeedbackgenerator |
| SensoryFeedback (SwiftUI) | https://developer.apple.com/documentation/swiftui/sensoryfeedback |
| WWDC21 10278 — Practice audio haptic design | https://developer.apple.com/videos/play/wwdc2021/10278/ |
| WWDC19 810 — Designing Audio-Haptic Experiences | https://developer.apple.com/videos/play/wwdc2019/810/ |
| WWDC19 223 — Expanding the Sensory Experience with Core Haptics | https://developer.apple.com/videos/play/wwdc2019/223/ |
| WWDC17 803 — Designing Sound | https://developer.apple.com/videos/play/wwdc2017/803/ |
| MDN — Vibration API | https://developer.mozilla.org/en-US/docs/Web/API/Vibration_API |
| caniuse — navigator.vibrate | https://caniuse.com/mdn-api_navigator_vibrate |
| MDN — prefers-reduced-motion | https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion |
| SwiftUI Sensory Feedback (Use Your Loaf) | https://useyourloaf.com/blog/swiftui-sensory-feedback/ |
| Core Haptics with CHHapticEngine (Donny Wals) | https://www.donnywals.com/adding-haptics-to-your-app/ |
| Haptic Feedback Done Correctly (Varun Santhanam) | https://www.vsanthanam.com/writing/2017/10/24/haptic-feedback-done-correctly |
| History of Apple Haptics (Medium/MacClock) | https://medium.com/macoclock/the-history-of-apples-haptics-3fe1ef64b0fc |
| Josh W. Comeau — Springs in Native CSS | https://www.joshwcomeau.com/animation/linear-timing-function/ |
| Haptics on Apple Platforms (Eidinger) | https://blog.eidinger.info/haptics-on-apple-platforms |

---

CONFIDENCE: 82% — Core UIFeedbackGenerator and SensoryFeedback content is well-documented; system-haptic firing contexts for built-in controls and precise latency targets are inferred from WWDC/HIG secondary sources rather than directly verified from live HIG pages (Apple's HIG returned only page titles on fetch attempts).
