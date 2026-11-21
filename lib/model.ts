// The token radar's model (radar-7): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every other
// pre-token protocol the watchlist's own exclusion rule would keep: no wrapped, staked, bridged or
// exchange product, no versioned pool. A protocol is pre-token when its index entry records no token
// (no market cap, no CoinGecko id, no symbol). The snapshot's live-token protocols are kept apart and
// shown as the market's own values, never mixed into the ranked board — but their market caps ARE the
// evidence for the model: the size curve is fitted to them, and the farm economics are netted against
// the value the curve implies.
//
// Implied value is an EXPECTED value: what the launch would be worth, times the odds it happens.
// A protocol that will never launch is worth nothing to a farmer, however large its TVL; a protocol
// that launches for certain is worth its full fitted value. Both halves follow only from the
// snapshot's own figures, and both are tested out of sample:
//
//   VALUE IF IT LAUNCHES (the size curve, fitted on the snapshot's trading protocols):
//     log10(mcap) = a + b x log10(tvl_usd)          (ordinary least squares over the comparables)
//     offset(cat) = shrunk median residual of the category's comparables (k = 8, n >= 3),
//                   falling back to the category FAMILY's offset when the category has no evidence
//     value      = 10 ^ (a + b x log10(tvl_usd) + offset(category))
//     growthMult = 1 + (clamp(change_7d, -60, 120) / 100) x 0.5
//     value      = value x growthMult
//   LAUNCH ODDS (a logistic regression on the snapshot's own token statuses):
//     odds = sigmoid(w0 + w1 x z(log10 TVL) + w2 x z(chains) + w3 x z(category token rate)
//                      + w4 x z(age-bucket token rate))
//     fitted on the 442 rankable protocols; the target is whether the protocol records a token.
//     The age feature is a BUCKET RATE, not a linear age term: the token rate by age is
//     non-monotone (0-90d 31%, 90-180d 19%, 180-365d 38%, 1-2y 39%, 2-3y 63%, 3y+ 86%),
//     and a linear term cannot bend at the 90-180d dip — it would also crush young protocols'
//     odds to single digits. A bucket rate gives a young protocol its bucket's own rate (about
//     one in three protocols its age record a token), which is the honest reading of the
//     snapshot. The bucket rate is shrunk toward the base rate (k = 8), exactly like the
//     category rate, and refit per fold in the validation. Leave-one-out accuracy 72.0%
//     against a 55.2% base rate (radar-5's three-feature model: 60.6%).
//   IMPLIED = max(1, round(value x odds))
//
//   The slope stays GLOBAL on purpose: per-category slopes were tested (two formulations,
//   naive and centred on each category's mean TVL) and hurt out of sample — the within-
//   category TVL range is too narrow to identify a slope at n = 11-13, and the raw slopes
//   run from -1.8 to +1.8 against a global 0.49. The category story is carried by the
//   offsets alone, which is what the evidence supports.
//
// The comparables are the live-token protocols that pass the watchlist's exclusion rule AND trade at
// no more than 5x their TVL. A token above 5x TVL is priced on speculation about future volume, not
// on the protocol's record — five such tokens (ratios to 400x) bent radar-4's curve and are set
// aside, named, in the model's own audit. The curve is TESTED, not assumed: leave-one-out, 5-fold
// and a time split, each comparable priced by a curve fitted without it (see backtest()). The
// prediction band (P25-P75 of the out-of-sample residuals) is carried on every row, so the board
// states its own uncertainty — and the band is CALIBRATED, not just drawn: each row's band, built
// from the other comparables' residuals, holds the held-out protocol's real market cap 45% of the
// time (nominal 50%), and the wider P10-P90 band holds 78% (nominal 80%). No protocol name is ever
// special-cased: the same functions score every row, and the curve, the offsets, the families and
// the odds are computed from the snapshot at runtime, never hardcoded.
//
// Farm economics: a $1,000 plan's slice is what $1,000 deposited would get if 10% of the launch goes
// to depositors pro rata (slice = 1000/TVL x 10% x implied). Net = slice - gas fees - the 4% T-bill
// yield the capital gives up over the hold. The plan is netted TWICE: at the implied value and at the
// band's low end, so a verdict survives the model's own uncertainty. ROBUST pays even at the band's
// low end; FARM pays at the implied value; THIN beats its fees only; SKIP loses to its fees. The
// verdict is arithmetic, not a slogan.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  /** The shrinkage strength for a category's offset: each category's median residual is pulled toward 0 by k pseudo-observations. */
  shrinkage_k: number;
  /** The minimum live comparables before a category's own offset counts at all: below this, the offset falls back to the family. */
  min_comparables: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  /** A comparable whose market cap is more than this multiple of its TVL is set aside: its token is priced on speculation, not on the protocol's record. */
  speculative_cap: number;
  /** The shrinkage strength for a category's token rate in the odds model (pseudo-observations toward the base rate). */
  odds_cat_k: number;
  /** The shrinkage strength for an age bucket's token rate in the odds model (same rule, same strength). */
  odds_age_k: number;
  /** The L2 penalty on the odds model's logistic regression (the intercept is never penalised). */
  odds_lambda: number;
  /** The share of a launch that goes to depositors pro rata, for the $1,000 slice. */
  airdrop_share: number;
  /** The risk-free yield the farmed capital gives up, per year, for the net-of-all-costs verdict. */
  tbill_rate: number;
  /** The capital the farm economics are computed at, in dollars. */
  plan_capital: number;
  /** The prediction band's percentiles (P25-P75 of the out-of-sample residuals). */
  band_low: number;
  band_high: number;
}

