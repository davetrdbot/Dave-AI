# Accessibility & Inclusive Design — Apple's Approach
Scope: Apple's accessibility ethos and the concrete design constraints it imposes on layout, color, motion, materials, and typography — plus the web mapping (WCAG 2.2 AA + CSS preference queries).

---

## Principles

### Accessibility as a core design value, not a retrofit
Apple frames accessibility as a founding obligation, not a compliance checkbox. [documented] The company states it has designed with disability in mind for four decades, and the HIG opens its accessibility section with language that makes clear every interface element — not just "accessible variants" — must work for every user. [documented] The implication for designers: there is no separate "accessible mode." The primary design IS the accessible design.

### The curb-cut effect: edges inform the mainstream
Features initially targeted at disability become universal infrastructure. [observed] Voice Control grew from hands-free access for motor-impaired users into Siri and the ambient-computing baseline. Dynamic Type's reflow logic became the responsive layout foundation for all iOS apps. The captions subsystem powers live sports overlays. Designing for the hardest use case routinely produces the best design for the average case. [documented — WWDC25 session 316]

### The POUR contract (Perceivable / Operable / Understandable / Robust)
WCAG's four principles — and Apple's HIG is architecturally aligned with them. [documented] Perceivable = every sensory channel is covered (vision → VoiceOver, hearing → captions, touch → haptics). Operable = every interaction is reachable without the primary modality (touch → Switch Control, voice → Voice Control, pointer → keyboard). Understandable = language is clear, state is announced, errors are described. Robust = output works with current and future assistive technologies.

### The inclusion-gap model (WWDC25)
Disability is not a fixed body state — it is a gap between what a person can do and what the environment demands. [documented] That gap is situational (one hand occupied, bright sunlight, noisy environment) as much as permanent. Building to close the gap for permanent impairment simultaneously closes it for the situational case. The design directive: support multiple sensory paths, enable customization, adopt the platform's accessibility APIs, and document known inclusion debt for iteration. [documented — WWDC25 session 316]

### Design for the five disability spectrums
Vision (legal blindness → full sight) / Hearing (deaf → full hearing) / Motor (no hand control → full dexterity) / Speech (non-verbal → full articulation) / Cognitive (varying processing ability). [documented — WWDC25] Each spectrum requires a distinct affordance layer; none can be ignored even if the primary audience appears fully able-bodied.

---

## Apple Specifics

### VoiceOver — the semantic contract
VoiceOver is a gesture-based screen reader built into every Apple platform. [documented] It imposes a hard semantic contract on every UI element.

**What designers must provide per element:**
- **Accessibility label** — the spoken name. Must be concise, in the user's language, and must not duplicate the hint. An icon button needs an explicit label; "heart.fill" is not a label. [documented]
- **Accessibility hint** — optional second sentence describing the result of the action ("Deletes this item permanently"). [documented]
- **Accessibility traits** — the role/state vocabulary VoiceOver announces: `.isButton`, `.isHeader`, `.isLink`, `.isSelected`, `.isImage`, `.isStaticText`, `.playsSound`, `.updatesFrequently`, `.startsMediaSession`, `.allowsDirectInteraction`. [documented] Incorrect traits cause VoiceOver to misrepresent the control.
- **Accessibility value** — current state for controls with a range or variable state (slider position, star rating, toggle on/off). [documented]
- **Element grouping** — related visuals (icon + label + badge) must be collapsed into one element with a combined label using `.accessibilityElement(children: .combine/.ignore)`, so VoiceOver does not read three disconnected fragments. [documented]
- **Reading order** — must match visual reading order; in complex custom layouts, the order must be manually specified. [documented]
- **Custom actions** — complex swipe gestures (delete, archive, reply) must be exposed as named custom actions visible in the Actions rotor. [documented]
- **Dynamic updates** — when content or layout changes on-screen without a navigation event, the accessibility tree must be explicitly notified (`.accessibilityPostNotification`, `UIAccessibility.post(notification:argument:)`). [documented]

