# State & Feedback Logic — Loading, Empty, Error, Optimistic, Pagination

**Scope:** Functional/behavioral rules for all transient UI states in Apple-platform and faithful web equivalents. Covers *when* each state fires, *which* pattern to deploy, *why* that choice serves the user, and the latency thresholds that drive those decisions. Color/visual styling is out of scope (see `apple-design-materials.md`).

---

## Principles

1. **Never show a blank screen.** A blank or frozen screen reads as a crash. Show structure immediately; fill it with real content as it arrives. [documented — Apple HIG Loading]
2. **Match indicator cost to wait duration.** A spinner for a 60 ms operation is noise; no indicator for a 12 s operation is abandonment bait. The Nielsen/Norman thresholds are the calibration table. [documented — NN/G]
3. **Every state has an exit.** Empty states offer a path forward. Error states offer a recovery action. Disabled controls explain their condition. Dead ends are design failures. [observed — Apple HIG, NN/G]
4. **Preserve user input unconditionally.** No transient state — load, error, network loss — should destroy what a user typed. [documented — Apple HIG, general HCI consensus]
5. **Never blame the user.** Error copy attributes failure to the system or the network, never to the person. [documented — Apple HIG Alerts]
6. **Optimistic updates are a privilege, not a default.** Reserve them for low-risk, reversible, idempotent actions. Roll back visibly but non-disruptively on failure. [documented — React/NN/G]
7. **Skeleton shapes mirror real content.** Placeholders that match the eventual layout reduce the perceived layout shift and anchor expectations. [observed — Apple HIG, industry practice]

---

## Apple Specifics

### 1. Loading States

#### Perceived-latency thresholds (Nielsen/Norman calibration table)

| Duration | User perception | Required UI | [source] |
|---|---|---|---|
| < 100 ms | Instantaneous — feels like direct manipulation | None. Show the result only. | [documented] |
| 100 ms – 1 s | Noticeable delay but flow uninterrupted | Optional subtle cue (opacity pulse, micro-animation). No spinner. | [documented] |
| 1 s – 10 s | User perceives machine latency; attention drifts | Activity indicator (spinner) OR skeleton/redacted placeholder. Prefer skeleton if layout is known. | [documented] |
| > 10 s | Attention breaks; task-switching begins | Determinate progress bar + estimated time or running count + cancel affordance. | [documented] |

**Rule: never show a spinner for sub-100 ms operations.** [documented — NN/G] Adding a flash of spinner-then-gone trains users to doubt the app's speed.

#### Skeleton vs spinner vs progress bar vs progressive content — when each

**Skeleton / `.redacted(reason: .placeholder)`**
- Use when you know the *shape* of the incoming content (a feed, a detail card, a list of items).
- Placeholders must be sized to match real content — same line count, same image aspect ratio. [documented — Apple HIG Loading]
- Add a shimmer (sweeping LinearGradient or CSS `background-position` animation) to signal activity. Static gray blocks feel broken. [observed — industry practice]
- Duration 1–2 s for the shimmer cycle; slower than 2 s feels stale, faster than 1 s is anxious. [inferred — from CSS animation consensus]

**Activity indicator (spinner / `ProgressView()` with no value)**
- Use for indeterminate waits where the layout is *not* known in advance (e.g., launching a modal sheet, sending a message, background sync).
- Apple's native `UIActivityIndicatorView` / SwiftUI `ProgressView()` auto-scales and respects Dark/Light mode. [documented — Apple HIG Progress Indicators]
- Do not use for sub-100 ms or when a skeleton can be shown instead.

**Determinate progress bar (`ProgressView(value:total:)`)**
- Use when you can report real percentage — file uploads, multi-step operations, bulk exports.
- Show supplementary text: "Uploading 3 of 12 photos" is better than a bare bar. [documented — Apple HIG Progress Indicators]
- Add a cancel button for operations > 10 s. [documented — NN/G]

