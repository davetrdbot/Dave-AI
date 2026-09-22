# App Component Anatomy — iOS / iPadOS UIKit & SwiftUI
Scope: Standard Apple UI component library — anatomy, metrics, when-to-use, SwiftUI recipes, web CSS mimic. Current era including iOS 26 Liquid Glass restyling.

---

## Principles

**1. Consistency over novelty.** Platform components carry 15+ years of muscle memory. Every deviation — a custom slider, a non-standard toggle, a bespoke sheet — forces relearning. Reach for a custom control only when the platform control demonstrably cannot express the interaction. [documented]

**2. Native affordances are free accessibility.** UIKit/SwiftUI controls bake in Dynamic Type, VoiceOver labels, high-contrast adaptation, and pointer-hover states with zero developer effort. Custom components must replicate all of these manually. [documented]

**3. Grouping for scannability — the form grammar.** iOS uses visual grouping (inset-grouped sections, toolbar clusters, tab bar items) as the primary cognitive organiser. Related controls share a section; unrelated groups get blank-row breathing room. Dense flat lists without section breaks are an anti-pattern. [documented]

**4. Touch target ≥ 44 × 44 pt.** Every tappable element must hit this floor, even if the visual footprint is smaller (e.g., a 31 × 51 pt switch has an invisible tap extension). [documented]

**5. Liquid Glass era (iOS 26).** As of iOS 26, standard bars (navigation bars, tab bars, toolbars, sheets) automatically adopt a translucent refractive glass material when recompiled against the iOS 26 SDK. The design philosophy: glass floats above content and adapts — it is not applied to primary content rows. Primary row backgrounds remain opaque. [documented]

---

## Apple Specifics

### Navigation

#### Navigation Bar
**Anatomy** [documented]
- Status bar above (20–54 pt depending on device)
- Bar body: 44 pt tall (standard / inline title mode)
- Large title extension: +52 pt → total ~96 pt when expanded (iOS 11+)
- Leading area: Back button (chevron + previous screen title, truncated to ~8 chars), or custom leading items
- Centre: title label (inline) or empty (large title floats below bar)
- Trailing: 1–3 action buttons (icon-only preferred; text labels for single prominent action)
- Hairline separator at bottom (hidden when content scrolls to top in large-title mode)

**Large title behaviour** [documented]
- `navigationBarTitleDisplayMode(.large)` — title lives below bar at rest, collapses into bar on upward scroll
- Collapse is triggered by the first scrollable child reaching the navigation bar boundary
- In iOS 26, the bar becomes a frosted-glass strip; large title text still renders above it at rest

**Back button** [documented]
- Renders as SF Symbol `chevron.left` + text label of the previous screen's title
- Falls back to "Back" when the previous title is empty or too long
- Swipe-from-left-edge always available, regardless of whether a back button is visible
- Never replace with a custom "X" for hierarchical navigation (modal dismissal only)

**iOS 26 Liquid Glass** [documented]
- Navigation bar automatically becomes translucent glass on recompile
- Custom view embeddings in `navigationItem.leftBarButtonItem` should set `hidesSharedBackground = true` to avoid double-glass artefacts
- Toolbar items float on the glass surface; no manual blur needed

```swift
// SwiftUI — large title nav stack
NavigationStack {
    List(items) { item in
        NavigationLink(item.title, value: item)
    }
    .navigationTitle("Library")
    .navigationBarTitleDisplayMode(.large)
    .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
            Button("Add", systemImage: "plus") { }
        }
    }
}
```

---

#### Tab Bar
**Anatomy** [documented]
- Fixed to bottom of screen, above home indicator
- Height: 49 pt (83 pt with safe area on Face ID devices) [observed]
- Each item: SF Symbol icon (~25–28 pt, weight matched to selected/unselected state) + text label (10 pt, San Francisco, smallest system text)
- Badge: small red pill anchored top-right of icon; numeric (1–99+) or dot-only
- Selection: tinted icon + label (system tint colour); unselected: secondary label colour
- Limit: 2–5 tabs on iPhone; if more needed, use a "More" tab or sidebar on iPad

**iOS 26 behaviour** [documented]
- Tab bar shrinks (collapses) as user scrolls down content, expanding again on scroll-up
- The bar itself is rendered as Liquid Glass; items remain tappable during collapse animation
- New Tab API enables role-based tabs including a `.search` role that morphs into a search field

```swift
// SwiftUI iOS 18+ tab syntax (also valid iOS 26)
TabView {
    Tab("Home", systemImage: "house") {
        HomeView()
    }
    Tab("Search", systemImage: "magnifyingglass", role: .search) {
        SearchView()
    }
    Tab("Profile", systemImage: "person") {
        ProfileView()
    }
}
```

---

#### Toolbar
**Anatomy** [documented]
- Appears at bottom of screen (iOS) or below navigation bar (macOS/iPad)
- Height: 44 pt (same as navigation bar)
- Items clustered with `ToolbarItemGroup`; spacing is system-managed
- In iOS 26, toolbar items float on a Liquid Glass capsule, not a full-width bar

```swift
.toolbar {
    ToolbarItemGroup(placement: .bottomBar) {
        Button("Compose", systemImage: "square.and.pencil") { }
        Spacer()
        Button("Trash", systemImage: "trash", role: .destructive) { }
    }
}
```

---

### Lists & Tables

#### List Styles Comparison [documented]

| Style | SwiftUI token | Visual | When |
|---|---|---|---|
| Inset Grouped | `.insetGrouped` | Rounded-corner cards, inset from edges; iOS 13+ default | Settings-style forms, grouped prefs |
| Grouped | `.grouped` | Full-width sections with grey separators; older aesthetic | Legacy / high-density tables |
| Plain | `.plain` | No section chrome; hairline separators | Contacts-style flat index lists |
| Inset | `.inset` | Like plain but with horizontal insets | Mixed content feeds |
| Sidebar | `.sidebar` | Disclosure triangles in headers; iPadOS sidebar | iPad split-view navigation |

The SwiftUI `Form` default on iOS is identical to `.listStyle(.insetGrouped)`. [documented]

#### Cell Anatomy [documented]
Standard UITableViewCell has four predefined styles:

| Style | Primary | Secondary | Image | Notes |
|---|---|---|---|---|
| Default | title (left) | — | left | Most common |
| Subtitle | title | subtitle below | left | Music, Files |
| Value1 | title (left) | value (right, grey) | left | Settings rows |
| Value2 | title (right-indented) | value (left) | — | Contact detail |

Cell regions (left→right):
1. **Editing control** (delete/insert, appears in edit mode)
2. **Image view** (optional, ~29×29 pt display area)
3. **Content view**: text label stack
4. **Accessory view** (right edge)

**Accessory types:**
- `disclosureIndicator` — grey chevron-right; means "tap row → navigate deeper"
- `detailDisclosureButton` — `ⓘ` + chevron; two tap zones (row = navigate, ⓘ = info)
- `detailButton` — `ⓘ` only; tap shows info without navigating
- `checkmark` — selection state (single-select lists)

**Swipe actions** [documented]
- Trailing swipe (leading edge): typically Delete (red), Archive
- Leading swipe (trailing edge): secondary actions (e.g., flag, mark read)
- Full-swipe destructive: triggered by `allowsFullSwipe: true` (use carefully)
- `.swipeActions(edge: .trailing) { Button(role: .destructive) { } }` in SwiftUI

**Section headers/footers** [documented]
- Header: 28 pt tall by default; UPPERCASE grey label in grouped style; can be custom view
- Footer: left-aligned secondary text, typically explanatory; lighter font weight
- In inset-grouped, header text is inset-aligned; rounded cap on section top/bottom

```swift
// SwiftUI list with sections and swipe actions
List {
    Section("Favourites") {
        ForEach(favourites) { item in
            HStack {
                Image(systemName: item.icon)
                VStack(alignment: .leading) {
                    Text(item.title)
                    Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { delete(item) } label: {
                    Label("Delete", systemImage: "trash")
                }
                Button { archive(item) } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .tint(.orange)
            }
        }
    } footer: {
        Text("Items you've starred appear here.")
    }
}
.listStyle(.insetGrouped)
```

---

### Forms & Inputs

#### Form Container [documented]
`Form` in SwiftUI is a semantic wrapper that:
- Applies inset-grouped list styling automatically
- Adapts contained controls to form presentation (Toggle gets right-aligned switch, Picker gets value-right layout)
- Styled with `.tint()` to colour interactive elements; `.scrollContentBackground(.hidden)` + `.background(colour)` for custom bg (iOS 16+)

#### Text Fields [documented]
- Anatomy: rounded rect or underline container + placeholder text + clear button (appears when non-empty + focused) + optional left/right accessory views
- Standard height: ~36 pt (content) inside a 44 pt touch zone
- In Form: renders as full-width row with label left + field right

```swift
Form {
    Section("Account") {
        TextField("Email", text: $email)
            .keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .autocorrectionDisabled()
        SecureField("Password", text: $password)
            .textContentType(.password)
    }
}
```

#### Toggle (UISwitch) [documented]
- Physical dimensions: 51 × 31 pt (touch target expanded to 44 × 44 pt by system)
- Anatomy: pill-shaped track + circular thumb; thumb slides right (on = green/tint) / left (off = grey)
- In Form/List: label left, toggle right-aligned
- iOS 26: Toggle adopts Liquid Glass tinting

```swift
Toggle("Enable Notifications", isOn: $notificationsEnabled)
// In Form context, this auto-layouts label-left, switch-right
```

#### Slider [documented]
- Anatomy: horizontal track (grey filled / tinted fill) + circular thumb (~28 pt)
- Continuous or stepped
- Optional min/max value labels or icons

```swift
Slider(value: $brightness, in: 0...1) {
    Text("Brightness")
} minimumValueLabel: {
    Image(systemName: "sun.min")
} maximumValueLabel: {
    Image(systemName: "sun.max")
}
```

#### Stepper [documented]
- Anatomy: label (left) + minus/plus button pair (right, connected capsule)
- Height: 29 pt for stepper widget; full row 44 pt

```swift
Stepper("Quantity: \(count)", value: $count, in: 1...99)
```

#### Segmented Control [documented]
- Anatomy: capsule container, N equal-width segments; selected segment gets white pill background (iOS 13+), non-selected are transparent
- Height: ~32 pt (intrinsic); minimum segment width ~44 pt
- Use as `Picker` with `.pickerStyle(.segmented)` in SwiftUI
- Max ~5 segments; beyond that use a menu or navigation

```swift
Picker("View", selection: $selectedTab) {
    Text("Day").tag(0)
    Text("Week").tag(1)
    Text("Month").tag(2)
}
.pickerStyle(.segmented)
```

#### Picker — Wheel / Inline / Navigation Link [documented]

| Style | Presentation | Use |
|---|---|---|
| `.wheel` | Spinning drum, 3 visible rows | Date/time in sheets, standalone |
| `.inline` | Expanded in-place list | Inside Form section |
| `.navigationLink` | Chevron row → separate screen | Settings value selection |
| `.menu` | Dropdown context menu | Compact inline |
| `.segmented` | Segmented control | 2–5 options, always visible |

#### Date Picker [documented]
- Two modes: `displayedComponents: .date`, `.hourAndMinute`, `.date` + `.hourAndMinute`
- Styles: `.compact` (tappable label → popover calendar), `.graphical` (full calendar inline), `.wheel` (spinning drums)

```swift
DatePicker("Reminder", selection: $date, displayedComponents: [.date, .hourAndMinute])
    .datePickerStyle(.compact)
```

#### Menus [documented]
- `Menu` in SwiftUI: button that reveals a contextual list of actions
- Anatomy: title + arrow, or icon-only button → pull-down list (iOS 14+) or context menu (long-press, iOS 13+)
- Supports sections, dividers, submenus, destructive roles
- Preferred over segmented control when options are 5+ or labels are long

```swift
Menu {
    Button("Rename", systemImage: "pencil") { }
    Button("Duplicate", systemImage: "doc.on.doc") { }
    Divider()
    Button("Delete", systemImage: "trash", role: .destructive) { }
} label: {
    Image(systemName: "ellipsis.circle")
}
```

---

### Buttons

#### Button Hierarchy [documented]

Apple defines a visual weight hierarchy for buttons. In any given context, only one button should carry the highest visual weight.