**The Rotor** — a VoiceOver-specific navigation wheel. System rotors include Headings, Links, Form Controls, Tables, Landmarks. Designers can add custom rotors for app-specific navigation (e.g., jump between unread messages). [documented — WWDC20] Heading hierarchy (`.isHeader` trait) is what makes the Headings rotor useful; skip levels or omit headers and the rotor is useless.

**Design constraint imposed:** Every screen needs a written accessibility spec that is as formal as the visual spec — listing labels, traits, groupings, custom actions, and reading order. VoiceOver testing is a first-class QA gate, not a post-ship audit. [documented — Apple HIG]

---

### Dynamic Type — the layout reflow imperative
Dynamic Type is the system-wide user font-size preference. [documented] iOS scales body text from ~17pt (default) up to over 50pt at the largest Accessibility size. Apps must reflow layout, not truncate. [documented]

**The five key Dynamic Type sizes:**
- Default (xSmall → Large, ~11–17pt for body)
- Accessibility sizes (5 levels: xLarge → xxxLarge extra-accessibility, up to ~53pt)
- iOS requires apps to scale primary text to at least **200% of default**; watchOS to at least **140%**. [documented — App Store Connect Accessibility Evaluation]

**Design constraints imposed:**
- **No fixed-height text containers.** Every container holding user-facing text must grow vertically. [documented]
- **Horizontal → vertical layout pivots.** HStacks of label+value pairs must flip to VStacks at Accessibility sizes. The HIG shows Apple Mail reflowing sender/date from horizontal to vertical at large sizes. [documented]
- **No truncation of primary content.** Secondary elements (navigation labels, tab-bar titles) may stay fixed-size; primary content must not be cut off. [documented]
- **SF Symbols scale with Dynamic Type automatically** when using the font-based symbol sizing API. Custom icons must be provided in all relevant sizes or must use the API. [documented]
- **Avoid light font weights.** At large sizes, light weights lose legibility. Use Regular or Medium as the minimum for body content. [documented — Apple HIG]
- **Avoid full justification and all-caps** for extended passages — both degrade readability at scale. [documented — Apple HIG]

**The upstream design implication:** Dynamic Type is WHY Apple's layout philosophy relies on flexible Stacks and adaptive VStack/HStack pivots rather than fixed-frame grids. The grid must survive being expanded 3×. [inferred from documented constraints]

---

### Reduce Motion — the animation opt-out layer
Users enable Reduce Motion in Settings → Accessibility → Motion. [documented] The system exposes this as `UIAccessibility.isReduceMotionEnabled` (UIKit), `@Environment(\.accessibilityReduceMotion)` (SwiftUI), and `prefers-reduced-motion` on the web.

**Design constraints imposed:**
- All non-essential animations must be suppressible. [documented]
- Transition animations that cross large spatial distances (slide-in, zoom, parallax) are the highest-risk category; they trigger vestibular disorders in a measurable user population. [documented — WCAG 2.1 SC 2.3.3]
- The replacement is a cross-fade, opacity change, or instantaneous cut — not the absence of feedback. [documented — Apple HIG]
- The HIG explicitly calls out: "avoid animations unless they're essential for the experience." [documented]
- Designers must specify the non-animated alternative for every animated transition in the spec. [documented]

**The upstream design implication:** Reduce Motion is WHY the Apple motion design language gravitates toward opacity fades (not slides) as the safe default animation. Fades survive Reduce Motion with only a duration change; translates do not. [inferred]

---

### Reduce Transparency / Increase Contrast — the materials fallback
Users enable these separately in Settings → Accessibility → Display & Text Size.