**Progressive content reveal**
- Apple advises showing the screen immediately and revealing content as it loads rather than blocking behind a gate. [documented — Apple HIG Loading]
- Pattern: render nav/chrome/header instantly → skeleton rows → replace row-by-row as data streams in.
- Preload the *next* screen's content while the user is still on the current one. [documented — Apple HIG Loading]

---

### 2. Empty States

**`ContentUnavailableView` (iOS 17+, iPadOS 17+, macOS 14+)**

Three distinct flavors — use the right one:

| Scenario | Pattern | Path forward required |
|---|---|---|
| First run (no data yet) | Custom `ContentUnavailableView` with CTA | "Create your first item" button |
| Search/filter returns nothing | `ContentUnavailableView.search` or `.search(text:)` | "Clear search" or "Try different terms" |
| Load failure / offline | Custom `ContentUnavailableView` with Retry | "Try Again" button wired to re-fetch |
| User deliberately cleared | Custom with explanation | "Undo" or next-action CTA |

**Decision rules:**
- A `ContentUnavailableView` is an **overlay** on an otherwise-empty list/container — it must not change the scroll container's dimensions. Apply as `.overlay` on the `List` when `items.isEmpty`. [documented — avanderlee.com]
- Always pair a system image (SF Symbol) + title + brief description + action. The action is not optional — an empty state without a path forward is a dead end. [documented — Apple HIG, observed across iOS system apps]
- For search, prefer `ContentUnavailableView.search(text: queryText)` — it auto-generates localized copy and extracts the query string when `searchable` is placed *below* the overlay in the view hierarchy. [documented — swiftwithmajid.com]

---

### 3. Error States

#### Three surfaces and when each is correct

| Surface | When to use | SwiftUI | Web |
|---|---|---|---|
| **Inline / field-level** | Error is tied to a specific input or piece of content | `.overlay`, `Label` below field | `<p role="alert" aria-live="polite">` near field |
| **Banner / toast** | Transient, non-blocking, recoverable (e.g., "Message failed — Retry") | `.alert` modifier *or* custom overlay pinned to top/bottom | CSS toast, `role="status"` |
| **Full-screen / sheet alert** | Blocking, unrecoverable, requires explicit acknowledgment (destructive confirm, auth failure) | `Alert` / `.confirmationDialog` | Modal dialog, `role="alertdialog"` |

**Decision rules:**
- Prefer inline over alert. Alerts interrupt flow; inline errors keep the user on the task. [documented — Apple HIG Alerts]
- Use alerts sparingly — only for errors that require explicit acknowledgment before the user can continue (e.g., payment failure, auth required). [documented — Apple HIG Alerts]
- Never chain multiple sequential alerts. Consolidate. [documented — Apple HIG Alerts]
- Button labels must be specific verbs: "Retry", "Delete", "Go Offline" — not "OK". [documented — Apple HIG Alerts]
- For destructive confirmations, the Cancel/safe action should be the visually prominent button. [documented — Apple HIG Alerts]

**Copy rules:**
- State *what happened* and *what the user can do*. "Couldn't send — check your connection and try again" not "Error 503". [documented — Apple HIG]
- Never say the user "did something wrong" — attribute to network/system. [documented — Apple HIG, NN/G]
- Preserve all user input. On a failed form submit, repopulate every field exactly as entered. [documented — general HCI]

---

### 4. Disabled States

**Disable vs. hide — the rule:**

| Condition | Action |
|---|---|
| Feature is temporarily unavailable (user can unlock it) | **Disable** — keep visible, reduce opacity to 0.3–0.4, block interaction |
| Feature is permanently unavailable to this user/role | **Hide** — showing a button that can never be used wastes cognitive space |
| Feature requires completing a prior step | **Disable** with discoverable reason (tooltip, helper text, label change) |

**Why disable rather than hide (when applicable):** Disabled controls teach the app's capability map — users learn what exists even before qualifying for it. This reduces "where did that feature go?" confusion when they eventually unlock it. [documented — UX Psychology, Unity HIG]

