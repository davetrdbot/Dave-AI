# Apple Navigation & Presentation Models — Decision Framework
Scope: functional/technical decision rules for choosing and combining iOS/iPadOS/macOS navigation and presentation patterns; color and visual design excluded.

---

## Principles

These transfer across platforms and technology stacks:

1. **Navigation is orientation.** At every moment the user must know where they are, how they got there, and how to get back. Titles, back-button labels, and hierarchy depth all serve this goal. [documented]

2. **Navigation is data, not imperative code.** Apple's modern APIs (NavigationStack with a bound path, NavigationSplitView with selection bindings) encode the current navigation state as a serializable value. This makes deep linking, state restoration, and programmatic navigation first-class features rather than hacks. [documented]

3. **Modality has a cost — pay it only when earned.** Switching a user into a modal context interrupts their flow. Reserve it for self-contained tasks that must be completed or abandoned before returning, or when you genuinely need to capture attention. Overuse erodes trust. [documented — Apple HIG Modality]

4. **Predictable back is non-negotiable.** Users must always be able to reach the previous context. The swipe-right edge gesture on iOS is a system contract, not a courtesy. Never disable or intercept it without providing a clearly labeled replacement. [documented — Apple HIG]

5. **State belongs to the user, not the session.** Return users to exactly where they were — same tab, same scroll position, same navigation depth. State restoration is an expectation, not a bonus. [documented — WWDC22 Nav session]

6. **Flat > deep.** A two-level hierarchy with well-chosen top-level sections (tabs/sidebar) scales better than a four-level drill-down. Every extra level multiplies the cognitive cost of orientation. [documented — HIG, WWDC22]

7. **Each layer has one job.** Tab bar = switch peer top-level sections. Push/pop = drill into a hierarchy. Sheet = a self-contained sub-task with its own lifecycle. Full-screen cover = full immersion. Popover = transient contextual detail. Mixing these roles confuses users. [documented]

---

## Apple Specifics

### 2.1 Hierarchical Push/Pop — NavigationStack

**What it is.** A stack of screens where each new screen slides in from the right; back button and edge-swipe return to the previous screen. [documented]

**When to use.**
- Content has a true parent-child relationship (inbox → message → attachment).
- Each level discloses more detail or options than its parent.
- Users will frequently navigate back as well as forward.
- The destination count is dynamic/data-driven (lists of unknown length). [documented — WWDC22]

**When NOT to use.**
- Peer sections with no parent-child relationship (use tab bar instead). [documented]
- Tasks the user should complete then dismiss (use sheet). [documented]
- More than ~3–4 levels deep; after that, reconsider the IA. [inferred from HIG and Frank Rausch analysis]

**Back behavior rules.** [documented — WWDC22, Apple HIG]
- The back button label always shows the TITLE of the previous screen, not a generic "Back."
- Edge-swipe (right from left edge) is a system gesture that mirrors the back button exactly; don't intercept it.
- Never show a save/confirm dialog on a back navigation from a push-navigation screen — that pattern belongs to sheets. Push navigation is modeless.

**NavigationStack code (SwiftUI — iOS 16+).**
```swift
// Value-based navigation — the modern pattern
enum Route: Hashable {
    case product(Product)
    case related(Product)
    case search(String)
}

struct RootView: View {
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            ProductListView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .product(let p):  ProductDetailView(p)
                    case .related(let p):  ProductDetailView(p.similar[0])
                    case .search(let q):   SearchResultsView(query: q)
                    }
                }
                .toolbar {
                    Button("Home") { path.removeAll() }   // pop-to-root
                }
        }
        // Deep link via URL scheme
        .onOpenURL { url in
            if let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "q" })?.value {
                path.append(.search(query))
            }
        }
    }
}
```
[documented — Swift with Majid, Apple developer docs]

**Anti-pattern: defining path at the App level** (shared across all scenes) breaks multi-window support. Define path inside a View with @State or a scene-scoped @StateObject. [documented — Swift with Majid]

---

### 2.2 Sheets + Detents

**What it is.** A modal card that slides up from the bottom. It can be presented at a fixed or resizable height via `presentationDetents`. [documented — Apple HIG Sheets, iOS 16+]

