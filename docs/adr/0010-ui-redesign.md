# UI Redesign: Refined Data Canvas

## Overview

We are adopting a new design aesthetic called "Refined Data Canvas" for Trace Flow, moving away from the standard "Dark Mode SaaS / AI Tool" look (e.g., deep purples, neon glows, and heavy cards). Our goal is to create an interface that feels pleasant, highly usable, and akin to a beautifully curated data visualization or editorial piece. It will be clean, breathable, and rely on spacing and typography rather than heavy borders and glowing elements.

## Color Palette

Instead of using generic primary colors, we will employ a curated, art-directed 8-color palette for data visualizations such as models, providers, and latency charts.

1. **Terracotta** (Warm Red/Orange)
2. **Ochre** (Muted Gold)
3. **Sage** (Soft Green)
4. **Cerulean** (Calm Blue)
5. **Amethyst** (Dusty Purple)
6. **Coral** (Soft Pinkish-Red)
7. **Teal** (Deep Blue-Green)
8. **Umber** (Rich Brown-Gold)

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