**Making the reason discoverable:**
- On iOS/iPadOS: long-press → popover/tooltip explaining why. [observed — iOS system apps, e.g., Wallet on unsupported hardware]
- On macOS: hover tooltip (NSToolTip) is mandatory if a control is disabled with no other explanation.
- On web: `aria-disabled="true"` + `title` attribute + visible helper text. Never use `disabled` alone with no context.
- In SwiftUI: `.disabled(true)` + `.help("Reason")` for macOS tooltips; for iOS, use a `TapGesture` overlay that presents an explanatory sheet/popover. [documented — Apple Developer]

**Never** just remove the opacity and leave no explanation. [inferred — from Apple HIG Controls guidance]

---

### 5. Optimistic UI

**When it is safe:**
- Action is low-risk and reversible (like, bookmark, follow, reorder)
- Failure rate is empirically low (< ~2% in production)
- Rollback UX is non-destructive (a toast + visual revert is sufficient)
- The operation is idempotent (re-sending on failure is safe) [documented — React useOptimistic, codingeasypeasy.com]

**When NOT to use it:**
- Financial transactions, deletions of large datasets, anything with legal/audit significance
- Operations where partial state is worse than no state (e.g., partially sent message)
- When failure means data corruption [documented — React useOptimistic docs]

**The three-phase contract:**
1. **Apply immediately** — update local state as if server confirmed success.
2. **Reconcile** — on server response, either confirm (no-op if already correct) or roll back.
3. **Roll back gracefully** — revert the UI change, show an inline error or toast, offer retry. *Never silently fail.* Partial rollback (mark item as failed rather than vanishing it) is often more user-friendly than full revert. [documented — React useOptimistic, dev.to]

---

### 6. Pull-to-Refresh

- SwiftUI: `.refreshable { await viewModel.reload() }` on a `List` or `ScrollView`. iOS renders the native rubber-band animation and activity indicator automatically. [documented — Apple Developer]
- The async closure must `await` the reload — iOS holds the indicator visible until the async work completes.
- Do **not** implement custom pull-to-refresh on iOS — users expect the native feel, and custom implementations frequently mismatch scroll physics. [observed — Apple HIG, common anti-pattern]
- Web equivalent: a manual "Refresh" button in the toolbar is preferred over a custom pull gesture (browsers may intercept it). Reserve gesture-based refresh for PWAs/hybrid apps where you control the scroll container.

---

### 7. Pagination & Infinite Scroll

**Pattern selection table:**

| Content type | Recommended pattern | Why |
|---|---|---|
| Social/entertainment feed (browse-not-search) | Infinite scroll | Low interaction cost, natural mobile flow |
| Search results, e-commerce catalog | "Load more" button | Users need to compare, return to position, reach footer |
| Structured data (analytics, settings lists) | Traditional pagination | Predictable position, bookmarkable state |
| Mixed (browse then refind) | "Load more" + page anchors | Balance of flow and refindability |

[documented — NN/G Infinite Scrolling Tips, Baymard Institute via search results]

**Infinite scroll UX rules:**
- Show a spinner or skeleton at the bottom sentinel while fetching the next page. [documented — NN/G]
- Preserve scroll position on back-navigation. If the browser/app resets to top, users abandon. [documented — NN/G]
- Expose a "Back to top" control once the user is > 2 screens below fold. [observed — iOS system Mail, Apple News]
- Use virtualized/windowed lists for > ~200 items to keep frame rate stable. [inferred — from iOS UICollectionView/SwiftUI LazyVStack guidance]
- **Illusion of completeness:** Infinite scroll with no bottom boundary misleads users into thinking they have seen everything. Use "X more items" counters or section headers. [documented — NN/G]

---

### 8. Form Validation Timing

