# Restraint & Anti-Slop — Apple's real defaults (read before reaching for effects)

The rest of this family documents Apple's *techniques* (glass, springs, bento,
Liquid Glass, scrollytelling). This file documents the **discipline** that makes
those techniques read as Apple instead of as generic AI-generated UI. Apple's
identity is **deference** — it *withholds* far more than it applies. Most "make
it Apple" failures are not missing effects; they are **too many** effects.

> Origin: a dogfood test where agents armed only with this family's effect
> recipes produced **darker, glassier, gradient-ier** landing pages than both
> apple.com and the project's own hand-built page. The recipes were applied
> correctly; the *restraint* was missing. [observed]

## Apple's real marketing defaults (the ones LLMs get wrong)

1. **Light is the default; dark is the exception.** [observed — apple.com]
   apple.com marketing is overwhelmingly **light** (`#f5f5f7`/white). Dark
   sections exist but are *deliberate, occasional moments* (a product film, one
   dramatic feature), not the page's baseline. **Do not default to a dark hero.**
   A dark-by-default page reads as generic dark-SaaS, not Apple.

2. **Show the real product. Always.** [documented — HIG product-as-hero; observed]
   Apple's hero is the actual product — a real device, a real screenshot inside a
   real device frame, a real render. **Placeholder rectangles, abstract SVG
   "UI diagrams," and lorem blocks are a failure**, not a stand-in. If you have no
   asset, build a faithful device-framed mock of the *real* UI — never an abstract
   gradient blob standing in for "the app."

   - **Fidelity tiers:** (a) real screenshot / photographic render inside a device frame = Apple's public-marketing bar; (b) structurally faithful HTML/SVG device-frame mock containing the real UI's actual text/controls = acceptable for internal/prototype work; (c) abstract placeholder rectangles or gradient blobs = **never acceptable**. Aim for (a); (b) passes; (c) fails. [observed]

3. **One accent, lots of neutral.** [observed]
   Neutral greys + generous whitespace + **one** systemBlue accent. Resist a
   second accent, resist gradient text on every heading, resist rainbow tiles.

4. **Whitespace is the feature.** [documented — HIG layout]
   Big empty space is confidence. When unsure, add space, not an element.

5. **Type does the work, not chrome.** [observed]
   A large, tight-tracked headline on calm background out-Apples any amount of
   glass. Hierarchy comes from **type scale + space**, not from boxes/borders/glow.

## The AI-slop traps (each is a real failure mode from the dogfood)

| Trap | Why it's wrong | Do instead |
|---|---|---|
| **Dark-by-default hero** | Apple defaults light; dark-everywhere = generic | Light hero; reserve dark for ≤1 purposeful section |
| **Glass on everything** | Apple uses glass on *chrome* (nav/sheets/sidebars), not every card | Glass for floating chrome; **solid/quiet** surfaces for content cards |
| **Gradient text on every heading** | Apple uses it on *one* accent phrase, rarely | At most one accent word, one place — or none |
| **Bento because you can** | Bento is for a *feature highlights* moment, not the whole page | Use bento once, where it earns it; else simple stacked sections |
| **Placeholder abstractions** | Apple never ships "abstract UI" | Real product in a real device frame |
| **Effect-stacking** (glass + gradient + blur + shadow + spring all at once) | Reads busy/synthetic | Pick the *one* effect the moment needs |
| **Over-saturation / glow** | Apple is restrained, cool, calm | Mute it; lower opacity; remove the glow |

## The restraint pass (run before declaring "Apple-grade")

For every effect on the screen, ask: **"If I remove this, does the design lose
meaning — or just lose decoration?"** If it only loses decoration, **remove it.**
Then check:

- [ ] Is the page **light by default**, with dark only where it's purposeful?
- [ ] Is a **real product** shown (device frame / real screenshot), not a placeholder?
- [ ] Is there **exactly one** accent color doing the pointing?
- [ ] Could a **plain solid card** replace this glass card with no loss? (then do it)
- [ ] Is gradient-text used **0–1 times**, not on every heading?
- [ ] Does **type + whitespace** carry the hierarchy (not boxes/borders/glow)?
- [ ] Have I **removed** at least one effect since the first draft?
- [ ] On a **flagship/marketing page** — is there continuous scroll-linked motion and at least one pinned or scrubbed cinematic scene, or is this a dead static template? [observed — the absence of this is as much an Apple failure as over-decoration]

If you can't remove anything from a utility screen, you probably haven't applied enough restraint yet. If a flagship marketing page has only one-shot fades, you haven't applied enough aliveness yet.

## The other failure mode: under-animation (the dead template)

Restraint cuts gratuitous **decoration**. It does NOT mean "no motion." This is
the equal and opposite failure — and the one LLM-generated "Apple" pages now
fail on most often.

A flagship/marketing/product page with only static one-shot fades, no
continuous scroll-linked motion, and no pinned or scrubbed scenes is **also an
Apple failure**. It reads as a dead template — the kind any generic CSS
framework generates by default. Apple's marketing pages are not dead; they are
some of the most carefully animated pages on the web. Removing all motion in
the name of "restraint" is as wrong as stacking every glass effect because you
have a recipe for it. [observed — apple.com/iphone/ and product detail pages]

> The research inventory at `_planning/research-findings-inventory.md` documents
> the full signature "alive" set (continuous scroll-progress transforms, sticky
> pinned scenes, scrubbed hero, theme morph, ambient float, text wipe). These
> are not decoration — they ARE the substance of a flagship marketing page.

## The surface axis (how much motion is correct)

The right motion budget is determined by **surface type**, not by a single
universal rule. Restraint discipline applies to both; the budget is opposite.

| Surface | Motion budget | Right call |
|---|---|---|
| **Utility** — app screen, dashboard, settings, form, content card | **Restrained, near-invisible.** Springs ≤300ms. No scroll-jacking. Ambient / cinematic effects OFF. State transitions only. | If the user is here to accomplish a task, motion should accelerate the task, not comment on it. |
| **Flagship marketing / product** — apple.com/iphone-class hero, landing page, feature showcase | **Motion IS the substance.** Commit to cinematic scroll choreography: scrubbed/pinned scenes, continuous damped scroll-progress transforms, theme morph light↔dark, ambient float. Under-animating here is the failure. | If the user is here to be persuaded, the page must feel alive — static = dead = unconvincing. |

One line: **same restraint discipline, opposite motion budget** — pick the
budget from the surface type, not from a universal default. [observed]

## Exemplar (two references — one for each axis)

**Restraint exemplar:** The project's own `frontend/css/landing.css` is the
model for **deference and restraint** [observed]: a light `#f5f5f7` hero with a
tight-tracked headline, one blue accent, clean white feature cards, the real app
in a phone device-frame, and a single purposeful dark section. More Apple-aligned
than any dark-glass pastiche because it *withholds*. Match this for restraint.

**Aliveness exemplar:** `apple.com/iphone` (and product detail pages like
`apple.com/iphone-16-pro`) is the model for **cinematic aliveness** [observed]:
continuous scroll-progress transforms with damped lerp, sticky-pinned scenes with
multi-element choreography, cross-section light↔dark theme morph, ambient float
on idle product imagery, and text-wipe reveals. This is the benchmark a flagship
marketing page is measured against. Match this for aliveness.

A well-executed flagship page needs **both** — landing.css restraint discipline
(light-first, real product, one accent, no slop) applied to the apple.com/iphone
motion budget (continuous, cinematic, scroll-driven). Neither exemplar alone is
sufficient.

## Sources
- apple.com homepage + product pages, observed 2026-05-22 (light-first, real product imagery, single-accent discipline). [observed]
- Apple HIG — "Provide an excellent first experience" / product-as-hero, deference principle. [documented]
- Project `frontend/css/landing.css` + `frontend/landing.html` (the exemplar). [observed]
