// The token radar's model (radar-4): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every other
// pre-token protocol the watchlist's own exclusion rule would keep: no wrapped, staked, bridged or
// exchange product, no versioned pool. A protocol is pre-token when its index entry records no token
// (no market cap, no CoinGecko id, no symbol). The snapshot's live-token protocols are kept apart and
// shown as the market's own values, never mixed into the ranked board — but their market caps ARE the
// evidence for the model: the size curve is fitted to them, and the farm economics are netted against
// the value the curve implies.
//
// Implied value follows only from the snapshot's own figures. A dollar of TVL is worth a different
// multiple at $5M than at $5B, so the model fits that curve on the snapshot's own trading protocols
// instead of applying one flat multiple:
//
//   log10(mcap) = a + b x log10(tvl_usd)          (ordinary least squares over the comparables)
//   offset(cat) = shrunk median residual of the category's comparables (k = 4, n >= 3 or 0)
//   base       = 10 ^ (a + b x log10(tvl_usd) + offset(category))
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied    = max(1, round(base x growthMult x maturity))
//
// The curve is TESTED, not assumed: leave-one-out, each comparable is priced by a curve fitted without
// it, and the median miss is compared with the flat multiple's (see backtest()). The prediction band
// (P25-P75 of the out-of-sample residuals) is carried on every row, so the board states its own
// uncertainty. No protocol name is ever special-cased: the same function scores every row, and the
// curve, the offsets and the band are computed from the snapshot at runtime, never hardcoded.
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
  /** The minimum live comparables before a category's own offset counts at all: below this, the offset is 0. */
  min_comparables: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
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
  shrinkage_k: 4,
  min_comparables: 3,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  airdrop_share: 0.1,
  tbill_rate: 0.04,
  plan_capital: 1000,
  band_low: 0.25,
  band_high: 0.75,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-4';

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
  implied_value_usd: number;
  /** The prediction band: implied value times the band's low/high multipliers (P25-P75 of the out-of-sample residuals). */
  band_low_usd: number;
  band_high_usd: number;
  model: {
    /** The category offset this row was scored with (log10 units, from the snapshot's live-token evidence). */
    category_offset: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
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
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  /** The category offset this row was scored with, so the page recomputes the same number. */
  category_offset: number;
  growth_multiplier: number;
  maturity_multiplier: number;
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
}

/** The leave-one-out backtest: the curve tested against the flat multiple, out of sample. */
export interface Backtest {
  /** Median miss of the curve, leave-one-out (each comparable priced by a curve fitted without it). */
  curve_median_miss: number;
  /** Median miss of one flat mcap/TVL multiple, same folds. */
  flat_median_miss: number;
  /** Share of comparables the curve prices within 3x of their real market cap, out of sample. */
  curve_within_3x: number;
  /** Same, for the flat multiple. */
  flat_within_3x: number;
  /** Share of comparables the curve prices within 10x, out of sample. */
  curve_within_10x: number;
  /** The prediction band's multipliers (P25-P75 of the out-of-sample residuals, in linear units). */
  band_low_mult: number;
  band_high_mult: number;
  /** Time-split check: curve fitted on pre-2024 listings, median miss on newer ones. */
  time_split_curve_miss: number | null;
  /** Same, for the flat multiple. */
  time_split_flat_miss: number | null;
  /** How many comparables the time split fitted on (listed before 2024). */
  time_split_fit_n: number;
  /** How many comparables the time split tested on. */
  time_split_n: number;
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

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  curve: CurveFit;
  backtest: Backtest;
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
 * The comparables the curve is fitted on: live-token protocols that pass the watchlist's exclusion
 * rule (no bridge, liquid-staking, exchange or wrapped product, no versioned pool). A wrapped token's
 * market cap is the wrapped asset's value, not a launch's — it would bend the curve toward the assets
 * the board exists to exclude. A comparable needs a positive market cap and a positive TVL, or its
 * logarithm is undefined.
 */
export function comparables(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && passesWatchlistExclusions(p),
  );
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
 * token does, and the snapshot's own trading protocols say by how much. Nothing here is hardcoded:
 * run this on a future snapshot and the curve, the offsets and the backtest move with the market.
 */
export function fitCurve(snapshot: Snapshot, model: ModelConstants = MODEL): CurveFit {
  const comps = comparables(snapshot);
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const { intercept, slope, rSquared } = ols(xs, ys);
  const residualsByCategory = new Map<string, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const cat = comps[i]!.category ?? 'Other';
    const list = residualsByCategory.get(cat);
    const r = ys[i]! - (intercept + slope * xs[i]!);
    if (list === undefined) residualsByCategory.set(cat, [r]);
    else list.push(r);
  }
  const categories: CategoryOffset[] = [...residualsByCategory.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([category, residuals]) => {
      const { raw, offset, fallback } = shrunkOffset(residuals, model);
      return { category, comparables: residuals.length, raw_median: raw, offset, fallback: fallback || undefined };
    });
  return { intercept: round4(intercept), slope: round4(slope), r_squared: round4(rSquared), comparables: comps.length, categories };
}