| Style token | Visual weight | Appearance | When |
|---|---|---|---|
| `.borderedProminent` | Highest | Filled background (system tint, e.g., blue) | Single primary CTA; App Store Download |
| `.bordered` | Medium-high | Tinted border + tinted label | Secondary actions next to a prominent button |
| `.borderless` / `.plain` | Low | Text or icon, no background | Tertiary, inline actions, toolbar items |
| `.automatic` | Context-adaptive | Resolves to borderless in most contexts | Default; use `.bordered` / `.borderedProminent` explicitly |

**Roles** (semantic, not visual): [documented]
- `.destructive` — red tint; confirms irreversible action
- `.cancel` — de-emphasised; used in alerts/dialogs

**Sizes via `controlSize`** [documented]
- `.large` — ~50 pt tall; full-width CTAs
- `.regular` — ~44 pt; standard buttons
- `.small` — ~28 pt; compact inline
- `.mini` — ~16 pt; very compact (rare)

**Button shapes via `buttonBorderShape`** [documented]
- `.roundedRectangle` (default for bordered)
- `.capsule` — pill shape; App Store style
- `.circle` — icon-only FABs

```swift
// Primary CTA
Button("Download") { }
    .buttonStyle(.borderedProminent)
    .buttonBorderShape(.capsule)
    .controlSize(.large)

// Secondary alongside primary
Button("Preview") { }
    .buttonStyle(.bordered)

// Destructive
Button("Delete Account", role: .destructive) { }
    .buttonStyle(.borderedProminent)
```

**iOS 26 Liquid Glass buttons** [documented]
- New `.buttonStyle(.glass)` available; produces a glass-effect capsule
- Use `.glassEffect()` + `.clipShape(Capsule())` for custom glass-button compositions
- Avoid applying glass to every button; reserve for overlay/toolbar contexts

---

### Modals, Sheets, Alerts, Popovers

#### Sheets [documented]
- Default: slides up from bottom, covers full screen
- `presentationDetents([.medium, .large])` — iOS 16+; allows half-height (medium ≈ 50% screen) and full (large)
- Grab indicator: appears automatically when >1 detent is provided; can force with `.presentationDragIndicator(.visible)`
- Dismissal: swipe down (when `.interactiveDismissDisabled(false)`) or programmatic
- iOS 26: partial-height sheets render with a Liquid Glass inset background that morphs as detent changes; Form content inside requires `.scrollContentBackground(.hidden)` to reveal glass

```swift
.sheet(isPresented: $showSettings) {
    SettingsView()
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.glass) // iOS 26
}
```

#### Full-Screen Cover [documented]
- `.fullScreenCover(isPresented:)` — occupies entire screen including safe areas
- Use for: cameras, media players, immersive onboarding; NOT for standard settings or detail views

#### Alerts [documented]
- Anatomy: rounded card over dimmed background; non-dismissible by background tap
- Title (semibold) + optional message (body) + 1–3 buttons
- 1 button: centred (OK / Got it)
- 2 buttons: side-by-side; Cancel left, primary action right
- 3+ buttons: stacked vertically (action sheet territory — prefer `confirmationDialog` instead)
- Destructive button: red label
- Cancel: bold (most prominent of non-destructive options)
- Rule: alerts interrupt; use only for information that requires immediate decision [documented]

```swift
.alert("Delete Item?", isPresented: $showDeleteAlert) {
    Button("Delete", role: .destructive) { deleteItem() }
    Button("Cancel", role: .cancel) { }
} message: {
    Text("This action cannot be undone.")
}
```

#### Confirmation Dialog (Action Sheet) [documented]
- Slides up from bottom on iPhone; popover on iPad
- Use for: 3+ destructive/ambiguous choices; "are you sure?" before destructive actions
- Title visible by default; can suppress with `.titleVisibility(.hidden)`
- Always include Cancel

```swift
.confirmationDialog("Share Options", isPresented: $showShare, titleVisibility: .visible) {
    Button("Save to Photos") { savePhoto() }
    Button("Copy Link") { copyLink() }
    Button("Delete", role: .destructive) { deleteItem() }
    Button("Cancel", role: .cancel) { }
}
```

#### Popovers [documented]
- iPad: floating card anchored to trigger point; dismisses by tapping outside
- iPhone: falls back to sheet unless `.popover(attachmentAnchor:)` is forced; usually avoid on iPhone
- Use for: supplementary info, colour/option pickers, inline details that don't deserve full navigation

```swift
.popover(isPresented: $showPicker) {
    ColorPickerView()
        .frame(minWidth: 280, minHeight: 200)
}
```

---

### Search

#### Search Field Anatomy [documented]
- Rounded rect container with magnifying glass icon (left) + placeholder + clear X (right, when non-empty)
- Cancel button appears on focus (right of field), dismisses keyboard and clears search state
- Scope bar (optional): segmented control directly below search field to filter scope

#### `.searchable` in SwiftUI [documented]
- Attaches to `NavigationStack` or `NavigationSplitView`; system decides placement
- iOS 26: iPhone moves search to bottom toolbar area (thumb-reach optimised); iPad moves it to top-trailing corner as Liquid Glass pill
- Scope: `.searchScopes($scope) { }` adds segmented scope bar under field
- Suggestions: pass a view block with `.searchCompletion()` per row
- Active state: `@Environment(\.isSearching)` available in iOS 15+; `isPresented` binding in iOS 17+

```swift
NavigationStack {
    List(filteredItems) { item in ItemRow(item) }
    .navigationTitle("Messages")
    .searchable(text: $query, prompt: "Search messages")
    .searchScopes($scope) {
        Text("All").tag(Scope.all)
        Text("Unread").tag(Scope.unread)
    }
}
```

---

### Status Components

#### Progress Indicators [documented]
- **Indeterminate spinner** (`ProgressView()` no value): radial spokes animation; use when duration unknown
- **Determinate progress bar** (`ProgressView(value: 0.6)`): horizontal fill track; use when progress is quantifiable
- **Gauge** (`Gauge`): arc or linear; use on watchOS primarily, available iOS 16+

```swift
ProgressView()                           // indeterminate spinner
ProgressView(value: progress, total: 1)  // determinate bar
ProgressView("Loading…", value: step, total: totalSteps)
```