**When to use.**
- Self-contained sub-tasks the user initiates and returns from: compose a reply, add a calendar event, configure a filter. [documented]
- The task is short and focused — HIG: "simple, short, and narrowly focused." [documented]
- Users need to return to the originating context after finishing, so the previous screen should remain visually present (the peeking card). [documented]
- Medium detent is appropriate when the task needs only partial-screen height (e.g., a quick filter picker). [documented]

**When NOT to use.**
- As a substitute for push navigation within a hierarchy. [documented]
- For purely informational content with no action to complete — use push or an inline expansion instead. [inferred]
- Stacking sheet-over-sheet more than one level deep (HIG: avoid creating a hierarchy of modal views). [documented]

**Detents (iOS 16+).**
```swift
.sheet(isPresented: $showCompose) {
    ComposeView()
        .presentationDetents([.medium, .large])   // drag handle appears automatically
        .presentationDragIndicator(.visible)
        // .presentationDetents([.fraction(0.35)]) — 35% height for quick pickers
        // .presentationDetents([.height(240)])     — exact pixel height
        .presentationBackgroundInteraction(.enabled(upThrough: .medium)) // allow background tap at medium
}
```
[documented — Apple docs, Sarunw, nilcoalescing]

- `.medium` = ~50% screen; inactive in compact height (landscape iPhone). [documented]
- When multiple detents given, SwiftUI adds a drag indicator automatically. [documented]
- `presentationBackgroundInteraction` lets users tap the underlying content at certain detent heights — useful for map/filter combos. [documented]

**Done / Cancel button rules (sheets).** [documented — WWDC22 Nav session, Apple HIG]
- **Right side of nav bar = primary action**: "Save," "Create," "Add" — bold, disabled until valid state.
- **Left side = Cancel** — explicitly labeled. Never use X/close icon when the user has entered data (X implies "view" dismissal, not "edit" dismissal).
- Use X only on view-only sheets with no text input (e.g., article reader).
- Tapping Cancel when the user has unsaved changes MUST show a confirmation: "Discard Changes?" with a destructive "Discard" action. Never silently discard. [documented — WWDC22]
- Completion action (Save/Create) dismisses the sheet automatically; no need for a separate "Done." [documented]

---

### 2.3 Full-Screen Cover

**What it is.** A modal that takes over the entire screen, including the status bar area, covering tab bars and navigation bars. On SwiftUI: `.fullScreenCover`. [documented]

**When to use.**
- Immersive media experiences: video playback, camera/scanner, AR. [documented]
- Onboarding flows, authentication, paywalls — flows that must gate access to the app. [documented]
- Multi-step wizards where partial-screen would feel cramped and where the user should not accidentally dismiss mid-flow. [documented — HIG Modality]

**When NOT to use.**
- Routine sub-tasks (use sheet with detents instead). [documented]
- As a lazy substitute for a push-navigation destination. [inferred]

**Key difference from sheet.** Full-screen cover CANNOT be dismissed by dragging. You MUST provide an explicit "Done," "Close," or navigation-back control. [documented — Hacking with Swift, Apple HIG]

```swift
.fullScreenCover(isPresented: $showCamera) {
    CameraView()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { showCamera = false }
            }
        }
}
```
[documented]

---

### 2.4 Modal vs. Non-Modal — The Attention Trap Rule

**Modal (focus-trapping) contexts are justified when ALL of the following hold:** [documented — Apple HIG Modality]
1. The task is self-contained and has a clear completion condition.
2. It must be completed or consciously abandoned before the user continues.
3. Returning to the previous context with no decision would cause data loss or confusion.

**Non-modal overlays** (action menus, non-blocking popovers, inline expandable cards) are preferred when the user just needs more options or detail without committing to a sub-task. [documented — Frank Rausch analysis]

**Never use modality for:**
- Navigation between main sections of the app. [documented]
- Displaying information the user may need to reference while doing something else. [documented]
- Error messages that don't require an action. [documented — Apple HIG]
- More than one level of stacked modals. [documented — Apple HIG: "don't display a modal view above a popover"; same spirit applies to modal stacks]

---

### 2.5 Tab Bars

**What it is.** A persistent row of icons at the bottom of the screen (iPhone) or a sidebar (iPad landscape) providing instant access to top-level sections. [documented — Apple HIG, WWDC22]

**When to use.**
- The app has 2–5 peer, top-level sections — each independently useful, none more important than another. [documented]
- Users need to frequently switch between sections without losing their place in each. [documented]
- Each section has clearly distinct content, not overlapping features. [documented — WWDC22]