/** The offset a category gets: its shrunk offset, or 0 when it has no evidence. */
export function offsetFor(category: string | null, fit: CurveFit): number {
  if (category === null) return 0;
  const entry = fit.categories.find((c) => c.category === category);
  return entry === undefined ? 0 : entry.offset;
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

/**
 * The backtest: leave-one-out, each comparable is priced by a curve fitted without it (its category
 * offset refit from the remaining comparables), and the median miss is compared with one flat
 * mcap/TVL multiple's on the same folds. The prediction band comes from the out-of-sample residuals'
 * percentiles. A time split (fit on pre-2024 listings, test on newer ones) checks the curve holds
 * forward in time, not just across the sample.
 */
export function backtest(snapshot: Snapshot, model: ModelConstants = MODEL): Backtest {
  const comps = comparables(snapshot);
  const flatMedian = medianOf(comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b));
  const curveMisses: number[] = [];
  const flatMisses: number[] = [];
  const oosResiduals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const xs = rest.map((p) => Math.log10(p.tvl_usd));
    const ys = rest.map((p) => Math.log10(p.mcap_usd!));
    const { intercept, slope } = ols(xs, ys);
    const held = comps[i]!;
    const cat = held.category ?? 'Other';
    const catResiduals = rest
      .filter((p) => (p.category ?? 'Other') === cat)
      .map((p) => Math.log10(p.mcap_usd!) - (intercept + slope * Math.log10(p.tvl_usd)));
    const { offset } = shrunkOffset(catResiduals, model);
    const predLog = intercept + slope * Math.log10(held.tvl_usd) + offset;
    const pred = 10 ** predLog;
    curveMisses.push(missOf(pred, held.mcap_usd!));
    flatMisses.push(missOf(held.tvl_usd * flatMedian, held.mcap_usd!));
    oosResiduals.push(Math.log10(held.mcap_usd!) - predLog);
  }
  oosResiduals.sort((a, b) => a - b);
  const within = (misses: number[], k: number): number =>
    Math.round((misses.filter((m) => m <= k).length / misses.length) * 1000) / 1000;
  // Time split: fit on listings before 2024, test on the newer ones.
  const old = comps.filter((p) => p.listed_at !== null && p.listed_at < '2024-01-01');
  const newer = comps.filter((p) => p.listed_at !== null && p.listed_at >= '2024-01-01');
  let timeSplitCurve: number | null = null;
  let timeSplitFlat: number | null = null;
  if (old.length >= 5 && newer.length >= 5) {
    const { intercept, slope } = ols(
      old.map((p) => Math.log10(p.tvl_usd)),
      old.map((p) => Math.log10(p.mcap_usd!)),
    );
    const cm = newer.map((p) => missOf(10 ** (intercept + slope * Math.log10(p.tvl_usd)), p.mcap_usd!));
    const fm = newer.map((p) => missOf(p.tvl_usd * flatMedian, p.mcap_usd!));
    timeSplitCurve = round4(medianOf([...cm].sort((a, b) => a - b)));
    timeSplitFlat = round4(medianOf([...fm].sort((a, b) => a - b)));
  }
  return {
    curve_median_miss: round4(medianOf([...curveMisses].sort((a, b) => a - b))),
    flat_median_miss: round4(medianOf([...flatMisses].sort((a, b) => a - b))),
    curve_within_3x: within(curveMisses, 3),
    flat_within_3x: within(flatMisses, 3),
    curve_within_10x: within(curveMisses, 10),
    band_low_mult: round4(10 ** percentileOf(oosResiduals, model.band_low)),
    band_high_mult: round4(10 ** percentileOf(oosResiduals, model.band_high)),
    time_split_curve_miss: timeSplitCurve,
    time_split_flat_miss: timeSplitFlat,
    time_split_fit_n: old.length,
    time_split_n: newer.length,
  };
}

/** The three multipliers and the implied value one protocol gets under `model` and the fitted curve. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fit: CurveFit,
): { implied: number; offset: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const offset = offsetFor(protocol.category, fit);
  const base = 10 ** (fit.intercept + fit.slope * Math.log10(Math.max(protocol.tvl_usd, 1)) + offset);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, offset, growthPct, growthMult, maturityMult, age };
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
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, fit: CurveFit = fitCurve(snapshot, model)): BoardRow[] {
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
  const scored = [...chosen.values()].map((p) => {
    const { implied, offset, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model, fit);
    return { p, implied, offset, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
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
    implied_value_usd: s.implied,
    band_low_usd: Math.max(1, Math.round(s.implied * test.band_low_mult)),
    band_high_usd: Math.max(1, Math.round(s.implied * test.band_high_mult)),
    model: {
      category_offset: s.offset,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    economics: farmEconomics(s.p, s.implied, s.age, model, test.band_low_mult),
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
    implied_value_usd: row.implied_value_usd,
    band_low_usd: row.band_low_usd,
    band_high_usd: row.band_high_usd,
    category_offset: row.model.category_offset,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    economics: row.economics,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fit = fitCurve(snapshot, model);
  const test = backtest(snapshot, model);
  const board = buildBoard(snapshot, model, fit);
  const live = liveRows(snapshot);
  const setAside = setAsideRows(snapshot);
  const scatter = comparables(snapshot).map((p) => ({ tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }));
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    curve: fit,
    backtest: test,
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