#### Activity Indicator [documented]
- `ProgressView()` without value is the SwiftUI equivalent of `UIActivityIndicatorView`
- Sizes: `.controlSize(.large)` for prominent loading screens, default for inline use
- Placement: centred in content area for full-screen loads; inline in cells for row-level loads

#### Badges [documented]
- `.badge(count)` on Tab / List row in SwiftUI
- Renders as red pill (numeric) or red dot (`.badge(1)` → dot when `badgeLabel` is empty)
- App icon badge count set separately via `UNUserNotificationCenter`

#### ContentUnavailableView (iOS 17+) [documented]
The canonical empty-state component. Anatomy: large SF Symbol icon + title + optional subtitle + optional action button. Centred vertically in available space.

```swift
// Generic empty state
ContentUnavailableView(
    "No Bookmarks",
    systemImage: "bookmark.slash",
    description: Text("Save articles to access them here.")
)

// Built-in search empty state (matches system search UI exactly)
ContentUnavailableView.search

// Search with current query
ContentUnavailableView.search(text: searchQuery)

// Custom with action
ContentUnavailableView {
    Label("No Items", systemImage: "tray.fill")
} description: {
    Text("Add your first item to get started.")
} actions: {
    Button("Add Item") { showAddSheet = true }
        .buttonStyle(.borderedProminent)
}
```

---

### Onboarding Patterns [documented / inferred]

Apple HIG guidance (paraphrased from official Onboarding + Launching pages):

- **Minimise setup friction.** Let users into core value immediately; defer account creation, permission prompts, and personalisation. [documented]
- **Request permissions at moment of need**, not on first launch. A camera permission should be requested when the user first taps the camera button, not on app open. [documented]
- **Avoid feature tours.** Prefer contextual tooltips or coach marks over multi-page carousels that most users skip. [documented]
- **Restore state.** Re-launch should return users to exactly where they left off (`UISceneSession` state restoration). [documented]
- **Sign-in should be optional** until a personalised action truly requires it; offer "explore first." [inferred from HIG modality guidelines]

Common patterns (observed in system apps):
- **Welcome screen** — single screen, hero illustration, brief tagline, primary CTA "Get Started" + secondary "Sign In"
- **Page carousel** — `TabView` with `.page` style, page dots, auto-advances or manual; 3–5 pages max
- **Inline permission prompts** — triggered contextually mid-flow, not batched

```swift
// Page-style onboarding carousel
TabView(selection: $page) {
    OnboardingPage(step: 1).tag(0)
    OnboardingPage(step: 2).tag(1)
    OnboardingPage(step: 3).tag(2)
}
.tabViewStyle(.page)
.indexViewStyle(.page(backgroundDisplayMode: .always))
```

---

## Guided journeys & multi-step flows (pattern) [synthesized — see confidence notes below]

**Confidence preamble:** Apple does not publish a "journey component" or "step flow" component in the HIG. This section synthesizes the pattern from:
- **[documented]** — HIG Onboarding page, frankrausch.com "iOS Navigation Patterns" (step-by-step modal flows, page controls)
- **[documented]** — Apple's page controls component guidance (dots representing position in a flat sequence)
- **[observed]** — iOS Setup Assistant, Apple Watch pairing flow, Shortcuts shortcut runner, Apple Fitness workout progress, Health app checklists, Journal prompts
- **[inferred]** — the restraint stance (anti-gamification) is inferred from Apple's overall motion/hierarchy philosophy; Apple has never stated "don't use gamified paths" directly

Where each claim sits is marked inline.

---

### What Apple uses for sequential progress [observed + documented]

Apple does **not** use a single canonical "journey" component. The observed vocabulary is small:

| Mechanism | Where seen | HIG component |
|---|---|---|
| Page dots (page control) | Onboarding carousels, Setup Assistant | `UIPageControl` / `.tabViewStyle(.page)` [documented] |
| Numbered step rows in a list | Health app checklist, Shortcuts runner action list | Plain `List` with numbered badge, no custom chrome [observed] |
| Stacked inset-grouped cards | Wallet / Apple Pay setup, Sign in with Apple prompts | Sequential `Form` sections revealed progressively [observed] |
| Activity rings / circular arcs | Fitness, Health summary | `Gauge` or custom arc — represents quota not journey order [documented] |
| Progress bar (linear, determinate) | File transfer, software update, AirDrop | `ProgressView(value:total:)` [documented] |
| Full-screen modal steps | Apple Watch pairing, macOS Setup Assistant | Each step is its own full-screen view in a modal container [observed] |

**What Apple never uses** [inferred from observed absence]: winding path maps, game-board layouts, Duolingo-style branching node graphs, XP bars, or coin/reward imagery in system UI or first-party apps.

---

### Locked / active / done state treatment [observed in iOS Setup Assistant, Health, Wallet flows]

Apple handles the three states with the lightest-possible visual treatment:

| State | Visual | Motion on transition |
|---|---|---|
| **Locked / not yet reached** | Reduced opacity (~40–50%), no interactive affordance, grey tint on icon/badge | No motion until user reaches it |
| **Active / current** | Full opacity, tint colour on leading icon or badge, often an SF Symbol replacing a number | Entry via opacity + gentle scale (§4.7 in motion reference) |
| **Done / completed** | Checkmark SF Symbol (`checkmark.circle.fill`), secondary-label grey or tint at reduced saturation | Brief spring on checkmark appearing; connector fills (§4.8 in motion reference) |

Apple **does not** use: crossed-out text, red failure states in journey steps, bold animations on completed steps, trophy icons, or XP notation. [inferred from observed restraint]

---

### Restraint vs. gamification stance [inferred]

Apple's HIG Onboarding guidance states: *"Avoid feature tours"* and *"minimize setup friction"* — get users into value immediately. [documented, paraphrased from HIG]

From this, and from the complete absence of game-mechanics in Apple's own sequential flows, the inferred principle is:

> A sequential flow should feel like **a document being filled in**, not **a level being cleared**. Progress is acknowledged quietly (a checkmark, a tint change) rather than celebrated loudly (confetti, score, achievement banner). Celebrations are reserved for a **single moment** at true completion — and even then, they are brief and functional (Health ring close animation, Fitness streak completion).

The single exception is the Fitness activity ring "close" animation — a brief radial fill + glow — but this is completion of a *recurring daily goal*, not a step in an onboarding flow. The distinction matters: **ongoing habits earn celebration; setup steps do not**. [inferred]