**Rules.** [documented — Apple HIG, WWDC22]
- **Minimum 2, maximum 5 tabs.** Beyond 5, iOS shows a "More" tab — a fallback, not a target; if you reach it, restructure your IA. [documented]
- **Never hide the tab bar** during push navigation within a tab (HIG: it should remain visible). [documented — WWDC22]
- **Never auto-navigate** users between tabs programmatically without explicit user intent. [documented — WWDC22]
- **Tabs are not actions.** Tab bar items should not trigger sheets or immediate actions — selecting a tab changes the active section. [documented — Frank Rausch]
- **Each tab preserves its own navigation state** independently. Switching from Tab A to Tab B and back returns to the same position in Tab A. [documented — WWDC22]
- **Do not duplicate features across tabs** or create a "Home" tab that consolidates features that live in other tabs. [documented — WWDC22]
- Labels: concise nouns or short verb phrases; no generic labels like "More" for a real section.

```swift
TabView {
    FeedView()
        .tabItem { Label("Feed", systemImage: "newspaper") }
    SearchView()
        .tabItem { Label("Search", systemImage: "magnifyingglass") }
    LibraryView()
        .tabItem { Label("Library", systemImage: "books.vertical") }
    ProfileView()
        .tabItem { Label("Profile", systemImage: "person") }
}
```
[documented]

---

### 2.6 Split View / Columns — NavigationSplitView

**What it is.** Two- or three-column layout where selections in leading columns drive content in trailing columns. Automatically collapses to a NavigationStack-style stack on compact-width devices (iPhone, iPad Slide Over). [documented — Apple HIG Split Views, SwiftUI docs]

**When to use.**
- iPad or Mac apps with a primary list or sidebar and a detail pane (Mail, Notes, Settings). [documented]
- Three-column when the hierarchy is category → item list → detail (e.g., folders → messages → message body). [documented]
- As the preferred alternative to tab bars on iPad — "use a split view instead of a tab bar on iPad" per HIG. [documented — Apple HIG Split Views]

**When NOT to use.**
- iPhone-only apps (it collapses to a stack anyway, but design for compact width first). [documented]
- Flat, single-level content without a master-detail relationship. [inferred]

**Column visibility styles.** [documented — SwiftUI docs]
- `.automatic`: balanced (side-by-side) in landscape, prominent-detail (sidebar overlay) in portrait.
- `.all` / `.detailOnly` / `.doubleColumn`: programmatically control visibility for focus modes.

```swift
@State private var selection: Item?
@State private var columnVisibility = NavigationSplitViewVisibility.automatic

NavigationSplitView(columnVisibility: $columnVisibility) {
    // Sidebar — category list
    List(categories, selection: $selectedCategory) { category in
        Label(category.name, systemImage: category.icon)
    }
    .navigationTitle("Library")
} content: {
    // Content — item list driven by sidebar selection
    if let category = selectedCategory {
        List(category.items, selection: $selection) { item in
            Text(item.title)
        }
    }
} detail: {
    // Detail — driven by content selection
    if let item = selection {
        ItemDetailView(item: item)
    } else {
        Text("Select an item").foregroundStyle(.secondary)
    }
}
```
[documented — Swift with Majid, Hacking with Swift, SwiftUI docs]

**Collapse behavior.** In narrow width, SwiftUI collapses all columns into a NavigationStack and shows the deepest column with useful content. NavigationSplitView automatically wraps root views in a NavigationStack per column; nest explicit NavigationStack inside the detail column only for supplementary push navigation within that column. [documented]

---

### 2.7 Popovers

**What it is.** A floating overlay anchored by an arrow to the control that triggered it. Shows contextual options or information above the main content. [documented — Apple HIG Popovers]

**When to use.**
- iPad and macOS: transient contextual actions (share menu, sort options, color picker) anchored to a toolbar button or inline control. [documented]
- When the user needs to see — and possibly interact with — the underlying content while the overlay is visible. [documented]

**When NOT to use.**
- iPhone (compact width): the system converts popovers to action sheets automatically. Design for this transformation. [documented]
- Critical information requiring forced attention (use an alert). [documented]
- Hierarchical sub-menus layered inside popovers ("never show hierarchical popovers"). [documented — Apple HIG]