**Reduce Transparency:**
- Blurred/translucent materials (UIVisualEffectView, SwiftUI materials, backdrop-filter) must degrade to opaque, solid-color surfaces. [documented]
- The replacement color must be chosen specifically for the opaque context — it cannot be the same RGBA value with alpha removed, because the visual result will differ from the blurred state. [documented — Apple HIG]
- System materials handle this automatically; custom blur implementations must respond to `UIAccessibility.isReduceTransparencyEnabled`. [documented]

**Increase Contrast:**
- When enabled, system colors shift to higher-contrast alternatives. [documented]
- Apps using semantic system colors (`.label`, `.secondaryLabel`, `.systemBackground`) inherit this automatically. [documented]
- Custom colors must provide alternate high-contrast asset catalog variants or respond to `UIAccessibility.isDarkerSystemColorsEnabled`. [documented]

**Design constraint imposed:** Every material/glass surface in the design must have an opaque fallback documented alongside it. The fallback is a primary deliverable, not an afterthought. This is WHY Apple's design system distinguishes "material" (layered, context-sensitive) from "tint" (flat, always-available) — the tint IS the fallback. [inferred, consistent with documented system behavior]

---

### Color & Contrast — the non-color-alone rule
**Minimum contrast ratios (WCAG AA, mirrored in Apple HIG):** [documented]
- Normal text (< 18pt regular or < 14pt bold): **4.5:1** against background
- Large text (≥ 18pt regular or ≥ 14pt bold): **3:1**
- Non-text UI components (icons, borders, input outlines): **3:1**

**Color independence rule:** Color must never be the sole carrier of meaning. [documented] A red error state must also have an icon, a text label, or a border change. A selected tab must use position + a text weight change + a tint, not tint alone. [documented — Apple HIG]

`@Environment(\.accessibilityDifferentiateWithoutColor)` in SwiftUI exposes the user's "Differentiate without Color" setting, enabling apps to show an icon alongside color-only signals. [documented]

---

### Touch target — the 44pt minimum
Apple mandates a minimum **44×44 pt** (logical pixels, not screen pixels) hit area for every interactive element. [documented — Apple HIG] This equates to approximately 9mm × 9mm on most device densities — the approximate width of an adult fingertip.

**Design constraints imposed:**
- Small visual elements (icons, checkmarks, disclosure arrows) must have invisible touch-target padding extending to 44pt. [documented]
- WCAG 2.2 AA (SC 2.5.8) sets a 24×24 CSS pixel minimum for the web; 44pt is the higher, stricter Apple platform standard. [documented]
- Secondary actions in swipe rows still require 44pt targets. [documented]

---

### Switch Control, AssistiveTouch, Voice Control
- **Switch Control** — device operated via external switches (one-to-five switches) scanning through elements in sequence. [documented] Every custom gesture-only action is invisible to Switch Control users unless exposed as an accessibility action.
- **AssistiveTouch** — a floating on-screen menu that replaces hardware buttons and gestures. [documented] Pinch/swipe gestures used in custom UIs must have tap-accessible alternatives.
- **Voice Control** — device operated by spoken commands ("tap Submit", "scroll down"). [documented] Elements reachable by Voice Control must have correct labels matching what a user would say. Unlabeled elements get a numbered grid overlay — functional but poor UX.

---

### Captions & Audio Descriptions
- All video with meaningful dialogue or audio must carry closed captions. [documented — Apple HIG, WCAG 1.2.2]
- Pre-recorded video must have audio descriptions for visual information not in the audio track. [documented — WCAG 1.2.5 AA]
- Live audio requires live captions (WCAG 1.2.4 AA). [documented]
- Apple's Live Captions (on-device, real-time) covers system-level calls and media; in-app video requires developer implementation. [documented]

---

### Bold Text, Display Accommodations
- **Bold Text** setting increases font weight across the system. Apps using SF Pro or system text styles inherit this; custom fonts must respond manually. [documented]
- **Larger Text accessibility sizes** (5 levels above the standard Large) are the primary concern for layout reflow — the standard Dynamic Type range is rarely tested but the Accessibility sizes are the true stress test. [documented]
- **Invert Colors / Smart Invert** — Smart Invert skips images, video, and apps that have opted out. Apps should mark media elements to prevent double-inversion. [documented]