export const MODEL: ModelConstants = {
  shrinkage_k: 8,
  min_comparables: 3,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  speculative_cap: 5,
  odds_cat_k: 8,
  odds_age_k: 8,
  odds_lambda: 1,
  airdrop_share: 0.1,
  tbill_rate: 0.04,
  plan_capital: 1000,
  band_low: 0.25,
  band_high: 0.75,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-7';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A farm plan's economics at the model's plan capital: the slice, the costs, the verdict. */
export interface FarmEconomics {
  /** What the plan capital deposited would get if the airdrop share goes to depositors pro rata. */
  slice_usd: number;
  /** The same slice at the prediction band's low end: what the plan gets if the launch is worth the model's low estimate. */
  slice_low_usd: number;
  /** All gas the plan pays: setup (2 tx) + one weekly action per hold week. */
  fees_usd: number;
  /** The T-bill yield the capital gives up over the hold. */
  tbill_usd: number;
  /** slice - fees - T-bill: what the plan nets after every cost. */
  net_usd: number;
  /** slice_low - fees - T-bill: what the plan nets if the launch is worth the band's low end. */
  net_low_usd: number;
  /** slice - fees: what the plan nets before the opportunity cost. */
  net_after_fees_usd: number;
  /** ROBUST pays even at the band's low end; FARM pays at the implied value; THIN beats its fees only; SKIP loses to its fees. */
  verdict: 'ROBUST' | 'FARM' | 'THIN' | 'SKIP';
  /** Net per hands-on hour (setup + weekly actions + claim + log). */
  net_per_hour_usd: number;
  /** The smallest capital at which the plan nets above zero, or null when it never does. */
  pays_from_usd: number | null;
  /** The implied value at which the plan breaks even (slice = fees + T-bill), or null when the slice rate is zero. */
  breakeven_implied_usd: number | null;
  /** Hands-on hours the plan takes, in total. */
  hours: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  /** What the launch would be worth if it happened, before the odds discount. */
  value_if_launches_usd: number;
  /** The launch odds: the fitted probability this protocol records a token (0-1). */
  launch_odds: number;
  /** The expected value: value-if-launches x launch odds. The board ranks on this. */
  implied_value_usd: number;
  /** The prediction band: implied value times the band's low/high multipliers (P25-P75 of the out-of-sample residuals). */
  band_low_usd: number;
  band_high_usd: number;
  /** The ranks this row would hold at the band's high and low ends: the rank's own uncertainty. */
  rank_best: number;
  rank_worst: number;
  model: {
    /** The category offset this row was scored with (log10 units, from the snapshot's live-token evidence). */
    category_offset: number;
    /** The family the offset fell back to, when the category itself had no evidence (null when the category's own offset counted). */
    offset_family: string | null;
    growth_pct: number;
    growth_multiplier: number;
    age_days: number | null;
  };
  economics: FarmEconomics;
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  value_if_launches_usd: number;
  launch_odds: number;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  rank_best: number;
  rank_worst: number;
  /** The category offset this row was scored with, so the page recomputes the same number. */
  category_offset: number;
  offset_family: string | null;
  growth_multiplier: number;
  economics: FarmEconomics;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's offset, with its derivation: the dashboard's model panel shows this table. */
export interface CategoryOffset {
  category: string;
  /** Live-token comparables in the category. */
  comparables: number;
  /** The raw median log10 residual of those comparables against the curve (null when there are none). */
  raw_median: number | null;
  /** The shrunk offset the model applies, in log10 units (0 when fewer than min_comparables). */
  offset: number;
  /** True when the offset is 0 for lack of evidence (fewer than min_comparables live comparables). */
  fallback?: boolean;
}

/** One family's offset: categories that share a value-capture mechanism pool their residuals. */
export interface FamilyOffset {
  family: string;
  /** Live-token comparables across the family's categories. */
  comparables: number;
  /** The raw median log10 residual of those comparables against the curve. */
  raw_median: number;
  /** The shrunk offset the model applies to a category of this family that has no evidence of its own. */
  offset: number;
}

/** A comparable set aside as speculative: its token trades far above its TVL. */
export interface SpeculativeExcluded {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  /** Market cap over TVL: above the speculative cap, so the token is priced on speculation. */
  ratio: number;
}

/** The fitted size curve and its backtest, for the dashboard. */
export interface CurveFit {
  /** log10(mcap) = intercept + slope x log10(TVL). */
  intercept: number;
  slope: number;
  /** R-squared of the fit on the comparables. */
  r_squared: number;
  /** How many live-token protocols the curve is fitted on. */
  comparables: number;
  /** One entry per category with at least one live comparable, sorted by category name. */
  categories: CategoryOffset[];
  /** One entry per family with at least one live comparable, sorted by family name. */
  families: FamilyOffset[];
  /** The comparables set aside as speculative, largest ratio first: the audit trail for the filter. */
  speculative_excluded: SpeculativeExcluded[];
}

/** The leave-one-out backtest: the curve tested against the flat multiple, out of sample. */
export interface Backtest {
  /** Median miss of the curve, leave-one-out (each comparable priced by a curve fitted without it). */
  curve_median_miss: number;
  /** Median miss of one flat mcap/TVL multiple, same folds. */
  flat_median_miss: number;
  /** Median miss of the curve, 5-fold (deterministic folds by slug). */
  curve_five_fold_miss: number;
  /** Same, for the flat multiple. */
  flat_five_fold_miss: number;
  /** Share of comparables the curve prices within 3x of their real market cap, out of sample. */
  curve_within_3x: number;
  /** Same, for the flat multiple. */
  flat_within_3x: number;
  /** Share of comparables the curve prices within 10x, out of sample. */
  curve_within_10x: number;
  /** Share of comparables whose real market cap falls inside the band their own row would carry (category, family or board tier, built from the other comparables' residuals): the band's honest calibration against its nominal 50%. */
  band_coverage_50: number;
  /** Share of comparables whose real market cap falls inside the wider P10-P90 band of the other residuals: the wider band's calibration against its nominal 80%. */
  band_coverage_80: number;
  /** The prediction band's multipliers (P25-P75 of the out-of-sample residuals, in linear units). */
  band_low_mult: number;
  band_high_mult: number;
  /** A category's own band multipliers (P25-P75 of that category's out-of-sample residuals), for categories with at least 5 residuals; a row uses its category's band, else its family's, else the board's. */
  band_by_category: { category: string; low_mult: number; high_mult: number }[];
  /** A family's own band multipliers, same rule, for families with at least 5 residuals. */
  band_by_family: { family: string; low_mult: number; high_mult: number }[];
  /** Time-split check: curve fitted on pre-2024 listings, median miss on newer ones. */
  time_split_curve_miss: number | null;
  /** Same, for the flat multiple. */
  time_split_flat_miss: number | null;
  /** How many comparables the time split fitted on (listed before 2024). */
  time_split_fit_n: number;
  /** How many comparables the time split tested on. */
  time_split_n: number;
}

/** One age bucket's token rate: the share of rankable protocols of that age that record a token, shrunk toward the base rate. */
export interface AgeBucketRate {
  /** The bucket's label, e.g. "0–90d" or "3y+". */
  bucket: string;
  /** The bucket's lower edge in days (inclusive). */
  min_days: number;
  /** The bucket's upper edge in days (exclusive), or null for the open-ended oldest bucket. */
  max_days: number | null;
  /** Rankable protocols in the bucket. */
  protocols: number;
  /** Of those, how many record a token. */
  with_token: number;
  /** The shrunk token rate. */
  rate: number;
}

/** The launch-odds model: a logistic regression on the snapshot's own token statuses. */
export interface OddsFit {
  /** Coefficients: [intercept, log10 TVL, chains, category token rate, age-bucket token rate] on standardised features. */
  coefficients: number[];
  /** The standardisation means for [log10 TVL, chains, category token rate, age-bucket token rate]. */
  means: number[];
  /** The standardisation standard deviations for the same four features. */
  sds: number[];
  /** The base rate: the share of rankable protocols that record a token. */
  base_rate: number;
  /** How many rankable protocols the odds model is fitted on. */
  protocols: number;
  /** One entry per category with at least one rankable protocol: its shrunk token rate. */
  category_rates: { category: string; protocols: number; with_token: number; rate: number }[];
  /** One entry per age bucket: its shrunk token rate. */
  age_bucket_rates: AgeBucketRate[];
  /** The shrunk token rate for protocols whose listing date is not recorded. */
  age_null_rate: number;
}

/** The odds model's validation: leave-one-out accuracy against the base rate. */
export interface OddsBacktest {
  /** Share of protocols whose token status the model calls right, leave-one-out. */
  loo_accuracy: number;
  /** The base rate: the share the majority class alone would call right. */
  base_rate: number;
  /** How many protocols the validation ran on. */
  protocols: number;
}

/** A pre-token protocol the board sets aside, with the rule that set it aside. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  /** Why it is not a launch candidate: wrapped, staked, bridged, exchange, or versioned. */
  reason: string;
}

/** One comparable's point on the scatter plot: its TVL against its market cap. */
export interface ScatterPoint {
  tvl_usd: number;
  mcap_usd: number;
}

/** The snapshot's 758 protocols accounted for, every group with one reason. */
export interface Accounting {
  ranked: number;
  live_token: number;
  bridges: number;
  liquid_staking: number;
  exchanges: number;
  versioned: number;
  wrapped: number;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  curve: CurveFit;
  backtest: Backtest;
  odds: OddsFit;
  odds_backtest: OddsBacktest;
  accounting: Accounting;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  set_aside_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  set_aside: SetAsideRow[];
  /** The comparables' TVL/market-cap points, for the scatter plot. */
  scatter: ScatterPoint[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A number rounded to four decimals, for the offsets table and the model breakdown. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted array (the mean of the two middles when the count is even). */
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The category families: categories grouped by the mechanism through which a token would capture
 * value, so a category with no live-token evidence of its own borrows its family's. Vaults manage
 * other people's capital for a fee; Credit lends against collateral; Trading takes a cut of volume;
 * Real Assets tokenise off-chain yield; Staking secures a chain; Bridges move assets across chains.
 * A category not listed here has no family and falls back to offset 0. This is a grouping of
 * categories by mechanism, never of protocol names — the same map would apply to a future snapshot.
 */
export const FAMILIES: Record<string, string> = {
  'Risk Curators': 'Vaults',
  'Onchain Capital Allocator': 'Vaults',
  'Yield Aggregator': 'Vaults',
  Yield: 'Vaults',
  'Liquidity Manager': 'Vaults',
  Lending: 'Credit',
  CDP: 'Credit',
  'Collateral Management': 'Credit',
  'Leveraged Farming': 'Credit',
  Dexs: 'Trading',
  Derivatives: 'Trading',
  Perpetuals: 'Trading',
  Options: 'Trading',
  'Basis Trading': 'Trading',
  RWA: 'Real Assets',
  Restaking: 'Staking',
  'Staking Pool': 'Staking',
  'Liquid Staking': 'Staking',
  Bridge: 'Bridges',
  'Canonical Bridge': 'Bridges',
  'Cross Chain Bridge': 'Bridges',
};

/** The family a category belongs to, or null when it has none. */
export function familyOf(category: string | null): string | null {
  if (category === null) return null;
  return FAMILIES[category] ?? null;
}

/**
 * The comparables the curve is fitted on: live-token protocols that pass the watchlist's exclusion
 * rule (no bridge, liquid-staking, exchange or wrapped product, no versioned pool) AND trade at no
 * more than the speculative cap times their TVL. A wrapped token's market cap is the wrapped asset's
 * value, not a launch's — it would bend the curve toward the assets the board exists to exclude.
 * A token above the cap is priced on speculation about future volume, not on the protocol's record:
 * five such tokens (ratios to 400x) bent radar-4's curve and are set aside, named, by
 * speculativeExcluded(). A comparable needs a positive market cap and a positive TVL, or its
 * logarithm is undefined.
 */
export function comparables(snapshot: Snapshot, model: ModelConstants = MODEL): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) =>
      p.mcap_usd !== null &&
      p.mcap_usd > 0 &&
      p.tvl_usd > 0 &&
      p.mcap_usd / p.tvl_usd <= model.speculative_cap &&
      passesWatchlistExclusions(p),
  );
}