---

### When to use a journey vs. a plain list [inferred + documented]

Use a **sequential guided flow** when:
- Steps must happen in strict order (each unlocked by the prior) [documented — step-by-step modal pattern]
- Steps involve distinct UI modes (camera, form, confirmation) that can't coexist in one scroll view [observed]
- The flow is a one-time setup or infrequent milestone (not daily) [documented — HIG Onboarding]
- 3–7 steps; beyond 7, group into phases [observed — frankrausch.com]

Use a **plain list** (inset-grouped or plain) when:
- Steps are independent (can be done in any order)
- Steps are frequent or repeatable (reminders, daily tasks)
- Steps are optional — not all users need all rows

Use **page dots + carousel** when:
- Content is parallel (not sequential/gated) — each page is a peer, not a prerequisite [documented — HIG page controls]
- 3–7 pages max [observed convention]

---

### HTML / CSS recipe — Apple-style step/journey list

This recipe implements the lightest reasonable interpretation of Apple's observed step-row pattern: numbered badge → checkmark on completion, tint accent, locked opacity. No gamification chrome.

```html
<!-- Apple-style sequential step list -->
<ol class="step-list" role="list" aria-label="Setup steps">

  <!-- Completed step -->
  <li class="step-row step-row--done" data-state="done">
    <div class="step-connector-above" aria-hidden="true">
      <div class="step-connector__fill"></div>
    </div>
    <div class="step-badge" aria-hidden="true">
      <!-- SF Symbol proxy: checkmark.circle.fill -->
      <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="10" fill="#34c759"/>
        <path d="M5.5 10l3 3 6-6" stroke="#fff" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="step-content">
      <span class="step-title">Create your account</span>
      <span class="step-subtitle">Signed in as you@example.com</span>
    </div>
    <div class="step-connector-below" aria-hidden="true">
      <div class="step-connector__fill is-complete"></div>
    </div>
  </li>

  <!-- Active / current step -->
  <li class="step-row step-row--active" data-state="active" aria-current="step">
    <div class="step-badge" aria-hidden="true">
      <span class="step-number">2</span>
    </div>
    <div class="step-content">
      <span class="step-title">Verify your email</span>
      <span class="step-subtitle">Check your inbox for a link</span>
    </div>
    <div class="step-connector-below" aria-hidden="true">
      <div class="step-connector__fill"></div><!-- not complete yet -->
    </div>
  </li>

  <!-- Locked step -->
  <li class="step-row step-row--locked" data-state="locked" aria-disabled="true">
    <div class="step-badge" aria-hidden="true">
      <span class="step-number">3</span>
    </div>
    <div class="step-content">
      <span class="step-title">Set your preferences</span>
    </div>
  </li>

</ol>
```

```css
/* ─── Step list — Apple-style ─── */

.step-list {
  list-style: none;
  margin: 0;
  padding: 0 16px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
}

/* ── Row layout ── */
.step-row {
  display: grid;
  grid-template-columns: 32px 1fr;
  grid-template-rows: auto auto auto;
  /* connector-above / badge+content / connector-below */
  gap: 0 12px;
  position: relative;
  transition: opacity 250ms ease;
}

/* ── Badge (number or checkmark) ── */
.step-badge {
  grid-column: 1;
  grid-row: 2;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f2f2f7;             /* iOS grouped bg — "inactive" */
  z-index: 1;
  align-self: start;
  margin-top: 2px;
}

.step-badge svg {
  width: 32px;
  height: 32px;
  display: block;
}

.step-number {
  font-size: 14px;
  font-weight: 600;
  color: #6e6e73;                  /* secondary label */
  line-height: 1;
}

/* ── Content area ── */
.step-content {
  grid-column: 2;
  grid-row: 2;
  padding: 4px 0 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.step-title {
  font-size: 17px;
  font-weight: 400;
  color: #000;
  line-height: 1.35;
}

.step-subtitle {
  font-size: 13px;
  color: #6e6e73;
}

/* ── Connector line (vertical, between rows) ── */
.step-connector-above,
.step-connector-below {
  grid-column: 1;
  width: 2px;
  margin: 0 auto;
  position: relative;
  overflow: hidden;
  border-radius: 1px;
  background: #e5e5ea;
}

.step-connector-above {
  grid-row: 1;
  height: 8px;                     /* gap above badge */
}

.step-connector-below {
  grid-row: 3;
  flex: 1;
  min-height: 20px;
}

/* Fill overlay — animates via transform:scaleY (compositor-thread) */
.step-connector__fill {
  position: absolute;
  inset: 0;
  background: #34c759;             /* green = complete; swap to tint for brand */
  transform-origin: top center;
  transform: scaleY(0);
  transition: transform 500ms var(--spring-smooth-easing, ease-out);
  will-change: transform;
}

.step-connector__fill.is-complete {
  transform: scaleY(1);
}

/* ── State modifiers ── */

/* Done */
.step-row--done .step-badge {
  background: transparent;         /* checkmark SVG fills its own bg */
}

.step-row--done .step-title {
  color: #6e6e73;                  /* secondary — done, not current focus */
}

/* Active */
.step-row--active .step-badge {
  background: #007aff;             /* tint bg */
}

.step-row--active .step-number {
  color: #fff;
}

.step-row--active .step-title {
  font-weight: 600;                /* semibold for current step only */
  color: #000;
}

/* Locked */
.step-row--locked {
  opacity: 0.4;
  pointer-events: none;            /* not interactive */
}

/* ── Dark mode ── */
@media (prefers-color-scheme: dark) {
  .step-title  { color: #fff; }
  .step-number { color: rgba(235,235,245,0.6); }
  .step-badge  { background: #2c2c2e; }
  .step-row--active .step-badge { background: #0a84ff; }
  .step-row--active .step-title { color: #fff; }
  .step-row--done .step-title   { color: rgba(235,235,245,0.6); }
  .step-connector-above,
  .step-connector-below { background: rgba(84,84,88,0.6); }
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .step-connector__fill {
    transition: background-color 200ms ease;
    transform: scaleY(1);          /* always fully drawn; only colour changes */
    background: #e5e5ea;
  }
  .step-connector__fill.is-complete {
    background: #34c759;
  }
}
```