**Rules.** [documented — Apple HIG Popovers, iOS HIG archive]
- Show one popover at a time.
- Arrow must point at the triggering control; the popover must not cover the trigger or essential reference content.
- Dismiss on tap-outside (non-destructive contexts) or by explicit selection.
- Save state automatically if dismissing without a cancel button; only discard on explicit "Cancel." [documented]
- Never show another modal or sheet over an open popover. [documented — Apple HIG]

```swift
Button("Sort") { showSort = true }
    .popover(isPresented: $showSort, arrowEdge: .bottom) {
        SortOptionsView()
            .frame(width: 280)
    }
```
[documented]

---

### 2.8 Back Behavior, State Preservation, and Deep Linking

**Back behavior summary.** [documented]
- Push navigation: back button + edge-swipe = modeless return, no confirm dialogs.
- Sheets: "Cancel" = modeless close (with confirm-discard if dirty); "Done/Save" = complete + dismiss.
- Full-screen covers: explicit close button required; no swipe-to-dismiss.
- Tabs: selecting a different tab preserves the current tab's stack state; returning restores it.
- Popovers: tap-outside = auto-dismiss (save state); explicit cancel = discard.

**State preservation (SwiftUI).** [documented — nilcoalescing, Kodeco, SwiftUI State Restoration guide]
```swift
// Per-scene storage — survives background/foreground cycles
// Cleared only when user explicitly quits the app from the app switcher
@SceneStorage("selectedTab") private var selectedTab = "feed"
@SceneStorage("navigation.path") private var pathData: Data?

// Encode NavigationPath for serialization
// (requires Route: Codable in addition to Hashable)
@MainActor final class NavigationStore: ObservableObject {
    @Published var path: [Route] = []

    func encode() -> Data? { try? JSONEncoder().encode(path) }
    func restore(from data: Data) {
        path = (try? JSONDecoder().decode([Route].self, from: data)) ?? []
    }
}

// In root view:
.task {
    if let data = pathData { navStore.restore(from: data) }
    for await _ in navStore.$path.values {
        pathData = navStore.encode()
    }
}
```
[documented — Swift with Majid]

**Scroll position.** Use `@SceneStorage` to persist a selected item ID, then use `ScrollViewReader` to scroll to it on appear. SwiftUI does not automatically preserve scroll offset. [documented — nilcoalescing]

**Deep linking.** [documented]
- Parse inbound URL in `.onOpenURL` or `.onContinueUserActivity`.
- Translate parsed parameters to Route enum values, then assign to the NavigationPath.
- Never hard-code a push sequence; always express destination as data.

**"Where am I?" orientation tools.** [documented — Apple HIG, WWDC22]
- NavigationBar title: current screen name.
- Back button label: PARENT screen name (not "Back").
- Hierarchy depth: keep to ≤3–4 levels; beyond that the back-button chain loses meaning.
- Large titles (`.navigationBarTitleDisplayMode(.large)`) provide a visual anchor at the root of each stack; switch to `.inline` on deeper levels.

---

## Decision Table

```
START: Does the user need to go to a NEW CONTEXT?
│
├── YES — Is it a PEER SECTION (equal importance, no parent-child)?
│   ├── YES, and device has wide screen (iPad/Mac) ──► NavigationSplitView (sidebar/columns)
│   └── YES, and narrow screen / 2–5 peer sections ──► TabView (tab bar)
│
├── YES — Is it a CHILD/DETAIL of the current screen?
│   └── YES ──► NavigationStack push (NavigationLink / path.append)
│
├── YES — Is it a SELF-CONTAINED SUB-TASK (compose, create, configure)?
│   ├── Needs full attention / immersive / must not accidentally dismiss
│   │   └── fullScreenCover
│   └── Can sit above context / task is short
│       ├── Quick / partial-height OK ──► sheet + .presentationDetents([.medium, .large])
│       └── Full content needed ──► sheet + .presentationDetents([.large])
│
├── YES — Is it TRANSIENT CONTEXTUAL OPTIONS (sort, filter, share)?
│   ├── iPad / Mac (regular width) ──► popover (anchored)
│   └── iPhone (compact width) ──► action sheet / context menu (system auto-converts)
│
└── NO — Content changes IN PLACE (loading state, empty state, selection)
    └── State change within the same view — no new navigation layer needed
```

