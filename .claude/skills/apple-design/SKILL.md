---
name: apple-design
description: "Use when building, restyling, critiquing, or making any interface feel Apple-grade / premium / Cupertino-quality, or when you need Apple's design philosophy (Human Interface Guidelines — clarity, deference, depth), the 2025 Liquid Glass design language, or a map into deep Apple references. This is the HUB; route to apple-design-foundations/-materials/-motion/-os/-web/-backend/-tactics for specifics. Keywords: apple design, HIG, human interface guidelines, design philosophy, clarity deference depth, liquid glass, iOS 26, macOS Tahoe, visionOS, apple-grade, premium UI, cupertino, design system, make it look apple."
---

# Apple Design (family hub)

The reference for designing the way Apple does — and the index to the rest of the
family. Apple's whole system rests on three HIG themes:

- **Clarity** — legibility at every size, precise icons, deference of decoration to function.
- **Deference** — fluid motion and crisp, mostly-translucent UI that lets *content* lead; chrome recedes.
- **Depth** — distinct layers and realistic motion convey hierarchy and a sense of place.

The 2025 **Liquid Glass** era unifies all platforms around one adaptive, translucent material; the design goal is *hierarchy, harmony, consistency*. Read `references/philosophy-and-evolution.md` for the full "why" (skeuomorphism → flat → depth → glass) — imitate the *reasoning*, not just the blur.

## ⚠ Restraint first — but restraint is two-sided

Apple's identity is **deference**: it *withholds* far more than it applies. The #1 way "make it Apple" goes wrong is **too many** effects — but the equal and opposite failure is **too few** on the wrong surface.

**Two-axis decision — pick both before reaching for any effect:**

| Axis | Question | Rule |
|---|---|---|
| **Restraint axis** | Am I adding decoration, or meaning? | Remove anything that only adds decoration. Light-first, one accent, type+space carries hierarchy, glass = chrome only. |
| **Surface axis** | Is this a utility screen or a flagship/marketing page? | **Utility** (app/dashboard/form): motion near-invisible, springs ≤300ms, cinematic effects OFF. **Flagship** (landing/hero/product): motion IS the substance — continuous scroll-driven choreography required; a static page is the failure. |

Same restraint **discipline**, opposite motion **budget** — the surface sets the budget.

- **Light is the default; dark is the exception.** Do **not** default to a dark hero.
- **Show the real product** — a real screenshot inside a real device frame. A placeholder/abstract blob is a failure, not a stand-in.
- **One accent color**, lots of neutral + whitespace. **Type + space** carry hierarchy — not boxes, borders, or glow.
- **Glass = chrome only** (nav / sheets / sidebars), not every card. **Gradient-text 0–1×**, not every heading. **Bento once**, where it earns it.
- Before calling anything "Apple-grade", for each effect ask: *"Remove it — does the design lose meaning, or just decoration?"* If decoration, **remove it.** On a flagship page also ask: *"Is there at least one continuous scroll-driven cinematic scene, or is this a dead template?"*

Restraint exemplar: `frontend/css/landing.css` (deference, light-first, one accent).  
Aliveness exemplar: `apple.com/iphone` (continuous scroll-progress transforms, pinned scenes, theme morph, ambient float — the cinematic benchmark).

Full guide + slop-trap table + dead-template guard + restraint checklist: **`references/restraint-and-antislop.md`** — read it *before* the effect recipes in the child skills.

## When to use this hub
- The task is "make it feel Apple / premium" and you're not sure which sub-skill applies → start here, then route.
- You want the philosophy/principles, the era history, or the cross-cutting rules.

## Route to the right child

**This family is weighted toward the technical & functional substance** — layout/grid systems, motion mechanics, and interaction logic (how things *behave* and why). Color/theming is the light, replaceable part (one reference); don't over-index on it.

| Need | Skill |
|---|---|
| Layout/grid/spacing + adaptive/responsive logic · typography (+ color) | **apple-design-foundations** |
| **Interaction logic** — navigation models, state/loading/empty/error behavior, perceived performance, input/focus | **apple-design-interaction** |
| Animation/springs + timing & choreography, gestures, haptics, micro-interactions | **apple-design-motion** |
| iOS/iPadOS/macOS/visionOS/watchOS surfaces + component anatomy | **apple-design-os** |
| Glass/vibrancy materials, app icons, SF Symbols | **apple-design-materials** |
| apple.com marketing pages, scrollytelling, front-end engineering | **apple-design-web** |
| CDN/image/video delivery + (reverse-engineered) backend architecture | **apple-design-backend** |
| Accessibility/inclusive design + marketing/persuasion/brand tactics | **apple-design-tactics** |
| **"Make this landing/marketing page feel alive" / apple.com/iphone-style scrollytelling** | **apple-design-web** (interaction inventory, scrollytelling recipes) + **apple-design-motion** (continuous scroll-progress section, damped lerp primitive, pinned scenes) |

## Universal Apple rules (apply everywhere)
- Defer to content: chrome is quiet, translucent, and gets out of the way.
- Use the system type stack and **semantic** colors, not hardcoded hex (adapts to light/dark/contrast).
- Motion is **spring-based, interruptible, and respects `prefers-reduced-motion`**.
- Minimum **44pt** touch target; layouts must **reflow** for Dynamic Type, never truncate.
- Materials must degrade gracefully under Reduce Transparency / Increase Contrast.

## Confidence labels (used across all references)
Every non-trivial claim in the reference files is tagged `[observed]` (verifiable in the product), `[documented]` (Apple HIG/WWDC/docs), `[inferred]` (reasoned, unconfirmed), or `[speculative]` (educated guess). Treat `[inferred]`/`[speculative]` as analysis, never fact — this matters most in **apple-design-backend**.

## References
- `references/restraint-and-antislop.md` — **read first.** Apple's real defaults (light-first, real product, one accent) + the AI-slop traps + the restraint checklist.
- `references/philosophy-and-evolution.md` — HIG principles, the era evolution, and the *why* behind each shift.