/** The live-token protocols the speculative cap sets aside, largest ratio first. */
export function speculativeExcluded(snapshot: Snapshot, model: ModelConstants = MODEL): SpeculativeExcluded[] {
  return snapshot.protocols
    .filter(
      (p) =>
        p.mcap_usd !== null &&
        p.mcap_usd > 0 &&
        p.tvl_usd > 0 &&
        p.mcap_usd / p.tvl_usd > model.speculative_cap &&
        passesWatchlistExclusions(p),
    )
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
    }))
    .sort((a, b) => b.ratio - a.ratio);
}

/** Ordinary least squares for y = a + b x. */
function ols(xs: number[], ys: number[]): { intercept: number; slope: number; rSquared: number } {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
    ssTot += (ys[i]! - my) * (ys[i]! - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  return { intercept, slope, rSquared: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/** The median residual of a category's comparables against a fitted line, shrunk toward 0. */
function shrunkOffset(residuals: number[], model: ModelConstants): { raw: number | null; offset: number; fallback: boolean } {
  if (residuals.length === 0) return { raw: null, offset: 0, fallback: true };
  const sorted = [...residuals].sort((a, b) => a - b);
  const raw = medianOf(sorted);
  if (residuals.length < model.min_comparables) return { raw: round4(raw), offset: 0, fallback: true };
  const offset = (residuals.length * raw) / (residuals.length + model.shrinkage_k);
  return { raw: round4(raw), offset: round4(offset), fallback: false };
}

/**
 * The size curve, fitted from the snapshot's own live-token protocols: log10(mcap) on log10(TVL) by
 * ordinary least squares, plus a shrunk per-category offset from the residuals. The offsets are why
 * the curve beats a flat multiple: a DEX token captures more value per dollar of TVL than a lending
 * token does, and the snapshot's own trading protocols say by how much. A category with too few
 * comparables for its own offset falls back to its FAMILY's offset — Risk Curators, the board's
 * largest category, has one live comparable and would otherwise get no adjustment at all, while its
 * Vaults family (Yield Aggregator, Onchain Capital Allocator, Yield) has twenty. Nothing here is
 * hardcoded: run this on a future snapshot and the curve, the offsets and the backtest move with
 * the market.
 */
export function fitCurve(snapshot: Snapshot, model: ModelConstants = MODEL): CurveFit {
  const comps = comparables(snapshot, model);
  const fit = fitCurveOn(comps, model);
  return {
    ...fit,
    intercept: round4(fit.intercept),
    slope: round4(fit.slope),
    speculative_excluded: speculativeExcluded(snapshot, model),
  };
}

/**
 * The size curve fitted on one list of comparables (the backtest refits it per fold, so the
 * speculative audit is attached by fitCurve, not here). The intercept and slope are kept at full
 * precision for scoring; fitCurve rounds them for display.
 */
export function fitCurveOn(comps: SnapshotProtocol[], model: ModelConstants = MODEL): Omit<CurveFit, 'speculative_excluded'> {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const { intercept, slope, rSquared } = ols(xs, ys);
  const residualsByCategory = new Map<string, number[]>();
  const residualsByFamily = new Map<string, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const cat = comps[i]!.category ?? 'Other';
    const r = ys[i]! - (intercept + slope * xs[i]!);
    const list = residualsByCategory.get(cat);
    if (list === undefined) residualsByCategory.set(cat, [r]);
    else list.push(r);
    const fam = familyOf(comps[i]!.category);
    if (fam !== null) {
      const flist = residualsByFamily.get(fam);
      if (flist === undefined) residualsByFamily.set(fam, [r]);
      else flist.push(r);
    }
  }
  const categories: CategoryOffset[] = [...residualsByCategory.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, residuals]) => {
      const { raw, offset, fallback } = shrunkOffset(residuals, model);
      return { category, comparables: residuals.length, raw_median: raw, offset, fallback: fallback || undefined };
    });
  const families: FamilyOffset[] = [...residualsByFamily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([family, residuals]) => {
      const { raw, offset } = shrunkOffset(residuals, model);
      return { family, comparables: residuals.length, raw_median: raw ?? 0, offset };
    });
  return { intercept, slope, r_squared: round4(rSquared), comparables: comps.length, categories, families };
}