---

## Recipes

### 1. Semantic HTML + ARIA accessible toggle button (web)

```html
<!-- Toggle button: label stays constant; state communicated via aria-pressed -->
<button
  type="button"
  aria-pressed="false"
  class="mute-btn"
  id="muteBtn"
>
  Mute
</button>

<script>
  const btn = document.getElementById('muteBtn');
  btn.addEventListener('click', () => {
    const pressed = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!pressed));
    // update underlying state
  });
</script>

<style>
/* Do NOT change the label on toggle — change aria-pressed only */
.mute-btn[aria-pressed="true"] {
  background: var(--color-active);
}
</style>
```

---

### 2. Accessible modal dialog (web)

```html
<button type="button" id="openModal">Open Settings</button>

<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="modalTitle"
  aria-describedby="modalDesc"
  id="settingsModal"
  hidden
>
  <h2 id="modalTitle">Display Settings</h2>
  <p id="modalDesc">Adjust font size and color theme.</p>

  <!-- focusable content -->
  <label for="fontSize">Font size</label>
  <input id="fontSize" type="range" min="12" max="32" value="16" />

  <button type="button" id="closeModal">Close</button>
</div>

<script>
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('openModal');
  const closeBtn = document.getElementById('closeModal');

  // All focusable elements inside the dialog
  const focusable = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

  function openModal() {
    modal.removeAttribute('hidden');
    // Move focus to first focusable element
    modal.querySelector(focusable).focus();
    trapFocus(modal);
  }

  function closeModal() {
    modal.setAttribute('hidden', '');
    openBtn.focus(); // Return focus to trigger
  }

  function trapFocus(container) {
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const focusables = [...container.querySelectorAll(focusable)];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
  }

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);

  // Escape key closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) closeModal();
  });
</script>
```

---

### 3. `prefers-reduced-motion` — CSS + JS

```css
/* Default: motion on */
.card {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.card:hover {
  transform: scale(1.03);
}

/* Reduced motion: keep opacity fade (non-spatial), kill transform */
@media (prefers-reduced-motion: reduce) {
  .card {
    transition: opacity 0.15s ease;
  }
  .card:hover {
    transform: none;
  }
}

/* Nuclear option for low-stakes decorative motion only */
@media (prefers-reduced-motion: reduce) {
  .decorative-animation {
    animation: none;
    transition: none;
  }
}

/* Conditional animation load — skip the CSS file entirely */
/* <link rel="stylesheet" href="animations.css"
         media="(prefers-reduced-motion: no-preference)"> */
```

```javascript
// JS-driven animations (GSAP, canvas, etc.) must check this
const prefersReducedMotion =
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateEntry(el) {
  if (prefersReducedMotion) {
    el.style.opacity = '1'; // instant reveal
    return;
  }
  // full keyframe animation
  el.animate([{ opacity: 0, transform: 'translateY(16px)' },
              { opacity: 1, transform: 'translateY(0)' }],
             { duration: 400, easing: 'ease-out', fill: 'forwards' });
}

// React to live changes (user toggling the setting mid-session)
window.matchMedia('(prefers-reduced-motion: reduce)')
  .addEventListener('change', ({ matches }) => {
    document.body.classList.toggle('reduced-motion', matches);
  });
```

---

### 4. `prefers-contrast` — CSS

```css
/* Base: standard Apple-glass card with material */
.card {
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: #1d1d1f;
}

/* Increase Contrast: drop translucency, boost borders */
@media (prefers-contrast: more) {
  .card {
    background: #ffffff;        /* opaque — matches Reduce Transparency fallback */
    backdrop-filter: none;
    border: 2px solid #000000;
    color: #000000;
  }
}

/* Forced colors (Windows High Contrast, Edge) */
@media (forced-colors: active) {
  .card {
    background: Canvas;
    color: CanvasText;
    border: 2px solid ButtonText;
  }
}
```

