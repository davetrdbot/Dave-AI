# iOS / iPadOS Design Reference

Scope: Surface anatomy, navigation patterns, sheet system, iOS 26 Liquid Glass era — with metrics, web analogs, and copy-paste recipes.

---

## Principles

### Thumb-reach first
The entire iOS control grammar is built around the palm-in-hand grip. Bottom tab bars, bottom toolbars, floating glass bars — all primary actions live within the lower 40% of the screen, reachable without shifting the grip. Top-anchored controls are reserved for destructive or rare actions that benefit from the friction of a long reach. [documented — Apple HIG "Layout" guidance]

### Content-first, chrome-second
Navigation chrome dims, minimizes, or goes translucent on scroll. The rule: content deserves full attention; chrome is a utility layer that appears when summoned and retreats when not needed. Liquid Glass (iOS 26) formalizes this as a material contract — glass is exclusively for the navigation layer that floats *above* app content; lists, tables, and media never wear glass. [documented — Apple developer documentation on Liquid Glass]

### Bottom-anchored, edge-to-edge
Safe-area insets exist precisely to push content away from the home indicator and Dynamic Island. Every layout must respect `safeAreaInsets` (SwiftUI) or `UIView.safeAreaLayoutGuide` (UIKit). On web, use `env(safe-area-inset-bottom)` in CSS. Bars that ignore this look broken immediately on physical devices. [documented — iOS HIG Layout]

### Predictable affordances
Tabs stay enabled even when the destination is temporarily unavailable — removing or disabling a tab breaks the user's mental model of the app's topology. Navigation hierarchies are stack-based and reversible with a back gesture or button. Sheets confirm destructive actions with an `.alert` or action sheet before dismissal. [documented — Apple HIG Tab Bars, Navigation]

### Adaptive continuity
The same screen layout should degrade gracefully from an iPad in Stage Manager down to an iPhone SE. Using `NavigationSplitView` and `NavigationStack` with dynamic column counts handles this without branching code. Avoid hardcoding widths; use `GeometryReader` or `containerRelativeFrame`. [documented — Apple HIG Layout, WWDC sessions]

---

## Apple Specifics

### Design era timeline
- **2007–2012 (Skeuomorphic)**: Real-world textures (leather, linen, stitching). Visually dense. Applications mimicked physical objects.
- **2013 (iOS 7 — "Flat")**: Jony Ive redesign. Transparency and blur (vibrancy materials), thin type, white space, geometric icons. The spring-loaded navigation model (push/pop, modal sheets) codified.
- **2014–2024 (Refinement)**: SF Pro typeface (2015), Dynamic Type, SF Symbols, large titles (iOS 11), rounded system font, dark mode (iOS 13), SwiftUI (2019), widgets (iOS 14), sheet detents (iOS 16).
- **2025–present (iOS 26 — Liquid Glass)**: Most significant visual overhaul since iOS 7. Translucent, refracting glass material replaces opaque bars. Floating pill-shaped tab bars. Clock merges with wallpaper. Metal-accelerated real-time rendering. [documented — Apple Newsroom June 2025]

---

### Home Screen

**Icon grid** [documented]
- iPhone: 4×6 grid of app icons (24 icons per page)
- Icon tap target: 60×60 pt display size; rendered at 180×180 px (@3x)
- Minimum spacing between icons: 12 pt
- iOS 26: icons gain multi-layer Liquid Glass construction — foreground, mid-ground, background — with specular highlights that shift as the device tilts. Users can choose Light, Dark, Clear (nearly transparent), or Tinted icon modes.

**Widget sizes (iPhone, approximate points)** [documented — WidgetKit, community measurements]

| Size | Grid cells | Approximate point dimensions |
|------|-----------|-------------------------------|
| Small | 2×2 | ~169 × 169 pt |
| Medium | 4×2 | ~360 × 169 pt |
| Large | 4×4 | ~360 × 376 pt |
| Extra-large | iPad only | ~715 × 376 pt (varies by model) |

Exact values vary by device screen size; never hardcode — always use WidgetKit's `CGSize` from `TimelineEntry.context.displaySize` at runtime.