/**
 * The offset a category gets, and the family it fell back to: the category's own shrunk offset when
 * it has enough comparables, else its family's offset, else 0. The family is returned so the board
 * can say which evidence priced the row.
 */
export function offsetFor(category: string | null, fit: Pick<CurveFit, 'categories' | 'families'>): { offset: number; family: string | null } {
  if (category === null) return { offset: 0, family: null };
  const entry = fit.categories.find((c) => c.category === category);
  if (entry !== undefined && !entry.fallback) return { offset: entry.offset, family: null };
  const fam = familyOf(category);
  if (fam === null) return { offset: 0, family: null };
  const fentry = fit.families.find((f) => f.family === fam);
  if (fentry === undefined || fentry.offset === 0) return { offset: 0, family: null };
  return { offset: fentry.offset, family: fam };
}

/** The miss of a prediction against the real value: the larger over the smaller, so 1 is exact. */
function missOf(pred: number, actual: number): number {
  return Math.max(pred, actual) / Math.min(pred, actual);
}

/** A percentile of a sorted array, linearly interpolated. */
function percentileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** One comparable's value under a fitted curve (curve + offset + growth), in dollars. */
function valueUnder(p: SnapshotProtocol, fit: Pick<CurveFit, 'categories' | 'families' | 'intercept' | 'slope'>, model: ModelConstants): number {
  const { offset } = offsetFor(p.category, fit);
  const g = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(p.change_7d, 0)));
  const growthMult = 1 + (g / 100) * model.growth_weight;
  return 10 ** (fit.intercept + fit.slope * Math.log10(Math.max(p.tvl_usd, 1)) + offset) * growthMult;
}

/**
 * The backtest: leave-one-out, 5-fold and a time split, each comparable priced by a curve fitted
 * without it (its category offset — and family fallback — refit from the remaining comparables), and
 * the median miss compared with one flat mcap/TVL multiple's on the same folds. The prediction band
 * comes from the out-of-sample residuals' percentiles. The time split (fit on pre-2024 listings,
 * test on newer ones) checks the curve holds forward in time, not just across the sample.
 */
export function backtest(snapshot: Snapshot, model: ModelConstants = MODEL): Backtest {
  const comps = comparables(snapshot, model);
  const flatMedian = medianOf(comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b));
  const curveMisses: number[] = [];
  const flatMisses: number[] = [];
  const oosResiduals: number[] = [];
  const oosList: { category: string; family: string | null; residual: number }[] = [];
  const oosByCategory = new Map<string, number[]>();
  const oosByFamily = new Map<string, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const fit = fitCurveOn(rest, model);
    const held = comps[i]!;
    const pred = valueUnder(held, fit, model);
    curveMisses.push(missOf(pred, held.mcap_usd!));
    flatMisses.push(missOf(held.tvl_usd * flatMedian, held.mcap_usd!));
    const res = Math.log10(held.mcap_usd!) - Math.log10(pred);
    oosResiduals.push(res);
    oosList.push({ category: held.category ?? 'Other', family: familyOf(held.category), residual: res });
    const cat = held.category ?? 'Other';
    const clist = oosByCategory.get(cat);
    if (clist === undefined) oosByCategory.set(cat, [res]);
    else clist.push(res);
    const fam = familyOf(held.category);
    if (fam !== null) {
      const flist = oosByFamily.get(fam);
      if (flist === undefined) oosByFamily.set(fam, [res]);
      else flist.push(res);
    }
  }
  oosResiduals.sort((a, b) => a - b);
  // A category's (or family's) own band, where it has at least 5 out-of-sample residuals: the
  // spread of its own evidence, not the board's. Fewer than 5 and the percentiles are noise, so
  // the row falls back to the family, then to the board's band. The residuals are centred on their
  // own median first: the offset already corrects the category's level, so the band shows the
  // SPREAD around the corrected estimate — and always contains the implied value.
  const bandOf = (residuals: number[]): { low_mult: number; high_mult: number } => {
    const sorted = [...residuals].sort((a, b) => a - b);
    const med = medianOf(sorted);
    const centred = sorted.map((r) => r - med);
    return {
      low_mult: round4(10 ** percentileOf(centred, model.band_low)),
      high_mult: round4(10 ** percentileOf(centred, model.band_high)),
    };
  };
  const band_by_category = [...oosByCategory.entries()]
    .filter(([, rs]) => rs.length >= 5)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, rs]) => ({ category, ...bandOf(rs) }));
  const band_by_family = [...oosByFamily.entries()]
    .filter(([, rs]) => rs.length >= 5)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([family, rs]) => ({ family, ...bandOf(rs) }));
  const within = (misses: number[], k: number): number =>
    Math.round((misses.filter((m) => m <= k).length / misses.length) * 1000) / 1000;
  // 5-fold: deterministic folds by slug, so the split is the same on every run.
  const sorted = [...comps].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const foldCurve: number[] = [];
  const foldFlat: number[] = [];
  for (let f = 0; f < 5; f++) {
    const test = sorted.filter((_, i) => i % 5 === f);
    const train = sorted.filter((_, i) => i % 5 !== f);
    const fit = fitCurveOn(train, model);
    for (const p of test) {
      foldCurve.push(missOf(valueUnder(p, fit, model), p.mcap_usd!));
      foldFlat.push(missOf(p.tvl_usd * flatMedian, p.mcap_usd!));
    }
  }
  // Time split: fit on listings before 2024, test on the newer ones.
  const old = comps.filter((p) => p.listed_at !== null && p.listed_at < '2024-01-01');
  const newer = comps.filter((p) => p.listed_at !== null && p.listed_at >= '2024-01-01');
  let timeSplitCurve: number | null = null;
  let timeSplitFlat: number | null = null;
  if (old.length >= 5 && newer.length >= 5) {
    const fit = fitCurveOn(old, model);
    const cm = newer.map((p) => missOf(valueUnder(p, fit, model), p.mcap_usd!));
    const fm = newer.map((p) => missOf(p.tvl_usd * flatMedian, p.mcap_usd!));
    timeSplitCurve = round4(medianOf([...cm].sort((a, b) => a - b)));
    timeSplitFlat = round4(medianOf([...fm].sort((a, b) => a - b)));
  }
  const overallBand = bandOf(oosResiduals);
  // Band calibration, honestly measured: for each comparable, the band is built from the OTHER
  // comparables' residuals (centred on their median, exactly as bandOf builds it), and the held
  // one's real market cap is checked against it. The P25-P75 coverage uses the band the board
  // would actually assign that row (its category's, else its family's, else the board's); the
  // P10-P90 coverage uses the board's band. A band that claims 50% should hold about half.
  const coverageAt = (qLow: number, qHigh: number, tiered: boolean): number => {
    let inside = 0;
    for (let i = 0; i < oosList.length; i++) {
      const held = oosList[i]!;
      let pool = oosResiduals.filter((_, j) => j !== i);
      if (tiered) {
        const catPool = oosList.filter((o, j) => j !== i && o.category === held.category).map((o) => o.residual);
        const famPool = held.family === null
          ? []
          : oosList.filter((o, j) => j !== i && o.family === held.family).map((o) => o.residual);
        if (catPool.length >= 5) pool = catPool;
        else if (famPool.length >= 5) pool = famPool;
      }
      const sorted = [...pool].sort((a, b) => a - b);
      const med = medianOf(sorted);
      const centred = sorted.map((r) => r - med);
      const c = held.residual - med;
      if (c >= percentileOf(centred, qLow) && c <= percentileOf(centred, qHigh)) inside++;
    }
    return round4(inside / oosList.length);
  };
  return {
    curve_median_miss: round4(medianOf([...curveMisses].sort((a, b) => a - b))),
    flat_median_miss: round4(medianOf([...flatMisses].sort((a, b) => a - b))),
    curve_five_fold_miss: round4(medianOf([...foldCurve].sort((a, b) => a - b))),
    flat_five_fold_miss: round4(medianOf([...foldFlat].sort((a, b) => a - b))),
    curve_within_3x: within(curveMisses, 3),
    flat_within_3x: within(flatMisses, 3),
    curve_within_10x: within(curveMisses, 10),
    band_coverage_50: coverageAt(model.band_low, model.band_high, true),
    band_coverage_80: coverageAt(0.1, 0.9, false),
    band_low_mult: overallBand.low_mult,
    band_high_mult: overallBand.high_mult,
    band_by_category,
    band_by_family,
    time_split_curve_miss: timeSplitCurve,
    time_split_flat_miss: timeSplitFlat,
    time_split_fit_n: old.length,
    time_split_n: newer.length,
  };
}