```javascript
// Complete a step programmatically
function completeStep(stepEl) {
  // 1. Mark row done
  stepEl.dataset.state = 'done'
  stepEl.classList.replace('step-row--active', 'step-row--done')

  // 2. Fill the connector below
  const fill = stepEl.querySelector('.step-connector-below .step-connector__fill')
  if (fill) fill.classList.add('is-complete')

  // 3. After a brief stagger, activate next step (entry materialize)
  const next = stepEl.nextElementSibling
  if (next && next.dataset.state === 'locked') {
    setTimeout(() => {
      next.dataset.state = 'active'
      next.classList.replace('step-row--locked', 'step-row--active')
      // step-row--locked sets opacity:0.4 → 1 via the CSS transition
    }, 150)  // stagger: connector fills first, then next step materializes
  }
}
```

---

### Anti-patterns for guided journeys [inferred from Apple's restraint principles]

1. **Gamified chrome in setup flows** — XP bars, coin rewards, confetti on every step completion. Reserve celebration for true terminal moments only (if at all). [inferred]
2. **Winding path / game-board layout** — spatially positioning steps as nodes on a curved map implies non-linearity and game metaphor. Apple's flows are always vertical lists or page sequences. [inferred from observed absence]
3. **More than 7 ungrouped steps** — cognitive overload; group into phases (each phase is its own modal section). [observed — frankrausch.com]
4. **Branching paths on mobile** — iOS has no standard component for visible branching flows; use conditional step inclusion (some steps appear only if prior answer warrants them) with a simple linear presentation. [documented — step-by-step modal note on branching]
5. **Persistent journey UI during core tasks** — the journey chrome (step list, connectors) should disappear once the user enters a step's dedicated view. Don't overlay the step indicator while the user is doing the actual task. [observed — Apple Watch pairing each step fills the full screen]

---

## Recipes

### SwiftUI — Full-featured Form
```swift
struct SettingsForm: View {
    @State private var notificationsOn = true
    @State private var fontSize = 16.0
    @State private var theme = "System"
    @State private var selectedLanguage = "English"

    var body: some View {
        NavigationStack {
            Form {
                // MARK: — Appearance
                Section("Appearance") {
                    Picker("Theme", selection: $theme) {
                        Text("Light").tag("Light")
                        Text("Dark").tag("Dark")
                        Text("System").tag("System")
                    }
                    .pickerStyle(.navigationLink) // value-right row; taps → new screen

                    Picker("Font size", selection: $fontSize) {
                        ForEach([14.0, 16.0, 18.0, 20.0], id: \.self) { size in
                            Text("\(Int(size)) pt").tag(size)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                // MARK: — Notifications
                Section {
                    Toggle("Allow Notifications", isOn: $notificationsOn)
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("You can customise alert types in system Settings.")
                }

                // MARK: — Account
                Section("Account") {
                    NavigationLink("Privacy Settings") { PrivacyView() }
                    Button("Sign Out", role: .destructive) { signOut() }
                }
            }
            .navigationTitle("Settings")
        }
    }
}
```

### SwiftUI — ContentUnavailableView with search integration
```swift
struct SearchableList: View {
    @State private var query = ""
    var filteredItems: [Item] { items.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) } }

    var body: some View {
        NavigationStack {
            List(filteredItems) { item in
                Text(item.name)
            }
            .overlay {
                if filteredItems.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .navigationTitle("Results")
            .searchable(text: $query)
        }
    }
}
```

### SwiftUI — Alert + ConfirmationDialog
```swift
struct DestructiveExample: View {
    @State private var showAlert = false
    @State private var showSheet = false

    var body: some View {
        VStack(spacing: 16) {
            Button("Delete", role: .destructive) { showAlert = true }
                .buttonStyle(.borderedProminent)

            Button("More options") { showSheet = true }
                .buttonStyle(.bordered)
        }
        .alert("Permanently delete?", isPresented: $showAlert) {
            Button("Delete", role: .destructive) { performDelete() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This item will be removed from all your devices.")
        }
        .confirmationDialog("Options", isPresented: $showSheet) {
            Button("Export PDF") { }
            Button("Share Link") { }
            Button("Archive") { }
            Button("Delete", role: .destructive) { }
            Button("Cancel", role: .cancel) { }
        }
    }
}
```

### SwiftUI — List with swipe actions and disclosure
```swift
List {
    ForEach(messages) { msg in
        HStack {
            VStack(alignment: .leading) {
                Text(msg.sender).fontWeight(.semibold)
                Text(msg.preview).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text(msg.timestamp).font(.caption).foregroundStyle(.tertiary)
            Image(systemName: "chevron.right").foregroundStyle(.tertiary).font(.caption)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { delete(msg) } label: {
                Label("Delete", systemImage: "trash")
            }
            Button { archive(msg) } label: {
                Label("Archive", systemImage: "archivebox")
            }.tint(.orange)
        }
        .swipeActions(edge: .leading) {
            Button { toggleRead(msg) } label: {
                Label(msg.isRead ? "Unread" : "Read", systemImage: "envelope")
            }.tint(.blue)
        }
    }
}
.listStyle(.insetGrouped)
.badge(unreadCount)
```

---

### CSS — iOS Inset-Grouped List
Faithful recreation of the Settings-style card-list aesthetic.

```css
/* Reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #f2f2f7;     /* iOS system grouped background */
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Section container */
.ios-section {
  margin: 0 16px 10px;     /* inset from edges; gap between sections */
}

/* Section header label */
.ios-section-header {
  font-size: 13px;
  font-weight: 400;
  color: #6e6e73;           /* iOS secondary label */
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 6px 16px 4px;
  /* No negative margin — header aligns with card edge */
}

/* Section footer label */
.ios-section-footer {
  font-size: 13px;
  color: #6e6e73;
  padding: 4px 16px 8px;
}

/* Card (inset-grouped group) */
.ios-card {
  background: #fff;
  border-radius: 10px;
  overflow: hidden;         /* clip internal separators to rounded corners */
}

/* Each row */
.ios-row {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 10px 16px;
  background: #fff;
  gap: 12px;
  position: relative;
}

/* Hairline separator (skip on last child) */
.ios-row:not(:last-child)::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 16px;              /* aligns with text start, not image start */
  right: 0;
  height: 0.5px;
  background: rgba(60, 60, 67, 0.18);  /* iOS separator */
}

/* Left icon (SF Symbols proxy: use SVG or img) */
.ios-row-icon {
  width: 29px;
  height: 29px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 17px;
}

/* Primary label */
.ios-row-label {
  flex: 1;
  font-size: 17px;
  font-weight: 400;
  color: #000;
  line-height: 1.3;
}

/* Value / detail (right side) */
.ios-row-value {
  font-size: 17px;
  color: #6e6e73;
  flex-shrink: 0;
}

/* Disclosure chevron */
.ios-chevron::after {
  content: '';
  display: inline-block;
  width: 8px;
  height: 13px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 13'%3E%3Cpath d='M1 1l6 5.5L1 12' stroke='%23c7c7cc' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;
  margin-left: 4px;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  body { background: #1c1c1e; }
  .ios-card { background: #2c2c2e; }
  .ios-row { background: #2c2c2e; }
  .ios-row-label { color: #fff; }
  .ios-row:not(:last-child)::after { background: rgba(84, 84, 88, 0.6); }
}
```

