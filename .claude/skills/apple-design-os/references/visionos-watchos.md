# visionOS & watchOS Spatial + Wearable Design Reference

**Scope:** Design principles, metrics, SwiftUI recipes, and faithful-replication notes for visionOS (spatial computing) and watchOS (wearable glance UI). Era: visionOS 26 / watchOS 26 (current as of WWDC 2025). Includes the definitive link between visionOS's glass aesthetic and the Liquid Glass design language.

---

## Principles

### 1. Depth as hierarchy [documented]

On flat screens, hierarchy is expressed through size, color, and z-index CSS stacking. visionOS externalizes that metaphor into literal 3D space: objects closer to the viewer carry more urgency; background layers recede visually and spatially. This is not decoration — it is the primary organizational grammar of the platform. Suppress depth cues inconsistently and the brain resolves conflict through eye fatigue or double-vision (documented as a comfort failure mode in WWDC23 "Design considerations for vision and motion").

### 2. Gaze ergonomics over touch ergonomics [documented]

Touch UIs optimize for finger precision (~10 mm tip, forgives small targets). visionOS input is eye-gaze + pinch: gaze has measurable drift, so minimum interactive target rises from the familiar 44 pt (iOS) to **60 pt** on visionOS. Additionally, eye muscles fatigue in different directions: left/right rotation is comfortable; upward gaze is the most tiring. Content placed above the horizon line must be brief-interaction only. This is a hard ergonomic constraint, not a stylistic preference.

### 3. Glass as environmental honesty [documented]