---

### 5. `:focus-visible` ring — CSS

```css
/* Remove the default browser outline for mouse users,
   keep it for keyboard users */
:focus:not(:focus-visible) {
  outline: none;
}

/* Two-tone ring: visible on any background color */
:focus-visible {
  outline: 3px solid #0a72e0;        /* primary brand blue */
  outline-offset: 3px;
  border-radius: 4px;               /* match element rounding */
  /* Second ring via box-shadow for light backgrounds */
  box-shadow: 0 0 0 5px rgba(255, 255, 255, 0.9);
}

/* High-contrast mode fallback — outline is visible; box-shadow is not */
@media (forced-colors: active) {
  :focus-visible {
    outline: 3px solid Highlight;
    box-shadow: none;
  }
}
```

> Note: `box-shadow` is invisible in Windows High Contrast Mode. The `outline` is the load-bearing a11y property; `box-shadow` is decorative contrast enhancement only. [documented — MDN, WebAIM]

---

### 6. `prefers-reduced-transparency` — CSS

```css
/* Standard glass material */
.sidebar {
  background: rgba(248, 248, 248, 0.85);
  backdrop-filter: saturate(180%) blur(20px);
}

/* When user has enabled Reduce Transparency */
@media (prefers-reduced-transparency: reduce) {
  .sidebar {
    background: #f5f5f7;            /* solid — pick a real color, not just alpha=1 */
    backdrop-filter: none;
  }
}
```

---

### 7. SwiftUI accessibility modifiers

```swift
// ── Labels + hints ──────────────────────────────────────────────
Button(action: toggleFavorite) {
    Image(systemName: isFavorite ? "heart.fill" : "heart")
}
.accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
.accessibilityHint("Double-tap to toggle") // omit if obvious

// ── Traits ──────────────────────────────────────────────────────
Text("Recent Orders")
    .font(.headline)
    .accessibilityAddTraits(.isHeader) // rotor-navigable heading

CardView(item: item)
    .onTapGesture { select(item) }
    .accessibilityAddTraits(.isButton) // custom tap target declared as button

// ── Grouping visual clusters ────────────────────────────────────
HStack {
    Image(systemName: "envelope.fill").accessibilityHidden(true)
    Text("3 unread messages")
}
.accessibilityElement(children: .ignore)
.accessibilityLabel("3 unread messages")

// ── Value for range/state controls ─────────────────────────────
StarRating(rating: 4, max: 5)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Rating")
    .accessibilityValue("4 out of 5 stars")

// ── Custom actions (appear in VoiceOver Actions rotor) ──────────
MessageRow(message: msg)
    .accessibilityElement(children: .combine)
    .accessibilityAction(named: "Mark as read") { markRead(msg) }
    .accessibilityAction(named: "Delete") { delete(msg) }

// ── Dynamic Type layout pivot ───────────────────────────────────
struct AdaptiveRow<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let content: () -> Content

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, content: content)
        } else {
            HStack(content: content)
        }
    }
}

// ── Reduce Motion ───────────────────────────────────────────────
struct PulsingBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        Circle().fill(.blue)
            .scaleEffect(pulsing && !reduceMotion ? 1.4 : 1.0)
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 1).repeatForever(),
                value: pulsing
            )
            .onAppear { pulsing = true }
    }
}

// ── Differentiate without Color ─────────────────────────────────
struct StatusBadge: View {
    @Environment(\.accessibilityDifferentiateWithoutColor) private var noColor
    let status: Status

    var body: some View {
        HStack(spacing: 4) {
            if noColor { Image(systemName: status.iconName) }
            Text(status.label)
        }
        .foregroundStyle(status.color)
    }
}

// ── Programmatic focus (e.g., move focus to error message) ──────
struct LoginView: View {
    @State private var errorMessage: String?
    @AccessibilityFocusState private var errorFocused: Bool

    var body: some View {
        VStack {
            if let msg = errorMessage {
                Text(msg).foregroundStyle(.red)
                    .accessibilityFocused($errorFocused)
            }
            Button("Sign In") { validate() }
        }
    }

    private func validate() {
        errorMessage = "Invalid email address"
        errorFocused = true // VoiceOver cursor jumps to error
    }
}

// ── Decorative element hidden from assistive tech ───────────────
Image("hero-bg")
    .accessibilityHidden(true)
```