| Trigger | Use for | Avoid for |
|---|---|---|
| **On keypress (live)** | Password strength meter, character count, search-as-you-type | Format validation (email, phone) — flags partial valid input as errors mid-type |
| **On blur** | Email format, phone format, URL format | Empty-required fields (user may not have reached that field yet) |
| **On submit** | Required-field presence check, cross-field validation (e.g., password confirm) | — |
| **Combined (blur + submit)** | General forms | — |

[documented — Smashing Magazine inline validation research, a11yblog]

**Accessibility rule:** Never fire validation on every keystroke for screen-reader users — it creates excessive announcement noise. Gate on blur minimum. [documented — a11yblog 2026]

---

## Recipes

### SwiftUI

#### Skeleton / redacted placeholder
```swift
struct ArticleRow: View {
    let article: Article?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(article?.title ?? String(repeating: "X", count: 40))
                .font(.headline)
            Text(article?.subtitle ?? String(repeating: "X", count: 60))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .redacted(reason: article == nil ? .placeholder : [])
        // Add shimmer via a package (e.g. markiv/SwiftUI-Shimmer) or
        // a custom LinearGradient ViewModifier sweeping left→right.
    }
}
```

#### ContentUnavailableView — three scenarios
```swift
// 1. Search no-results (system-localized copy)
ContentUnavailableView.search(text: searchQuery)

// 2. First-run empty state
ContentUnavailableView {
    Label("No Notes Yet", systemImage: "note.text")
} description: {
    Text("Tap the compose button to write your first note.")
} actions: {
    Button("Create Note") { viewModel.createNote() }
}

// 3. Network error with retry
ContentUnavailableView {
    Label("Couldn't Load Feed", systemImage: "wifi.slash")
} description: {
    Text("Check your connection and try again.")
} actions: {
    Button("Retry") { Task { await viewModel.load() } }
}
```

#### AsyncImage with all three phases
```swift
AsyncImage(url: imageURL) { phase in
    switch phase {
    case .empty:
        // Skeleton placeholder shaped like the final image
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(.systemFill))
            .aspectRatio(16/9, contentMode: .fill)
            .redacted(reason: .placeholder)
    case .success(let image):
        image
            .resizable()
            .aspectRatio(contentMode: .fill)
            .transition(.opacity.animation(.easeIn(duration: 0.2)))
    case .failure:
        Image(systemName: "photo.slash")
            .font(.largeTitle)
            .foregroundStyle(.secondary)
    @unknown default:
        EmptyView()
    }
}
```

#### Pull-to-refresh
```swift
List(viewModel.items) { item in
    ItemRow(item: item)
}
.refreshable {
    await viewModel.reload()  // holds indicator until await resolves
}
```

#### Optimistic update (SwiftUI + async/await pattern)
```swift
func toggleLike(post: Post) async {
    // 1. Apply immediately
    viewModel.setLiked(post.id, to: !post.isLiked)

    do {
        // 2. Confirm with server
        try await api.toggleLike(postID: post.id)
    } catch {
        // 3. Roll back + notify
        viewModel.setLiked(post.id, to: post.isLiked)  // revert
        viewModel.showToast("Couldn't update — try again")
    }
}
```

---

### Web

#### CSS skeleton shimmer
```css
.skeleton {
    background: linear-gradient(
        90deg,
        #e8e8e8 25%,
        #f5f5f5 50%,
        #e8e8e8 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite linear;
    border-radius: 4px;
}

@keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

/* Shape placeholders to match real content */
.skeleton-title  { height: 1.25rem; width: 70%; margin-bottom: 0.5rem; }
.skeleton-body   { height: 0.875rem; width: 100%; margin-bottom: 0.25rem; }
.skeleton-avatar { width: 40px; height: 40px; border-radius: 50%; }
```

```html
<!-- Accessibility: mark skeleton container as busy -->
<div aria-live="polite" aria-busy="true" class="feed">
  <div class="skeleton skeleton-title"></div>
  <div class="skeleton skeleton-body"></div>
</div>
```