/** The protocols the odds model is fitted on: every protocol the watchlist's exclusion rule keeps, live-token and pre-token alike. */
export function rankableProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.tvl_usd > 0 && passesWatchlistExclusions(p));
}

/** The logistic function, clamped so it never overflows. */
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * The age buckets: 3 months, 6 months, 1 year, 2 years, 3 years. The token rate is not monotone
 * in age — it dips at 90-180 days, when a protocol is old enough to have been expected to launch
 * and young enough not to have done it — so the odds model reads the rate of the protocol's own
 * bucket rather than a linear age term, which cannot bend at the dip.
 */
export const AGE_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: '0–90d', min: 0, max: 90 },
  { label: '90–180d', min: 90, max: 180 },
  { label: '180–365d', min: 180, max: 365 },
  { label: '1–2y', min: 365, max: 730 },
  { label: '2–3y', min: 730, max: 1095 },
  { label: '3y+', min: 1095, max: null },
];

/** The bucket an age in days falls in, or -1 when the age is not recorded. */
export function ageBucket(age: number | null): number {
  if (age === null) return -1;
  for (let i = 0; i < AGE_BUCKETS.length; i++) {
    const b = AGE_BUCKETS[i]!;
    if (age >= b.min && (b.max === null || age < b.max)) return i;
  }
  return AGE_BUCKETS.length - 1;
}

/** The odds model's four features, unstandardised: log10 TVL, chain count, the category's token rate and the age bucket's token rate (both filled in by the caller). */
type OddsFeatures = { logTvl: number; nChains: number; catRate: number; ageRate: number };

/** A protocol's odds features, with the category rate from `catRate` and the age-bucket rate from `ageRate`. */
function oddsFeatures(
  p: SnapshotProtocol,
  age: number | null,
  catRate: (p: SnapshotProtocol) => number,
  ageRate: (age: number | null) => number,
): OddsFeatures {
  return {
    logTvl: Math.log10(Math.max(p.tvl_usd, 1)),
    nChains: p.chains.length,
    catRate: catRate(p),
    ageRate: ageRate(age),
  };
}

/** A shrunk category token rate: (with_token + k x base) / (n + k), so a small category borrows the base rate. */
function categoryTokenRates(
  protocols: SnapshotProtocol[],
  model: ModelConstants,
): { base: number; rates: Map<string, { n: number; has: number; rate: number }> } {
  const base = protocols.filter((p) => !isPreToken(p)).length / protocols.length;
  const byCat = new Map<string, { n: number; has: number }>();
  for (const p of protocols) {
    const c = p.category ?? 'Other';
    const v = byCat.get(c) ?? { n: 0, has: 0 };
    v.n++;
    if (!isPreToken(p)) v.has++;
    byCat.set(c, v);
  }
  const rates = new Map<string, { n: number; has: number; rate: number }>();
  for (const [c, v] of byCat) {
    rates.set(c, { n: v.n, has: v.has, rate: (v.has + model.odds_cat_k * base) / (v.n + model.odds_cat_k) });
  }
  return { base, rates };
}

/** A shrunk age-bucket token rate: (with_token + k x base) / (n + k) per bucket, so a thin bucket borrows the base rate. Protocols with no recorded listing date get their own shrunk rate. */
function ageBucketRates(
  protocols: SnapshotProtocol[],
  ages: (number | null)[],
  model: ModelConstants,
): { base: number; rates: number[]; counts: { n: number; has: number }[]; nullRate: number; nullCount: { n: number; has: number } } {
  const base = protocols.filter((p) => !isPreToken(p)).length / protocols.length;
  const counts = AGE_BUCKETS.map(() => ({ n: 0, has: 0 }));
  const nullCount = { n: 0, has: 0 };
  for (let j = 0; j < protocols.length; j++) {
    const b = ageBucket(ages[j]!);
    const target = b === -1 ? nullCount : counts[b]!;
    target.n++;
    if (!isPreToken(protocols[j]!)) target.has++;
  }
  const rates = counts.map((c) => (c.has + model.odds_age_k * base) / (c.n + model.odds_age_k));
  const nullRate = (nullCount.has + model.odds_age_k * base) / (nullCount.n + model.odds_age_k);
  return { base, rates, counts, nullRate, nullCount };
}