```html
<!-- Usage -->
<div class="ios-section">
  <div class="ios-section-header">Appearance</div>
  <div class="ios-card">
    <div class="ios-row">
      <span class="ios-row-icon" style="background:#007aff;color:#fff">🌙</span>
      <span class="ios-row-label">Dark Mode</span>
      <!-- toggle goes here -->
    </div>
    <div class="ios-row">
      <span class="ios-row-icon" style="background:#ff9500;color:#fff">✦</span>
      <span class="ios-row-label">Theme</span>
      <span class="ios-row-value">System</span>
      <span class="ios-chevron"></span>
    </div>
  </div>
  <div class="ios-section-footer">Changes appearance across the app.</div>
</div>
```

---

### CSS — iOS Toggle Switch
Mirrors UISwitch: 51 × 31 pt, thumb slides, green on / grey off.

```css
.ios-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.ios-toggle input[type="checkbox"] {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.ios-toggle-track {
  width: 51px;
  height: 31px;
  border-radius: 31px;
  background: #e5e5ea;
  cursor: pointer;
  transition: background 0.25s ease;
  position: relative;
  flex-shrink: 0;
}

.ios-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0,0,0,0.25);
  transition: transform 0.25s ease;
}

/* Checked state */
.ios-toggle input:checked + .ios-toggle-track {
  background: #34c759;  /* iOS green */
}

.ios-toggle input:checked + .ios-toggle-track .ios-toggle-thumb {
  transform: translateX(20px);
}

/* Focus ring for accessibility */
.ios-toggle input:focus-visible + .ios-toggle-track {
  outline: 2px solid #007aff;
  outline-offset: 2px;
}
```

```html
<label class="ios-toggle">
  <input type="checkbox" id="toggle-notifications">
  <div class="ios-toggle-track">
    <div class="ios-toggle-thumb"></div>
  </div>
</label>
```

---

### CSS — iOS Segmented Control
3-segment control, white pill selection, grey background.

```css
.ios-segmented {
  display: inline-flex;
  background: rgba(118, 118, 128, 0.12);
  border-radius: 9px;
  padding: 2px;
  gap: 0;
  height: 32px;
}

.ios-segmented input[type="radio"] {
  display: none;
}

.ios-segmented label {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: #000;
  border-radius: 7px;
  cursor: pointer;
  padding: 0 12px;
  white-space: nowrap;
  transition: background 0.18s ease, box-shadow 0.18s ease;
  user-select: none;
  -webkit-user-select: none;
}

.ios-segmented input:checked + label {
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);
  color: #000;
}

@media (prefers-color-scheme: dark) {
  .ios-segmented { background: rgba(118, 118, 128, 0.24); }
  .ios-segmented label { color: rgba(255,255,255,0.9); }
  .ios-segmented input:checked + label {
    background: rgba(255,255,255,0.16);
    color: #fff;
  }
}
```

```html
<div class="ios-segmented" role="group" aria-label="View mode">
  <input type="radio" name="view" id="view-day" checked>
  <label for="view-day">Day</label>
  <input type="radio" name="view" id="view-week">
  <label for="view-week">Week</label>
  <input type="radio" name="view" id="view-month">
  <label for="view-month">Month</label>
</div>
```

---

## Faithful Replication — iOS Settings / List Aesthetic on Web

**Key visual tokens** [observed from iOS system UI]:

