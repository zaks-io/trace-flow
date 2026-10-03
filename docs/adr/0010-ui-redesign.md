# UI Redesign: Refined Data Canvas

## Overview

We are adopting a new design aesthetic called "Refined Data Canvas" for Trace Flow, moving away from the standard "Dark Mode SaaS / AI Tool" look (e.g., deep purples, neon glows, and heavy cards). Our goal is to create an interface that feels pleasant, highly usable, and akin to a beautifully curated data visualization or editorial piece. It will be clean, breathable, and rely on spacing and typography rather than heavy borders and glowing elements.

## Color Palette

Data visualizations (models, providers, token types, latency) use an 8-slot categorical palette exposed as `--chart-1..8` (`bg-chart-N`, `var(--color-chart-N)`). Terracotta stays the brand accent as `--primary`; it is no longer a series color.

### Amendment (October 2026): colorblind-safe categorical palette

The original art-directed palette (terracotta, ochre, sage, cerulean, amethyst, coral, teal, umber) failed colorblind separation. Amethyst next to cerulean measured a CVD ΔE of 5.5 against a target of 8, and three slots sat outside the lightness band on the dark card surface. We replaced it with the dataviz skill's validated reference palette, keeping its slot order because the order is the colorblind-safety mechanism. The validator guarantees separation between adjacent slots, which covers a fixed-order stack or bar only while no segment drops out. Lines that cross, and stacks, bars and pies that omit zero segments, let any two series touch, so those charts are held to the all-pairs check described under the rules below.

| Slot | Hue     | Light (`:root`) | Dark (`.dark`) |
| ---- | ------- | --------------- | -------------- |
| 1    | blue    | `#2a78d6`       | `#3987e5`      |
| 2    | orange  | `#eb6834`       | `#d95926`      |
| 3    | aqua    | `#1baf7a`       | `#199e70`      |
| 4    | yellow  | `#eda100`       | `#c98500`      |
| 5    | magenta | `#e87ba4`       | `#d55181`      |
| 6    | green   | `#008300`       | `#008300`      |
| 7    | violet  | `#4a3aa7`       | `#9085e9`      |
| 8    | red     | `#e34948`       | `#e66767`      |

Validator results (`validate_palette.js`, OKLab ΔE ×100, Machado 2009 CVD simulation, adjacent pairs) against the app's own surfaces, converted from the OKLCH tokens:

| Check                                            | Dark card `#111114` | Dark page `#0c0d0f` | Light card `#f6f5f1`                                    | Light page `#fdfcf8`                       |
| ------------------------------------------------ | ------------------- | ------------------- | ------------------------------------------------------- | ------------------------------------------ |
| Lightness band (dark 0.48-0.67, light 0.43-0.77) | PASS                | PASS                | PASS                                                    | PASS                                       |
| Chroma floor (C >= 0.10)                         | PASS                | PASS                | PASS                                                    | PASS                                       |
| CVD separation (target >= 8)                     | PASS, worst 8.4     | PASS, worst 8.4     | PASS, worst 9.1                                         | PASS, worst 9.1                            |
| Normal-vision floor (>= 15)                      | PASS, worst 19.3    | PASS, worst 19.3    | PASS, worst 19.6                                        | PASS, worst 19.6                           |
| Contrast vs surface (>= 3:1)                     | PASS, all 8         | PASS, all 8         | WARN: orange 2.93, aqua 2.58, yellow 1.98, magenta 2.47 | WARN: aqua 2.74, yellow 2.11, magenta 2.62 |

The worst dark CVD pair is yellow and aqua (slots 4 and 3); the worst normal-vision pair is magenta and yellow (slots 5 and 4). No light slot hard-fails, so none was re-stepped. The app currently renders only the dark theme (`<html class="dark">`), so the light values are validated for when a light theme ships.

Rules that follow from the validation:

- **What is validated.** Adjacent pairs, in render order, for fixed-order stacks and bars that never omit a segment. All pairs (`--pairs all`) for everything else: lines that can cross, and stacks, bars and pies that drop zero segments. A chart that uses non-consecutive slots must pass on its exact set. Avoid slot 6 (green) and slot 8 (red) for series that carry ordinal weight, such as percentiles, or share a mark set with status colors, because they read as good and bad.
- **Three series max where any two marks can touch.** The first three slots pass all-pairs in both modes (worst CVD 9.4 dark, 9.2 light). On the dark card the best four slots (1, 4, 5, 6) clear all-pairs only in the 6-8 CVD floor band, and no five clear it at all, so a chart past three either folds into "Other", facets, or carries a secondary encoding that the rules below name.
- **Token types share one mapping and one stack order** (`components/shared/tokenTypes.ts`): Input slot 4, Cache Read slot 1, Cache Write slot 6, Output slot 5, Reasoning slot 7, stacked in that order everywhere (usage, operations, agents, traces, the cost pie). The order is part of the validation. Reasoning only exists alongside Output and stacks directly against it, so in stacks and the pie Reasoning only ever touches Output (and Input across the pie's wrap). Results on the dark card (CVD / normal-vision ΔE):
  - Adjacent, all five in order: PASS, 13.0 / 19.7.
  - All pairs among the four that can meet in a stack (Input, Cache Read, Cache Write, Output): PASS, 6.9 / 19.3. Input against Cache Write sits in the 6-8 CVD floor band, which is legal only with secondary encoding.
  - Output against Reasoning: PASS, 16.0 / 19.7.
  - All pairs, all five: FAIL, Cache Read against Reasoning at 1.9 / 9.8. They can only meet where lines cross, so line charts carry a dash per series.
  - Light card: PASS on every check above, including all pairs for all five.
- **Secondary encodings in use.** Bar cards (`BarCard`) leave a gap at every color change, so segments that meet after zero values drop out stay separable. The agents usage chart and the usage cost chart give every series its own dash (`components/shared/seriesDash.ts`) with matching legend icons; no slot pair that fails the validator shares a dash. The cost pie keeps its padding gaps and the value table beside it.
- **Agent groups** (by repo, model or source) use slots 1-8 in order and fold the rest into "Other", which takes neutral ink instead of cycling back to slot 1. They pass adjacent (8.4 / 19.3) and fail all-pairs (1.6 / 7.1, the three-series cap binding), so lines and stacked areas rely on the dash per series and the legend.
- **Validated non-consecutive sets** (render order, dark card `#111114`, CVD / normal-vision ΔE; all also pass on the light card):
  - Trace Duration bar, TTFT and Generation (slots 2, 1): 26.8 / 31.8.
  - Usage duration line, Avg and P95 (3, 7): 17.3 / 24.6.
  - Usage percentile labels, Median, P75, P95 and Max (3, 2, 7, 5): 9.4 / 19.7.
  - Operations latency labels, P95 and Max (7, 5): 16.0 / 19.7.
  - Caching cards, Uncached, Cached and Warmup in token-type colors (4, 1, 6): adjacent 27.3 / 29.9; all pairs 6.9 / 23.3, floor band, carried by the bar gap.
  - Estimated Cost card, token segments and the Upstream label (4, 1, 6, 5, 7, 2): 13.0 / 19.7.
  - Usage card tints, Requests through Caching with Projected Cost on slot 1 (5, 4, 1, 2, 7, 3): 13.2 / 19.3.
  - Admin operational totals, skip rate, TTFB, prompt and bytes (2, 7, 5, 1): 15.9 / 19.7.
- **Light-mode relief rule.** Light slots below 3:1 on their surface (the WARN rows above) may only ship with visible direct labels or a table view of the same values. The contrast WARN obligates that relief channel; it is not dismissable.

### Status colors

Status is a separate, fixed scale exposed as `--status-good` `#0ca30c`, `--status-warning` `#fab219`, `--status-serious` `#ec835a`, and `--status-critical` `#d03b3b` (`text-status-good`, `var(--color-status-good)`). It is identical in both themes. On the dark card all four clear 3:1 (good 5.62, warning 10.27, serious 7.15, critical 3.92). On the light card warning (1.68) and serious (2.42) sit below 3:1 by design, so a status color always pairs with an icon or a text label and never carries meaning alone.

When a series means good or bad (success and failure, errors, priced and unpriced, fast and slow), it wears status tokens. When it is just "series 4", it wears a chart slot. Never mix the two in one chart, and never use a chart slot to imply status: slot 6 is green and slot 8 is red only as identities.

### Themes

- **Dark Theme**: A neutral, sophisticated charcoal (e.g., `oklch(0.16 0.005 270)`) rather than saturated deep purple-blue.
- **Light Theme**: A soft, warm off-white (e.g., `oklch(0.99 0.005 90)`) to ensure it feels natural and is easy on the eyes.

## Typography

- **UI & Headings**: We use a typeface that brings character while preserving extreme legibility, such as `Plus Jakarta Sans` or `Manrope`. This provides a warmer, more open feel than typical technical sans-serifs.
- **Data & Code**: We retain a crisp monospace font (like `JetBrains Mono` or `Fira Code`) strictly for displaying data values, IDs, and code snippets.

## Layout & Components

- **De-box the UI**: Remove heavy background cards (`bg-card`). We allow data to sit directly on the canvas, using extremely subtle tonal shifts instead of stark borders to separate content.
- **Navigation**: The sidebar navigation will be lighter and cleaner, potentially utilizing a floating or minimalistic pattern that maximizes the screen real estate for data.
- **Spacing**: We embrace generous whitespace. Elements will be grouped by proximity rather than by drawing explicit lines around them.

## Principles for Future Development

1. **Prioritize Legibility**: The primary purpose of Trace Flow is to observe data. Typography and contrast must always prioritize reading data over aesthetic flourish.
2. **Subtle Transitions**: Use gentle color transitions and shadows (if any). Avoid harsh neon glows unless absolutely necessary for critical alerts.
3. **Consistent Visualization**: Always map the same properties (e.g., specific models or providers) to the same colors from the 8-color palette when visualizing data to build user familiarity over time.