**Sheet vs Full-Screen Cover quick rule:**
- Sheet = task the user chose to start; they should be able to peek at what's behind it.
- Full-screen cover = task that demands complete focus or covers camera/media where showing the background would be meaningless or disorienting.

**Tab bar vs Split view quick rule (iPad):**
- If the user will want to see a list AND its detail side-by-side → Split view.
- If sections are completely independent and always full-screen → Tab view (but HIG recommends split view for most iPad navigation). [documented]

---

## Recipes

### 4.1 SwiftUI — Full Navigation System

```swift
// Root: adaptive split view that collapses on iPhone
struct AppRoot: View {
    @State private var columnVisibility = NavigationSplitViewVisibility.automatic
    @State private var selectedSection: Section?

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(selection: $selectedSection)
        } detail: {
            NavigationStack {  // push navigation inside detail column
                if let section = selectedSection {
                    SectionRootView(section: section)
                } else {
                    EmptyDetailView()
                }
            }
        }
    }
}

// Tab bar version (iPhone-first):
struct PhoneRoot: View {
    var body: some View {
        TabView {
            NavigationStack { FeedView() }
                .tabItem { Label("Feed", systemImage: "newspaper") }
            NavigationStack { SearchView() }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            NavigationStack { ProfileView() }
                .tabItem { Label("Profile", systemImage: "person") }
        }
    }
}
```
[documented]

### 4.2 SwiftUI — Sheet with Detents and Done/Cancel

```swift
struct ParentView: View {
    @State private var showCompose = false

    var body: some View {
        Button("Compose") { showCompose = true }
            .sheet(isPresented: $showCompose) {
                NavigationStack {         // sheets can have their own nav stack
                    ComposeView()
                        .navigationTitle("New Message")
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Cancel") {
                                    // show discard-changes alert if dirty
                                    showCompose = false
                                }
                            }
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Send") {
                                    // commit action
                                    showCompose = false
                                }
                                .disabled(!isValid)
                            }
                        }
                }
                .presentationDetents([.medium, .large])
            }
    }
}
```
[documented — WWDC22, Apple HIG]

### 4.3 SwiftUI — Full-Screen Cover

```swift
.fullScreenCover(isPresented: $showCamera) {
    CameraView()
        .ignoresSafeArea()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { showCamera = false }
            }
        }
}
// No swipe-to-dismiss; explicit button is required [documented]
```

### 4.4 SwiftUI — Popover (iPad/Mac)

```swift
Button("Sort") { showSort.toggle() }
    .popover(isPresented: $showSort, arrowEdge: .top) {
        SortPickerView()
            .frame(minWidth: 220, minHeight: 160)
    }
// System converts to action sheet on compact width automatically [documented]
```

### 4.5 Web Analogs

**Push/pop → History API / Navigation API**
```js
// Modern Navigation API (Baseline 2026) [documented — InfoQ, WICG]
navigation.navigate('/products/42', { state: { productId: 42 } });
navigation.addEventListener('navigate', e => {
    e.intercept({ handler: async () => { await renderRoute(e.destination.url); } });
});
// Back = history.back() or navigation.back(); forward = navigation.forward()
// Popstate event fires on browser back/forward — restore scroll / state here
window.addEventListener('popstate', e => restoreScrollPosition(e.state));
```

**Sheet / modal → `<dialog>` element**
```html
<!-- Native dialog: built-in focus trap, Escape key, correct ARIA [documented — W3C APG, CSS-Tricks] -->
<dialog id="compose" aria-labelledby="compose-title">
    <h2 id="compose-title">New Message</h2>
    <!-- content -->
    <button onclick="document.getElementById('compose').close()">Cancel</button>
    <button>Send</button>
</dialog>
```
```js
document.getElementById('compose').showModal();  // blocks background; Escape dismisses
// .show() for non-modal (non-blocking) presentation
```
- `<dialog>` opened with `.showModal()` traps focus natively in supporting browsers. No manual `aria-hidden` needed on background content. [documented — W3C APG, CSS-Tricks]
- For older browser support or custom styling, use `inert` attribute on background: `document.querySelector('main').inert = true`. [documented — MDN]

**Tab bar → ARIA tablist / router tabs**
```html
<nav role="tablist" aria-label="App sections">
    <a role="tab" aria-selected="true" href="/feed">Feed</a>
    <a role="tab" aria-selected="false" href="/search">Search</a>
</nav>
```
```js
// State preservation per tab: store each tab's scroll and route in sessionStorage
sessionStorage.setItem('tab.feed.scrollY', window.scrollY);
```