**App Library** [documented]
- Swipe past the final Home Screen page (or swipe left from lock screen) to reach the App Library.
- Layout: auto-categorized folders in a 2×2 icon-cluster format, with the fourth cluster showing a 2×2 micro-grid of overflow apps.
- Search field at top triggers an alphabetical A–Z list of all apps.
- iOS 26: App Library adopts the same frosted Liquid Glass appearance as folders, dynamically tinted by the current wallpaper.

---

### Lock Screen

**Anatomy** [documented]
- Status bar (top): time, carrier, battery — 54 pt tall on Dynamic Island devices [observed — community measurements on iPhone 15/16]
- **Clock**: center-dominant large numeral display, ~96 pt font. iOS 26 Liquid Glass clock: rendered in translucent glass material, dynamically repositions around wallpaper subjects. Users can choose Glass or Solid clock styles, adjust weight and color.
- **Depth Effect / Spatial Scene**: if the wallpaper has a clear subject, the clock layers *behind* the subject (3D parallax). Tilting the device shifts layers, driven by gyroscope. Requires iPhone 12+ [documented — Apple Support iOS 26]
- Lock Screen widget row (below clock): up to 4 small widgets or 2 medium. Added iOS 16.
- Notification stack: iOS 16+ stacks notifications in a compact pile at screen bottom; tap to expand. iOS 26 notifications use frosted glass variant.
- Bottom controls: flashlight + camera (or customized controls in iOS 18+) in circular Liquid Glass capsule buttons. [documented]

**Live Activities** [documented]
- Appear on Lock Screen as expanded cards (full width) replacing the notification stack top.
- On Dynamic Island (iPhone 14 Pro+): persistent compact view lives in the pill cutout at the top; long-press to expand into a fullscreen card overlay.
- Dynamic Island has two zones: leading (left of pill) and trailing (right of pill) for compact content, plus a center expanded state.

---

### Control Center

**Pre-iOS 26**: Full-screen overlay with fixed grid of rounded-rectangle cards. Swipe down from top-right corner (Face ID devices) or swipe up from bottom (Touch ID). [documented]

**iOS 26 redesign** [documented]
- Cards adopt Liquid Glass frosted appearance; background shows blurred wallpaper beneath.
- Multi-page layout: swipe up/down to reveal additional control pages.
- Customization extended — users can reorganize controls across pages.
- Early betas were so translucent buttons were near-unreadable; Apple tuned frosting through four developer betas to balance aesthetics and legibility.
- Minimum contrast requirement: 4.5:1 (WCAG AA) must be maintained against any underlying content. [documented — accessibility guidance]

---

### Status Bar and Dynamic Island

**Status bar heights** [observed — community measurements, Figma iOS guides]

| Device type | Status bar height (pt) | Top safe area inset (pt) |
|-------------|------------------------|--------------------------|
| iPhone SE (3rd gen, no notch) | 20 pt | 20 pt |
| iPhone with notch (12, 13, mini) | 44 pt | 44 pt |
| iPhone with Dynamic Island (14 Pro–16 Pro Max) | 54 pt | 59 pt |
| iPad (no notch) | 20 pt | 20 pt |
| iPad Pro (with Face ID) | 24 pt | 24 pt |

Never hardcode these — query them at runtime via `UIApplication.shared.connectedScenes`, `window.safeAreaInsets.top`, or in SwiftUI via `.safeAreaInset`.

**Dynamic Island behavioral states** [documented]
- **Minimal**: single small indicator for background activity (e.g., Call timer)
- **Compact leading / trailing**: two simultaneous activities, left and right of pill
- **Expanded**: tapping the island reveals a larger interactive card overlay
- Live Activities drive all island content through ActivityKit

---

### Navigation Patterns

**Navigation Stack (push/pop)** [documented]
- `NavigationStack` (SwiftUI) / `UINavigationController` (UIKit)
- Navigation bar: 44 pt tall + top safe area inset
- Large title mode: title is ~34 pt bold, collapses to 17 pt semibold inline title on scroll
- Back button: chevron glyph (SF Symbols `chevron.left`) + parent title text, positioned leading
- Search bar appears below navigation bar, collapses on scroll (`.searchable` modifier)