| Token | Value |
|---|---|
| System grouped background | `#f2f2f7` (light), `#1c1c1e` (dark) |
| Card background | `#ffffff` (light), `#2c2c2e` (dark) |
| Primary label | `#000000` (light), `#ffffff` (dark) |
| Secondary label | `#6e6e73` (light), `rgba(235,235,245,0.6)` (dark) |
| Separator | `rgba(60,60,67,0.18)` (light), `rgba(84,84,88,0.6)` (dark) |
| Tint / accent | `#007aff` (iOS blue default) |
| Section corner radius | `10px` |
| Row min-height | `44px` |
| Row horizontal padding | `16px` |
| Icon rounded rect | `29×29px`, `border-radius: 6px` |
| Chevron colour | `#c7c7cc` |
| Separator inset | starts at `16px` from left (aligned to text, not card edge) |
| Font | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif` |
| Body font size | `17px` |
| Section header / footer size | `13px`, uppercase for header |

**Squircle note** [documented]: iOS icons use a superellipse (squircle) corner, not standard `border-radius`. For icon containers, `border-radius: 22.5%` approximates the squircle without SVG clipping.

**Typography** [documented]:
- Body rows: SF Pro Text 17pt / Regular
- Section header: 13pt / Regular / UPPERCASE / secondary label colour
- Detail value (Value1 style): 17pt / Regular / secondary label colour
- Footer note: 13pt / Regular / secondary label colour

**Separator discipline**: Use a `0.5px` pseudo-element (`::after`), not a full `border-bottom`. The separator is inset from the card left edge to align with text content, not with card boundary. This matches the system behaviour exactly.

**Scroll behaviour**: The grouped background shows between sections during rubber-band overscroll. Ensure the page background matches the grouped background token so cards "float" correctly.

---

## Anti-Patterns

**1. Custom controls that break platform expectations** [documented]
- Replacing a toggle with a custom animated component that behaves subtly differently — users will fight muscle memory
- Building a custom date picker drum when `DatePicker(.wheel)` exists and is accessible

**2. Wrong button hierarchy — everything is primary** [documented]
- Multiple `.borderedProminent` buttons in the same view compete for attention; only one CTA should be highest weight
- Using filled-background buttons for all actions regardless of importance

**3. Alert overuse** [documented]
- Showing alerts for non-critical confirmations ("Are you sure you want to navigate away?")
- Alerts for success confirmations ("Item saved!") — use inline feedback or a toast instead
- Alerts with more than 2–3 buttons — use `confirmationDialog` / action sheet

**4. Missing empty states** [inferred / documented]
- Blank white screen when a list has no items — always provide `ContentUnavailableView` or equivalent
- Generic "No data" label without a system image, description, or action button
- Showing an empty state during loading — show `ProgressView` instead, then transition to empty state

**5. Dense flat forms without grouping** [documented]
- 20 settings controls in a plain list with no sections — group logically into ≤5–7 related controls per section with a clear header
- Using `VStack` + `Divider()` to manually recreate what `Form` provides natively — no accessibility semantics, no dynamic type adaptation

**6. Disclosure indicator on non-navigating rows** [documented]
- Adding a chevron to a row that shows a sheet or performs an action (not navigation)
- Chevron = "this row pushes a new screen". For sheets / info: use the `detailButton` accessory or no accessory

**7. Non-grouped inset-grouped alternative: plain list for settings** [observed]
- Using `.plain` list style for settings-style content removes the visual grouping cues users rely on

**8. Forcing iOS 26 glass on all content** [documented]
- `.glassEffect()` applied to primary list rows, cards, or body content creates visual chaos; glass is for floating/overlay UI layers (bars, sheets, FABs) not content surfaces

**9. Tab bar misuse** [documented]
- Using tab bar buttons to trigger actions (share, camera shutter) instead of navigation — tab items must always switch content areas
- More than 5 tabs on iPhone without a "More" overflow pattern

**10. Modality over-nesting** [documented]
- Pushing a modal presentation from inside another modal sheet
- Full-screen covers for content that is secondary / reversible — use a sheet or navigation link instead

---

## Sources

- [Human Interface Guidelines — Apple Developer](https://developer.apple.com/design/human-interface-guidelines/)
- [Tab bars — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- [Toolbars — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Navigation and search — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/navigation-and-search)
- [Lists and tables — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/components/layout-and-organization/lists-and-tables/)
- [Selection and input — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/selection-and-input)
- [Alerts — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/alerts)
- [Action sheets — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/action-sheets)
- [Modality — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/modality)
- [Onboarding — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- [Progress indicators — Apple Developer HIG](https://developer.apple.com/design/human-interface-guidelines/components/status/progress-indicators/)
- [A Closer Look at Table View Cells — Apple Archive](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/TableView_iPhone/TableViewCells/TableViewCells.html)
- [swipeActions modifier — Apple Developer Docs](https://developer.apple.com/documentation/swiftui/view/swipeactions(edge:allowsfullswipe:content:))
- [ButtonStyle — Apple Developer Docs](https://developer.apple.com/documentation/SwiftUI/ButtonStyle)
- [ContentUnavailableView — avanderlee.com](https://www.avanderlee.com/swiftui/contentunavailableview-handling-empty-states/)
- [SwiftUI List Style — sarunw.com](https://sarunw.com/posts/swiftui-list-style/)
- [SwiftUI Form Styling — sarunw.com](https://sarunw.com/posts/swiftui-form-styling/)
- [Bottom Sheet presentationDetents — sarunw.com](https://sarunw.com/posts/swiftui-bottom-sheet/)
- [Searchable modifier — sarunw.com](https://sarunw.com/posts/searchable-in-swiftui/)
- [iOS 26 SwiftUI Search Enhancements — nilcoalescing.com](https://nilcoalescing.com/blog/SwiftUISearchEnhancementsIniOSAndiPadOS26/)
- [Liquid Glass Sheets with NavigationStack and Form — nilcoalescing.com](https://nilcoalescing.com/blog/LiquidGlassSheetsWithNavigationStackAndForm/)
- [Designing custom UI with Liquid Glass on iOS 26 — donnywals.com](https://www.donnywals.com/designing-custom-ui-with-liquid-glass-on-ios-26/)
- [Grow on iOS 26 — fatbobman.com](https://fatbobman.com/en/posts/grow-on-ios26/)
- [Apple Liquid Glass iOS 26 SwiftUI Guide — getskyscraper.com](https://getskyscraper.com/blog/apple-liquid-glass-ios-26-swiftui-guide)
- [Apple introduces Liquid Glass — Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
- [SwiftUI Button Styles — avanderlee.com](https://www.avanderlee.com/swiftui/swiftui-button-styles/)
- [SwiftUI Button Size — sarunw.com](https://sarunw.com/posts/swiftui-button-size/)
- [iOS Disclosure Indicator — blog.thomasdurand.fr](https://blog.thomasdurand.fr/story/2016-08-12-ios-disclosure-indicator-done-right/)
- [Large Titles for Navigation Bars iOS 11 — chariotsolutions.com](https://chariotsolutions.com/blog/post/large-titles-ios-11/)
- [Modern iOS Navigation Patterns — Frank Rausch](https://frankrausch.com/ios-navigation/) — step-by-step modal flows, page controls for sequential progress, "wizard/assistant" pattern; 3–7 step guidance
- [Progress Tracker Design UX Best Practices — UXPin](https://www.uxpin.com/studio/blog/design-progress-trackers/) — visual stepper conventions (external reference, not Apple-specific)
- [iOS 26 Liquid Glass Reference — madebyluddy/Medium](https://medium.com/@madebyluddy/overview-37b3685227aa) — `.glassEffectTransition(.materialize)` API; "materialize" as Apple's named transition concept

---

CONFIDENCE: 82% — Component anatomy, SwiftUI APIs, and CSS recipes are well-grounded in documented sources; specific pixel/point metrics for some secondary controls (stepper, slider thumb) are inferred from observed system UI rather than confirmed in official HIG spec sheets. The new "Guided journeys" section (§ between Onboarding and Recipes) is approximately 25% [documented], 50% [observed], and 25% [inferred] — see the inline labels within that section for per-claim detail.