**State restoration → sessionStorage + popstate**
```js
// On navigate away: save state
window.addEventListener('pagehide', () => {
    sessionStorage.setItem('nav.scrollY', window.scrollY);
    sessionStorage.setItem('nav.route', location.pathname);
});
// On restore:
document.addEventListener('DOMContentLoaded', () => {
    const y = sessionStorage.getItem('nav.scrollY');
    if (y) window.scrollTo(0, +y);
});
```
[documented — MDN History API, WICG Navigation API]

---

## Faithful Replication on Web

Replicating Apple navigation models on the web requires respecting the same *semantic roles* even though the browser primitives differ: [documented where cross-referenced to standards; [inferred] for specific mapping recommendations]

| Apple pattern | Web analog | Key fidelity requirement |
|---|---|---|
| NavigationStack push | `history.pushState` + route render | `popstate` must restore previous view state including scroll position [documented] |
| Sheet | `<dialog>.showModal()` or CSS bottom-drawer | Focus trapped inside; Escape = Cancel; background inert [documented] |
| Full-screen cover | `<dialog>` + `position: fixed; inset: 0` | No click-outside dismiss; explicit close button required [documented — mirrors Apple rule] |
| Tab bar | `role="tablist"` + router | Each tab's NavigationStack state stored separately (sessionStorage keyed by tab) [inferred] |
| Split view | CSS `display: grid` two-column + media query collapse | Collapses to single-column stack at ≤768 px; maintain selection state on expand [inferred] |
| Popover | `<details>` / Popover API (`popover` attribute, `popovertarget`) | Anchored to trigger; dismissed on Escape or click-outside; one at a time [documented — MDN Popover API] |
| Back button label = parent title | `document.title` of history entry, or `aria-label` on back button | Show previous screen's title, not generic "Back" [inferred from HIG principle] |

**The Popover API** (`popover` attribute, `showPopover()` / `hidePopover()`) is the native web analog to iOS popovers — light-dismiss built in, top-layer rendering, no z-index wars. Baseline 2024. [documented — MDN]

---

## Anti-Patterns

1. **Modal overuse.** Using `.sheet` or `fullScreenCover` for navigation between top-level sections (should be tabs/sidebar) or for content the user only needs to read (should be push). Cost: users lose orientation and can't use the back gesture. [documented — Apple HIG Modality]

2. **Unpredictable back.** Intercepting the edge-swipe gesture, popping two levels at once silently, or requiring a save dialog on a push-navigation back. Violates the iOS system contract. [documented — Frank Rausch, Apple HIG]

3. **Lost state on tab switch.** Resetting a tab's NavigationStack when the user returns to it. Expected behavior: the tab remembers exactly where the user was. [documented — WWDC22]

4. **More than 5 tabs.** Triggering the "More" overflow tab is a IA problem disguised as a navigation problem. If you need more than 5, promote the structure with a split view sidebar. [documented — Apple HIG Tab Bars]

5. **Deep nesting past ~3–4 levels.** Each level added to a push stack degrades orientation. Users cannot reconstruct how they got 5 screens deep. Solution: flatten with tabs/split view, or use a hub-and-spoke modal pattern for the leaf task. [documented — Apple HIG; depth number inferred from HIG spirit]

6. **Gesture-only navigation.** Using only swipe gestures (no visible back button, no cancel button on a full-screen cover). Violates discoverability — new users won't find it. [documented — Apple HIG, WWDC22]

7. **Stacked modals.** Presenting a sheet from inside a sheet, or a full-screen cover over a sheet. Apple explicitly prohibits another view over a popover. The same spirit extends to modal stacks: keep modal depth to one. [documented — Apple HIG]

8. **Defining NavigationPath at the App level.** Creates a shared path across all scenes, breaking multi-window support on iPad. Always scope path to a scene or a view. [documented — Swift with Majid]

9. **Using X button on input-bearing sheets.** The X/close icon signals "view dismissal with no consequences." When the user has typed data, X creates ambiguity: did it save? Users should see an explicit "Cancel" button with a discard-confirmation flow. [documented — WWDC22 Nav session]