**Tab Bar** [documented]
- Bottom anchored, always visible for top-level content switching
- Standard height: 49 pt + bottom safe area inset (34 pt on Face ID phones → ~83 pt total visual footprint)
- Icon size: 25×25 pt; label: 11 pt regular
- Maximum recommended tabs: 5 on iPhone; More tab used for overflow (UIKit legacy)
- 3–5 tabs produce 20–30% faster navigation than 6+ [observed — cited in HIG-aligned UX research]

**iOS 26 Liquid Glass tab bar** [documented — Apple Newsroom, WWDC25 session 284]
- Tab bar is now a floating, fully-rounded pill/capsule that hovers above content
- Applied Liquid Glass material: translucent, blur-sampled from the content beneath
- Scroll behavior: `.tabBarMinimizeBehavior(.onScrollDown)` → bar shrinks to a compact floating button on scroll down; scrolling back up restores full bar with fluid animation
- Accessory view: `.tabViewBottomAccessory { }` — places a view above the bar (e.g., a Now Playing strip); accessory collapses next to the minimized button when bar is compact
- Search tab role: `.role(.search)` positions search in bottom-right; replaces the Magnifier tab pattern
- Tab bar inset from screen edges: ~21 pt on left, right, and bottom [observed — FabBar implementation reference]
- On iPad: tab bar and sidebar both lift into Liquid Glass and float above content

**Toolbars** [documented]
- Bottom bar (`ToolbarItem(placement: .bottomBar)`): same glass treatment in iOS 26, floating above content
- Top bar (`.topBarLeading` / `.topBarTrailing`): navigation bar button items
- `ToolbarSpacer(.fixed, spacing:)` for precise item spacing
- Bottom toolbars never overlap content — they push the content's scroll inset up

**Large Title on scroll (web analog)** [documented behavior, web pattern inferred]
Native: UIKit `UINavigationController` with `prefersLargeTitles = true` — title at 34 pt in the navigation bar's "bottom" section; on scroll past the title threshold the bar transitions to the compact 17 pt title with a crossfade. Web reproduction is a sticky header that shrinks on scroll (see Recipes).

---

### Sheets and Modal Presentation

**Sheet anatomy** [documented — Apple HIG Sheets, SwiftUI API]
- Sheet rises from the bottom, dims the presenting view with a translucent scrim
- Grabber (drag indicator): a 36×5 pt pill at the top of the sheet, shown via `.presentationDragIndicator(.visible)`
- Corner radius: 13 pt (system default); customizable via `.presentationCornerRadius(25)`
- Scrim opacity: system-managed; user can tap outside to dismiss

**Detent system (iOS 16+)** [documented]

| Detent | Value | Notes |
|--------|-------|-------|
| `.large` | 100% of available height minus safe areas | Default, fullscreen sheet |
| `.medium` | ~50% of screen height | Half-sheet |
| `.fraction(0.3)` | 30% of screen height | Custom fraction |
| `.height(300)` | Exact 300 pt | Custom fixed height |
| `CustomPresentationDetent` | Computed height | Fully dynamic detent |

Multiple detents allow user to drag between snap points. Programmatic control via `selectedDetentIdentifier` binding.

**Page sheet vs. full-screen** [documented]
- `.sheet` → card-style with rounded top corners, underlying view shrinks/scales behind
- `.fullScreenCover` → no visible parent, no dismiss by drag
- On iPad, `.sheet` defaults to a centered form sheet (~540 pt wide); use `.presentationSizing(.page)` (iOS 17) to get iPhone-style bottom sheet on iPad

**Card-stack visual** [documented — iOS 13+]
When a sheet is presented, the presenting view scales down slightly (~0.92 scale) and rounds its own top corners to reveal a stack effect. This signals modal depth without losing context.

---

### Search Placement

**iOS convention** [documented]
- `.searchable(text:)` in SwiftUI places a search bar below the navigation bar large title; it scrolls away with content and re-appears when the user pulls down
- `.searchToolbarBehavior(.minimized)` → search collapses to a button in the toolbar
- In iOS 26, a Search tab (`.role(.search)`) is the preferred pattern for apps with prominent search; it floats in the tab bar's bottom-right

