# ADR 0021: Statistical Methods for Agent Analytics

## Status

Accepted (methods catalog). Implementation tracked separately. Companion to the feature
spec `specs/features/agent-analytics-query-engine.md` and the fact model in ADR 0012.

## Context

The agent analytics generic query engine must characterize agent-conversation cost and
usage data **factually** — it computes statistics over raw facts and presents them; it does
not editorialize, diagnose, or render judgment. The defining product rule: facts, not
opinions.

The data has properties that make naive (classical, normal-theory) statistics actively
misleading:

- **Cost (USD) and token counts are heavy-tailed / strongly right-skewed.** A handful of
  turns dominate every sum. Observed concentration: top 10% of conversations ≈ 66% of spend.
- **Grouping entities (sessions) vary by orders of magnitude** in turn count and cost.
- **`turn_index` is a heavily-tied integer** (many sessions share index 1, 2, 3…).
- **Zero-cost / zero-token turns exist** (non-billable roles, missing coverage).

On this kind of data, mean ± standard deviation, Pearson correlation, and equal-width
histograms have **0% breakdown** — a single extreme value drives the result. Every statistic
in this catalog is therefore **robust-by-construction or nonparametric**, which is the
defensible posture for heavy-tailed cost data.

This ADR is the authoritative catalog of which statistical methods the engine uses, the
correct sample estimator for each (including finite-sample corrections that are commonly
gotten wrong), each method's failure modes, and a primary source for each. The engine's
"statistics boundary" is decided here: a **bounded catalog of robust operations** — each
applicable to any dimension/measure of the fact model — **not** arbitrary user SQL and
**not** an open-ended measure-algebra.

## Decision

Adopt the catalog below. Group the operations into six families:

1. Concentration / inequality
2. Distribution / heavy-tail description
3. Relationship / association
4. Trend / change over time
5. Decomposition / attribution
6. Outlier identification (stated as fact)

Each family applies to any measure (cost_usd, any token type, duration_ms, counts) across any
dimension (session, turn_index, model, source, repo, day, tool, …) of the fact model. New
questions are new (family × measure × dimension) configurations — never new bespoke pipes.

---

## 1. Concentration / inequality

Use when answering "where does spend concentrate" across entities (which conversations /
models / repos hold the cost). Anchor fact: top 10% of conversations ≈ 66% of spend.

### Lorenz curve

- **Definition:** sort entities ascending by value; `L(p)` = cumulative share of total value
  held by the bottom `p` fraction of entities. Plot cumulative entity share (x) vs cumulative
  value share (y); diagonal = perfect equality, convex curve bows below.