10. **Tab bar items that trigger actions or sheets.** Tabs are for navigation, not commands. "Tab bar items should behave in a predictable way; they should not bring up sheets or trigger actions." [documented — Frank Rausch, Apple HIG]

---

## Sources

- [Apple HIG — Modality](https://developer.apple.com/design/human-interface-guidelines/modality) [accessed 2026-05-22]
- [Apple HIG — Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) [accessed 2026-05-22]
- [Apple HIG — Tab Bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) [accessed 2026-05-22]
- [Apple HIG — Tab Views](https://developer.apple.com/design/human-interface-guidelines/tab-views) [accessed 2026-05-22]
- [Apple HIG — Split Views](https://developer.apple.com/design/human-interface-guidelines/split-views) [accessed 2026-05-22]
- [Apple HIG — Popovers](https://developer.apple.com/design/human-interface-guidelines/popovers) [accessed 2026-05-22]
- [Apple HIG — Navigation and Search](https://developer.apple.com/design/human-interface-guidelines/navigation-and-search) [accessed 2026-05-22]
- [WWDC22 — Explore navigation design for iOS (Session 10001)](https://developer.apple.com/videos/play/wwdc2022/10001/) [core source for tab/push/modal rules]
- [WWDC25 — Build a UIKit app with the new design (Session 284)](https://developer.apple.com/videos/play/wwdc2025/284/) [sheet appearance updates, Liquid Glass]
- [SwiftUI — presentationDetents(_:)](https://developer.apple.com/documentation/swiftui/view/presentationdetents(_:)) [accessed 2026-05-22]
- [Apple Developer — Bringing robust navigation structure to your SwiftUI app](https://developer.apple.com/documentation/swiftui/bringing_robust_navigation_structure_to_your_swiftui_app)
- [Swift with Majid — Mastering NavigationStack deep linking](https://swiftwithmajid.com/2022/06/21/mastering-navigationstack-in-swiftui-deep-linking/)
- [Swift with Majid — Mastering NavigationSplitView](https://swiftwithmajid.com/2022/10/18/mastering-navigationsplitview-in-swiftui/)
- [Frank Rausch — Modern iOS Navigation Patterns](https://frankrausch.com/ios-navigation/) [comprehensive pattern taxonomy; primary secondary source]
- [iOS HIG Archive — Modality interaction rules](https://codershigh.github.io/guidelines/ios/human-interface-guidelines/interaction/modality/index.html)
- [iOS HIG Archive — Popovers rules](https://codershigh.github.io/guidelines/ios/human-interface-guidelines/ui-views/popovers/index.html)
- [nilcoalescing — Resizable sheet APIs in SwiftUI](https://nilcoalescing.com/blog/ResizableSheetInSwiftUI/)
- [nilcoalescing — SceneStorage state restoration](https://nilcoalescing.com/blog/UsingSceneStorageForStateRestorationInSwiftUIApps/)
- [DEV Community — SwiftUI Navigation State Restoration](https://dev.to/sebastienlato/swiftui-navigation-state-restoration-cold-launch-deep-links-tabs-543c)
- [W3C WAI-ARIA APG — Dialog Modal Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [MDN — History API: pushState](https://developer.mozilla.org/en-US/docs/Web/API/History/pushState)
- [WICG — Navigation API](https://github.com/WICG/navigation-api)
- [InfoQ — Navigation API reaches Baseline (Jan 2026)](https://www.infoq.com/news/2026/05/navigation-api-browser/)
- [CSS-Tricks — No need to trap focus on a dialog element](https://css-tricks.com/there-is-no-need-to-trap-focus-on-a-dialog-element/)
- [appmakers.dev — SwiftUI Modal Navigation: sheet, fullScreenCover, popover](https://appmakers.dev/swiftui-modal-navigation-sheet-fullscreencover-popover/)
- [uiuxdesigning.com — iOS Tab Bar Guide 2026](https://uiuxdesigning.com/ios-tab-bar/)

---

CONFIDENCE: 82% — Core navigation rules (push/pop, sheet, tab bar, split view) are well-grounded in multiple corroborating sources including direct WWDC22 transcript extraction; main gaps are: Apple HIG pages that blocked body-content fetch (cited rules reconstructed from archive mirrors and secondary sources), the exact numeric depth limit (3–4 levels is inferred from HIG spirit rather than a stated number), and iOS 26 / WWDC25 Liquid Glass sheet appearance changes which are only partially covered.