---

## iPadOS Specifics

### Windowing and Stage Manager (iPadOS 26)

**Three multitasking modes** [documented — slatepad.org, Apple Newsroom]
1. **Full Screen**: traditional single-app focus
2. **Windowed Apps**: unlimited freeform windows in one workspace; no dock sidebar; windows resize freely to any dimension
3. **Stage Manager**: workspace-grouped windows with a sidebar showing recent sets; now allows more than 4 apps per Stage (previously limited); functions like macOS Stage Manager

**Window controls** [documented]
- macOS-style traffic-light buttons (close/minimize/maximize) in top-left of each window
- Tap to trigger; expand on hover (pointer) or tap (touch)
- Hold traffic-light → reveals "Window Tiling" options (split layouts mirroring macOS 15 tiling)
- Freeform resize via bottom-right drag handle; no snap-to-size restrictions

**iPadOS menu bar** [documented — MacRumors, MacStories]
- New in iPadOS 26: a macOS-style menu bar appears when the cursor moves to the top of the screen
- Searchable, mirrors the Mac menubar's app-level commands
- Disappears when cursor moves away; touch-only users access it via a top-edge swipe

**Sidebar pattern** [documented]
- `NavigationSplitView` with three-column option: sidebar / content / detail
- On compact width (iPhone): sidebar collapses into the navigation stack
- On regular width (iPad): sidebar is persistent or shown/hidden via toolbar button
- iOS 26: sidebars adopt Liquid Glass — they refract the content behind them and reflect wallpaper from around them, removing the opaque sidebar background

**Pointer (cursor) support** [documented]
- iPadOS 13.4+ supports trackpad/mouse input
- Pointer morphs to the shape of interactive elements (capsule over buttons, beam over text)
- Design for both touch (44 pt minimum targets) and pointer (can be as small as 16 pt with hover state), because the same layout handles both inputs
- Hover effects: `.hoverEffect(.highlight)` / `.hoverEffect(.lift)` in SwiftUI

**Keyboard** [documented]
- `.onKeyPress` / `keyboardShortcut` modifiers for hardware keyboard shortcuts
- Smart keyboard shortcuts must not conflict with system-level shortcuts (Cmd+H = Home, Cmd+Space = Spotlight)
- Keyboard dismissal: `UIScrollView.keyboardDismissMode = .interactive` for drag-to-dismiss

---

## Recipes

### 1. CSS bottom sheet with detents and grabber

```css
/* ── iOS-style bottom sheet with 3 detent snap points ── */

:root {
  --sheet-radius: 13px;           /* system default; use 20–25px for modern feel */
  --grabber-w: 36px;
  --grabber-h: 5px;
  --detent-medium: 50vh;
  --detent-large: calc(100dvh - env(safe-area-inset-top, 44px) - 8px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

/* Scrim overlay */
.sheet-scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  z-index: 100;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.sheet-scrim.open { opacity: 1; pointer-events: auto; }

/* Sheet container */
.sheet {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 101;
  background: #fff;
  border-radius: var(--sheet-radius) var(--sheet-radius) 0 0;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.12);
  /* transform drives detent position */
  transform: translateY(100%);
  transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
  /* snap physics feel — use Web Animations API for velocity-aware snap */
  touch-action: none; /* JS handles touch tracking */
  padding-bottom: var(--safe-bottom);
  overscroll-behavior: none;
}

/* Detent states driven by JS adding classes */
.sheet.detent-medium  { transform: translateY(calc(100% - var(--detent-medium))); }
.sheet.detent-large   { transform: translateY(calc(100% - var(--detent-large))); }
.sheet.detent-closed  { transform: translateY(100%); }

/* Grabber */
.sheet-grabber {
  width: var(--grabber-w);
  height: var(--grabber-h);
  background: rgba(0, 0, 0, 0.18);
  border-radius: calc(var(--grabber-h) / 2);
  margin: 8px auto 0;
}

/* Sheet content scroll area — MUST scroll within the sheet, not the page */
.sheet-content {
  max-height: calc(var(--detent-large) - 24px); /* 24px = grabber + margin */
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 16px 16px calc(16px + var(--safe-bottom));
}
```