The system-provided glass material is intentionally translucent — it lets the physical world show through, grounding virtual elements in real space. Opaque solid windows feel "constricting" (Apple's direct language, WWDC23) because they deny the wearer perceptual connection to their room. This is the spatial equivalent of a design principle: respect the user's physical context. Craig Federighi confirmed (WWDC 2025) that visionOS's glass UI was "the most obvious inspiration" for Liquid Glass, which then spread to iOS 26 / macOS Tahoe / watchOS 26 as a unified design language.

### 4. Glance-ability as a first-class requirement [documented]

watchOS interactions average under 5 seconds; ~60% last under 5 seconds; the approachability-perception window is ~2.6 seconds. This means every watchOS screen must deliver its primary value without any tap. Complications are the extreme end: they must read in ~1.6 seconds on average. Design for the glance first; design for the tap second.

### 5. Crown precision — the scroll wheel reborn [documented]

The Digital Crown is a high-resolution rotary encoder with haptic detent feedback. It gives watchOS a scroll/navigation input that requires zero screen real estate and no occlusion (finger-over-screen problem). Design for it means: prefer linear vertical content (lists, long text) that maps naturally to crown rotation; use haptic detents at meaningful data boundaries; never make the crown gesture ambiguous with a swipe gesture serving the same function.

### 6. Immersion as a spectrum, not a binary [documented]

visionOS defines three discrete modes rather than on/off immersion. Launching directly into Full Space is an anti-pattern: it disorients users who haven't been given a spatial anchor. Always begin in Shared Space; let the user opt into deeper immersion after orientation.

### 7. Comfortable field of view — landscape wins [documented]

Human peripheral vision is wider than it is tall. visionOS windows should therefore favor landscape/wide aspect ratios. This matches the ergonomic rule about horizontal vs. vertical eye rotation. Portrait-heavy layouts force excessive vertical scanning and are an iOS-brain import that fights the platform.

---

## Apple Specifics

### visionOS

#### Windows and the Glass Material [documented]

Every visionOS window uses a system-provided glass background by default. The glass:
- Is **not overridable** with an opaque solid background in standard `WindowGroup` scenes — the system enforces it.
- Responds dynamically to real-world lighting conditions, adding specular highlights and shadows in real time.
- Adapts contrast and color balance based on the wearer's environment.
- Uses vibrant materials layered on top: **Primary** (standard text), **Secondary** (subtitles, descriptions), **Tertiary** (lowest emphasis) — all white-biased because white reads reliably over dynamic glass.

Default window placement: center of the user's view. The system provides a window bar at the bottom for repositioning. Windows always face the user as they move (billboarding). A Digital Crown long-press recenters content in front of the viewer.

#### Ornaments [documented]

Ornaments are floating panels that attach to the **outside** of a window — the canonical location for persistent tool controls, media playback controls, or navigation aids. Key rules:
- Overlap the bottom edge of the window by **20 points** to create a visual anchor without covering content.
- Sit **slightly in front of the window** in Z-space (depth-separated from the window plane).
- Use borderless buttons inside ornaments.
- Apply `.glassBackgroundEffect()` to give the ornament its own glass surface.
- Max recommended items: keep sparse — ornaments are not secondary navigation bars.

The system provides ornament placement automatically for:
- `TabView` → becomes a **vertical left-side ornament** (collapsed to icons by default; expands to labels on gaze hover; collapses when gaze moves away; max 6 items).
- `.toolbar { ToolbarItem(placement: .bottomOrnament) }` → bottom center ornament.

#### Depth & Z-layering [documented]

| Layer | Use case |
|---|---|
| Background window (furthest) | Ambient context, passthrough |
| Primary window | Main app content |
| Ornaments | Controls attached to window exterior, just in front |
| Modals / sheets | Slide in front of window; parent dims and pushes back |
| Menus / popovers | Expand beyond window, centered on focused element |

Sheets: when a sheet appears, the parent window **pushes back with dimming** — signaling modal depth visually. Nested sheets add additional dimming layers. This is enforced by the system, not by the developer.

Corner radii formula (concentric design rule): `outer_radius = inner_radius + padding`. Always apply continuous corners. [documented]

#### Immersion Levels [documented]

| Level | API `.immersionStyle` | Description |
|---|---|---|
| Shared Space | (default `WindowGroup`) | App coexists with other apps; full passthrough |
| Progressive | `.progressive` | Replaces a partial portion of view; some passthrough retained |
| Full Space | `.full` | Single app owns entire FOV; all passthrough hidden |
| Mixed | `.mixed` | Virtual content blends into passthrough without vignette |

Recommendation: start in Shared Space. Transition to Full Space only for experiences explicitly designed for immersion (e.g., meditation, 3D product viewing). Provide clear exit affordances.

System fades passthrough when the user physically moves during an immersive experience — this is automatic motion protection. Developers should design fade-in/fade-out transitions for scene changes.

#### Eye + Pinch Input [documented]

Primary input: **look-to-target** (eye gaze selects) → **pinch** (thumb + index finger closes to confirm). No touching the display.

| Metric | Value |
|---|---|
| Minimum interactive target | 60 pt |
| Minimum spacing between interactive elements | 4 pt (to prevent hover overlap) |
| Recommended padding around standard button | 8 pt all sides (giving 44 pt button a 60 pt tap zone) |
| Minimum spacing between stacked buttons | 16 pt |

System provides automatic hover brightening on focused elements. Do not replicate this manually — add `hoverEffect()` only for custom interactive regions. Define custom hover regions for composite lockups (image + text = one interactive unit).

Secondary inputs: direct touch (arm extended), keyboard, trackpad, voice — all system-supported.

#### Typography Adjustments for visionOS [documented]

| Role | iOS weight | visionOS weight |
|---|---|---|
| Body | Regular | Medium |
| Title | Semibold | Bold |
| Display | — | Extra Large Title 1 (new) |

Tracking is slightly increased. All font sizes use the point system, which guarantees legibility regardless of physical viewing distance. Do not use 3D/extruded text — keep all text flat.

#### Spatial Audio [inferred from WWDC23 principles]

Audio is positional in 3D space. Sound sources attached to spatial objects move with them. Use spatial audio as a confirmation or orientation cue (e.g., a sound emitting from the direction of a notification). Avoid loud, continuous spatial audio that causes fatigue.

#### Ergonomic Placement Rules [documented]

- Place reading content farther than arm's-length (forces comfortable focal distance).
- Most comfortable eye positions: downward, left, right.
- Most fatiguing: upward and diagonal gaze.
- Extended reading → center of view, slightly **below** the horizon line.
- Never anchor content to the viewer's head (head-locked content) unless absolutely necessary; use world-locked or lazy-follow animations instead.
- Avoid oscillating motion at ~0.2 Hz (one oscillation per ~5 seconds) — this frequency causes maximum motion discomfort. [documented]
- Moving virtual objects covering a large FOV should be made semitransparent to preserve passthrough grounding. [documented]

---

### watchOS

#### Screen Dimensions [documented]

| Model | Display size | Resolution |
|---|---|---|
| 38 mm / 40 mm | 1.57 in | ~272 × 340 px |
| 41 mm | ~1.69 in | ~396 × 484 px |
| 44 mm / 45 mm | ~1.78 in | ~368 × 448 px |
| 49 mm (Ultra) | largest | ~410 × 502 px |

All use OLED (infinite contrast ratio, true black). Design with OLED black (not dark gray) as your background — it's free real estate that makes elements appear to float. [documented]

#### Complications (WidgetKit) [documented]

Complications are the watch-face data slots. Since watchOS 9, complications are built with **WidgetKit** + SwiftUI, sharing code with iOS Lock Screen widgets.

| Family | Description | Data density |
|---|---|---|
| `.accessoryCircular` | Small circle; good for gauges, progress, single value | ≤ 2 values |
| `.accessoryRectangular` | Wide rectangle; multi-line data | ≤ 4 values |
| `.accessoryInline` | Single text line across face | ≤ 20 chars (engagement drops 38% beyond this) |
| `.accessoryCorner` | Corner with image + curved label | 1 value + 1 label |

Update budget: up to **50 refreshes/day** per complication. Recommended cadence: every 15 minutes for dynamic data (weather, fitness), hourly for slow data. [documented]

Typography for complications: minimum **12–13 pt** text. Limit text to **7–9 characters** on small families. [documented]

#### Digital Crown [documented]

The Crown is a high-precision rotary encoder. Design for it:
- **Scrolling** long vertical content (lists, text, pickers) — the primary mapping.
- **Precision input** on sliders, pickers (e.g., time selection) with haptic detents at meaningful boundaries.
- **Smart Stack navigation** from the watch face: crown rotation reveals the Smart Stack widget tray.
- Click: return to watch face / last app. Double-click: App Switcher. Long-press: Siri.

Haptic detents (`WKHapticType`) provide tactile confirmation at step boundaries. Use them wherever the crown controls discrete state (not continuous scrolling). [documented]

#### Navigation Patterns [documented]

watchOS 10+ standardized on:
- **`NavigationStack`** for hierarchical drill-down: large title on root, back button on sub-views, no deeper than **3 levels**.
- **Vertical paging / tab views** for peer-level sections (swipe up/down between tabs).
- **Full-screen modals** for momentary tasks (confirmation, quick input).
- **Smart Stack** (accessed via crown from watch face): context-aware widget suggestions using sensor + routine data.

Avoid: deep NavigationStack hierarchies, complex multi-step flows, any pattern that demands more than a few seconds of sustained attention.

#### Glanceability Design [documented]

- Max **3 interactive elements** per screen.
- Every screen must communicate its primary value within **2.6 seconds** (approachability-perception window).
- Complication engagement window: ~**1.6 seconds** average.
- Use large, bold type. San Francisco Display at large sizes. Prefer single-purpose screens.
- OLED true black (`.black` Color on watchOS, not `.systemBackground`) for maximum contrast with foreground elements.

#### Hit Targets on watchOS [documented]

Minimum **44 × 44 pt** for interactive elements. At sub-44 pt, tap accuracy drops ~33%. Use full-width list rows (they get the entire watch-width tap zone automatically via SwiftUI `List`).

#### Notifications [documented]

Two states:
- **Short look**: glanceable alert (app icon + brief title). Appears automatically on wrist raise.
- **Long look**: scrollable full notification with actions. Appears after brief delay or on crown scroll.

Keep notification bodies under 3 lines. Action buttons: 2 max, labeled with verbs, full-width.

watchOS 26 adds Liquid Glass treatment to notifications and Smart Stack widgets — translucent backgrounds that show the watch face content behind them. [documented]

#### Liquid Glass on watchOS 26 [documented]

Liquid Glass (announced WWDC June 2025, shipping watchOS 26) applies a translucent glass aesthetic most visibly to:
- Notifications
- Smart Stack widgets
- Control Center
- Music and playback controls

The glass layer responds to wrist movement (real-time reflection changes). App icons gain a layered 3D glass appearance. This is the same language as iOS 26 / macOS Tahoe, all descending from the visionOS glass material system.

---

## Recipes

### visionOS — Glass Window + Bottom Ornament + ImmersiveSpace

```swift
import SwiftUI
import RealityKit

// MARK: - App Entry Point
@main
struct SpatialApp: App {
    @State private var immersionStyle: ImmersionStyle = .mixed

    var body: some Scene {
        // Primary windowed content — glass background is automatic
        WindowGroup(id: "main") {
            ContentView()
        }
        .defaultSize(width: 800, height: 600)  // points, not pixels

        // Optional immersive layer
        ImmersiveSpace(id: "immersive-env") {
            ImmersiveView()
        }
        .immersionStyle(selection: $immersionStyle, in: .mixed, .progressive, .full)
    }
}

// MARK: - Main Content with Ornament
struct ContentView: View {
    @Environment(\.openImmersiveSpace) var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) var dismissImmersiveSpace
    @State private var isImmersed = false

    var body: some View {
        NavigationSplitView {
            // Sidebar — sits alongside vertical tab bar
            List {
                NavigationLink("Section A") { SectionView(title: "A") }
                NavigationLink("Section B") { SectionView(title: "B") }
            }
        } detail: {
            SectionView(title: "A")
        }
        // Bottom-center ornament for persistent controls
        .ornament(
            visibility: .visible,
            attachmentAnchor: .scene(.bottom),   // anchors to window bottom edge
            contentAlignment: .bottom            // ornament aligns its bottom to anchor
        ) {
            HStack(spacing: 16) {
                Button(action: { /* previous */ }) {
                    Image(systemName: "chevron.left")
                }
                Button(action: { /* play/pause */ }) {
                    Image(systemName: "play.fill")
                }
                Button(action: { /* next */ }) {
                    Image(systemName: "chevron.right")
                }
            }
            .labelStyle(.iconOnly)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            // Gives the ornament its own glass surface, ~20 pt below window bottom
            .glassBackgroundEffect(in: .capsule)
        }
        // TabView alternative — automatically becomes a vertical left-side ornament on visionOS
        // TabView { ... }
    }
}

// MARK: - Immersive Space View
struct ImmersiveView: View {
    var body: some View {
        RealityView { content in
            // Add RealityKit entities here
            let sphere = ModelEntity(
                mesh: .generateSphere(radius: 0.15),
                materials: [SimpleMaterial(color: .blue, isMetallic: true)]
            )
            sphere.position = [0, 1.5, -2]  // meters in world space
            content.add(sphere)
        }
    }
}

// MARK: - glassBackgroundEffect variants
struct GlassExamples: View {
    var body: some View {
        VStack {
            // Automatic: inherits glass from parent if present, applies own otherwise
            Text("Implicit glass")
                .padding()
                .glassBackgroundEffect(displayMode: .implicit)

            // Always apply, circular shape
            Image(systemName: "star.fill")
                .padding(32)
                .glassBackgroundEffect(.plate, in: .circle, displayMode: .always)

            // Feathered soft-edge glass (editorial use)
            Text("Feature headline")
                .font(.extraLargeTitle)
                .glassBackgroundEffect(.feathered(padding: 36, softEdgeRadius: 3), displayMode: .always)
        }
    }
}
```

> **Note:** The `ornament` anchor `.scene(.bottom)` overlaps the window by ~20 pt by design — the system handles exact gap geometry. The `.glassBackgroundEffect()` on the ornament content gives it an independent glass bubble rather than a flat cutout.

---

### visionOS — Custom Ornament with Full Parameters

```swift
struct DetailView: View {
    var body: some View {
        ScrollView {
            // ...main content...
        }
        .ornament(
            visibility: .visible,
            attachmentAnchor: .scene(.bottomTrailing),  // bottom-right corner of window
            contentAlignment: .bottom
        ) {
            VStack(spacing: 8) {
                Button("New", systemImage: "plus") { }
                Button("Share", systemImage: "square.and.arrow.up") { }
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) { }
            }
            .labelStyle(.iconOnly)
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .glassBackgroundEffect()
        }
    }
}
```

---

### watchOS — Full-Width List + Large Navigation Title

```swift
import SwiftUI

// MARK: - Root list view (NavigationStack pattern)
struct WatchRootView: View {
    var body: some View {
        NavigationStack {
            List {
                ForEach(WorkoutType.allCases) { workout in
                    NavigationLink(destination: WorkoutDetailView(workout: workout)) {
                        // Full-width row — tap target is entire row width automatically
                        HStack {
                            Image(systemName: workout.icon)
                                .font(.title2)
                                .foregroundStyle(.blue)
                                .frame(width: 36, height: 36)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(workout.name)
                                    .font(.headline)
                                Text(workout.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Workouts")  // large title on root only
        }
    }
}

// MARK: - Detail view — no large title, back button only
struct WorkoutDetailView: View {
    let workout: WorkoutType

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(workout.description)
                    .font(.body)

                // Full-width primary action button
                Button("Start") {
                    // begin workout
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)  // full width — easier to tap
                .tint(.blue)
            }
            .padding()
        }
        .navigationTitle(workout.name)
        .navigationBarTitleDisplayMode(.inline)  // inline on sub-views
    }
}
```

---

### watchOS — WidgetKit Complication (All Families)

```swift
import WidgetKit
import SwiftUI

// MARK: - Data model
struct HeartRateEntry: TimelineEntry {
    let date: Date
    let bpm: Int
    let trend: String  // "↑", "↓", "→"
}

// MARK: - Timeline provider
struct HeartRateProvider: TimelineProvider {
    func placeholder(in context: Context) -> HeartRateEntry {
        HeartRateEntry(date: .now, bpm: 72, trend: "→")
    }

    func getSnapshot(in context: Context, completion: @escaping (HeartRateEntry) -> Void) {
        completion(HeartRateEntry(date: .now, bpm: 72, trend: "→"))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HeartRateEntry>) -> Void) {
        // Refresh every 15 minutes — within the ~50/day budget
        let entry = HeartRateEntry(date: .now, bpm: fetchCurrentBPM(), trend: fetchTrend())
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: .now)!
        completion(Timeline(entries: [entry], policy: .after(nextUpdate)))
    }

    private func fetchCurrentBPM() -> Int { 72 }  // replace with HealthKit fetch
    private func fetchTrend() -> String { "→" }
}

// MARK: - Entry view (routes per family)
struct HeartRateEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HeartRateEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            // Circular: icon + value — max 2 data points
            VStack(spacing: 2) {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
                    .font(.caption.bold())
                Text("\(entry.bpm)")
                    .font(.headline.bold())
                    .widgetAccentable()  // tinted by watch face accent color
            }

        case .accessoryRectangular:
            // Rectangular: up to 4 data points, multi-line
            HStack {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
                    .font(.title3.bold())
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(entry.bpm) BPM")
                        .font(.headline)
                        .widgetAccentable()
                    Text("Heart Rate \(entry.trend)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

        case .accessoryInline:
            // Inline: single line, < 20 characters
            ViewThatFits {
                Text("HR \(entry.bpm) BPM \(entry.trend)")
                Text("HR \(entry.bpm) \(entry.trend)")
                Text("\(entry.bpm) BPM")
            }

        case .accessoryCorner:
            // Corner: centered icon + curved text label
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "heart.fill")
                    .foregroundStyle(.red)
                    .font(.title3.bold())
            }
            .widgetLabel {
                Text("\(entry.bpm)")
            }

        @unknown default:
            Text("\(entry.bpm)")
        }
    }
}

// MARK: - Widget declaration
struct HeartRateWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HeartRateComplication", provider: HeartRateProvider()) { entry in
            HeartRateEntryView(entry: entry)
        }
        .configurationDisplayName("Heart Rate")
        .description("Live BPM from HealthKit.")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
            .accessoryCorner
        ])
    }
}

// MARK: - Preview
#Preview(as: .accessoryCircular) {
    HeartRateWidget()
} timeline: {
    HeartRateEntry(date: .now, bpm: 72, trend: "→")
}
```

---

## Faithful Replication on Flat Screens

**What transfers:**

| visionOS / watchOS concept | Flat-screen equivalent |
|---|---|
| Glass depth aesthetic | CSS `backdrop-filter: blur()` + translucent panel; the Liquid Glass visual language (iOS 26, now standard in web-adjacent design systems) |
| 60 pt gaze-friendly targets | Large click/touch targets (min 44–48 px); benefit any pointer-imprecise device (TV, kiosk, trackpad) |
| Glance density | Card-based designs where primary value reads in < 3 seconds without interaction |
| Ornament pattern | Floating action toolbars positioned outside the main content frame (e.g., fixed bottom toolbar, floating sidebar) |
| Vibrant layering | Semitransparent overlays with content behind visible (modals, sheets, sidebars) |
| Concentric corner radii | CSS nested-border-radius rule: `inner_radius = outer_radius - padding` |
| Vertical tab bar | Left-side navigation rail (Material Design standard; also Apple's web and macOS sidebar pattern) |

**What does NOT transfer:**

- Eye-gaze input is purely a spatial-platform concept. Web has no gaze API (and shouldn't — privacy).
- The Crown has no web equivalent. The closest analog is a scroll wheel, but haptic detents, click-semantics, and precision encoding do not translate.
- Immersion levels (shared/full/progressive) have no direct web equivalent. Fullscreen API is a weak analog but lacks passthrough/mixed-reality semantics.
- Spatial audio positioning is partially achievable via Web Audio API `PannerNode`, but without head tracking it is approximate.
- 3D window placement and Z-ordered physical placement in a room is entirely specific to spatial computing hardware.

[inferred from platform capabilities]

---

## Anti-Patterns

### visionOS

**1. Tiny gaze targets** [documented]
Interactive elements under 60 pt with less than 4 pt spacing cause hover bleed — the system cannot confidently resolve which element the eye is targeting. Result: user frustration, inaccurate selection.

**2. Head-locked content** [documented]
Content that moves with the user's head (fixed HUD) causes motion discomfort because the inner ear detects no movement while the visual field suggests stasis at an unnatural focal distance. Use world-locked or lazy-follow approaches.

**3. Rapid motion / oscillation at ~0.2 Hz** [documented]
Oscillatory motion at the resonant frequency of ~0.2 Hz (one complete cycle per ~5 seconds) produces maximum vestibular-visual conflict. Do not animate at this frequency. Provide Reduce Motion alternatives.

**4. Opaque solid window backgrounds** [documented]
Blocking the physical world removes the perceptual grounding that makes visionOS comfortable. Solid backgrounds feel claustrophobic and fight the platform's core design contract. Use glass.

**5. Launching directly into Full Space** [documented]
Dropping users into a fully occluded environment without orientation causes disorientation. Always begin in Shared Space; let users choose immersion depth.

**6. Stacking lighter glass materials** [documented]
Layering lighter materials on each other degrades text legibility (contrast washes out). Use darker materials for input fields and areas requiring contrast against glass.

**7. Overusing multiple windows** [documented]
visionOS prefers a single primary window unless the use case genuinely requires side-by-side comparison. Multiple unprompted windows clutter the user's physical space.

**8. 3D or extruded text** [documented]
Text rotated or extruded in 3D space loses legibility. visionOS applies font adjustments (weight, tracking) for spatial readability, but the text plane itself must remain flat/billboarded.

---

### watchOS

**1. Porting phone UI at watch scale** [documented]
Small-button grids, navigation drawers, tabs-across-the-bottom, multi-column layouts — none of these work on a 40–45 mm screen. Redesign; do not scale down.

**2. Deep navigation hierarchies** [documented]
More than 3 levels of NavigationStack on watchOS requires too many taps and too much time. Flatten to 2–3 levels maximum.

**3. Dense watch-face complications** [documented]
Cramming 4+ data points into an accessoryCircular complication makes text unreadable at glance distance. Limit: 2 data points for circular, 4 for rectangular.

**4. Updating complications too frequently** [documented]
Budget is ~50 refreshes/day per complication. Polling more aggressively drains battery and is throttled by the system. Use timeline scheduling intelligently.

**5. Ignoring OLED black** [inferred]
Using `Color(.systemBackground)` (which is white in light mode, very dark gray in dark mode on iPhone) on watchOS gives a washed-out dark-gray background instead of true black, wasting the OLED panel's infinite contrast advantage. Use `Color.black` explicitly.

**6. Scrollable complications** [documented]
Complications must display a static snapshot — no animation, no scrolling, no interactive elements beyond a deeplink tap. Attempting to build mini-apps into complications violates both the HIG and the WidgetKit capability boundary.

**7. Non-verb action labels** [documented]
Notification action buttons with noun labels ("Settings", "Info") are less actionable than verbs ("Reply", "Dismiss", "Start"). Attention is under 5 seconds — be imperative.

**8. Low-contrast color on OLED** [documented]
Light gray (`#E5E5EA`) on white, or near-black (`#1C1C1E`) on true black, fails glanceability. Reserve red for warnings, green for positive/active states. Always target minimum 4.5:1 contrast ratio.

---

## Sources

1. **WWDC23 — "Design for spatial user interfaces"** (Apple Developer, session 10076)
   https://developer.apple.com/videos/play/wwdc2023/10076/

2. **WWDC23 — "Principles of spatial design"** (Apple Developer, session 10072)
   https://developer.apple.com/videos/play/wwdc2023/10072/

3. **WWDC23 — "Design considerations for vision and motion"** (Apple Developer, session 10078)
   https://developer.apple.com/videos/play/wwdc2023/10078/

4. **WWDC23 — "Elevate your windowed app for spatial computing"** (Apple Developer, session 10110)
   https://developer.apple.com/videos/play/wwdc2023/10110/

5. **WWDC22 — "Complications and widgets: Reloaded"** (Apple Developer, session 10050)
   https://developer.apple.com/videos/play/wwdc2022/10050/

6. **Apple HIG — Designing for visionOS** (Apple Developer)
   https://developer.apple.com/design/human-interface-guidelines/designing-for-visionos

7. **Apple HIG — Ornaments** (Apple Developer)
   https://developer.apple.com/design/human-interface-guidelines/ornaments

8. **Apple HIG — Complications** (Apple Developer)
   https://developer.apple.com/design/human-interface-guidelines/complications

9. **Liquid Glass — Wikipedia** (history, Craig Federighi quote, platform rollout)
   https://en.wikipedia.org/wiki/Liquid_Glass

10. **watchOS 26 roundup — MacRumors** (Liquid Glass on watchOS specifics)
    https://www.macrumors.com/roundup/watchos-26/

11. **visionOS ornaments in SwiftUI — Swift with Majid** (code reference)
    https://swiftwithmajid.com/2024/01/30/visionos-ornaments-in-swiftui/

12. **Spatial SwiftUI: glassBackgroundEffect — Step Into Vision** (code reference)
    https://stepinto.vision/example-code/spatial-swiftui-glassbackgroundeffect/

13. **Exploring immersive spaces in visionOS — Create with Swift** (code reference)
    https://www.createwithswift.com/exploring-immersive-spaces-in-visionos/

14. **watchOS complications tutorial — Kodeco / Cain Luo mirror** (complication code reference)
    https://cainluo.github.io/watchOS%20With%20SwiftUI%20by%20Tutorials/en/9.Complications/

15. **Designing for Apple Watch: design rules & metrics — Moldstud**
    https://moldstud.com/articles/p-how-to-design-user-friendly-interfaces-for-apple-watch-apps-essential-tips-and-best-practices

16. **Complication design dos and don'ts — Moldstud**
    https://moldstud.com/articles/p-the-ultimate-guide-to-designing-complications-for-apple-watch-dos-and-donts

17. **Developing for visionOS — Igor Tarantino / Medium** (window/immersive space code)
    https://medium.com/@igor.tarantino/developing-for-visionos-open-and-dismiss-windows-and-immersive-spaces-79904ae5dcd1

18. **The complete guide to designing for visionOS — Think Design**
    https://think.design/blog/the-complete-guide-to-designing-for-visionos/

19. **Apple Spatial Design — Frame Sixty**
    https://framesixty.com/apple-vision-pro-spatial-design/

20. **Designing for spatial continuity (2026 update) — Bolder Apps**
    https://www.bolderapps.com/blog-posts/designing-for-spatial-continuity-how-to-port-mobile-apps-to-visionos-and-meta-quest-4-in-2026

---

CONFIDENCE: 82% — Core visionOS principles and metrics are directly sourced from WWDC23 video content; watchOS metrics are drawn from third-party HIG summaries rather than live Apple HIG pages (which returned empty during fetch), so complication pixel dimensions and some interaction timings are single-source and should be verified against current Apple HIG before production use.
