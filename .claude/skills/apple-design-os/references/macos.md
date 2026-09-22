# macOS Design Reference

Scope: macOS surface anatomy, interaction model, and Liquid Glass (macOS 26 Tahoe) — for faithful native-style implementation and marketing mockups.

---

## Principles

### 1. Pointer Precision, Not Touch Tolerance
macOS is designed for a cursor with sub-pixel precision. Controls can be small because users don't need to land a fingertip. The minimum meaningful hit target on Mac is ~16–20 pt [documented]; compare iOS's 44 pt mandate. This enables information density that mobile cannot match: toolbars with 8+ items, compact inspector panels, multi-column layouts as the default rather than the exception.

### 2. The Menu Bar Is the Global Command Surface
Unlike every other major OS, macOS has ONE menu bar that belongs to the frontmost app, anchored to the top of the display. This is load-bearing architecture: every discoverable command must live here. Users learn apps by reading menus. Keyboard shortcuts are exposed here and nowhere else by default. Hiding this model (building an app with no menu bar, or a hamburger menu instead) breaks the platform contract and confuses experienced Mac users. [documented]

### 3. Windows Are First-Class Objects
Mac users can have dozens of windows open simultaneously, resize them freely, arrange them across spaces, and switch between them via Cmd+Tab or Expose/Mission Control. Windows are not "screens" — they coexist spatially. This means: content must make sense when partially obscured, z-ordering matters, and panels/inspectors should be non-modal where possible. [documented]

### 4. Information Density as a Feature
Mac apps consistently pack more into less space than their iOS counterparts. Sidebars show 20+ items without scrolling. Inspectors show granular attribute panels. This density is intentional: the target user has a large display and a precise pointer. Designing a "mobile-friendly" Mac app that wastes screen real estate reads as amateur. [observed]

### 5. Keyboard as a Peer to Mouse
Every action should be keyboard-accessible via a menu (which implies a keyboard shortcut). Tab/Shift+Tab cycles through controls. The menu bar is keyboard-navigable via Control+F2. macOS expects power users to live in keyboard shortcuts. This is NOT an accessibility afterthought — it is core UX. [documented]

---

## Apple Specifics

### Design History — Why It Looks This Way

| Era | Period | Character |
|-----|--------|-----------|
| **Aqua** | 2001–2013 | Skeuomorphic. Liquid droplet buttons, brushed aluminum, pinstripes, linen, leather. Steve Jobs: "when you saw it you wanted to lick it." |
| **Flat + Vibrancy** | 2013–2020 | OS X Mavericks + Yosemite. iOS 7 influence. Frosted-glass vibrancy (`.NSVisualEffectView`) replaced fake textures. Icons flattened. |
| **Big Sur** | 2020 | First major redesign in 7 years. iOS/macOS design language converged. Squircle icons, floating rounded Dock, full-height sidebars, rounded window corners, lighter chrome. Removed title bar line between sidebar and toolbar. |
| **Liquid Glass (Tahoe 26)** | 2025– | Biggest redesign since 2013. Translucent glass material across toolbar, sidebar, Dock, menu bar. Transparent menu bar by default. Controls taller. New Extra Large size. Corner radii increased. Sidebars float above content. |

[documented — Apple Newsroom, Wikipedia macOS Tahoe, Six Colors review]

---

### Window Anatomy

#### Traffic Light Buttons (Close / Minimize / Zoom)

The three colored orbs at the top-left of every window are officially called "window control buttons." [documented]