```js
// Minimal JS: snap to nearest detent on drag-end
// Attach touchstart/mousemove/touchend; track delta; on end, snap.
const DETENTS_VH = [0, 50, 100]; // closed / medium / large (% of dvh)

function snapSheet(sheet, currentPct) {
  const nearest = DETENTS_VH.reduce((prev, curr) =>
    Math.abs(curr - currentPct) < Math.abs(prev - currentPct) ? curr : prev
  );
  if (nearest === 0)   sheet.className = 'sheet detent-closed';
  if (nearest === 50)  sheet.className = 'sheet detent-medium';
  if (nearest === 100) sheet.className = 'sheet detent-large';
}
```

---

### 2. Large-title-on-scroll (CSS + JS)

Reproduces iOS 11+ large-title navigation bar behavior: 34 pt title in extended bar collapses to 17 pt inline title in compact bar on scroll.

```css
.nav-bar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  left: 0; right: 0;
  z-index: 50;
  background: rgba(255,255,255,0.85);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 0.5px solid rgba(0,0,0,0.1);
  transition: all 0.25s ease;
}

/* Compact state (after scroll) */
.nav-bar.compact {
  box-shadow: 0 1px 0 rgba(0,0,0,0.1);
}

.nav-bar__large-title {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.5px;
  padding: 8px 16px 12px;
  transition: opacity 0.2s, transform 0.2s;
}
.nav-bar.compact .nav-bar__large-title {
  opacity: 0;
  transform: translateY(-4px);
  height: 0;
  overflow: hidden;
  padding: 0;
}

.nav-bar__compact-row {
  height: 44px;
  display: flex;
  align-items: center;
  padding: 0 16px;
}

.nav-bar__inline-title {
  font-size: 17px;
  font-weight: 600;
  opacity: 0;
  transition: opacity 0.2s 0.05s;
}
.nav-bar.compact .nav-bar__inline-title { opacity: 1; }
```

```js
const navBar = document.querySelector('.nav-bar');
const COLLAPSE_THRESHOLD = 44; // approximate large-title height

window.addEventListener('scroll', () => {
  navBar.classList.toggle('compact', window.scrollY > COLLAPSE_THRESHOLD);
}, { passive: true });
```

---

### 3. Floating Liquid Glass tab bar (CSS)

Reproduces the iOS 26 floating pill tab bar that minimizes on scroll.

```css
.tab-bar {
  position: fixed;
  bottom: calc(21px + env(safe-area-inset-bottom, 0px));
  left: 21px; right: 21px;
  height: 56px;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: saturate(200%) blur(24px) brightness(1.05);
  -webkit-backdrop-filter: saturate(200%) blur(24px) brightness(1.05);
  border-radius: 28px; /* fully rounded pill */
  border: 0.5px solid rgba(255,255,255,0.6);
  box-shadow:
    0 2px 8px rgba(0,0,0,0.10),
    0 0 0 0.5px rgba(0,0,0,0.06) inset;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 0 16px;
  z-index: 90;
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1),
              width 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}

/* Minimized state — collapses to a compact icon button */
.tab-bar.minimized {
  width: 56px;
  left: auto;
  right: 21px;
  transform: none;
  border-radius: 28px;
  justify-content: center;
}
.tab-bar.minimized .tab-item:not(.tab-item--active) { display: none; }
.tab-bar.minimized .tab-item--active span { display: none; }

.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  cursor: pointer;
  border-radius: 22px;
  transition: background 0.15s;
}
.tab-item:hover { background: rgba(0,0,0,0.06); }

.tab-item svg { width: 24px; height: 24px; }
.tab-item span { font-size: 11px; font-weight: 500; letter-spacing: -0.2px; }
.tab-item--active svg { color: #007AFF; }
.tab-item--active span { color: #007AFF; }

/* Dark OS safety — pin to light theme so glass stays readable */
@media (prefers-color-scheme: dark) {
  .tab-bar {
    background: rgba(28, 28, 30, 0.72);
    border-color: rgba(255,255,255,0.12);
  }
}
```