#### Optimistic update (vanilla JS)
```js
async function toggleLike(button, postId) {
    const wasLiked = button.dataset.liked === "true";

    // 1. Apply immediately
    button.dataset.liked = String(!wasLiked);
    button.setAttribute("aria-pressed", String(!wasLiked));
    updateLikeCount(postId, wasLiked ? -1 : +1);

    try {
        // 2. Confirm
        await api.toggleLike(postId);
    } catch (err) {
        // 3. Roll back + toast
        button.dataset.liked = String(wasLiked);
        button.setAttribute("aria-pressed", String(wasLiked));
        updateLikeCount(postId, wasLiked ? +1 : -1);
        showToast("Couldn't save — try again", { action: "Retry",
            onAction: () => toggleLike(button, postId) });
    }
}
```

#### Inline form error
```html
<div class="field">
    <label for="email">Email</label>
    <input
        id="email"
        type="email"
        aria-describedby="email-error"
        aria-invalid="true"
    />
    <p id="email-error" role="alert" class="field-error">
        Enter a valid email address — for example, you@example.com
    </p>
</div>
```
```css
.field-error {
    color: var(--color-error, #d1242f);
    font-size: 0.8125rem;
    margin-top: 4px;
}
input[aria-invalid="true"] {
    border-color: var(--color-error, #d1242f);
    outline-color: var(--color-error, #d1242f);
}
```

#### IntersectionObserver infinite scroll
```js
const sentinel = document.querySelector("#load-more-sentinel");

const observer = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || isFetching || !hasMore) return;

    isFetching = true;
    showSkeletonRows(3);         // append skeleton rows immediately

    try {
        const newItems = await api.fetchPage(++currentPage);
        removeSkeletonRows();
        appendItems(newItems);
        if (newItems.length < PAGE_SIZE) {
            hasMore = false;
            observer.disconnect();
            showEndMarker("You've reached the end");
        }
    } catch (err) {
        removeSkeletonRows();
        showInlineError("Couldn't load more — Retry", onRetry);
    } finally {
        isFetching = false;
    }
}, { rootMargin: "200px" });     // pre-fetch 200px before sentinel enters view

observer.observe(sentinel);
```

---

## Faithful Replication

When building web UIs that should feel like Apple apps:

1. **Redacted → CSS skeleton.** Match placeholder shapes to real content dimensions. Never use a spinner where the layout is known.
2. **ContentUnavailableView → full-container empty state.** Center icon + title + subtitle + CTA. Use SF Symbols via system font (or SVG equivalents). Never shrink into a one-liner.
3. **`.refreshable` → manual refresh button** on desktop web; on mobile PWA, implement pull-gesture only if you own the scroll container (no browser chrome conflict).
4. **Native alerts → `<dialog>` with `role="alertdialog"`** for blocking errors; banner/toast for transient non-blocking errors.
5. **Timing match:** Respect the 100 ms / 1 s / 10 s thresholds exactly. Introduce artificial minimum display times of ~400 ms for skeletons if the real fetch is sub-100 ms — a flash-of-skeleton is worse than no skeleton. [inferred — common practice]
6. **Optimistic updates:** Use `useOptimistic` (React 19) or the vanilla pattern above. Always pair rollback with a visible, actionable toast.

---

## Anti-patterns