| Property | Value | Confidence |
|----------|-------|-----------|
| Button diameter | ~12–14 pt (appears ~12 pt on standard display) | [inferred/observed — SVG reverse-engineer] |
| Spacing between buttons | ~8 pt center-to-center | [inferred/observed] |
| Distance from left window edge | ~20 pt to first button center | [inferred/observed — Electron's default `trafficLightPosition: {x:20}` matches system] |
| Distance from top window edge | ~7–9 pt (vertically centered in title bar) | [inferred/observed] |
| Title bar height (title-bar-only window) | ~22 pt | [inferred — smaller corner radius variant per WWDC25] |
| Unified toolbar height (icon-only) | ~34–38 pt | [inferred/observed] |
| Unified toolbar height (with label) | ~52 pt | [inferred/observed] |

**Colors** [observed — lwouis/macos-traffic-light-buttons-as-SVG]:

| State | Red fill | Yellow fill | Green fill |
|-------|----------|-------------|------------|
| Normal | `#ed6a5f` | `#f6be50` | `#61c555` |
| Normal border | `#e24b41` | `#e1a73e` | `#2dac2f` |
| Unfocused (window inactive) | `#dddddd` | `#dddddd` | `#dddddd` |
| Unfocused border | `#d1d0d2` | `#d1d0d2` | `#d1d0d2` |
| Hover symbol color | `#460804` | `#90591d` | `#2a6218` |

Hover reveals symbols: Red = ×, Yellow = −, Green = + (or ⤢ full-screen). [observed]

#### Window Chrome in macOS 26 Tahoe

- **Larger corner radius** on toolbar windows; the outer corner concentrically wraps the glass toolbar. [documented — WWDC25 session 310]
- **Smaller corner radius** on title-bar-only windows. [documented]
- **Scroll edge effect**: automatic fade/blur beneath floating toolbar and sidebar glass. [documented]
- **`cornerConcentric` shape**: SwiftUI/AppKit provide APIs to align content corner radii with the window's outer radius. [documented]

#### Toolbar Styles (AppKit `NSWindow.toolbarStyle`)

| Style | Appearance |
|-------|-----------|
| `.unified` | Title and toolbar items share the same row. Most common in macOS 11+ apps. |
| `.unifiedCompact` | Shorter height variant; used in apps like Terminal. |
| `.expanded` | Traditional — title row above toolbar row. Rarely used now. |
| `.preference` | Used in Settings/Preferences windows with icon+label tabs. |
| `.automatic` | System picks based on window content. |

[documented — Apple Developer Docs]

In macOS 26, toolbar items float on a glass surface that **adapts to the content behind it**, automatically switching between light and dark appearance. AppKit groups adjacent button-type items onto a single glass piece automatically. [documented — WWDC25 session 310]

```swift
// AppKit — remove glass from non-interactive labels
toolbarItem.isBordered = false

// Apply accent tint to a prominent action
toolbarItem.style = .prominent

// Add a badge
toolbarItem.badge = NSItemBadge.count(4)

// Revert to pre-Tahoe control sizing if needed
view.prefersCompactControlSizeMetrics = true
```

---

### Sidebars

Sidebars are the primary navigation surface for Mac apps — the leading (left) column showing sections, collections, or libraries. [documented]

| Property | Pre-Tahoe | macOS 26 Tahoe |
|----------|-----------|----------------|
| Material | `NSVisualEffectView` `.sidebar` vibrancy | Floats as glass pane above content |
| Visual position | Integrated into window frame | Appears to float above content |
| Width (typical) | 200–260 pt | Same [observed] |
| Row height | 24–28 pt | Slightly taller [documented] |
| Icon size in rows | 16×16 pt SF Symbol | 16×16 pt [observed] |
| Collapse shortcut | Cmd+Ctrl+S | Same |

**Tahoe sidebar ambient reflection**: the sidebar glass reflects nearby colorful content from the wallpaper, similar to iPad. [documented — Apple Newsroom]

AppKit implementation: use `NSSplitViewController` with a split item set to `.sidebar` behavior; AppKit applies the correct glass material automatically. Remove any `NSVisualEffectView` you added manually — it will block the new glass. [documented — WWDC25 session 310]

```swift
// SwiftUI
NavigationSplitView {
    List(sections, id: \.self) { section in
        Label(section.title, systemImage: section.icon)
    }
    .navigationTitle("Library")
} content: {
    ContentListView()
} detail: {
    DetailView()
}
```

**Inspectors** (opposite edge from sidebar): use edge-to-edge glass that sits *alongside* content, not floating above it. [documented — WWDC25 session 310]

```swift
// SwiftUI inspector panel
.inspector(isPresented: $showInspector) {
    InspectorContent()
        .inspectorColumnWidth(min: 180, ideal: 260, max: 400)
}
// Enable Cmd+Ctrl+I shortcut
.commands { InspectorCommands() }
```

---

### Menu Bar and Menus

**The always-present menu bar** spans the full width of the display and shows the frontmost app's menus. [documented]

Required menu structure for any Mac app [documented]:
1. **App menu** (bold, named after the app) — About, Settings/Preferences, Services, Hide, Quit
2. **File** — New, Open, Close, Save, Export, Print (omit if not document-based)
3. **Edit** — Undo, Redo, Cut, Copy, Paste, Select All, Find
4. **View** — Show/hide toolbars, sidebars, zoom
5. **Window** — Minimize, Zoom, Tile, Bring All to Front, list of open windows
6. **Help** — Search, app-specific help

App-specific menus go between Edit and Window.

**macOS 26 Tahoe menu bar changes** [documented]:
- Fully transparent by default — wallpaper shows through, icon/text color adapts (white or black) for legibility
- Users can restore the background in System Settings > Menu Bar > "Show menu bar background"
- Menu dropdowns retain their glass material for readability
- Menu items now prominently feature SF Symbol icons on their leading edge, forming a scannable column [documented — WWDC25 session 310]
- Control Center completely redesigned; third-party apps can contribute to it

**Context menus** (right-click / Ctrl+click / two-finger tap) follow the same icon-column convention in Tahoe. [documented]

---

### Dock

| Property | Value | Confidence |
|----------|-------|-----------|
| Default icon size | 48 pt (user-adjustable 16–128 pt) | [observed — macOS defaults] |
| Dock background | Liquid Glass in Tahoe; previously frosted dark pill | [documented] |
| Position | Bottom by default; can be left or right | [documented] |
| Squircle icon shape | Enforced from Big Sur 2020 | [documented] |
| Magnification | Off by default; on = icons scale up to ~128 pt on hover | [observed] |

---

### Sheets, Popovers, and Alerts

| Surface | Mac Behavior | When to Use |
|---------|-------------|-------------|
| **Sheet** | Slides down from title bar of the parent window; blocks that window only (document-modal, not app-modal) | Scoped task directly related to current document (Save As, Export, Print) |
| **Alert / Dialog** | Centered floating window, blocks the app; or attached as sheet | Destructive confirmations, errors requiring acknowledgment |
| **Popover** | Small floating view anchored to a control via a callout arrow; non-modal | Supplementary options/info; dismisses on click-outside |
| **Inspector/Panel** | Persistent side panel; floating utility window | Ongoing attribute editing (e.g., Xcode inspector, Keynote inspector) |

In macOS 26, partial-height sheets get automatic Liquid Glass background; remove custom `presentationBackground` to get the system default. [documented — WWDC25 session 323]

---

### Materials and Vibrancy

`NSVisualEffectView` materials [documented — Apple Developer Docs]:

| Material | Intended Surface |
|----------|-----------------|
| `.sidebar` | Sidebar background |
| `.menu` | Menu dropdowns |
| `.popover` | Popover chrome |
| `.titlebar` | Title bar tinting |
| `.headerView` | Table/outline header rows |
| `.sheet` | Sheet backgrounds |
| `.windowBackground` | Full window background |
| `.tooltip` | Tooltip bubbles |
| `.contentBackground` | Content area background |
| `.hudWindow` | Dark HUD panels |

**Blending modes**: `.behindWindow` (blurs what's behind the window — most common); `.withinWindow` (blurs within the window only).

In macOS 26, sidebars and toolbars now use `NSGlassEffectView` / `.glassEffect()` instead of `NSVisualEffectView`. The old vibrancy still works but does not gain the new Liquid Glass appearance. [documented — WWDC25 session 310]

---

### Pointer-First Interaction Model

- **Hover states**: buttons reveal labels or highlight on hover; this is reliable and expected on Mac. Build hover-triggered UI freely. [documented]
- **Cursor changes**: system cursors (`NSCursor`) communicate affordances — resize cursor on window edge, I-beam on text, crosshair for drawing, pointer hand for links. [documented]
- **Right-click context menus**: always present the most relevant commands for the clicked object. In Tahoe, these feature icon columns. [documented]
- **Drag-and-drop**: first-class citizen on Mac. Files, text, images can be dragged between app windows. Every content surface should support it where logical. [documented]
- **Window resize**: any window edge is draggable. Apps should handle arbitrary window sizes gracefully — no fixed-width layouts that break on resize. [documented]
- **Keyboard shortcuts**: Cmd+key is the primary shortcut space. Shift+Cmd for variants. Option+Cmd for alternate behaviors. Ctrl is used for system shortcuts (F-keys). Always expose shortcuts in menu items. [documented]

---

## Recipes

### SwiftUI — Full Mac App with Sidebar, Toolbar, and Inspector

```swift
import SwiftUI

@main
struct MacApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: true))

        // Settings window (Cmd+,)
        Settings {
            SettingsView()
        }
    }
}

struct ContentView: View {
    @State private var selectedSection: Section? = .library
    @State private var selectedItem: Item? = nil
    @State private var showInspector = false

    var body: some View {
        NavigationSplitView {
            // Sidebar — Liquid Glass in Tahoe automatically
            List(Section.allCases, id: \.self, selection: $selectedSection) { section in
                Label(section.rawValue, systemImage: section.icon)
            }
            .navigationTitle("Catalog")
            .navigationSplitViewColumnWidth(min: 180, ideal: 220)
        } content: {
            ItemListView(section: selectedSection, selection: $selectedItem)
                .navigationSplitViewColumnWidth(min: 280, ideal: 340)
        } detail: {
            DetailView(item: selectedItem)
                .inspector(isPresented: $showInspector) {
                    InspectorView(item: selectedItem)
                        .inspectorColumnWidth(min: 180, ideal: 260, max: 380)
                }
                .toolbar {
                    ToolbarSpacer(.fixed)          // Group separator
                    ToolbarItem(placement: .primaryAction) {
                        Button("Add", systemImage: "plus") { }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            showInspector.toggle()
                        } label: {
                            Label("Inspector", systemImage: "sidebar.trailing")
                        }
                    }
                }
        }
        .commands {
            InspectorCommands()   // Adds Cmd+Ctrl+I shortcut
            SidebarCommands()     // Adds Cmd+Ctrl+S shortcut
        }
    }
}

enum Section: String, CaseIterable {
    case library = "Library"
    case recent  = "Recent"
    case starred = "Starred"

    var icon: String {
        switch self {
        case .library: return "books.vertical"
        case .recent:  return "clock"
        case .starred: return "star"
        }
    }
}
```

### SwiftUI — Liquid Glass Buttons (Tahoe)

```swift
// Secondary action
Button("Cancel") { }
    .buttonStyle(.glass)

// Primary action
Button("Confirm") { }
    .buttonStyle(.glassProminent)
    .tint(.accentColor)

// Custom glass card
Text("User Info")
    .padding()
    .glassEffect(in: RoundedRectangle(cornerRadius: 12))

// Grouped glass elements (share a single sampling region)
GlassEffectContainer {
    HStack(spacing: 12) {
        Button("Edit", systemImage: "pencil") { }
        Button("Share", systemImage: "square.and.arrow.up") { }
    }
}
```

### AppKit — NSGlassEffectView and Toolbar

```swift
import AppKit

// Single glass container
let glassView = NSGlassEffectView()
glassView.contentView = myContentView
glassView.cornerRadius = 10

// Grouped glass (avoids glass-on-glass sampling)
let stack = NSStackView(views: [glassA, glassB])
stack.orientation = .horizontal
let container = NSGlassEffectContainerView()
container.contentView = stack
container.spacing = 8   // threshold for fluid joining/separating

// Glass bezel button
let btn = NSButton()
btn.bezelStyle = .glass
btn.bezelColor = NSColor.systemBlue

// Tint prominence on controls
shuffleButton.tintProminence = .secondary
playButton.tintProminence = .primary
```

### CSS — Mac Window Chrome Mockup

A faithful marketing mockup of a macOS window with Liquid Glass toolbar. Tested in Chrome/Safari/Firefox. Measurements are [inferred/observed] — close but not pixel-perfect to system.

```css
/* ─── Reset & scene ─────────────────────────── */
.mac-scene {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: linear-gradient(135deg, #1a6ee0 0%, #a84cf7 100%);
  /* simulates macOS wallpaper behind transparent window */
}

/* ─── Window shell ───────────────────────────── */
.mac-window {
  width: 720px;
  border-radius: 12px;          /* ~12pt system corner radius */
  overflow: hidden;
  box-shadow:
    0 32px 64px rgba(0,0,0,0.45),
    0 2px 4px rgba(0,0,0,0.2),
    inset 0 0 0 0.5px rgba(255,255,255,0.18);
  font-family: -apple-system, "SF Pro Text", BlinkMacSystemFont, sans-serif;
}

/* ─── Toolbar (Liquid Glass style) ───────────── */
.mac-toolbar {
  display: flex;
  align-items: center;
  height: 38px;                  /* unified toolbar height [inferred] */
  padding: 0 12px;
  gap: 8px;
  background: rgba(255,255,255,0.18);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border-bottom: 0.5px solid rgba(255,255,255,0.22);
  /* Subtle top highlight (glass edge) */
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.30);
}

/* ─── Traffic lights ─────────────────────────── */
.mac-traffic-lights {
  display: flex;
  align-items: center;
  gap: 8px;                      /* spacing between circles [inferred] */
  margin-right: 8px;
}

.mac-tl {
  width: 12px;                   /* diameter [inferred] */
  height: 12px;
  border-radius: 50%;
  cursor: pointer;
  transition: filter 0.15s ease;
  position: relative;
}
.mac-tl::after {
  /* symbol on hover */
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.15s;
}
.mac-traffic-lights:hover .mac-tl::after { opacity: 1; }

.mac-tl.close  { background: #ed6a5f; box-shadow: 0 0 0 0.5px #e24b41; }
.mac-tl.min    { background: #f6be50; box-shadow: 0 0 0 0.5px #e1a73e; }
.mac-tl.zoom   { background: #61c555; box-shadow: 0 0 0 0.5px #2dac2f; }

/* Inactive state (e.g., when window not focused) */
.mac-window.inactive .mac-tl {
  background: #dddddd;
  box-shadow: 0 0 0 0.5px #d1d0d2;
}

/* ─── Window title ───────────────────────────── */
.mac-title {
  flex: 1;
  text-align: center;
  font-size: 13px;
  font-weight: 590;             /* SF Pro medium weight */
  color: rgba(0,0,0,0.75);
  letter-spacing: -0.01em;
  pointer-events: none;
}

/* ─── Toolbar action buttons (glass pill style) ─ */
.mac-toolbar-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 20px;
  background: rgba(255,255,255,0.25);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 0.5px solid rgba(255,255,255,0.40);
  font-size: 12px;
  font-weight: 500;
  color: rgba(0,0,0,0.70);
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
  box-shadow:
    0 1px 3px rgba(0,0,0,0.12),
    inset 0 1px 0 rgba(255,255,255,0.5);
}
.mac-toolbar-btn:hover {
  background: rgba(255,255,255,0.38);
  transform: scale(1.02);
}
.mac-toolbar-btn:active {
  transform: scale(0.97);
}

/* ─── Content area ───────────────────────────── */
.mac-content {
  display: flex;
  min-height: 400px;
}

/* ─── Sidebar ────────────────────────────────── */
.mac-sidebar {
  width: 200px;
  background: rgba(255,255,255,0.10);
  backdrop-filter: blur(30px) saturate(150%);
  -webkit-backdrop-filter: blur(30px) saturate(150%);
  border-right: 0.5px solid rgba(255,255,255,0.18);
  padding: 12px 0;
}

.mac-sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 16px;
  font-size: 13px;
  color: rgba(0,0,0,0.65);
  border-radius: 6px;
  margin: 1px 6px;
  cursor: pointer;
  transition: background 0.12s;
}
.mac-sidebar-item:hover   { background: rgba(0,0,0,0.06); }
.mac-sidebar-item.active  {
  background: rgba(0,122,255,0.15);
  color: #007aff;
  font-weight: 500;
}

/* ─── Main content ───────────────────────────── */
.mac-main {
  flex: 1;
  background: rgba(255,255,255,0.75);
  padding: 20px;
  font-size: 13px;
  color: #1c1c1e;
}
```

**HTML structure:**

```html
<div class="mac-scene">
  <div class="mac-window">
    <div class="mac-toolbar">
      <div class="mac-traffic-lights">
        <div class="mac-tl close"></div>
        <div class="mac-tl min"></div>
        <div class="mac-tl zoom"></div>
      </div>
      <span class="mac-title">My App — Document</span>
      <button class="mac-toolbar-btn">＋ Add</button>
      <button class="mac-toolbar-btn">Share</button>
    </div>
    <div class="mac-content">
      <nav class="mac-sidebar">
        <div class="mac-sidebar-item active">📚 Library</div>
        <div class="mac-sidebar-item">🕐 Recent</div>
        <div class="mac-sidebar-item">⭐ Starred</div>
      </nav>
      <main class="mac-main">
        <!-- app content -->
      </main>
    </div>
  </div>
</div>
```

> **Note on the CSS mockup**: `backdrop-filter` requires the elements *behind* the glass to be visible through a parent that is not `overflow:hidden` at the wrong level. Test in Chrome or Safari — Firefox support for `backdrop-filter` on non-body elements can require the experimental flag in older builds. [observed]

---

## Faithful Replication

### For Native Apps (SwiftUI / AppKit)

1. **Use `NSSplitViewController`** with `.sidebar` and `.inspector` behaviors — AppKit auto-applies the correct glass material in Tahoe. Do not add `NSVisualEffectView` manually to sidebars.
2. **Remove custom toolbar backgrounds** — any `backgroundColor` on a toolbar view blocks the scroll-edge blur effect.
3. **Build with Xcode 26** — many Liquid Glass behaviors activate automatically at compile time with the Tahoe SDK.
4. **Audit hard-coded heights** — Tahoe control heights changed slightly. Use Auto Layout; never hard-code `frame.height = 22` for a control.
5. **Use `cornerConcentric`** for buttons near the bottom of sheets or inside containers — this keeps radii visually nested.
6. **Prefer monochrome SF Symbols** in toolbars; add `.tint()` only to convey semantic meaning (e.g., green = safe, red = destructive), not for decoration.
7. **Add icon badges** via `NSItemBadge.count(n)` / `.badge()` modifier — do not roll custom badge overlays.

### For Marketing Mockups / Web "Mac App" Framing

Key decisions for visual credibility:

| Detail | Right | Wrong |
|--------|-------|-------|
| Traffic lights | Three circles, left-aligned, 12 pt, gap 8 pt, correct colors | Squares, right-aligned, wrong colors, or only one/two circles |
| Title | Centered in toolbar, SF font weight ~590 (medium), not bold | Left-aligned, wrong font, too large |
| Window radius | ~12 pt outer | Straight corners or over-rounded (>20 pt looks iOS) |
| Toolbar | Glass/frosted, subtle highlight on top edge | Solid opaque color, no translucency |
| Sidebar | Translucent leading column, row items with icons | Solid white, no vibrancy, mobile-style nav |
| Content bg | White or very light gray | Full-bleed gradient (that's a mobile pattern) |
| Drop shadow | Soft, large, ~30–50 pt blur, rgba(0,0,0,0.35–0.50) | Hard pixel shadow, or no shadow |
| Window border | Hairline 0.5 px rgba white inset | Thick visible border, or none |

For macOS 26 mockups specifically: make the toolbar and sidebar glass areas genuinely transparent against your wallpaper background — the new aesthetic relies on seeing the wallpaper through chrome. A solid-color toolbar reads as pre-Tahoe.

---

## Anti-Patterns

### 1. Oversized Touch Targets
Minimum meaningful Mac click target: ~16–20 pt. Using 44 pt iOS-mandated targets wastes screen real estate and makes the app look designed for touch, not pointer. [documented]

### 2. Hamburger Menu Instead of the Menu Bar
There is no situation on macOS where a hamburger menu is appropriate. The system menu bar is always there, discoverable, and keyboard-navigable. Using a hamburger hides your app's commands and removes keyboard shortcut discoverability. [documented]

### 3. No Keyboard Shortcuts
Every primary action should have a Cmd+ shortcut exposed in the menu bar. Apps that are mouse-only frustrate power users who expect to live in the keyboard. [documented]

### 4. Fake Traffic Lights with Wrong Metrics
Common errors in web mockups:
- Buttons too large (>16 pt diameter) or too small (<10 pt)
- Too much or too little gap (correct: ~8 pt center-to-center)
- Right-aligned instead of left
- All three the same color (inactive state only)
- Missing the hover-to-reveal symbol behavior
- No unfocused/inactive dim state when "window" is not active
[inferred/observed]

### 5. Mobile Navigation Patterns (Tab Bar at Bottom)
Bottom tab bars are an iOS convention. macOS navigation lives in the sidebar (leading column) and the menu bar. A bottom tab bar on Mac reads as an Electron app poorly ported from mobile. [documented]

### 6. Full-Screen-Only Design
Mac apps must be usable in arbitrary window sizes. Designing only for a full-screen state breaks the spatial document model. Users tile, snap, and overlap windows constantly. [documented]

### 7. Ignoring the Menu Bar During Content Scrolling
On macOS 26, the menu bar is transparent and overlays the wallpaper. If you control the window content and it scrolls very close to the menu bar region (full-bleed apps), ensure content legibility doesn't depend on the menu bar area being a distinct color. [observed — Six Colors review noting legibility challenges]

### 8. Overusing Liquid Glass Depth
Liquid Glass is for top-level floating elements: toolbars, sidebars, Dock, system chrome. Using `NSGlassEffectView` for every card and button creates noise. Apple's guidance: limit to elements that genuinely float above the main content layer. [documented — WWDC25 session 310 best practices]

### 9. Glass-on-Glass Without a Container
If two glass elements overlap or sit adjacent, they must be wrapped in `NSGlassEffectContainerView` / `GlassEffectContainer`. Glass cannot sample through other glass — the visual result is undefined/broken without the container. [documented — WWDC25 sessions 310 & 323]

### 10. Hard-Coding Control Heights After Tahoe
Mini, small, and medium controls are slightly taller in Tahoe. Any layout that assumed the old pixel height will misalign. Use Auto Layout anchors, not `frame.height`. [documented — WWDC25 session 310]

---

## Sources

- [Apple Newsroom — Liquid Glass design announcement, June 2025](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
- [WWDC25 Session 310 — Build an AppKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/310/)
- [WWDC25 Session 323 — Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/)
- [Wikipedia — macOS Tahoe](https://en.wikipedia.org/wiki/MacOS_Tahoe)
- [Six Colors — macOS 26 Tahoe Review: Power under glass](https://sixcolors.com/post/2025/09/macos-26-tahoe-review-power-under-glass/)
- [Apple Developer — Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)
- [Apple Developer — NSVisualEffectView.Material](https://developer.apple.com/documentation/appkit/nsvisualeffectview/material)
- [Apple Developer — NSWindow.ToolbarStyle.unified](https://developer.apple.com/documentation/appkit/nswindow/toolbarstyle-swift.enum/unified)
- [lwouis/macos-traffic-light-buttons-as-SVG (color reverse-engineering)](https://github.com/lwouis/macos-traffic-light-buttons-as-SVG)
- [Electron Custom Title Bar docs (Electron traffic light position defaults)](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [DEV Community — Liquid Glass in Swift: Official Best Practices](https://dev.to/diskcleankit/liquid-glass-in-swift-official-best-practices-for-ios-26-macos-tahoe-1coo)
- [Create with Swift — Exploring NavigationSplitView](https://www.createwithswift.com/exploring-the-navigationsplitview/)
- [Create with Swift — Presenting an Inspector with SwiftUI](https://www.createwithswift.com/presenting-an-inspector-with-swiftui/)
- [MacRumors — macOS Tahoe design announcement](https://www.macrumors.com/2025/06/09/apple-unveils-macos-tahoe-26/)
- [Wikipedia — Aqua (user interface) design history](https://en.wikipedia.org/wiki/Aqua_(user_interface))
- [Medium — The Design of macOS Big Sur (Lars Augustin)](https://medium.com/futureproofd/the-design-of-macos-big-sur-fe9db098b651)
- [DEV Community — Recreating Apple's Liquid Glass Effect with Pure CSS](https://dev.to/kevinbism/recreating-apples-liquid-glass-effect-with-pure-css-3gpl)
- [macOS defaults — Dock icon size](https://macos-defaults.com/dock/tilesize.html)

---

CONFIDENCE: 78% — Core design principles, Tahoe APIs, and color specs are well-documented; exact traffic-light pixel measurements and precise pre-Tahoe title bar heights remain inferred from community reverse-engineering and Electron defaults rather than official Apple documentation.