```js
let lastScroll = 0;
const tabBar = document.querySelector('.tab-bar');

window.addEventListener('scroll', () => {
  const now = window.scrollY;
  tabBar.classList.toggle('minimized', now > lastScroll && now > 80);
  lastScroll = now;
}, { passive: true });
```

---

### 4. SwiftUI — Sheet with detents

```swift
import SwiftUI

struct ContentView: View {
  @State private var showSheet = false
  @State private var selectedDetent: PresentationDetent = .medium

  var body: some View {
    Button("Open Sheet") { showSheet = true }
      .sheet(isPresented: $showSheet) {
        SheetContent()
          .presentationDetents(
            [.medium, .large, .fraction(0.3)],
            selection: $selectedDetent
          )
          .presentationDragIndicator(.visible)    // grabber pill
          .presentationCornerRadius(20)           // override default 13pt
          .presentationBackground(.regularMaterial)  // iOS 26: glass blur
          .interactiveDismissDisabled(false)      // allow swipe to dismiss
      }
  }
}

// Custom detent example
struct HalfMinusToolbarDetent: CustomPresentationDetent {
  static func height(in context: Context) -> CGFloat? {
    max(200, context.maxDetentValue * 0.45)
  }
}
// Usage: .presentationDetents([.custom(HalfMinusToolbarDetent.self)])
```

---

### 5. SwiftUI — NavigationStack + large titles

```swift
NavigationStack {
  List(items) { item in
    NavigationLink(item.title, value: item)
  }
  .navigationTitle("Library")
  .navigationBarTitleDisplayMode(.large)   // 34pt large title; collapses on scroll
  .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
  .navigationDestination(for: Item.self) { item in
    DetailView(item: item)
  }
}
```

---

### 6. SwiftUI — iOS 26 Tab View with Liquid Glass

```swift
TabView {
  Tab("Home", systemImage: "house.fill") {
    HomeView()
  }
  Tab("Search", systemImage: "magnifyingglass", role: .search) {
    SearchView()
  }
  Tab("Library", systemImage: "books.vertical.fill") {
    LibraryView()
  }
  Tab("Profile", systemImage: "person.fill") {
    ProfileView()
  }
}
.tabBarMinimizeBehavior(.onScrollDown)   // iOS 26 collapse on scroll
.tabViewBottomAccessory {
  // e.g., a Now Playing mini-player above the tab bar
  MiniPlayerView()
    .frame(height: 60)
}
// iOS 26: glassEffect on a floating action button above the tab bar
.overlay(alignment: .bottomTrailing) {
  Button { } label: {
    Image(systemName: "plus")
      .font(.title2.weight(.semibold))
      .padding(16)
  }
  .glassEffect(.regular.interactive(), in: .circle)
  .padding(.trailing, 24)
  .padding(.bottom, 80)
}
```

---

### 7. SwiftUI — Liquid Glass button styles

```swift
// Secondary action — translucent glass
Button("Cancel") { }
  .buttonStyle(.glass)

// Primary action — opaque glassProminent
Button("Continue") { }
  .buttonStyle(.glassProminent)

// Custom shape glass effect
Text("Tag")
  .padding(.horizontal, 12)
  .padding(.vertical, 6)
  .glassEffect(.regular, in: .capsule)

// Glass morphing between two elements (same namespace)
@Namespace var glassNS

PillA().glassEffectID("nav", in: glassNS)
PillB().glassEffectID("nav", in: glassNS)
// Animating selection between them triggers a smooth glass morph
```

---

## Faithful Replication (Web / PWA)

### Core principles for web reproduction

1. **Use `dvh` not `vh`** — on mobile Safari, `100vh` includes the browser chrome height, causing overflow. `100dvh` (dynamic viewport height) accounts for the retracted/extended chrome. Always `height: 100dvh` for full-screen overlays. [documented — CSS spec, MDN]

