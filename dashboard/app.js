// Token Radar's dashboard: renders window.RADAR (written by main.ts) — top-5 strip, table, detail
// drawer, scatter, backtest, set-aside. No network; no name special-cased.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  // A signed dollar amount with cents, for farm economics: +$3.84, -$2.62.
  function fmtSigned(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2);
  }
  function fmtAge(days) {
    if (days == null) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The page recomputes every row from the snapshot figures and checks it against board.json.
  // value = 10 ^ (intercept + slope x log10(TVL) + category offset) x growthMult; odds = logistic
  // on z[log10 TVL, chains, category rate, age-bucket rate]; implied = round(value x odds).
  function valueOf(row, model, curve) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d == null ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var base = 10 ** (curve.intercept + curve.slope * Math.log10(Math.max(row.tvl_usd, 1)) + row.category_offset);
    return Math.max(1, Math.round(base * growthMult));
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
  // Launch odds: same features and standardisation as lib/model.ts oddsFor.
  function oddsOf(row, odds) {
    var entry = findIn(odds.category_rates, 'category', row.category || 'Other');
    var rate = entry ? entry.rate : odds.base_rate;
    var ageRate = odds.age_null_rate, a = row.age_days;
    if (a != null) odds.age_bucket_rates.forEach(function (x) { if (a >= x.min_days && (x.max_days == null || a < x.max_days)) ageRate = x.rate; });
    var feats = [Math.log10(Math.max(row.tvl_usd, 1)), row.chains.length, rate, ageRate];
    var z = odds.coefficients[0];
    for (var j = 0; j < 4; j++) z += odds.coefficients[j + 1] * ((feats[j] - odds.means[j]) / odds.sds[j]);
    return sigmoid(z);
  }
  // The row's age bucket and its token rate, as the odds model reads them.
  function ageBucketText(row) {
    var a = row.age_days, o = DATA.odds, r = o.age_null_rate, b = 'unknown age';
    if (a != null) o.age_bucket_rates.forEach(function (x) { if (a >= x.min_days && (x.max_days == null || a < x.max_days)) { r = x.rate; b = x.bucket; } });
    return b + ' — ' + Math.round(r * 100) + '% record a token';
  }
  function impliedOf(row, model, curve) {
    return Math.max(1, Math.round(valueOf(row, model, curve) * oddsOf(row, DATA.odds)));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    function add(c) {
      if (c == null) return;
      if (Array.isArray(c)) c.forEach(add);
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return node;
  }

  // Small builders, so the tables and the drawer stay readable without repeating the same nodes.
  function sub(text) { return el('span', { class: 'sub', text: text }); }
  function tdNum(value, cls) { return el('td', { class: 'num' + (cls ? ' ' + cls : ''), text: value }); }
  function stat(value, label, amber) {
    return el('div', { class: 'stat' + (amber ? ' amber' : '') }, el('b', { text: value }), el('span', { text: label }));
  }
  function eqRow(label, value, cls) {
    return el('div', null, el('span', { text: label }), el('b', { class: 'num' + (cls ? ' ' + cls : ''), text: value }));
  }
  function verdictClass(v) { return v === 'ROBUST' ? 'robust' : v === 'FARM' ? 'farm' : v === 'THIN' ? 'thin' : 'skip'; }

  // The farm plan mirrors board.json: category, chains, TVL and age decide the action, capital, hold and costs.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  // One branch per category, naming the real mechanism (specific first: 'yield aggregator' before
  // 'yield'); mirrors lib/model.ts exactly.
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('yield aggregator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' yield vault on ' + chain + ' and let it compound.';
    if (c.indexOf('cdp') >= 0) return 'Deposit $' + capital + ' of collateral into ' + name + ' on ' + chain + ' and mint its stable asset.';
    if (c.indexOf('lend') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('basis') >= 0) return 'Deposit $' + capital + ' into the ' + name + ' basis vault on ' + chain + ' and keep the position open.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + name + ' and keep it in one of its apps.';
    if (c.indexOf('farm') >= 0) return 'Provide $' + capital + ' of liquidity through ' + name + ' on ' + chain + ' and stake the LP tokens in its farm.';
    if (c.indexOf('liquidity manager') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' managed pool on ' + chain + ' and keep the shares.';
    if (c.indexOf('cedefi') >= 0) return 'Deposit $' + capital + ' into the ' + name + ' earn vault on ' + chain + ' and keep the receipt.';
    if (c.indexOf('btc') >= 0) return 'Deposit $' + capital + ' of BTC through ' + name + ' on ' + chain + ' and keep the receipt.';
    if (c.indexOf('payment') >= 0) return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' and keep the receipts.';
    if (c.indexOf('otc') >= 0) return 'Fill $' + capital + ' of OTC trades through ' + name + ' on ' + chain + ' and keep the receipts.';
    if (c.indexOf('governance') >= 0) return 'Deposit $' + capital + ' into the ' + name + ' voting market on ' + chain + ' and vote each round.';
    if (c.indexOf('card') >= 0) return 'Spend $' + capital + ' through the ' + name + ' card on ' + chain + ' and keep the statements.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of the ' + name + ' index on ' + chain + ' and hold it.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  // One transaction's cost by chain: Ethereum ~$3, Solana ~$0.01, BNB Chain ("Binance") ~$0.05,
  // the L2s ~$0.10, every other chain $0.50. Setup costs two transactions; the weekly action one.
  var L2_CHAINS = ['arbitrum', 'optimism', 'base', 'polygon', 'zksync', 'starknet', 'linea', 'scroll', 'blast', 'mantle', 'ink', 'world chain', 'manta', 'morph', 'rise', 'robinhood', 'reya', 'mode', 'zora', 'fraxtal', 'metis', 'boba', 'kroma', 'lisk', 'unichain', 'soneium', 'abstract', 'aevo', 'lyra', 'nova'];
  function gasPerTx(chain) {
    var c = chain.toLowerCase();
    if (c === 'ethereum') return 3;
    if (c === 'solana') return 0.01;
    if (c === 'binance' || c === 'bsc' || c.indexOf('bnb') >= 0) return 0.05;
    for (var i = 0; i < L2_CHAINS.length; i++) if (c.indexOf(L2_CHAINS[i]) >= 0) return 0.1;
    return 0.5;
  }
  function dollars(n) { return n >= 1 ? '$' + Math.round(n) : '$' + n.toFixed(2); }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasPerTx(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under ' + dollars(gas) + ' of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about ' + dollars(gas * 2) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about ' + dollars(gas) + ' of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // The first entry whose key matches, or null.
  function findIn(list, key, value) {
    var found = list.filter(function (x) { return x[key] === value; });
    return found.length ? found[0] : null;
  }
  // The offsets table, looked up by category: the derivation of one row's offset.
  function offsetEntry(category) {
    return category ? findIn(DATA.curve.categories, 'category', category) : null;
  }
  // The family a category's rows borrow their offset from, if any (read off the rows themselves).
  function familyFor(category) {
    for (var i = 0; i < DATA.rows.length; i++) if ((DATA.rows[i].category || 'Other') === category && DATA.rows[i].offset_family) return DATA.rows[i].offset_family;
    return null;
  }
  function familyEntry(family) {
    return findIn(DATA.curve.families, 'family', family);
  }
  // Board categories with no live comparable at all: they borrow a family offset, or get offset 0.
  function noEvidenceCategories() {
    var known = {};
    DATA.curve.categories.forEach(function (c) { known[c.category] = true; });
    var out = [];
    DATA.rows.forEach(function (r) {
      var cat = r.category || 'Other';
      if (!known[cat] && out.indexOf(cat) < 0) out.push(cat);
    });
    return out.sort();
  }
  // Verdict counts across the board, for the lede and the filter.
  function verdictCounts() {
    var counts = { ROBUST: 0, FARM: 0, THIN: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { if (counts[r.economics.verdict] !== undefined) counts[r.economics.verdict]++; });
    return counts;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (state.verdict !== 'all' && r.economics.verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortVal(r) {
    switch (state.sort) {
      case 'name': return r.name.toLowerCase();
      case 'tvl': return r.tvl_usd;
      case 'growth': return r.change_7d === null ? -Infinity : r.change_7d;
      case 'age': return r.age_days === null ? Infinity : r.age_days;
      case 'value': return r.value_if_launches_usd;
      case 'odds': return r.launch_odds;
      case 'slice': return r.economics.slice_usd;
      case 'net': return r.economics.net_usd;
      default: return r.implied_value_usd;
    }
  }
  function sortedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortVal(a), bv = sortVal(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function topRows(n) {
    return DATA.rows.slice(0, n);
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'radar-mark', 'aria-hidden': 'true' }), el('span', { class: 'brand-name' }, 'Token ', el('span', { text: 'Radar' }))),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'DefiLlama protocol index'),
        el('span', null, 'Model ', el('b', { text: DATA.model_version }))
      )
    );
  }

  function bestHour() {
    var best = DATA.rows.slice().sort(function (a, b) { return b.economics.net_per_hour_usd - a.economics.net_per_hour_usd; }).slice(0, 2);
    if (best.length === 0 || best[0].economics.net_per_hour_usd <= 0) return null;
    return 'Best hands-on hour: ' + best.map(function (r) { return r.name + ' ' + fmtSigned(r.economics.net_per_hour_usd) + '/h'; }).join(' · ');
  }

  function lede() {
    var v = verdictCounts();
    return el('section', { class: 'lede' },
      el('div', { class: 'kicker', text: 'Pre-token radar · ' + DATA.as_of }),
      el('h1', { text: 'The next token launches, ranked before they exist' }),
      el('p', { text: 'Implied value is an expected value: what the launch would be worth, read off the ' + DATA.curve.comparables + ' tokens that already trade, times the odds it happens.' }),
      el('div', { class: 'stats' },
        stat(DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'Watchlist protocols covered', true),
        stat(DATA.board_size, 'Pre-token rows scored'),
        stat('x' + DATA.backtest.curve_median_miss, 'Leave-one-out error (flat multiple: x' + DATA.backtest.flat_median_miss + ')'),
        stat(v.ROBUST + ' · ' + v.FARM + ' · ' + v.THIN + ' · ' + v.SKIP, 'ROBUST · FARM · THIN · SKIP verdicts at $1,000')
      )
    );
  }

  // All 758 protocols accounted for: ranked, live, or set aside with one reason each.
  function accountingBar() {
    var a = DATA.accounting;
    var total = a.ranked + a.live_token + a.bridges + a.liquid_staking + a.exchanges + a.versioned + a.wrapped;
    return el('div', { class: 'accounting' },
      el('b', { text: total + ' protocols, every one accounted for: ' }),
      a.ranked + ' ranked · ' + a.live_token + ' already trade · ' + a.bridges + ' bridges · ' + a.liquid_staking + ' liquid staking · ' + a.exchanges + ' exchanges · ' + a.versioned + ' versioned · ' + a.wrapped + ' wrapped');
  }

  function topStrip() {
    var cards = topRows(5).map(function (r) {
      var growth = r.change_7d === null ? null : el('span', { class: 'chip ' + (r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) + ' 7d' });
      return el('button', { class: 'card', type: 'button', 'aria-label': 'Rank ' + r.rank + ': ' + r.name + ', implied value ' + fmtUsd(r.implied_value_usd), onclick: function () { openDetail(r.slug); } },
        el('span', { class: 'rank', text: '#' + r.rank }),
        el('span', { class: 'cname', text: r.name }),
        el('span', { class: 'cmeta', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains[0] : 'multi-chain') }),
        el('span', { class: 'cvalue' }, el('span', { text: 'Implied value' }), fmtUsd(r.implied_value_usd)),
        el('span', { class: 'ctvl', text: 'Value ' + fmtUsd(r.value_if_launches_usd) + ' · odds ' + Math.round(r.launch_odds * 100) + '%' }),
        el('span', { class: 'ctvl', text: 'TVL ' + fmtUsd(r.tvl_usd) }),
        growth
      );
    });
    return el('section', { 'aria-label': 'Top 5 by implied value' },
      el('div', { class: 'strip-head' },
        el('h2', { text: 'Top 5 by implied value' }),
        sub(bestHour() || 'Select a card for its model and farm plan')
      ),
      el('div', { class: 'strip' }, cards)
    );
  }

  // One filter select: an "all" option plus one per value, re-rendering on change.
  function filterSelect(id, label, allLabel, values, current, onPick) {
    var s = el('select', { id: id },
      el('option', { value: 'all', text: allLabel }),
      values.map(function (v) { return el('option', { value: v, text: v, selected: v === current ? 'selected' : null }); })
    );
    s.addEventListener('change', function () { onPick(s.value); writeHash(); render(); });
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), s);
  }
  function tabBtn(tab, label) {
    return el('button', { type: 'button', 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; render(); } });
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catField = filterSelect('category', 'Category', 'All categories', categories, state.category, function (v) { state.category = v; });
    var chainField = filterSelect('chain', 'Chain', 'All chains', chains, state.chain, function (v) { state.chain = v; });
    var verdictField = filterSelect('verdict', 'Verdict', 'All verdicts', ['ROBUST', 'FARM', 'THIN', 'SKIP'], state.verdict, function (v) { state.verdict = v; });
    // The page recomputes every row: the count proves the page and board.json agree, row for row.
    var matched = DATA.rows.filter(function (r) { return impliedOf(r, DATA.model, DATA.curve) === r.implied_value_usd; }).length;
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      catField, chainField, verdictField,
      el('div', { class: 'field' }, sub('View'), el('div', { class: 'tabs' }, tabBtn('pre-token', 'Pre-token'), tabBtn('live', 'Live token'), tabBtn('set-aside', 'Set aside'), tabBtn('method', 'Method'))),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown · page = board.json: ' + matched + '/' + DATA.rows.length + ' match' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : state.tab === 'set-aside' ? DATA.set_aside_size + ' protocols set aside' : 'How the radar is built and tested' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { state.dir = state.sort === key ? -state.dir : -1; state.sort = key; render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category, chain or verdict to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; writeHash(); render(); } })
      ));
    }
    // The band bars share one log scale across the whole board, so a wide band reads as wide.
    var logMin = Math.log10(Math.min.apply(null, DATA.rows.map(function (r) { return r.band_low_usd; })));
    var logMax = Math.log10(Math.max.apply(null, DATA.rows.map(function (r) { return r.band_high_usd; })));
    function bandPct(v) { return Math.max(0, Math.min(100, ((Math.log10(v) - logMin) / (logMax - logMin)) * 100)); }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var e = r.economics;
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e2) { if (e2.key === 'Enter' || e2.key === ' ') { e2.preventDefault(); openDetail(r.slug); } }
      },
        el('td', null, el('div', { class: 'rank-cell' },
          el('span', { class: 'rank-badge' + (r.rank <= 3 ? ' top3' : ''), text: r.rank }),
          el('span', { class: 'rank-range', title: 'Rank range at the prediction band\u2019s high and low ends', text: '#' + r.rank_best + '–' + r.rank_worst })
        )),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          sub((r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain'))
        )),
        tdNum(fmtUsd(r.tvl_usd)),
        tdNum(growth, growthClass),
        tdNum(fmtAge(r.age_days)),
        tdNum(fmtUsd(r.value_if_launches_usd)),
        tdNum(Math.round(r.launch_odds * 100) + '%'),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'band', 'aria-hidden': 'true', title: 'Prediction band ' + fmtUsd(r.band_low_usd) + ' to ' + fmtUsd(r.band_high_usd) },
            el('i', { style: 'left:' + bandPct(r.band_low_usd).toFixed(1) + '%;width:' + Math.max(1, bandPct(r.band_high_usd) - bandPct(r.band_low_usd)).toFixed(1) + '%' }),
            el('b', { style: 'left:' + bandPct(r.implied_value_usd).toFixed(1) + '%' })
          ),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        tdNum('$' + e.slice_usd.toFixed(2)),
        tdNum(fmtSigned(e.net_usd), e.net_usd >= 0 ? 'pos' : 'neg'),
        el('td', null, el('span', { class: 'verdict ' + verdictClass(e.verdict), text: e.verdict }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest expected value first. Value is what the launch would be worth, odds the fitted launch probability, implied value x odds; the band is the P25\u2013P75 range and the rank range the rank at its ends. $1K slice is what $1,000 deposited would get if 10% of the launch goes to depositors; net is the slice minus gas and the 4% T-bill yield. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('value', 'Value'),
            sortHeader('odds', 'Odds'),
            sortHeader('implied', 'Implied value'),
            sortHeader('slice', '$1K slice'),
            sortHeader('net', 'Net'),
            el('th', { scope: 'col', text: 'Verdict' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('span', { class: 'status live', text: 'live' })),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), sub((r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain')))),
        tdNum(fmtUsd(r.tvl_usd)),
        tdNum(fmtPct(r.change_7d), r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'),
        tdNum(fmtUsd(r.mcap_usd)),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'These protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, ['Status', 'Protocol', 'TVL', '7d', 'Market cap', 'Token'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
          tbody
        )
      )
    );
  }

  // The audit trail: every pre-token protocol the board sets aside, with the rule that set it aside.
  function setAsideTable() {
    var tbody = el('tbody');
    DATA.set_aside.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), sub((r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain')))),
        tdNum(fmtUsd(r.tvl_usd)),
        el('td', null, sub(r.reason))
      ));
    });
    return el('div', { class: 'panel' },
      el('p', { class: 'sub', text: 'These ' + DATA.set_aside_size + ' pre-token protocols are not launch candidates: a wrapped, staked or bridged product of a token that already trades, an exchange, or one release of another protocol. The board ranks the other ' + DATA.board_size + '; the watchlist is the floor, and this list is the audit trail.' }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols set aside by the watchlist\u2019s own exclusion rule, largest first.' }),
          el('thead', null, el('tr', null, ['Protocol', 'TVL', 'Why it is set aside'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
          tbody
        )
      )
    );
  }

  // One offsets table, two uses: categories (with a derivation note) and families. Sorted by
  // offset, highest first, so the spread the model is built on is visible at a glance.
  function offsetTable(caption, head, rows) {
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tds = [el('td', { text: r[0] }), tdNum(r[1]),
        tdNum(r[2] === null ? 'n/a' : (r[2] >= 0 ? '+' : '') + r[2]),
        el('td', { class: 'num' }, el('b', { text: (r[3] >= 0 ? '+' : '') + r[3] + ' (x' + (10 ** r[3]).toFixed(2) + ')' }))];
      if (r[4] !== undefined) tds.push(el('td', null, r[4]));
      tbody.appendChild(el('tr', null, tds));
    });
    return el('div', { class: 'mult-table' },
      el('table', null,
        el('caption', { text: caption }),
        el('thead', null, el('tr', null, head.map(function (h) { return el('th', { scope: 'col', text: h }); }))),
        tbody
      )
    );
  }
  function categoryOffsets() {
    var m = DATA.model;
    var cats = DATA.curve.categories.slice().sort(function (a, b) { return b.offset - a.offset || (a.category < b.category ? -1 : 1); });
    var rows = cats.map(function (c) {
      var note;
      if (c.fallback) {
        var fam = familyFor(c.category);
        note = fam
          ? el('span', { class: 'fb', text: 'too thin — borrows the ' + fam + ' family offset' })
          : el('span', { class: 'fb', text: 'offset 0 — fewer than ' + m.min_comparables + ' live comparables' });
      } else note = el('span', { class: 'sub', text: 'shrunk toward 0 (k=' + m.shrinkage_k + ')' });
      return [c.category, c.comparables, c.raw_median, c.offset, note];
    });
    var noEv = noEvidenceCategories();
    return offsetTable('Category offsets, from the residuals of the ' + DATA.curve.comparables + ' live-token comparables against the curve. An offset of +0.15 lifts a category\u2019s value by 10^0.15 = 1.41x.' + (noEv.length === 0 ? '' : ' Categories with no live comparable at all — ' + noEv.join(', ') + ' — borrow a family offset or get 0.'),
      ['Category', 'Live comparables', 'Raw median residual (log10)', 'Offset applied', 'Derivation'], rows);
  }
  function familyOffsets() {
    var fams = DATA.curve.families.slice().sort(function (a, b) { return b.offset - a.offset || (a.family < b.family ? -1 : 1); });
    return offsetTable('Family offsets: categories grouped by how a token would capture value — Vaults manage capital, Credit lends, Trading takes volume, Real Assets tokenise yield, Staking secures, Bridges move assets. A category too thin for its own offset borrows its family\u2019s.',
      ['Family', 'Live comparables', 'Raw median residual (log10)', 'Offset applied'],
      fams.map(function (f) { return [f.family, f.comparables, f.raw_median, f.offset]; }));
  }

  // The scatter plot: the comparables' market caps against their TVL (log-log), the fitted curve,
  // and the board's rows at their implied values. Built as inline SVG from data.js — no network.
  function scatterPlot() {
    var W = 720, H = 300, padL = 52, padR = 12, padT = 12, padB = 32;
    var pts = DATA.scatter;
    var allX = pts.map(function (p) { return Math.log10(p.tvl_usd); }).concat(DATA.rows.map(function (r) { return Math.log10(r.tvl_usd); }));
    var allY = pts.map(function (p) { return Math.log10(p.mcap_usd); }).concat(DATA.rows.map(function (r) { return Math.log10(r.implied_value_usd); }));
    var xMin = Math.floor(Math.min.apply(null, allX)), xMax = Math.ceil(Math.max.apply(null, allX));
    var yMin = Math.floor(Math.min.apply(null, allY)), yMax = Math.ceil(Math.max.apply(null, allY));
    function X(v) { return padL + ((Math.log10(v) - xMin) / (xMax - xMin)) * (W - padL - padR); }
    function Y(v) { return padT + (1 - (Math.log10(v) - yMin) / (yMax - yMin)) * (H - padT - padB); }
    // The SVG namespace comes from a probe element, so the source names no network address.
    var probe = document.createElement('div');
    probe.innerHTML = '<svg></svg>';
    var SVG_NS = probe.firstChild.namespaceURI;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'scatter');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Scatter plot of traded tokens\u2019 market caps against TVL, with the fitted size curve and the board\u2019s implied values.');
    function node(name, attrs) {
      var n = document.createElementNS(SVG_NS, name);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }
    function axisLabel(g) {
      if (g >= 9) return '$' + (10 ** (g - 9)) + 'B';
      if (g >= 6) return '$' + (10 ** (g - 6)) + 'M';
      return '$' + (10 ** (g - 3)) + 'K';
    }
    // Gridlines + axis labels, one decade apart.
    for (var gx = xMin; gx <= xMax; gx++) {
      svg.appendChild(node('line', { x1: X(10 ** gx), y1: padT, x2: X(10 ** gx), y2: H - padB, class: 'grid' }));
      var xl = node('text', { x: X(10 ** gx), y: H - 10, class: 'axis' });
      xl.textContent = axisLabel(gx);
      svg.appendChild(xl);
    }
    for (var gy = yMin; gy <= yMax; gy++) {
      svg.appendChild(node('line', { x1: padL, y1: Y(10 ** gy), x2: W - padR, y2: Y(10 ** gy), class: 'grid' }));
      var yl = node('text', { x: padL - 6, y: Y(10 ** gy) + 3, class: 'axis', 'text-anchor': 'end' });
      yl.textContent = axisLabel(gy);
      svg.appendChild(yl);
    }
    // The fitted curve (before category offsets): a straight line on log-log axes.
    var c = DATA.curve;
    var x0 = 10 ** xMin, x1 = 10 ** xMax;
    var y0 = 10 ** (c.intercept + c.slope * xMin), y1 = 10 ** (c.intercept + c.slope * xMax);
    svg.appendChild(node('line', { x1: X(x0), y1: Y(y0), x2: X(x1), y2: Y(y1), class: 'curve' }));
    // Comparables in grey, board rows in amber.
    pts.forEach(function (p) { svg.appendChild(node('circle', { cx: X(p.tvl_usd), cy: Y(p.mcap_usd), r: 2.6, class: 'dot comp' })); });
    DATA.rows.forEach(function (r) { svg.appendChild(node('circle', { cx: X(r.tvl_usd), cy: Y(r.implied_value_usd), r: 2.2, class: 'dot board' })); });
    var cap = el('p', { class: 'sub', text: 'Grey: the ' + DATA.curve.comparables + ' traded comparables, market cap against TVL. Amber: the board at its implied values. Line: the size curve before category offsets (log10(mcap) = ' + c.intercept + ' + ' + c.slope + ' x log10(TVL), R\u00B2 ' + c.r_squared + ').' });
    return el('div', { class: 'scatter-wrap' }, svg, cap);
  }

  function backtestPanel() {
    var b = DATA.backtest;
    return el('section', { class: 'panel backtest' },
      el('h2', { text: 'The curve, tested before it is believed' }),
      el('p', { text: 'Leave-one-out: each of the ' + DATA.curve.comparables + ' comparables is priced by a curve fitted without it (category offset and family fallback refit), and the miss is measured against its real market cap. The flat multiple — one mcap/TVL median for every protocol — is tested on the same folds.' }),
      el('div', { class: 'stats' },
        stat('x' + b.curve_median_miss, 'Curve median miss, out of sample', true),
        stat('x' + b.flat_median_miss, 'Flat multiple median miss, same folds'),
        stat(Math.round(b.curve_within_3x * 100) + '% vs ' + Math.round(b.flat_within_3x * 100) + '%', 'Within 3x of the real cap: curve vs flat'),
        stat('x' + b.band_low_mult + ' – x' + b.band_high_mult, 'Prediction band (P25–P75 of the out-of-sample residuals)'),
        stat(Math.round(b.band_coverage_50 * 100) + '%', 'of comparables fall inside their row\u2019s band, out of sample (nominal 50%); the P10–P90 band holds ' + Math.round(b.band_coverage_80 * 100) + '% (nominal 80%)')
      ),
      el('p', { class: 'sub', text: '5-fold (deterministic folds by slug): curve x' + b.curve_five_fold_miss + ' against the flat multiple\u2019s x' + b.flat_five_fold_miss + '. ' + (b.time_split_n >= 5
        ? 'Time split: fitted on the ' + b.time_split_fit_n + ' comparables listed before 2024, the curve misses the ' + b.time_split_n + ' newer ones by x' + b.time_split_curve_miss + ' against the flat multiple\u2019s x' + b.time_split_flat_miss + ' — it holds forward in time, not just across the sample.'
        : 'Too few dated comparables for a time split; the leave-one-out test above is the check.') }),
      scatterPlot()
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var c = DATA.curve;
    var o = DATA.odds;
    var t = DATA.odds_backtest;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased. Implied value is an EXPECTED value: what the launch would be worth, times the odds it happens.' }),
      el('div', { class: 'formula' },
        'value = 10 ^ (' + c.intercept + ' + ' + c.slope + ' x log10(tvl_usd) + offset(category)) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ')'
      ),
      el('div', { class: 'formula' },
        'odds = sigmoid(' + o.coefficients[0] + ' + ' + o.coefficients[1] + ' x z(log10 TVL) + ' + o.coefficients[2] + ' x z(chains) + ' + o.coefficients[3] + ' x z(category token rate) + ' + o.coefficients[4] + ' x z(age-bucket token rate))'
      ),
      el('div', { class: 'formula' }, 'implied = round(value x odds)'),
      el('p', { text: 'offset(category) is the median log10 residual of the category\u2019s live comparables against the curve, shrunk toward 0 with k=' + m.shrinkage_k + '. A category with fewer than ' + m.min_comparables + ' live comparables borrows its family\u2019s offset (below); one with no family gets offset 0.' }),
      el('p', { text: 'The odds are a logistic regression on the ' + t.protocols + ' rankable protocols, target "records a token": log10 TVL, chain count, the category\u2019s token rate and the age bucket\u2019s token rate (each shrunk toward the base rate, k=' + m.odds_cat_k + '), each standardised. The token rate by age is not monotone — 31% under 90 days, 19% at 90–180 days, 86% past 3 years — so the model reads the rate of the protocol\u2019s own age bucket, not a linear age term. Leave-one-out accuracy ' + (t.loo_accuracy * 100).toFixed(1) + '% against a ' + (t.base_rate * 100).toFixed(1) + '% base rate.' }),
      el('p', { text: 'Set aside as speculative — ' + c.speculative_excluded.map(function (s) { return s.name + ' (' + (Math.round(s.ratio * 10) / 10) + 'x its TVL)'; }).join(', ') + ': a token above ' + m.speculative_cap + 'x its TVL is priced on speculation, not on the protocol\u2019s record, so the curve is fitted on the other ' + c.comparables + ' comparables.' }),
      categoryOffsets(),
      familyOffsets()
    );
  }

  // One row's offset, derived in words: the evidence behind the number.
  function derivationText(row) {
    var cat = row.category || 'Other';
    var entry = offsetEntry(row.category);
    var k = DATA.model.shrinkage_k;
    var mult = '(x' + (10 ** row.category_offset).toFixed(2) + ')';
    if (row.offset_family) {
      var f = familyEntry(row.offset_family);
      var n = entry ? entry.comparables : 0;
      return [el('b', { text: cat + ' — borrows the ' + row.offset_family + ' family offset. ' }),
        (n === 0 ? 'No live-token protocol in this category carries a market cap' : 'Only ' + n + ' live comparable' + (n === 1 ? '' : 's') + ' in this category — fewer than the ' + DATA.model.min_comparables + ' the model requires') + ', so the row takes its family\u2019s offset ' + row.category_offset + ' ' + mult + (f ? ', shrunk from ' + f.comparables + ' live comparables across the family.' : '.')];
    }
    if (!entry) {
      return [el('b', { text: cat + ' — no live comparables. ' }), 'No live-token protocol in this category carries a market cap, and it has no family to borrow from, so the model applies offset 0: the curve alone prices this row.'];
    }
    if (entry.fallback) {
      return [el('b', { text: cat + ' — offset 0. ' }), 'Only ' + entry.comparables + ' live comparable' + (entry.comparables === 1 ? '' : 's') + ' — fewer than the ' + DATA.model.min_comparables + ' the model requires — and no family offset applies, so the model applies offset 0 instead of the raw median residual ' + entry.raw_median + '.'];
    }
    return [el('b', { text: cat + ' — ' + entry.comparables + ' live comparables. ' }), 'Median log10 residual ' + entry.raw_median + ' against the curve, shrunk toward 0 with k=' + k + ', gives the offset ' + entry.offset + ' (x' + (10 ** entry.offset).toFixed(2) + ') this row was scored with.'];
  }

  // Why this row ranks where it does, generated from the model's own inputs.
  function whyHere(row) {
    var byTvl = DATA.rows.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    var tvlRank = byTvl.findIndex(function (r) { return r.slug === row.slug; }) + 1;
    var off = row.category_offset;
    var src = row.offset_family ? row.offset_family + ' family' : (row.category || 'Other');
    var offPart = off > 0.01
      ? 'its ' + src + ' offset of +' + off + ' (x' + (10 ** off).toFixed(2) + ') lifts it above the curve'
      : off < -0.01
        ? 'its ' + src + ' offset of ' + off + ' (x' + (10 ** off).toFixed(2) + ') pulls it below the curve'
        : 'its ' + src + ' offset is 0 (no category evidence of its own), so the curve alone prices it';
    var growthPart = row.change_7d === null
      ? 'no seven-day growth is recorded'
      : row.change_7d >= 0
        ? 'seven-day growth of +' + row.change_7d.toFixed(2) + '% lifts it (multiplier ' + row.growth_multiplier + ')'
        : 'seven-day growth of ' + row.change_7d.toFixed(2) + '% pulls it down (multiplier ' + row.growth_multiplier + ')';
    return el('p', { class: 'why' },
      el('b', { text: 'Why #' + row.rank + ': ' }),
      'its ' + fmtUsd(row.tvl_usd) + ' of TVL is the ' + tvlRank + (tvlRank === 1 ? 'st' : tvlRank === 2 ? 'nd' : tvlRank === 3 ? 'rd' : 'th') + ' largest on the board; ' + offPart + '; ' + growthPart + '; and its launch odds are ' + Math.round(row.launch_odds * 100) + '%, so the ' + fmtUsd(row.value_if_launches_usd) + ' launch value becomes ' + fmtUsd(row.implied_value_usd) + ' expected.'
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        eqRow('TVL', fmtUsd(row.tvl_usd)),
        eqRow('Curve value', fmtUsd(10 ** (DATA.curve.intercept + DATA.curve.slope * Math.log10(Math.max(row.tvl_usd, 1))))),
        eqRow('Category offset', (row.category_offset >= 0 ? '+' : '') + row.category_offset + ' (x' + (10 ** row.category_offset).toFixed(2) + ')' + (row.offset_family ? ' via ' + row.offset_family : '')),
        eqRow('Seven-day growth', fmtPct(row.change_7d)),
        eqRow('Growth multiplier', row.growth_multiplier),
        eqRow('Age with no token', fmtAge(row.age_days)),
        eqRow('Age bucket', ageBucketText(row)),
        eqRow('Value if it launches', fmtUsd(row.value_if_launches_usd)),
        eqRow('Launch odds', (row.launch_odds * 100).toFixed(1) + '%'),
        eqRow('Implied value (value x odds)', fmtUsd(row.implied_value_usd)),
        eqRow('Prediction band (P25–P75)', fmtUsd(row.band_low_usd) + ' – ' + fmtUsd(row.band_high_usd)),
        eqRow('Rank range at the band\u2019s ends', '#' + row.rank_best + '–#' + row.rank_worst)
      ),
      el('div', { class: 'derivation' }, derivationText(row)),
      whyHere(row),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model, DATA.curve)) + (impliedOf(row, DATA.model, DATA.curve) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    var econ = row.economics;
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm economics at $1,000' }),
      el('div', { class: 'equation' },
        eqRow('$1K slice', '$' + econ.slice_usd.toFixed(2)),
        eqRow('Slice at the band\u2019s low end', '$' + econ.slice_low_usd.toFixed(2)),
        eqRow('Gas fees', '$' + econ.fees_usd.toFixed(2)),
        eqRow('T-bill yield given up', '$' + econ.tbill_usd.toFixed(2)),
        eqRow('Net of all costs', fmtSigned(econ.net_usd), econ.net_usd >= 0 ? 'pos' : 'neg'),
        eqRow('Net at the band\u2019s low end', fmtSigned(econ.net_low_usd), econ.net_low_usd >= 0 ? 'pos' : 'neg'),
        eqRow('Net per hands-on hour', fmtSigned(econ.net_per_hour_usd) + '/h', econ.net_per_hour_usd >= 0 ? 'pos' : 'neg'),
        eqRow('Pays from', econ.pays_from_usd === null ? 'never' : '$' + econ.pays_from_usd),
        eqRow('Break-even implied value', fmtUsd(econ.breakeven_implied_usd))
      ),
      el('p', { class: 'why' },
        el('span', { class: 'verdict ' + verdictClass(econ.verdict), text: econ.verdict }),
        ' ' + (econ.verdict === 'ROBUST'
          ? 'This plan pays even if the launch is worth the band\u2019s low end: the verdict survives the model\u2019s own uncertainty.'
          : econ.verdict === 'FARM'
            ? 'This plan pays after every cost at the implied value, but not at the band\u2019s low end.'
            : econ.verdict === 'THIN'
              ? 'This plan beats its gas fees but not the 4% T-bill yield.'
              : 'This plan loses to its gas fees alone at $1,000' + (econ.pays_from_usd === null ? ', and no amount of capital changes that: the slice rate is below the T-bill rate.' : '.') )
      ),
      el('p', { class: 'sub', text: 'The slice is what $1,000 deposited would get if 10% of the launch goes to depositors pro rata. Hands-on time: ' + econ.hours + ' hours in total.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(accountingBar());
    if (state.tab === 'pre-token') shell.appendChild(topStrip());
    shell.appendChild(controls());
    if (state.tab === 'pre-token') {
      shell.appendChild(boardTable());
      shell.appendChild(backtestPanel());
      shell.appendChild(modelPanel());
    } else if (state.tab === 'live') {
      shell.appendChild(liveTable());
    } else if (state.tab === 'set-aside') {
      shell.appendChild(setAsideTable());
    } else {
      shell.appendChild(backtestPanel());
      shell.appendChild(modelPanel());
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