/** A logistic regression by batch gradient descent: fixed iterations, fixed step, no randomness. */
function fitLogistic(rows: number[][], ys: number[], lambda: number, iters: number): number[] {
  const d = rows[0]!.length;
  const w = new Array<number>(d).fill(0);
  const lr = 0.5;
  for (let it = 0; it < iters; it++) {
    const grad = new Array<number>(d).fill(0);
    for (let i = 0; i < rows.length; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += rows[i]![j]! * w[j]!;
      const err = sigmoid(z) - ys[i]!;
      for (let j = 0; j < d; j++) grad[j]! += err * rows[i]![j]!;
    }
    for (let j = 1; j < d; j++) grad[j]! += lambda * w[j]!;
    for (let j = 0; j < d; j++) w[j]! -= (lr / rows.length) * grad[j]!;
  }
  return w;
}

/**
 * The launch-odds model, fitted from the snapshot's own token statuses: a logistic regression on
 * the rankable protocols, target "records a token". Features: log10 TVL, chain count, the
 * category's shrunk token rate, and the age bucket's shrunk token rate — each standardised on
 * the training set. The age feature is a bucket rate, not a linear age term (see the header
 * comment): the token rate dips at 90-180 days and a linear term cannot bend there. The fit is
 * deterministic: fixed iterations, no randomness, no wall clock.
 */
export function fitOdds(snapshot: Snapshot, model: ModelConstants = MODEL): OddsFit {
  const protocols = rankableProtocols(snapshot);
  const ages = protocols.map((p) => ageDays(snapshot.as_of, p.listed_at));
  const { base, rates } = categoryTokenRates(protocols, model);
  const buckets = ageBucketRates(protocols, ages, model);
  const catRate = (p: SnapshotProtocol): number => rates.get(p.category ?? 'Other')?.rate ?? base;
  const ageRate = (age: number | null): number => {
    const b = ageBucket(age);
    return b === -1 ? buckets.nullRate : buckets.rates[b]!;
  };
  const feats = protocols.map((p, i) => oddsFeatures(p, ages[i]!, catRate, ageRate));
  const keys: (keyof OddsFeatures)[] = ['logTvl', 'nChains', 'catRate', 'ageRate'];
  const means = keys.map((k) => feats.reduce((s, f) => s + f[k], 0) / feats.length);
  const sds = keys.map((k, j) => {
    const v = Math.sqrt(feats.reduce((s, f) => s + (f[k] - means[j]!) ** 2, 0) / feats.length);
    return v === 0 ? 1 : v;
  });
  const design = (f: OddsFeatures): number[] => [1, ...keys.map((k, j) => (f[k] - means[j]!) / sds[j]!)];
  const coefficients = fitLogistic(
    feats.map(design),
    protocols.map((p) => (isPreToken(p) ? 0 : 1)),
    model.odds_lambda,
    500,
  );
  const category_rates = [...rates.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, v]) => ({ category, protocols: v.n, with_token: v.has, rate: round4(v.rate) }));
  const age_bucket_rates: AgeBucketRate[] = AGE_BUCKETS.map((b, i) => ({
    bucket: b.label,
    min_days: b.min,
    max_days: b.max,
    protocols: buckets.counts[i]!.n,
    with_token: buckets.counts[i]!.has,
    rate: round4(buckets.rates[i]!),
  }));
  return {
    coefficients: coefficients.map(round4),
    means: means.map(round4),
    sds: sds.map(round4),
    base_rate: round4(base),
    protocols: protocols.length,
    category_rates,
    age_bucket_rates,
    age_null_rate: round4(buckets.nullRate),
  };
}

/** The launch odds one protocol gets under a fitted odds model, at its age in days (null when its listing date is not recorded). */
export function oddsFor(p: SnapshotProtocol, fit: OddsFit, age: number | null): number {
  const rate = fit.category_rates.find((c) => c.category === (p.category ?? 'Other'))?.rate ?? fit.base_rate;
  const b = ageBucket(age);
  const ageRate = b === -1
    ? fit.age_null_rate
    : fit.age_bucket_rates[b]?.rate ?? fit.base_rate;
  const feats = [Math.log10(Math.max(p.tvl_usd, 1)), p.chains.length, rate, ageRate];
  let z = fit.coefficients[0]!;
  for (let j = 0; j < 4; j++) z += fit.coefficients[j + 1]! * ((feats[j]! - fit.means[j]!) / fit.sds[j]!);
  return sigmoid(z);
}

/**
 * The odds model's validation: leave-one-out, each protocol's token status called by a model fitted
 * without it (standardisation, category rates and age-bucket rates refit per fold), against the
 * base rate the majority class alone would call right. Fewer gradient steps per fold than the full
 * fit — the coefficients converge long before 150 steps, and the validation runs 442 fits.
 */
export function oddsBacktest(snapshot: Snapshot, model: ModelConstants = MODEL): OddsBacktest {
  const protocols = rankableProtocols(snapshot);
  const ages = protocols.map((p) => ageDays(snapshot.as_of, p.listed_at));
  const base = protocols.filter((p) => !isPreToken(p)).length / protocols.length;
  let correct = 0;
  for (let i = 0; i < protocols.length; i++) {
    const rest = protocols.filter((_, j) => j !== i);
    const restAges = ages.filter((_, j) => j !== i);
    const { base: b, rates } = categoryTokenRates(rest, model);
    const buckets = ageBucketRates(rest, restAges, model);
    const catRate = (p: SnapshotProtocol): number => rates.get(p.category ?? 'Other')?.rate ?? b;
    const ageRate = (age: number | null): number => {
      const bi = ageBucket(age);
      return bi === -1 ? buckets.nullRate : buckets.rates[bi]!;
    };
    const feats = rest.map((p, j) => oddsFeatures(p, restAges[j]!, catRate, ageRate));
    const keys: (keyof OddsFeatures)[] = ['logTvl', 'nChains', 'catRate', 'ageRate'];
    const means = keys.map((k) => feats.reduce((s, f) => s + f[k], 0) / feats.length);
    const sds = keys.map((k, j) => {
      const v = Math.sqrt(feats.reduce((s, f) => s + (f[k] - means[j]!) ** 2, 0) / feats.length);
      return v === 0 ? 1 : v;
    });
    const design = (f: OddsFeatures): number[] => [1, ...keys.map((k, j) => (f[k] - means[j]!) / sds[j]!)];
    const w = fitLogistic(
      feats.map(design),
      rest.map((p) => (isPreToken(p) ? 0 : 1)),
      model.odds_lambda,
      150,
    );
    const held = protocols[i]!;
    const f = oddsFeatures(held, ages[i]!, catRate, ageRate);
    const row = design(f);
    let z = 0;
    for (let j = 0; j < row.length; j++) z += row[j]! * w[j]!;
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === (isPreToken(held) ? 0 : 1)) correct++;
  }
  return { loo_accuracy: round4(correct / protocols.length), base_rate: round4(base), protocols: protocols.length };
}

