# Example PR description (TodaysPortCard, APP2X-841/842)

This is the user's own PR. It is the template for tone, density, structure, and section ordering. When in doubt about how a new PR description should read, match this.

---

Figma: [Fluidity UI Kit — Today's Port Card](https://www.figma.com/design/8auh62FLxGzJiSMKTTtboB/Fluidity-UI-Kit?node-id=<NODE_ID_HERE>&m=dev)
Jira: [APP2X-841](https://jira.rccl.com/browse/APP2X-841), [APP2X-842](https://jira.rccl.com/browse/APP2X-842)

## Summary

Implements the `TodaysPortCard` component for the Fluidity Design System in React Native — a vertical 3-slot card with port kicker/title/subtext, weather badge, gangway times, and a "Daily snapshot" CTA. Extracts `Pill` and `Selector` as reusable primitives. Adds 18 multi-color brand icons (weather + gangway) and upgrades the icon generator to preserve multi-color fills. Also includes several confetti fixes carried over from the countdown card work and a major token pipeline refresh.

## Note

`TodaysPortCard` is a pure presentational component — it does not fetch weather, compute gangway windows, or subscribe to sail-day state. The consumer owns all data: day number, ship time, temperature, icon selection, and gangway visibility. `showGangway={false}` is the hook for the last-port / at-sea state; the card does not infer it.

## Evidence

| iOS | Android |
| --- | --- |
| https://github.com/user-attachments/assets/4e1c8930-97d8-48ea-81c7-a668a4930969 | https://github.com/user-attachments/assets/6d9a66e0-a88e-45cc-86b4-8ff92893f989 |

## Component Features

### TodaysPortCard

- Vertical card with three slots: header (kicker / title / subtext + weather badge), gangway (down + up pills), and selector (Daily snapshot CTA)
- All spacing, padding, radius, and shadow pulled from `containment/standardCard/vertical/lg/*` tokens and shared `shadows.E3`
- Weather badge absolutely aligned to top-right of header, reserves content width so it doesn't collide with the title
- Gangway section conditionally hidden via `showGangway={false}` for at-sea / post-debark states
- Pressable variant with accessibility hint — card role switches between `button` (with `onPress`) and `summary` (without)
- VoiceOver reads kicker → title → subtext → temperature → gangway times → CTA in a single logical order
- Slots into the Header's `actionSlot` alongside `CruiseCountdownCard`

### WeatherBadge

- Inline weather icon + temperature display, top-right of the port card header
- Fixed 24×24 icon frame, Body/01 Strong temperature label
- Multi-color SVG rendering (sun + cloud layering) — reuses the new multi-color icon pipeline
- Styled entirely from tokens; no brand conditionals

### Pill (shared primitive)

- Icon circle + two-line content (label + value) in a rounded container
- Used twice in `TodaysPortCard` (Gangway down / Gangway up) and available for future card compositions
- Content area is `flex: 1` — handles long labels via single-line ellipsis on the value row
- Icon chip uses `color/containment/card/icon/fill` for the fill; icon foreground inherits from the chip
- Typography: Caption 02 Strong for the label, Body/01 Strong for the value, pulled from responsive `typeScale`

### Selector (shared primitive)

- Fully rounded CTA row with optional prefix/suffix icons and a label
- Default background: `color/action/selector/fill/sunken` (updated from `card/fill/common/raised01` to match Figma)
- Default radius: `radii/action/selector/default` (= 80, `proportion/10`), decoupled from the row height
- Gap: `spacing/m` (= 8), padding: `proportion/1_50` (= 12), height: 48
- Prefix icon 24×24, suffix icon 16×16 (default caret-right)
- Typography: Interface/Button 02 — size `xs`, lineHeight `xs`, letterSpacing `s`, semibold, `textIcon/common/mediumEmphasis`
- Label supports Dynamic Type via `allowFontScaling` + `DEFAULT_MAX_FONT_SIZE_MULTIPLIER`

## Icon Pipeline

- 18 new icons across all 3 brands (Royal / Celebrity / Silversea):
    - 14 multi-color weather icons (clear, partially cloudy, scattered clouds, misty, rain, snow, thunder — day + night variants)
    - 4 gangway icons (up / down, filled + outline)
- Multi-color SVG support — icon generator now preserves original `fill` attributes when an SVG has multiple colors, instead of globally replacing with `{color}`. Single-color icons continue to be monochromatic and tintable.
- Silversea gangway fix — gangway icon foregrounds were resolving to white-on-white; corrected in the Silversea theme.

## Token & Infrastructure Updates

- Tokens refreshed across all three brands (Royal, Celebrity, Silversea) — new `action/selector/*` color + radii tokens, responsive type scale updates, and re-generation of all iOS/Android artifacts (`.swift`, `.kt`).
- Tokenizer — `token-manager/ui.html` `breakpointModeMap` updated to support Figma's semantic mode names (Large / xLarge / xxLarge) alongside legacy pixel-range names. `wide` breakpoint inherits from `desktop` when Figma only exposes three modes.
- E3 shadow — added to shared `shadows.ts`; consumed by `TodaysPortCard`.
- Letter spacing — all text elements in the card now pull `letterSpacing` from responsive `typeScale` instead of hardcoded values.

## Confetti Carry-Overs (from APP2X-840)

- Memory leak fix — replaced `key` remounting with per-burst `Animated.Value` lifecycle + explicit `__detach()` cleanup
- `anchorRef` prop — pin confetti origin to any View's center, measured via `measureInWindow`. Used to anchor bursts on the countdown timer badge.
- Countdown clamp raised from 999 → 9999 to support multi-year pre-cruise countdowns.

## Third-Party Dependencies

| Package | Purpose | Why This Library |
| --- | --- | --- |
| `react-native-svg` | Multi-color weather + gangway | Already a peer dep; no new dependency added |

No new runtime dependencies introduced in this PR.

## Build & Packaging

New exports from `@rcg-digital-mobile/fluidity-react-native`:

- Components: `TodaysPortCard`, `WeatherBadge`, `Pill`, `Selector`
- Types: `TodaysPortCardProps`, `WeatherBadgeProps`, `PillProps`, `SelectorProps`

Other:

- Figma Code Connect mapping for `TodaysPortCard`
- Storybook stories at `apps/example-rn/src/stories/Display/TodaysPortCard.stories.tsx`
- Example app — 4 card-type demos (Cruise Countdown, Today's Port, Day 0 / Embarkation, At Sea) with runtime theme switcher via `DevSettings`

## Checklist

### Component Behavior

- [x] Card renders kicker, title, subtext, weather badge, gangway pills, and Daily snapshot selector
- [x] Weather badge hides when icon or temperature is missing
- [x] Gangway section hides when `showGangway={false}` or both times omitted
- [x] Daily snapshot selector fires `onDailySnapshotPress`
- [x] Card is pressable when `onPress` provided; otherwise renders as static summary
- [x] Slots cleanly into `Header.actionSlot` next to `CruiseCountdownCard`

### Token Compliance

- [x] All card styling uses design tokens (no hardcoded values)
- [x] Selector uses `action/selector/fill/sunken` + `radii/action/selector/default`
- [x] Card uses `containment/standardCard/vertical/lg/*` for padding and radius
- [x] Typography uses responsive `typeScale` tokens (size, lineHeight, letterSpacing)
- [x] Brand differences (Royal / Celebrity / Silversea) resolve through tokens automatically
- [x] Silversea gangway icon colors corrected

### Accessibility

- [x] VoiceOver reads kicker → title → subtext → temperature → gangway → CTA in order
- [x] Card role switches between `button` (with `onPress`) and `summary` (without)
- [x] Selector announces label via accessibility role `button`
- [x] Dynamic Type supported on all text via `DEFAULT_MAX_FONT_SIZE_MULTIPLIER` clamp

### Icon Pipeline

- [x] 14 weather icons render with original multi-color fills (sun/cloud layering)
- [x] 4 gangway icons render across all 3 brands
- [x] Icon generator multi-color path verified against single-color regressions

### Code Connect

- [x] `TodaysPortCard` Figma mapping published

### Build & CI

- [x] `npm run build` succeeds
- [x] `npm run typecheck` passes (RN package + example app)
- [x] `npm run lint` passes
- [x] `npm run format:check` passes
- [x] 185/185 tests passing (20 suites)
- [x] Selector unit tests (7/7) passing after spec update

## Test plan

- Verify Today's Port Card renders in Storybook for Royal, Celebrity, Silversea
- Toggle between all 4 card types in example app (Countdown → Port → Day 0 → At Sea)
- Verify gangway pills hide when `showGangway={false}` or props omitted
- Verify weather badge hides when icon or temperature missing
- Verify Daily snapshot selector background is `#E6E9ED` (sunken) and pill-shaped
- VoiceOver walkthrough on port card and at-sea card
- Fire confetti multiple times — confirm no memory growth in Xcode Instruments
- Verify confetti anchors to countdown card center via `anchorRef`
- Test 4-digit countdown (9999) — heading text should not overlap timer