2. **Safe area insets** — required in every PWA or mobile web app:
   ```html
   <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
   ```
   Then in CSS:
   ```css
   padding-bottom: env(safe-area-inset-bottom);
   padding-top: env(safe-area-inset-top);
   ```
   Without `viewport-fit=cover`, `env()` values are all zero. [documented — CSS Environment Variables spec]

3. **Backdrop-filter for glass** — `backdrop-filter: saturate(180%) blur(20px)` reproduces the vibrancy material. iOS Safari supports it with the `-webkit-` prefix. Always include both prefixed and unprefixed. Fallback for browsers that don't support it: a solid background color with slight opacity. [documented — CSS Filters Level 2]

4. **Large-title scroll pattern** — Use `position: sticky` on the nav bar and an `IntersectionObserver` or scroll event to toggle the compact class. Do not use `position: fixed` + manual top offset — it causes layout jank on iOS during the browser-chrome-resize animation.

5. **Bottom sheet physics** — Use the Web Animations API with easing `cubic-bezier(0.32, 0.72, 0, 1)` (approximately what UIKit uses for spring presentations). For production, consider `@okikio/animate` or the `Animation` interface directly rather than CSS transitions, to support velocity-aware snap. [inferred — from UIKit spring animation profile]

6. **Overscroll containment** — Add `overscroll-behavior-y: contain` to the sheet's scroll container so momentum scrolling doesn't propagate to the underlying page. [documented — CSS Overscroll Behavior]

7. **Dark OS contrast guarantee** — If your web UI uses frosted glass cards, the glass layer can invert to near-white text on dark mode, breaking legibility. Pin a light-theme context explicitly:
   ```html
   <div data-theme="light" style="color-scheme: light;">
   ```
   This prevents `prefers-color-scheme: dark` from flipping `--text` variables to white on a frosted glass that is inherently light. [documented — CSS color-scheme, observed pattern]

### PWA framing

A PWA with `"display": "standalone"` in its manifest removes the browser chrome and gains a full-screen canvas. With `viewport-fit=cover` and safe area insets, the PWA can render a native-feeling bottom tab bar and bottom sheet system that is virtually indistinguishable from a native UIKit app in screenshots. Key manifest fields:
```json
{
  "display": "standalone",
  "orientation": "portrait",
  "theme_color": "#ffffff"
}
```
`theme_color` colors the status bar area in standalone mode — set it to match your nav bar background for a seamless top edge.

---

## Anti-Patterns

**1. Top-only controls** [documented — HIG thumb-reach principle]
Placing primary actions in a navigation bar trailing button is fine for secondary/destructive actions. Placing the app's most frequent action (e.g., "New message") in the top-right forces a grip shift every time. Use a floating action button (bottom-right) or a tab bar accessory instead.

**2. Mimicking native chrome badly** [observed — common PWA mistake]
Using a gray 50 pt tall `<nav>` at the bottom with small icon images does not feel native — it looks like a gray bar with blurry icons. Native tab bars use precise SF Symbols equivalents, exact 25×25 pt icon sizing, 11 pt labels, and a blur material. On web: use SVG icons at 24×24, `font-size: 11px`, and the backdrop-filter glass recipe above.

**3. Fixed bars ignoring safe areas** [documented — common crash pattern]
A `position: fixed; bottom: 0` bar without `padding-bottom: env(safe-area-inset-bottom)` overlaps the home indicator on notch-less Face ID phones (iPhone 15+) and clips behind the home bar on older iPhones. Always add the env() padding. [documented]

**4. Modal overuse** [documented — Apple HIG Modality]
Sheets interrupt the user's flow. Apple's rule: use a modal only when the user must make a decision or complete a task before continuing. Navigation belongs in a `NavigationStack`, not a sheet. Presenting a detail view in a sheet (instead of a push) is a common mistake that breaks the back-swipe gesture expectation and prevents deep-linking.

**5. Disabling scrollability inside sheets** [observed — common implementation error]
If a sheet contains a `List` or `ScrollView` without the inner view being independently scrollable, scrolling the list content triggers the sheet-dismiss gesture instead. Fix: ensure the scroll container has a distinct touch-region and that `scrollContentBackground(.hidden)` + `overscroll-behavior: contain` (web) or `UIScrollView.bounces = false` is set appropriately at the detent boundary. [documented — SwiftUI `.presentationDetents` interaction notes]