| Anti-pattern | Why it fails | Correct alternative |
|---|---|---|
| **Spinner for everything** | Jarring for fast ops; no layout hint for slow ones | Skeleton for known layouts; ProgressView only for unknown-shape waits |
| **Spinner for sub-100 ms ops** | Flash-of-spinner trains users to think the app is slow | No indicator; show the result directly |
| **Blocking input during loading** | User is idle; typing ahead is natural | Debounce + accept input; load around the user's work |
| **Happy-path-only error handling** | Network always fails eventually | Every async call has an error branch with recovery UI |
| **Dead-end empty states** ("No items") | User is stranded | Always include a path forward: CTA, search tips, or retry |
| **Alert for everything** | Interrupts flow for problems the user didn't cause | Inline error for field issues; banner/toast for transient failures |
| **Blaming the user** ("You entered an invalid email") | Hostile; inaccurate attribution | "This doesn't look like a valid email — try user@example.com" |
| **Losing user input on error** | Infuriating; doubles user's work | Preserve all form state across errors, reloads, and network loss |
| **Premature validation (on every keystroke)** | Flags partial-valid input mid-type; a11y noise | Validate on blur; required-presence on submit only |
| **Infinite scroll with no bottom signal** | Illusion of completeness — users stop before the end | Add "X items remaining" counter or a "You've seen it all" marker |
| **Hiding disabled controls with no trace** | Users can't discover capabilities they'll later qualify for | Disable (reduce opacity + block input) + expose reason on interaction |
| **No cancel on long operations** | User is trapped; perceived as frozen | Cancel button for anything > 10 s; escape hatch for > 30 s [documented — NN/G] |

---

## Sources

- [Apple HIG — Loading](https://developer.apple.com/design/human-interface-guidelines/loading) [documented]
- [Apple HIG — Progress Indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) [documented]
- [Apple HIG — Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) [documented]
- [Apple HIG — Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) [documented]
- [Apple HIG — Controls](https://developer.apple.com/design/human-interface-guidelines/controls) [documented]
- [Nielsen Norman Group — Response Times: The 3 Important Limits](https://www.nngroup.com/articles/response-times-3-important-limits/) [documented]
- [Nielsen Norman Group — Infinite Scrolling Tips](https://www.nngroup.com/articles/infinite-scrolling-tips/) [documented]
- [Nielsen Norman Group — Powers of 10: Time Scales in UX](https://www.nngroup.com/articles/powers-of-10-time-scales-in-ux/) [documented]
- [Apple Developer — AsyncImage](https://developer.apple.com/documentation/swiftui/asyncimage) [documented]
- [Antoine van der Lee — ContentUnavailableView](https://www.avanderlee.com/swiftui/contentunavailableview-handling-empty-states/) [documented]
- [Antoine van der Lee — Redacted View Modifier](https://www.avanderlee.com/swiftui/redacted-view-modifier/) [documented]
- [Swift with Majid — Mastering ContentUnavailableView](https://swiftwithmajid.com/2023/10/31/mastering-contentunavailableview-in-swiftui/) [documented]
- [React — useOptimistic](https://react.dev/reference/react/useOptimistic) [documented]
- [Smashing Magazine — Inline Validation UX](https://www.smashingmagazine.com/2022/09/inline-validation-web-forms-ux/) [documented]
- [a11yblog — Real-time form validation accessibility](https://a11yblog.com/2026/02/05/why-real-time-form-validation-can-become-an-accessibility-issue/) [documented]
- [UX Psychology — Hidden vs Disabled States](https://uxpsychology.substack.com/p/hidden-vs-disabled-states) [documented]
- [UX Tigers — Inactive GUI Controls: Show, Disable, or Hide?](https://www.uxtigers.com/post/inactive-buttons) [documented]
- [markiv/SwiftUI-Shimmer](https://github.com/markiv/SwiftUI-Shimmer) [documented — open source]
- [Hacking with Swift — Pull to refresh](https://www.hackingwithswift.com/quick-start/swiftui/how-to-enable-pull-to-refresh) [documented]
- iOS Human Interface Guidelines (archived mirror) — Loading section [documented]

---

CONFIDENCE: 82% — Core thresholds (NN/G), ContentUnavailableView API, and SwiftUI skeleton/refreshable patterns are well-sourced; the "minimum 400 ms skeleton display" recommendation is inferred from industry convention rather than a cited Apple or NN/G source, and the specific opacity values for disabled states (0.3–0.4) are approximated from observed system behavior rather than a published HIG spec.