---

### 8. A11y review checklist

```
PERCEIVABLE
[ ] All images have meaningful alt text; decorative images are aria-hidden / accessibilityHidden
[ ] All video has captions; pre-recorded has audio descriptions
[ ] Color contrast ≥ 4.5:1 for body text; ≥ 3:1 for large text and UI components
[ ] Information is NOT conveyed by color alone (error states have icons/text)
[ ] Text can scale to 200% (iOS) / 140% (watchOS) without horizontal scrolling or truncation
[ ] Bold Text and Increase Contrast settings tested

OPERABLE
[ ] All interactions reachable by keyboard (Tab/Shift+Tab, Enter, Space, arrow keys)
[ ] :focus-visible ring is visible on all interactive elements
[ ] Focus is not obscured by sticky headers/footers (WCAG 2.4.11)
[ ] Focus order matches visual reading order
[ ] No keyboard traps (except intentional modal traps with Escape-out)
[ ] All drag-and-drop has a single-pointer alternative (WCAG 2.5.7)
[ ] Touch targets ≥ 44×44pt (Apple) / 24×24 CSS px (WCAG 2.5.8)
[ ] Custom gestures have VoiceOver custom-action equivalents
[ ] Session timeouts warn users in advance and allow extension

UNDERSTANDABLE
[ ] Form inputs have visible, persistent labels (not placeholder-only)
[ ] Error messages identify the field and describe the fix
[ ] Dynamic content updates are announced to VoiceOver / live regions
[ ] Reading order is logical for screen reader users
[ ] Language attribute is set on <html> and on any inline foreign-language passages

ROBUST
[ ] VoiceOver tested on device (iOS) and macOS
[ ] Switch Control tested for custom gesture features
[ ] Voice Control tested: spoken element names match visible labels
[ ] Semantic HTML used (button, nav, main, aside, h1–h6, lists)
[ ] ARIA roles/states/properties validated (no role conflicts, no orphan aria-labelledby targets)
[ ] Tested with prefers-reduced-motion: reduce enabled
[ ] Tested with prefers-contrast: more enabled
[ ] Tested with prefers-reduced-transparency: reduce enabled
[ ] Tested with Dynamic Type at xxxLarge Accessibility size
[ ] Automated scan run (axe, WAVE) as a baseline — catches ~40% of issues
```

---

## Faithful Replication — Building to Apple's Accessibility Bar on the Web

Apple's native apps operate under a dual standard: the platform accessibility APIs (UIAccessibility, SwiftUI environment values) AND the visual design system respecting all user preference settings. Replicating this on the web requires layering WCAG 2.2 AA with an Apple-specific preference-respect layer.

### Layer 1: WCAG 2.2 AA baseline [documented]