/** The value, the odds and the implied value one protocol gets under `model` and the fitted curve and odds. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fit: CurveFit,
  odds: OddsFit,
): {
  value: number;
  odds: number;
  implied: number;
  offset: number;
  family: string | null;
  growthPct: number;
  growthMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const { offset, family } = offsetFor(protocol.category, fit);
  const value = Math.max(1, Math.round(10 ** (fit.intercept + fit.slope * Math.log10(Math.max(protocol.tvl_usd, 1)) + offset) * growthMult));
  const p = oddsFor(protocol, odds, age);
  const implied = Math.max(1, Math.round(value * p));
  return { value, odds: round4(p), implied, offset, family, growthPct, growthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The categories RULES.txt's watchlist rule excludes: wrapped, staked or bridged products. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** The exchange names RULES.txt's watchlist rule excludes a protocol from beginning with. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word wrapped, staked or staking in a name, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether a protocol passes the watchlist's own exclusion rule (RULES.txt §2): its category is not a
 * bridge, a liquid-staking product or an exchange; its name ends in no version marker and carries no
 * whole word wrapped, staked or staking; and it does not begin with an exchange's name. The rule's
 * parentProtocol check cannot be replicated — DefiLlama's parent record is not one of the snapshot's
 * ten fields — so a protocol the watchlist leaves out only for its parent (Sentora Curator) passes
 * here and is ranked: its token, if it ever issues one, is a launch the radar exists to find.
 */