**6. Using glass effects on content** [documented — Apple Liquid Glass constraint]
Liquid Glass is exclusively for the navigation layer (tab bars, toolbars, navigation bars, system overlays). Applying `glassEffect()` to list rows, article backgrounds, or media cards violates the material contract and produces a visually confused hierarchy. `GlassEffectContainer` also prevents glass-on-glass sampling — nested glass views produce undefined rendering. [documented — Apple developer docs, WWDC25]

**7. Hardcoding status bar / tab bar heights** [documented]
`44`, `49`, `54`, `34` — these values all change across device families and OS updates. Always use `safeAreaInsets` programmatically. On web, always use `env(safe-area-inset-*)`. Hardcoding causes layout breaks with every new iPhone model.

**8. Non-adaptive iPad layouts** [documented]
Building a layout that works only in portrait on iPhone and then scaling it to an iPad results in a stretched, awkward interface. Use `NavigationSplitView` for iPad (sidebar always visible at regular width) and `NavigationStack` for iPhone (compact width). On web, use CSS container queries or `min-width` breakpoints with a sidebar pattern at ≥768 px.

---

## Sources

- [Apple Newsroom — Apple introduces a delightful and elegant new software design (June 2025)](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
- [Apple Developer — Liquid Glass overview](https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass)
- [Apple HIG — Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Apple HIG — Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [Apple HIG — Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Apple HIG — Navigation and search](https://developer.apple.com/design/human-interface-guidelines/navigation-and-search)
- [Apple Developer — WWDC25: Build a UIKit app with the new design (session 284)](https://developer.apple.com/videos/play/wwdc2025/284/)
- [Donny Wals — Exploring tab bars on iOS 26 with Liquid Glass](https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/)
- [MacRumors — iOS 26: Everything You Need to Know About the Liquid Glass Redesign](https://www.macrumors.com/guide/ios-26-liquid-glass/)
- [MacStories — iOS 26, iPadOS 26, and Liquid Glass: The MacStories Overview](https://www.macstories.net/news/ios-26-ipados-26-and-liquid-glass-the-macstories-overview/)
- [Create With Swift — Liquid Glass: Redefining design through Hierarchy, Harmony and Consistency](https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/)
- [letsdev — iOS 26 in detail: Liquid Glass UI between Usability and Accessibility](https://letsdev.de/en/blog/ios-26-in-detail-liquid-glass-ui-between-usability-and-accessibility.php)
- [Medium — iOS 26 Liquid Glass: Comprehensive Swift/SwiftUI Reference](https://medium.com/@madebyluddy/overview-37b3685227aa)
- [Sarunw — Bottom Sheet in SwiftUI on iOS 16 with presentationDetents](https://sarunw.com/posts/swiftui-bottom-sheet/)
- [Learn UI Design — iOS 26 Design Guidelines: Illustrated Patterns](https://www.learnui.design/blog/ios-design-guidelines-templates.html)
- [Slatepad — How Multitasking Works in iPadOS 26](https://slatepad.org/2025/06/17/heres-how-multitasking-works-in-ipados-26/)
- [GitHub — simonbs/ios-widget-sizes](https://github.com/simonbs/ios-widget-sizes)
- [UseyourLoaf — iPhone 15 Screen Sizes](https://useyourloaf.com/blog/iphone-15-screen-sizes/)
- [Apple Support — What's new in iOS 26](https://support.apple.com/guide/iphone/whats-new-in-ios-26-iphfed2c4091/ios)
- [GitHub — FabBar: Liquid Glass tab bar recreation](https://github.com/ryanashcraft/FabBar)
- [GitHub — LiquidGlassReference](https://github.com/conorluddy/LiquidGlassReference)

---

CONFIDENCE: 78% — Core iOS surface anatomy and most metrics are well-documented; iOS 26 Liquid Glass specifics are from June 2025 release coverage and developer betas rather than final-shipping HIG pages, so a handful of behavioral details (especially exact tab bar pill dimensions and Control Center exact layout) remain inferred from community measurement rather than official spec.