| Criterion | Requirement | Web Implementation |
|---|---|---|
| 1.1.1 Non-text Content | All images have alt | `alt=""` (decorative) or descriptive alt |
| 1.3.1 Info & Relationships | Structure is semantic | `<h1>–<h6>`, `<nav>`, `<main>`, `<ul>/<li>` |
| 1.4.3 Contrast (Minimum) | 4.5:1 text, 3:1 large | Audit with axe/Stark at design phase |
| 1.4.11 Non-text Contrast | 3:1 for UI components | Borders, icons, focus rings |
| 2.1.1 Keyboard | All functionality keyboard-accessible | No pointer-only event handlers |
| 2.4.7 Focus Visible | Focus indicator visible | `:focus-visible` ring; never `outline: none` globally |
| 2.4.11 Focus Not Obscured | Focus not fully hidden | `scroll-padding-top` for sticky bars |
| 2.5.7 Dragging Movements | Drag has single-pointer alt | Browse buttons, +/- controls |
| 2.5.8 Target Size | 24×24 CSS px minimum | Prefer 44px for parity with Apple native |
| 3.3.2 Labels or Instructions | Form inputs labeled | `<label for>` or `aria-label`; never placeholder-only |
| 4.1.2 Name, Role, Value | Custom controls announced | Semantic HTML first; ARIA only when HTML is insufficient |
| 4.1.3 Status Messages | Async messages announced | `role="status"` or `role="alert"`, `aria-live` regions |

### Layer 2: Apple-specific preference-respect [documented]

```
OS Setting                  → CSS/JS Hook                   → Design Fallback Required
─────────────────────────────────────────────────────────────────────────────────────
Reduce Motion               → prefers-reduced-motion: reduce → Cross-fade instead of slide
Increase Contrast           → prefers-contrast: more         → Heavier borders, opaque surfaces
Reduce Transparency         → prefers-reduced-transparency   → Solid background color (not rgba ghost)
Dark Mode                   → prefers-color-scheme: dark     → Full dark palette (not just inverted)
Forced Colors (Windows)     → forced-colors: active          → Canvas/CanvasText system colors
```

### Layer 3: Semantic structure discipline [documented]
- Use native HTML elements before reaching for ARIA. `<button>` is always preferable to `<div role="button">` because it brings keyboard, focus, and activation behavior for free.
- Accessible name computation order: `aria-labelledby` > `aria-label` > `<label for>` > element content > `title`. [documented — ARIA spec]
- `aria-describedby` supplements the label with a hint — it does not replace it.
- Live regions (`aria-live="polite"` for updates, `aria-live="assertive"` for urgent errors) mirror VoiceOver's UIAccessibility notification system.

### Layer 4: The Apple-glass material accessibility constraint [inferred, consistent with documented behavior]
Glassmorphism (backdrop-filter blur, translucent fills) is Apple's primary surface language. On the web, every glass surface must have a tested `prefers-contrast: more` and `prefers-reduced-transparency: reduce` branch. A card that renders as `rgba(255,255,255,0.72)` with blur should render as `#ffffff` with `border: 2px solid #000` under high-contrast. This is not optional for WCAG conformance; it is explicitly required by 1.4.3 (contrast) because translucent surfaces fail contrast measurement in the blurred state unless the underlying content is controlled.

---

## Anti-Patterns

**Color as sole meaning carrier** [documented]
`color: red` on a validation error, with no icon and no text label. Fails WCAG 1.4.1. Users with red-green color blindness (~8% of males) cannot distinguish it from success green. Fix: always pair color with an icon (❌/✓) or text ("Error:").

**Fixed font sizes in CSS** [documented]
`font-size: 14px` ignores the user's OS text-size preference and Dynamic Type completely. Use `rem` units (relative to root, which respects browser zoom), or `em` within components. Never `px` for body text.

**Motion with no opt-out** [documented]
Parallax scrolling, full-page slide transitions, or looping background video with no `prefers-reduced-motion` branch. Triggers vestibular disorders. Is also a WCAG 2.3.3 (AAA) issue and a WCAG 2.2 AA concern for animations triggered by interaction (SC 2.3.3 is AAA but 2.2 tightened focus-motion expectations).

**Opaque-only-on-blur text on glass** [documented — inferred failure mode]
Text placed over a blurred glass card where legibility depends on the blur scattering the background. When blur is removed (Reduce Transparency) the text may fail contrast. Test both states explicitly. The text color must pass 4.5:1 against the solid fallback background, not just the blurred composite.