export function passesWatchlistExclusions(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
  fit: CurveFit = fitCurve(snapshot, model),
  odds: OddsFit = fitOdds(snapshot, model),
): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Every other pre-token protocol the watchlist's own exclusion rule would keep — above and below
  // the floor alike. A wrapped, staked or bridged product of a token that already trades is not a
  // launch candidate at any size, so it is set aside (see setAsideRows) rather than ranked.
  // Sentora Curator passes here: the rule's parentProtocol check cannot be replicated (DefiLlama's
  // parent record is not one of the snapshot's ten fields), and its token, if it ever issues one,
  // is a launch the radar exists to find.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isPreToken(p) && passesWatchlistExclusions(p)) chosen.set(p.slug, p);
  }

  const test = backtest(snapshot, model);
  // A row's band: its category's own out-of-sample spread where the category has enough evidence,
  // else its family's, else the board's. A tight category (RWA) gets a tight band; a dispersed one
  // (Dexs) gets a wide one — and because the band varies by row, the rank range is real.
  const bandFor = (p: SnapshotProtocol): { low: number; high: number } => {
    const cat = test.band_by_category.find((b) => b.category === (p.category ?? 'Other'));
    if (cat !== undefined) return { low: cat.low_mult, high: cat.high_mult };
    const fam = familyOf(p.category);
    if (fam !== null) {
      const f = test.band_by_family.find((b) => b.family === fam);
      if (f !== undefined) return { low: f.low_mult, high: f.high_mult };
    }
    return { low: test.band_low_mult, high: test.band_high_mult };
  };
  const scored = [...chosen.values()].map((p) => {
    const { value, odds: o, implied, offset, family, growthPct, growthMult, age } = impliedValue(p, snapshot.as_of, model, fit, odds);
    const band = bandFor(p);
    return {
      p,
      value,
      odds: o,
      implied,
      offset,
      family,
      growthPct,
      growthMult,
      age,
      bandLowMult: band.low,
      bandLow: Math.max(1, Math.round(implied * band.low)),
      bandHigh: Math.max(1, Math.round(implied * band.high)),
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // The rank range: where each row would sit if IT were priced at its band's high end (its best
  // rank — how many rows' implied values still beat its optimistic value) or its band's low end
  // (its worst rank), holding every other row at its implied value. The band is the value model's
  // own uncertainty, so the range is the rank's uncertainty, not a second opinion.
  const implieds = scored.map((s) => s.implied).sort((a, b) => b - a);
  const rankOf = (v: number): number => implieds.filter((x) => x > v).length + 1;
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    value_if_launches_usd: s.value,
    launch_odds: s.odds,
    implied_value_usd: s.implied,
    band_low_usd: s.bandLow,
    band_high_usd: s.bandHigh,
    rank_best: rankOf(s.bandHigh),
    rank_worst: rankOf(s.bandLow),
    model: {
      category_offset: s.offset,
      offset_family: s.family,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      age_days: s.age,
    },
    economics: farmEconomics(s.p, s.implied, s.age, model, s.bandLowMult),
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** Why a pre-token protocol is set aside rather than ranked, in the rule's own words. */
function setAsideReason(p: SnapshotProtocol): string {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    if (p.category === 'CEX') return 'exchange — its token, if any, is the exchange\u2019s own';
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge — a wrapped product of a token that already trades';
    return 'liquid staking — a staked product of a token that already trades';
  }
  if (VERSIONED.test(p.name)) return 'versioned pool — one release of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked — a product of a token that already trades';
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return 'exchange product — named for an exchange';
  return 'not rankable';
}

/** The pre-token protocols the board sets aside, largest first: the audit trail for the 198-row board. */
export function setAsideRows(snapshot: Snapshot): SetAsideRow[] {
  const index = new Set(snapshot.watchlist);
  return snapshot.protocols
    .filter((p) => isPreToken(p) && !index.has(p.slug) && !passesWatchlistExclusions(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      reason: setAsideReason(p),
    }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The category's one action, in the words a farmer can follow. Every category on the board has its own
 * branch naming the protocol's real mechanism (deposit, supply, stake, mint, bridge, trade, vote) —
 * the generic fallback only serves a protocol with no category or a category the board does not carry.
 * Order matters: a specific branch is checked before the general one its name contains ('yield
 * aggregator' before 'yield', 'bridge' before 'chain', 'leveraged farm' before 'farm', 'restaking'
 * before 'btc'), so a category always lands on its most specific action.
 */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('yield aggregator')) return `Deposit $${capital} into a ${name} yield vault on ${chain} and let it compound.`;
  if (c.includes('cdp')) return `Deposit $${capital} of collateral into ${name} on ${chain} and mint its stable asset.`;
  if (c.includes('lend') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('basis')) return `Deposit $${capital} into the ${name} basis vault on ${chain} and keep the position open.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${name} and keep it in one of its apps.`;
  if (c.includes('farm')) return `Provide $${capital} of liquidity through ${name} on ${chain} and stake the LP tokens in its farm.`;
  if (c.includes('liquidity manager')) return `Deposit $${capital} into a ${name} managed pool on ${chain} and keep the shares.`;
  if (c.includes('cedefi')) return `Deposit $${capital} into the ${name} earn vault on ${chain} and keep the receipt.`;
  if (c.includes('btc')) return `Deposit $${capital} of BTC through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('otc')) return `Fill $${capital} of OTC trades through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('governance')) return `Deposit $${capital} into the ${name} voting market on ${chain} and vote each round.`;
  if (c.includes('card')) return `Spend $${capital} through the ${name} card on ${chain} and keep the statements.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index on ${chain} and hold it.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The Ethereum L2s and cheap rollups: one transaction costs about $0.10 there. */
const L2_CHAINS = [
  'arbitrum', 'optimism', 'base', 'polygon', 'zksync', 'starknet', 'linea', 'scroll', 'blast', 'mantle',
  'ink', 'world chain', 'manta', 'morph', 'rise', 'robinhood', 'reya', 'mode', 'zora', 'fraxtal',
  'metis', 'boba', 'kroma', 'lisk', 'unichain', 'soneium', 'abstract', 'aevo', 'lyra', 'nova',
];

/**
 * What one transaction costs on a chain, in dollars: a chain property, not a per-name hardcode.
 * Ethereum ~$3 (a simple transaction on L1 in 2026); Solana ~$0.01 (5,000-lamport base fee);
 * BNB Smart Chain ~$0.05 (DefiLlama names it "Binance"); the L2s ~$0.10; every other chain $0.50,
 * a conservative upper bound for a simple transaction on a chain whose fee market the radar does
 * not price. The farm plan's setup costs two transactions (approve, then deposit), so step 2
 * charges twice this; the weekly action costs one.
 */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 3;
  if (c === 'solana') return 0.01;
  if (c === 'binance' || c === 'bsc' || c.includes('bnb')) return 0.05;
  if (L2_CHAINS.some((l2) => c.includes(l2))) return 0.1;
  return 0.5;
}

/** A dollar amount as the farm plan prints it: $3, $1, $0.50, $0.10, $0.01 — no trailing noise. */
function dollars(n: number): string {
  return n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const gas = gasPerTx(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `under ${dollars(gas)} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about ${dollars(gas * 2)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about ${dollars(gas)} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/**
 * A farm plan's economics at the model's plan capital. The slice is what the capital deposited would
 * get if the airdrop share of the launch goes to depositors pro rata: slice = capital/TVL x share x
 * implied. The fees are the plan's own gas (setup + one weekly action per hold week, priced on the
 * protocol's first chain). The T-bill cost is the risk-free yield the capital gives up over the hold.
 * The plan is netted TWICE: at the implied value and at the band's low end (bandLowMult, the P25
 * multiplier from the backtest). The verdict follows from the arithmetic: ROBUST nets above zero even
 * at the band's low end; FARM nets above zero at the implied value; THIN beats its fees but not the
 * T-bill; SKIP loses to its fees alone. Pays-from is the smallest capital at which the plan nets above
 * zero — the slice and the T-bill cost both scale with capital, the fees do not. Break-even is the
 * implied value at which the slice exactly covers fees + T-bill.
 */
export function farmEconomics(p: SnapshotProtocol, implied: number, age: number | null, model: ModelConstants = MODEL, bandLowMult: number = 1): FarmEconomics {
  const capital = model.plan_capital;
  const hold = holdDaysFor(age);
  const gas = gasPerTx(chainOf(p));
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const slice = (capital / Math.max(p.tvl_usd, 1)) * model.airdrop_share * implied;
  const sliceLow = slice * bandLowMult;
  const fees = gas * 2 + gas * weeks;
  const tbill = capital * model.tbill_rate * (hold / 365);
  const net = slice - fees - tbill;
  const netLow = sliceLow - fees - tbill;
  const netAfterFees = slice - fees;
  const verdict: FarmEconomics['verdict'] = netLow > 0 ? 'ROBUST' : net > 0 ? 'FARM' : netAfterFees > 0 ? 'THIN' : 'SKIP';
  const hours = 0.25 + weeks * (10 / 60) + 10 / 60 + 5 / 60;
  // Net as a function of capital: capital x (sliceRate - tbillRate) - fees. It crosses zero at
  // fees / (sliceRate - tbillRate) when the slice rate beats the T-bill rate; otherwise never.
  const sliceRate = (model.airdrop_share * implied) / Math.max(p.tvl_usd, 1);
  const tbillRate = model.tbill_rate * (hold / 365);
  const paysFrom = sliceRate > tbillRate ? Math.ceil((fees / (sliceRate - tbillRate)) / 10) * 10 : null;
  // Break-even implied value: the launch value at which slice = fees + T-bill.
  // slice = capital/TVL x share x implied, so implied* = (fees + tbill) x TVL / (capital x share).
  const breakeven = Math.ceil(((fees + tbill) * Math.max(p.tvl_usd, 1)) / (capital * model.airdrop_share));
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    slice_usd: round2(slice),
    slice_low_usd: round2(sliceLow),
    fees_usd: round2(fees),
    tbill_usd: round2(tbill),
    net_usd: round2(net),
    net_low_usd: round2(netLow),
    net_after_fees_usd: round2(netAfterFees),
    verdict,
    net_per_hour_usd: round2(net / hours),
    pays_from_usd: paysFrom,
    breakeven_implied_usd: breakeven,
    hours: round2(hours),
  };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    value_if_launches_usd: row.value_if_launches_usd,
    launch_odds: row.launch_odds,
    implied_value_usd: row.implied_value_usd,
    band_low_usd: row.band_low_usd,
    band_high_usd: row.band_high_usd,
    rank_best: row.rank_best,
    rank_worst: row.rank_worst,
    category_offset: row.model.category_offset,
    offset_family: row.model.offset_family,
    growth_multiplier: row.model.growth_multiplier,
    economics: row.economics,
  };
}

/** The snapshot's 758 protocols accounted for, every group with one reason. */
export function accounting(snapshot: Snapshot, boardSize: number): Accounting {
  let live_token = 0;
  let bridges = 0;
  let liquid_staking = 0;
  let exchanges = 0;
  let versioned = 0;
  let wrapped = 0;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) {
      live_token++;
      continue;
    }
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') bridges++;
    else if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') liquid_staking++;
    else if (p.category === 'CEX' || EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) exchanges++;
    else if (VERSIONED.test(p.name)) versioned++;
    else if (WRAPPED_WORD.test(p.name)) wrapped++;
  }
  return { ranked: boardSize, live_token, bridges, liquid_staking, exchanges, versioned, wrapped };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fit = fitCurve(snapshot, model);
  const test = backtest(snapshot, model);
  const odds = fitOdds(snapshot, model);
  const oddsTest = oddsBacktest(snapshot, model);
  const board = buildBoard(snapshot, model, fit, odds);
  const live = liveRows(snapshot);
  const setAside = setAsideRows(snapshot);
  const scatter = comparables(snapshot, model).map((p) => ({ tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }));
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    curve: fit,
    backtest: test,
    odds,
    odds_backtest: oddsTest,
    accounting: accounting(snapshot, board.length),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    set_aside_size: setAside.length,
    rows: board.map(radarRow),
    live,
    set_aside: setAside,
    scatter,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