- **When:** to _see where_ concentration sits (structure a scalar hides).
- Sources: [Gini coefficient, Wikipedia](https://en.wikipedia.org/wiki/Gini_coefficient);
  [Income inequality metrics, Wikipedia](https://en.wikipedia.org/wiki/Income_inequality_metrics).

### Gini coefficient — with the mandatory sample bias correction

- **Definition:** `G = (Σ_i Σ_j |x_i − x_j|) / (2 n² x̄)` = 2 × area between Lorenz curve and
  the equality line.
- **Efficient O(n log n) form** (sorted ascending, 1-based i):
  `G = (2·Σ_i i·x_(i)) / (n·Σ_i x_(i)) − (n+1)/n` — this is the **biased "population"** form.
- **THE #1 LANDMINE — sample bias correction.** Gini is a U-statistic over distinct _pairs_;
  the `n²` denominator includes `n` zero self-pairs, **biasing the estimate downward (data
  looks more equal than it is)**, worst at small `n`. Use the `n/(n−1)` correction:
  `Ĝ_bc = (2·Σ_i i·x_(i)) / ((n−1)·Σ x_(i)) − (n+1)/(n−1)`.
  **Mandatory when comparing groups of different sizes** (repos/days with different
  conversation counts) — otherwise smaller cohorts look artificially more equal purely from
  `n`. **Never ship the population Gini; never compare unequal-n groups uncorrected.**
- **Inference:** no clean closed-form SE — use **bootstrap** (or jackknife, Ogwang 2000, which
  outperforms analytic linearization under extreme skew — i.e. this data).
- **Weaknesses:** most sensitive to transfers in the middle, relatively insensitive in the
  sparse tail (under-weights the few mega-cost conversations); not cleanly decomposable;
  requires non-negative data (negatives → G>1; a mass of zero-cost entities inflates it —
  decide explicitly whether zero-cost rows are in-population).
- **When:** one comparable scalar for _overall_ concentration — always the `n/(n−1)` version,
  always paired with a Lorenz / top-share view.
- Sources: **Deltas (2003), Rev. Econ. Stat. 85(1):226–234** ([MIT Press](https://direct.mit.edu/rest/article/85/1/226/57394/The-Small-Sample-Bias-of-the-Gini-Coefficient));
  [Gini coefficient, Wikipedia](https://en.wikipedia.org/wiki/Gini_coefficient);
  [giniVarCI vignette, CRAN](https://cran.r-project.org/web/packages/giniVarCI/vignettes/GiniVarInterval.html).

### Theil / Generalized Entropy — for attribution by dimension

The reason to carry this beyond Gini: **exact additive decomposability** (Gini cannot do this
cleanly).

- **GE(α) family** (scale-invariant): `GE(α) = 1/(α(α−1))·[(1/n)Σ(x_i/μ)^α − 1]`, α≠0,1.
  - **GE(1) = Theil's T** = `(1/n)Σ(x_i/μ)·ln(x_i/μ)` — weights by spend share → sensitive to
    the **whales** (max = `ln n`).
  - **GE(0) = Theil's L / MLD** = `(1/n)Σ ln(μ/x_i)` — weights by population share.
- **Decomposition (the payoff):** `GE(α) = Σ_g w_g·GE(α)_g + GE(α)_between`. For Theil T the
  within-weights are each group's **share of total spend**. Lets you report, as exact additive
  %: _"X% of spend concentration is between-model, Y% within-model."_
- **Failure modes (critical for cost):** **undefined at x=0** — Theil L blows up
  (`ln(μ/0)→∞`); negatives break both. **Strip/floor x≤0 before computing and surface the drop
  count.** If zeros are unfilterable, use **GE(2)** (= ½·CV²), which is finite at zero.
- **When:** "which models/repos dominate spend, and is it between- or within-dimension."
  Default decomposable measure = **Theil T**.
- Sources: **Shorrocks (1980), Econometrica 48(3):613–625**;
  [World Bank Handbook ch.6](https://faculty.economics.dal.ca/kxu/WorldBankHandbookOnPovertyAndInequality.pdf);
  [Cowell, ECINEQ 2005-01](https://www.ecineq.org/milano/WP/ECINEQ2005-01.pdf);
  [Theil index, Wikipedia](https://en.wikipedia.org/wiki/Theil_index).

### Hoover index (Robin Hood / Schutz / Pietra) — most intuitive scalar

- **Definition:** max vertical gap between Lorenz curve and equality line = **fraction of total
  spend that would have to be redistributed to equalize**.
  `H = (1/2)·Σ_i |x_i/Σx − 1/n| = max_p [p − L(p)]`. Range [0,1], O(n), no sort. (H ≤ G.)
- **When:** the most intuitive headline — "X% of spend is 'excess' concentration." Strong fit
  for the spend narrative.
- Sources: [Hoover index, Wikipedia](https://en.wikipedia.org/wiki/Hoover_index);
  [NIH PMC 2652960](https://pmc.ncbi.nlm.nih.gov/articles/PMC2652960/).

### Top-group share — the rigorous name for "top X% = Y% of spend"

- **Rigorous name:** a **cumulative top-group share** (here a **top-decile share**); it is **one
  point on the Lorenz curve**: `top-(1−p) share = 1 − L(p)`, so "top 10% = 66%" is
  `1 − L(0.90) ≈ 0.66`. In IO terms a concentration ratio CR_k.
- **Honest computation:** sort descending → cumulative spend → top-X% = (cumsum of top `⌈X·n⌉`
  units)/total. **Boundary issue:** when `X·n` isn't integer the cut lands inside one
  conversation — round the count (state which) or interpolate the cumulative-share curve at
  `p=X`. Immaterial at large n; matters at small n.
- **Report with:** `n`, the **unit (per-conversation vs per-turn — they differ; per-turn is the
  honest grain)**, that it is order-statistic based (has sampling variability — bootstrap a CI
  or show across periods), and don't imply it characterizes the whole distribution.
- Sources: [Concentration ratio, Wikipedia](https://en.wikipedia.org/wiki/Concentration_ratio);
  [Income inequality metrics, Wikipedia](https://en.wikipedia.org/wiki/Income_inequality_metrics).

### Atkinson, Palma, S80/S20 — situational

- **Atkinson** `A(ε) = 1 − (1/μ)·[(1/n)Σx_i^(1−ε)]^(1/(1−ε))`: bounded [0,1) like Gini with a
  tunable inequality-aversion knob ε (an explicit value judgment); ordinally equivalent to
  GE(1−ε). Positivity required; any zero → A=1 for ε≥1.
  ([Atkinson index, Wikipedia](https://en.wikipedia.org/wiki/Atkinson_index))
- **Palma** = top-10% share / bottom-40% share; targets the tails, drops the stable middle.
  ([UN DESA WP143](https://www.un.org/esa/desa/papers/2015/wp143_2015.pdf))
- **S80/S20 (Eurostat QSR):** **avoid for cost** — a near-$0 bottom quintile makes the
  denominator explode. Prefer Palma or a top-share.
  ([Eurostat glossary](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Glossary%3AIncome_quintile_share_ratio))

### "80/20" / Pareto framing — explicitly disallowed as a default claim

"80/20" is **one point on one Pareto distribution** (α≈1.16), not a law. This data is **10/66 —
_more_ skewed than 80/20** — so "the 80/20 rule" both misleads _and undersells_ it. Defensible:
"right-skewed / heavy-tailed; top decile holds ~66%." Overreach: "follows 80/20" / "a Pareto
law" without a fit. ([Pareto principle, Wikipedia](https://en.wikipedia.org/wiki/Pareto_principle))

---

## 2. Distribution / heavy-tail description

### Why mean / stddev mislead — do not headline them

The **mean** is dragged into the tail (not "typical"); under very heavy tails (Pareto α≤1) the
population mean is **infinite/undefined** and the sample mean won't stabilize (α≤2 → infinite
variance). **Stddev** has breakdown point 0 (one outlier → ∞); **CV** is unstable (both terms
unstable). Report **median + quantiles** instead — order statistics stay well-defined when
moments don't.
Sources: [QuantEcon Heavy Tails ch.22](https://intro.quantecon.org/heavy_tails.html);
[The American Statistician (2024), "When Heavy Tails Disrupt Statistical Inference"](https://www.tandfonline.com/doi/full/10.1080/00031305.2024.2402898);
[Robust measures of scale, Wikipedia](https://en.wikipedia.org/wiki/Robust_measures_of_scale).

### Robust location / spread (with breakdown points)

| Measure         | Definition                                    | Breakdown       |
| --------------- | --------------------------------------------- | --------------- | --------------------------------- | -------------- |
| Median          | 50th pct                                      | 50%             |
| IQR = Q3 − Q1   | central-50% spread (σ≈IQR/1.349 under normal) | 25%             |
| **MAD**         | `median(                                      | x_i − median(x) | )`, ×**1.4826** for σ-consistency | 50% (eff. 37%) |
| Trimmed mean    | mean after dropping α each end                | α               |
| Winsorized mean | mean after capping α each end                 | α               |

- **MAD constant 1.4826** = 1/Φ⁻¹(¾). Source: **Rousseeuw & Croux (1993), JASA
  88(424):1273–1283**; [MAD, Wikipedia](https://en.wikipedia.org/wiki/Median_absolute_deviation).
- **Caveat:** MAD is a _symmetric_ scale estimator; on right-skewed cost prefer reporting
  **asymmetric quantiles (P50/P90/P99)** as "spread" and use MAD mainly for **outlier flagging**
  (`|x − median| > 3·1.4826·MAD`).

### Quantile estimation — pin the estimator type

- **Hyndman & Fan (1996), TAS 50(4):361–365** catalog **9 types**. Types 1–3 discontinuous;
  **4–9 continuous** piecewise-linear, differing only in plotting-position constants.
- **Use Type 8** (`h = (N+1/3)p + 1/3`): **median-unbiased, approximately distribution-free**
  (doesn't assume normality like type 9).
- **THE COMMON BUG:** **R and NumPy default to Type 7**; Excel/older Python ≈ 6/7; SAS/Stata ≈
  type 2. Same data → different P90/P99 across tools unless pinned. **Set it explicitly**
  (NumPy `method='median_unbiased'` matches R type 8). The engine must pin one type everywhere.
- **HOUSE ESTIMATOR (implementation exception):** the ClickHouse layer pins **`quantileExact`**
  (and `quantileExactIf` / `quantileExactWeighted`) as the one estimator everywhere, **not**
  Type 8. ClickHouse has no native Hyndman–Fan Type 8 function; reproducing it would mean
  hand-rolled SQL interpolation and reworking the frozen `AggregateFunction(quantileExact(...))`
  state columns (`agent_context_call_buckets_hourly`), and would re-baseline every live p90/p95
  for a plotting-position difference that is immaterial at our n. `quantileExact` returns an
  exact order statistic (with linear interpolation between neighbors), which is robust and
  deterministic — it satisfies the real requirement ("pin ONE estimator, no cross-tool drift").
  **Any future engine / TS-side quantile MUST match `quantileExact`, not Type 8.** If a layer
  ever needs true Type 8, migrate the whole stack together; do not mix estimators.
- **Extreme tail (P99/P99.9) with limited data:** the most extreme order statistics are
  high-variance; **you cannot extrapolate past the sample max** without a tail model. Principled
  far-tail = **Extreme Value Theory / Peaks-Over-Threshold + Generalized Pareto** above ~90–95th
  pct (sensitive to threshold).
- Sources: [Hyndman & Fan, sample quantiles](https://robjhyndman.com/publications/quantiles/);
  [Quantile, Wikipedia](https://en.wikipedia.org/wiki/Quantile);
  [SAS DO Loop: sample quantiles](https://blogs.sas.com/content/iml/2017/05/24/definitions-sample-quantiles.html);
  [POT-GPD, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0167668703001677).

### Heavy-tail detection / power-law fitting — and when the claim is defensible

- **Log-log rank-size (Zipf) plot:** a straight line _suggests_ a power law (Zipf slope −s ↔
  density α = 1 + 1/s). **Eyeballing a straight line is NOT evidence** — lognormals look straight
  over limited ranges. Exploratory visual only.
  ([Adamic, HP Labs tutorial](https://www.hpl.hp.com/research/idl/papers/ranking/ranking.html))
- **Clauset–Shalizi–Newman (2009), SIAM Review 51(4):661–703** — the rigorous bar:
  1. **Fit α by MLE, not least-squares:** `α̂ = 1 + n/[Σ ln(x_i/x_min)]` (Hill above x_min).
     **Least-squares on a log-log histogram is biased and WRONG** (~29–36% error).
  2. **Estimate x_min by KS-minimization.**
  3. **GoF via KS + semiparametric bootstrap p-value:** **p>0.1 → power law plausible; p≤0.1 →
     ruled out.**
  4. **Likelihood-ratio (Vuong) tests vs lognormal / exponential / stretched-exponential.**
  - **Key caution:** a power law is **usually indistinguishable from a lognormal** — "it's a
    power law" is a frequent overreach.
- **Hill estimator** `ξ̂(k) = (1/k)Σ ln(X_(i)/X_(k+1))`: estimates tail index; **highly
  sensitive to k** (inspect the Hill plot for a plateau).
- **Defensible vs overreach:** asserting "it's a power law" needs MLE fit + GoF p>0.1 + LR tests
  ruling out lognormal — which you usually can't. **Engine default = the weaker, unimpeachable
  claim:** "right-skewed / heavy-tailed; top-decile share = X%; mean/median = R; P50/P90/P99 =
  …" — model-free and cannot be wrong.
- Sources: [Clauset–Shalizi–Newman, arXiv:0706.1062](https://arxiv.org/abs/0706.1062) and
  [method + code](https://aaronclauset.github.io/powerlaws/);
  [Danielsson et al., tail index](https://www.riskresearch.org/files/DanielssondeHaanErgundeVries2016.pdf).

### Histogram binning that doesn't lie

- **Equal-width (linear):** all mass in bin 1, tail invisible — **misleading for cost/tokens;
  not the main view.**
- **Equal-frequency / decile (quantile) bins:** ≈ n/k points per bin; adapts to density.
  **Report cost _share_ per decile** — clean, defensible default for cohort/share tables (label
  by value range, since unequal widths mean area ≠ density).
- **Log-scale bins:** equal width in log space, the standard heavy-tail fix. **Critical
  normalization: divide each bin's count by its linear width** to get a valid density —
  forgetting it gives slope −α+1 instead of −α.
- **Freedman–Diaconis** `h = 2·IQR/n^(1/3)` (**Freedman & Diaconis 1981, Z. Wahr.
  57(4):453–476**): robust (IQR not σ/range). On very heavy tails it produces too many empty
  tail bins → that's the cue to switch to log bins.
- **Sturges / Scott** assume near-normality → inferior for skew. Prefer FD on the linear bulk,
  log bins for the tail.
- Sources: [powerlaw, PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0085777);
  [Milojević, arXiv:1011.1533](https://arxiv.org/pdf/1011.1533);
  [Freedman–Diaconis rule, Wikipedia](https://en.wikipedia.org/wiki/Freedman%E2%80%93Diaconis_rule).

---

## 3. Relationship / association

Use when answering "do two measures move together" (e.g. cost vs turn_index, cost vs
context-size, cost vs session length).

### Do not use: Pearson correlation (on raw cost)

Pearson's r measures _linear_ association and assumes approximate bivariate normality. Its
**influence function is unbounded** — one extreme observation drags r arbitrarily — and it is
more variable than rank methods under high kurtosis. On heavy-tailed cost, r is dominated by
the few largest turns and describes the tail, not the bulk.
Sources: [Performance of Pearson, Spearman, and Kendall, ADAC](https://adac.ee/index.php/stat/article/download/412/221);
[de Winter et al., arXiv 2408.15979](https://arxiv.org/abs/2408.15979).

### Kendall τ-b — default association measure

- **Definition:** based on concordant minus discordant pairs; τ = (C − D) normalized. **τ-b**
  corrects for tied ranks (use it whenever ties exist — `turn_index` is heavily tied). τ has a
  direct probabilistic meaning: **P(concordant) − P(discordant)**.
- **Why:** bounded influence (robust to the cost tail); smaller asymptotic variability;
  preferred when ties are many and/or n is small.
- **When:** cost vs `turn_index` and any association involving a tied integer dimension.
- Sources: [Statistics How To: Kendall's Tau](https://www.statisticshowto.com/kendalls-tau/);
  [Kendall Tau-b vs Spearman](https://statisticseasily.com/kendall-tau-b-vs-spearman/);
  [ADAC](https://adac.ee/index.php/stat/article/download/412/221).

### Spearman's ρ — for two continuous heavy-tailed measures

- **Definition:** Pearson's r computed on ranks; measures _monotonic_ association.
- **When:** two continuous heavy-tailed quantities (e.g. cost vs context-size), slightly more
  powerful than τ there.
- **Commonly done wrong:** comparing ρ and τ magnitudes directly — different scales (τ is
  typically smaller for the same data).
- Sources: [UVA Library: Pearson, Spearman, Kendall](https://library.virginia.edu/data/articles/correlation-pearson-spearman-and-kendalls-tau).

### Theil–Sen slope — robust effect size ($/turn)

A correlation is unitless and does not say _how much_ cost rises per turn. For that, report a
slope.

- **Definition:** the **median of the slopes** of all point-pairs: slope = median over i<j of
  (y_j − y_i)/(x_j − x_i); intercept = median(y_i − slope·x_i).
- **Robustness:** breakdown point ≈ **29.3%** (vs **0%** for OLS — one point can ruin OLS).
- **When:** one defensible USD-per-turn number resistant to the cost tail. Also the slope
  paired with Mann–Kendall over time (see §4).
- Sources: [Theil–Sen estimator, Wikipedia](https://en.wikipedia.org/wiki/Theil%E2%80%93Sen_estimator);
  [scikit-learn TheilSen](https://scikit-learn.org/stable/auto_examples/linear_model/plot_theilsen.html).

### Quantile regression — median and tail slopes separately

- **Definition (Koenker & Bassett 1978):** models a conditional **quantile** τ by minimizing
  the asymmetrically weighted absolute error (check function ρ_τ). τ=0.5 = median regression.
- **Why here:** on heavy-tailed cost the **p90 slope** can rise steeply while the median
  barely moves; a mean slope hides this. Modeling cost's median **and** p90 vs `turn_index`
  shows "deep turns get expensive mostly in the tail."
- **When:** when the high end of cost (budget/tail risk) matters, or the relationship may
  differ across the distribution.
- Sources: [Quantile regression, Wikipedia](https://en.wikipedia.org/wiki/Quantile_regression);
  [Koenker & Hallock, JEP](https://www.aeaweb.org/articles?id=10.1257%2Fjep.15.4.143);
  [Cornell QR notes](https://ecommons.cornell.edu/bitstreams/ddba4399-59db-47d5-950b-7d5b377f1402/download).

### LOESS — nonparametric shape check

- **Definition (Cleveland 1979):** local distance-weighted polynomial fits → smooth curve
  with **no global functional form**; robust re-weighting damps outliers.
- **When:** diagnose whether cost-vs-turn_index is linear, plateauing, or accelerating — for
  exploration, not a single reportable number.
- Sources: [Local regression, Wikipedia](https://en.wikipedia.org/wiki/Local_regression);
  [Cleveland & Devlin, JASA 1988](https://sites.stat.washington.edu/courses/stat527/s14/readings/Cleveland_Delvin_JASA_1988.pdf);
  [EPA LOESS note](https://www.epa.gov/sites/default/files/2016-07/documents/loess-lowess.pdf).

### Binned conditional quantiles ("cost band by depth") — the honest default display

- **Method:** bin by `turn_index`, report **quantiles** of cost within each bin (median,
  p25/p75, p90). Assumes no functional form; fully robust; shows the whole conditional
  distribution shifting with depth.
- **Commonly done wrong:** plotting the **mean** per bin — reintroduces the tail-sensitivity
  ranks/quantiles were chosen to avoid. Use median + a high quantile.

### Mandatory caveats on any association

- **Correlation ≠ causation** — state plainly on every reported association.
- **Confounding / spurious correlation** — a third variable can drive both.
- **Simpson's paradox** — a pooled association can **reverse** within strata. A
  cost-vs-`turn_index` trend pooled across models may be an artifact of _which model_ runs at
  deep turns; verify the relationship holds **within** model/source/repo before asserting it.
- **Defensible phrasing:** "Cost and turn_index: Kendall τ-b = X (monotonic association);
  Theil–Sen slope = $Y/turn. Association, not causation; not controlled for model/repo mix."
- Sources: [DSCI 335 Causation](https://bookdown.org/csu_statistics/dsci_335_spring_2022/Causation.html);
  [Simpson's Paradox, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC2880329/).

---

## 4. Trend / change over time

### Period-over-period deltas

- Report **both absolute and relative** change.
- **Small-denominator trap:** % change explodes on a tiny base ($2→$5 = "+150%", a $3 move).
  **Suppress or flag % change below a stated base threshold; rank movers by absolute dollars.**
- Sources: [Absolute vs Relative Change Pitfalls, Singapore MOM](https://stats.mom.gov.sg/SL/Pages/Absolute-vs-Relative-Change-Pitfalls.aspx);
  [Relative change, Wikipedia](https://en.wikipedia.org/wiki/Relative_change).

### Mann–Kendall trend test + Sen's slope

- **Mann–Kendall:** nonparametric test for a **monotonic** trend over time (Kendall's tau on
  (value, time)). No distributional assumption; rank-based, so **unaffected by extreme
  values**.
- **Sen's slope:** the trend magnitude paired with MK — median of all pairwise slopes over
  time (Theil–Sen over time), in $/day.
- **Failure mode:** MK assumes **independent** observations; **serial correlation inflates
  significance**. Daily cost is often autocorrelated → space observations out or use a
  variance-corrected / pre-whitened MK variant. Do not read two endpoints as a "trend."
- **When:** "is there a real trend, and how big?" Report MK (is there?) + Sen's slope (how
  big?) together.
- Sources: [wql `mannKen`, R CRAN](https://search.r-project.org/CRAN/refmans/wql/html/mannKen.html);
  [ITRC Trend Tests](https://projects.itrcweb.org/gsmc-1/Content/GW%20Stats/5%20Methods%20in%20indiv%20Topics/5%205%20Trend%20Tests.htm).

---

## 5. Decomposition / attribution

Answer "which dimension drove the change/concentration" factually.

### Shift-share — which dimension drove a cost change

- **Method:** decompose an aggregate change into additive components: an overall scaling
  effect, a **mix (composition) effect** (more turns went to an expensive model/repo), and a
  **within-group rate** effect (a given model got pricier per turn).
- **When:** separates "we did more of the expensive thing" from "the thing itself got more
  expensive."
- Source: [Shift-share analysis, Wikipedia](https://en.wikipedia.org/wiki/Shift-share_analysis).

### Theil index decomposition — between- vs within-group dispersion

- **Definition:** entropy-based inequality measure T = (1/N)Σ(x_j/x̄)·ln(x_j/x̄).
- **Key property:** decomposes **exactly** into **between-group + within-group** components — a
  property the Gini **lacks**. Only entropy-family measures decompose perfectly.
- **When:** factually attribute cost concentration to "between models/repos" vs "within" —
  e.g. "70% of cost dispersion is between repos, 30% within."
- **Failure mode:** undefined for zero/negative values — handle zero-cost turns explicitly.
- Sources: [UTIP Young Person's Guide to the Theil Index](https://utip.gov.utexas.edu/papers/utip_14.pdf);
  [ECINEQ WP 2005-01](https://www.ecineq.org/milano/WP/ECINEQ2005-01.pdf).

---

## 6. Outlier identification (stated as fact)

### Do not use: mean ± k·standard deviation

Both mean and SD are **non-robust (0% breakdown)** — the outliers being hunted inflate the SD
and shift the mean (masking). On skewed cost it flags legitimate right-tail bulk and misses
real extremes.
Source: [Modified z-score, Statology](https://www.statology.org/modified-z-score/).

### IQR / Tukey fence

- **Rule:** outlier if < Q1 − 1.5·IQR or > Q3 + 1.5·IQR (inner fence); 3·IQR = outer fence.
- **Failure mode on skewed data:** assumes symmetry → **over-flags the right tail** of cost.
- Source: [Tukey's rule, Course Sidekick](https://www.coursesidekick.com/statistics/589732).

### Median + MAD (modified z-score, Iglewicz–Hoaglin)

- **Rule:** Mᵢ = 0.6745·(xᵢ − median)/MAD, MAD = median(|xᵢ − median|); flag |Mᵢ| > 3.5.
- **Robustness:** **50% breakdown** (accurate even if half the data are outliers).
- **Failure modes:** still assumes symmetry (shares over-flagging on strong skew, milder);
  **MAD = 0 when >50% of values tie** (e.g. many zero-cost turns) — guard for it.
- **When:** robust default for roughly symmetric / mildly skewed measures.
- Sources: [Modified z-score, Statology](https://www.statology.org/modified-z-score/);
  [Iglewicz & Hoaglin](https://rdrr.io/github/skinnider/modern/man/iglewicz_hoaglin.html).

### Adjusted boxplot (medcouple; Hubert–Vandervieren 2008) — default for skewed cost

- **Method:** widen/narrow the boxplot fences using the **medcouple (MC)**, a robust bounded-
  influence skewness measure: e.g. [Q1 − 1.5·e^(−4·MC)·IQR, Q3 + 1.5·e^(3·MC)·IQR] for
  right-skew — the upper fence stretches so genuine high-cost turns are not mislabeled.
- **When:** **the right default for heavy-tailed cost.** Distinguishes regular high values from
  true outliers without assuming a distribution. (`adjbox` in R `robustbase`.)
- **Caveat:** exact medcouple is O(n²) naively (fast O(n log n) exists); on very large turn
  tables compute MC on a sample or use the fast implementation.
- Source: [Hubert & Vandervieren 2008, CSDA](https://wis.kuleuven.be/statdatascience/robust/papers/2008/hubertvandervieren_adjustedboxplot_csda_2008.pdf/@@download/file/HubertVandervieren_AdjustedBoxplot_CSDA_2008.pdf);
  [robustbase `adjbox`](https://rdrr.io/cran/robustbase/man/adjbox.html).

### Honest framing

An outlier is **"a value beyond threshold T by rule R,"** a factual, reproducible statement —
never "anomalous," "suspicious," or "bad." Defensible form: "N turns ($X total) exceed the
upper adjusted-boxplot fence (medcouple-based, Hubert–Vandervieren) computed on cost within
{group}." Always name the rule and threshold so the claim is falsifiable.

---

## Recommended engine defaults

1. **Headline concentration:** top-decile cost **share** (state n, per-turn vs per-conversation
   unit, period) + **Hoover index** as the intuitive scalar.
2. **Comparable scalar:** `n/(n−1)`-corrected **Gini** + bootstrap CI. Never ship population
   Gini; never compare unequal-n groups uncorrected.
3. **Attribution by dimension:** **Theil T (GE(1))**, report between- vs within-%; strip x≤0
   first and surface the drop count (GE(2) if zeros are unfilterable).
4. **Location/spread:** **median + P50/P90/P99** (one pinned estimator — `quantileExact` in the
   ClickHouse layer; see §Distribution house-estimator note), MAD×1.4826 for outlier flags only.
   Never headline mean/stddev/CV.
5. **Far tail:** don't trust empirical P99.9; never extrapolate past sample max (EVT/GPD if it
   matters).
6. **Distribution claim:** say "right-skewed / heavy-tailed," **not** "power law" / "80/20" —
   this data is 10/66 (more skewed than 80/20) and lognormal usually can't be ruled out.
7. **Relationship:** Kendall τ-b (tied dims) / Spearman (continuous) + Theil–Sen slope; show
   conditional quantile bands, never bin means.

## "Commonly done wrong" — engine guardrails

The mistakes the engine must not make:

1. **Population vs `n/(n−1)` sample Gini on unequal-n groups** — biases small cohorts toward
   looking equal. Use the bias-corrected estimator.
2. **Unpinned quantile estimator** — different tools use different plotting positions (R/NumPy
   Type 7, SAS Type 2, ClickHouse `quantileExact`) → silent cross-tool P90/P99 disagreement.
   Pin ONE estimator everywhere; ours is **`quantileExact`** (see the house-estimator note in
   §Distribution), and any non-ClickHouse layer must match it rather than its own default.
3. **Least-squares fit on log-log to claim a power law** — biased; use MLE + GoF + LR tests, or
   don't claim a law.
4. **Equal-width histograms / un-normalized log bins on heavy tails** — hide the tail or distort
   the slope. Use decile/log bins, normalize by bin width.
5. **Theil / Atkinson silently dropping zeros** — strip x≤0 explicitly and surface the count.
6. **Mislabeling 10/66 as "80/20."**
7. **Pearson r / mean±SD on raw cost** — 0% breakdown, tail-dominated. Use rank correlation and
   median/MAD-or-medcouple.
8. **Mean cost per bin** — reintroduces tail sensitivity; use median + p90.
9. **Tukey 1.5·IQR on skewed cost** — over-flags the upper tail; use medcouple-adjusted fences.
10. **% change on small denominators** — base-effect lies; rank by absolute dollars, show both.
11. **Mann–Kendall on autocorrelated daily cost** — serial correlation inflates significance;
    space out or pre-whiten.
12. **Pooled cost-vs-turn_index trend** — risks Simpson's paradox; verify within model/repo,
    always state "association, not causation."

## Implementation status / conformance (as of the agent-analytics pipeline)

The shipped Tinybird `agent_*` pipes were audited against this catalog. They were already
largely conformant — quantile-first (never mean±SD on cost/tokens), real Lorenz + top-decile
share + Hoover-equivalent half-spend count, **equal-frequency** decile cost buckets, and
fact-only copy (no "anomaly", explicit "NOT a statistical anomaly model"). Two defects were
fixed to bring the live pipeline in line:

- **Gini** (`pipes/agent_session_cost_distribution.pipe`) now applies the **`n/(n−1)` sample
  correction**; it previously shipped the biased population form (guardrail #1).
- **Cost/context-by-depth elasticity** (`pipes/agent_cost_by_depth.pipe`) now uses a
  **Theil–Sen** slope (median of pairwise slopes); it previously used OLS
  (`simpleLinearRegression`), which has 0% breakdown on the heavy-tailed cost it fits.
  The production query bounds the pairwise fit to an evenly spaced sample of at most 128 eligible
  depths for very deep conversations and exposes `fit_sampled` when that cap is used.

Quantiles are pinned to **`quantileExact`** per the house-estimator exception above (no Type 8
migration).

**Known deferred gap (out of scope for this catalog, tracked separately):** the LLM/trace-layer
pipes (`llm_usage_summary`, `operations_leaderboard`, `operation_user_breakdown`,
`traces_summary`) headline **arithmetic-mean** durations (`avg`/`avgMerge`) and
`cost_per_request = total/count` on heavy-tailed latency/cost. They predate this ADR (which is
scoped to agent analytics) and already pair the mean with p95. Applying robust location to that
layer is a follow-up, not a conformance failure of the agent-analytics surface.

## Consequences

- The engine ships a fixed, defensible vocabulary of robust statistics. Any analytical
  question maps to (family × measure × dimension); adding a question needs no new pipe.
- Every output is a fact with a named method and, where relevant, a stated threshold/caveat.
  No diagnosis, no advisory copy.
- Implementations must use the **corrected sample estimators** noted here, not the naive
  textbook-population forms.
- Some methods (quantile regression, medcouple, Theil-Sen on large N) have nontrivial compute
  cost; the engine may sample or use fast algorithms, and must **disclose** when it does.

## References

Primary sources are cited inline per method above. Companion documents:
`specs/features/agent-analytics-query-engine.md` (engine design + fact model),
ADR 0012 (agent conversation analytics data model), ADR 0009 (Tinybird/ClickHouse).