**Div soup without semantics** [documented]
`<div onclick="...">` for buttons, `<div>` for navigation, no heading hierarchy. Breaks VoiceOver rotor, Screen Reader reading order, Voice Control element naming, and keyboard navigation simultaneously. Every structural element should be a semantic HTML element first.

**Focus traps outside modals** [documented]
Trapping Tab within a dropdown menu or flyout panel without providing Escape-to-close. A modal dialog intentionally traps focus — but must release it on Escape and when dismissed. Any other element that traps focus is a WCAG 2.1.2 failure.

**Missing or generic accessible names** [documented]
`aria-label="button"`, `aria-label="icon"`, or no label on icon-only buttons. Voice Control users cannot say "tap button" to target a unique element. VoiceOver reads "button" with no context. Every interactive element's accessible name must describe its specific function.

**Placeholder as label** [documented]
`<input placeholder="Email address">` with no `<label>`. Placeholder disappears on input, fails 3:1 contrast (most browsers render it at ~40% opacity), and is not reliably announced by all screen readers. Always use a persistent `<label>`.

**Assuming disability is binary** [documented — WWDC25]
Designing only for "disabled" vs. "not disabled" misses the situational spectrum: one hand occupied, bright outdoor glare, noisy environment, temporary injury. The resulting design is under-constrained for the average user in non-ideal conditions.

**Testing only with automation** [documented]
Automated scanners catch approximately 40% of WCAG issues. [documented — AllAccessible] The remaining 60% — meaningful alt text, logical reading order, correct ARIA semantics, keyboard trap detection, focus management — require manual testing with actual assistive technologies (VoiceOver on iOS/macOS, NVDA on Windows).

---

## Sources

- [Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) — primary reference for all Apple-platform requirements
- [Apple HIG: VoiceOver](https://developer.apple.com/design/human-interface-guidelines/voiceover)
- [Apple Developer: App Store Connect — Larger Text Evaluation Criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/larger-text-evaluation-criteria/)
- [WWDC25 Session 316: Principles of inclusive app design](https://developer.apple.com/videos/play/wwdc2025/316/)
- [WWDC24: Catch up on accessibility in SwiftUI](https://developer.apple.com/videos/play/wwdc2024/10073/)
- [WWDC20: VoiceOver efficiency with custom rotors](https://developer.apple.com/videos/play/wwdc2020/10116/)
- [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C WAI: What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)
- [W3C WAI-ARIA Authoring Practices Guide — Button Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
- [MDN: Using media queries for accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Using_for_accessibility)
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)
- [web.dev: prefers-reduced-motion — sometimes less movement is more](https://web.dev/articles/prefers-reduced-motion)
- [SwiftUI Accessibility Complete Guide — Swift Crafted](https://swiftcrafted.dev/article/swiftui-accessibility-complete-guide-voiceover-dynamic-type-inclusive-design)
- [SwiftUI Accessibility Traits — Mobile A11y](https://mobilea11y.com/guides/swiftui/swiftui-traits/)
- [AllAccessible: WCAG 2.2 Complete Guide 2025](https://www.allaccessible.org/blog/wcag-22-complete-guide-2025)
- [WebAIM: Contrast and Color Accessibility](https://webaim.org/articles/contrast/)
- [DBTA: Apple WWDC 2025 Accessibility Features](https://www.dbta.com/Columns/Emerging-Technologies/The-Future-of-Work-Is-Accessible-What-Apples-WWDC-2025-Accessibility-Features-Mean-for-an-Aging-Digital-Workforce-169912.aspx)

---

CONFIDENCE: 88% — Core Apple HIG requirements and WCAG 2.2 criteria are well-documented; some design-implication inferences (WHY certain layout patterns exist as a consequence of accessibility constraints) are labeled [inferred] and are consistent with documented behavior but not explicitly stated as causal in primary sources.
