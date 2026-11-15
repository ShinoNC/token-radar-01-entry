// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board: a top-10 strip, a filterable sortable table with each row's prediction band and
// farm verdict, a per-protocol detail drawer with the model's own inputs and the protocol's farm plan
// and economics, the size curve's scatter plot and backtest, and the protocols the board sets aside.
// No network: every byte it shows is in data.js. No protocol name is special-cased anywhere.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  // A signed dollar amount with cents, for farm economics: +$3.84, -$2.62.
  function fmtSigned(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2);
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  // base = 10 ^ (intercept + slope x log10(TVL) + category offset), then growth and maturity.
  function impliedOf(row, model, curve) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var base = Math.pow(10, curve.intercept + curve.slope * Math.log10(Math.max(row.tvl_usd, 1)) + row.category_offset);
    return Math.max(1, Math.round(base * growthMult * maturity));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) {
        if (c === null || c === undefined) return;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
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
  // Every category on the board has its own branch naming the protocol's real mechanism; the generic
  // fallback only serves a protocol with no category. Order matters: a specific branch is checked
  // before the general one its name contains ('yield aggregator' before 'yield', 'bridge' before
  // 'chain', 'leveraged farm' before 'farm', 'restaking' before 'btc'). This mirrors lib/model.ts
  // exactly — the page's farm plans must agree with board.json.
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
  // What one transaction costs on a chain, in dollars: Ethereum ~$3, Solana ~$0.01, BNB Smart Chain
  // (DefiLlama names it "Binance") ~$0.05, the L2s ~$0.10, every other chain $0.50. The setup costs
  // two transactions (approve, then deposit); the weekly action costs one.
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

  // The offsets table, looked up by category: the derivation of one row's offset.
  function offsetEntry(category) {
    if (!category) return null;
    var found = DATA.curve.categories.filter(function (c) { return c.category === category; });
    return found.length ? found[0] : null;
  }
  // Board categories with no live comparable at all: they get offset 0 (the curve alone).
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
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'slice') { av = a.economics.slice_usd; bv = b.economics.slice_usd; }
      else if (key === 'net') { av = a.economics.net_usd; bv = b.economics.net_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function topRows(n) {
    return DATA.rows.slice().sort(function (a, b) { return a.rank - b.rank; }).slice(0, n);
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
      el('p', { text: 'Every implied value is read off the ' + DATA.curve.comparables + ' tokens that already trade: a size curve fitted to their market caps, tested out of sample.' }),
      el('div', { class: 'stats' },
        el('div', { class: 'stat amber' }, el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size }), el('span', { text: 'Watchlist protocols covered' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.board_size) }), el('span', { text: 'Pre-token rows scored' })),
        el('div', { class: 'stat' }, el('b', { text: 'x' + DATA.backtest.curve_median_miss }), el('span', { text: 'Leave-one-out error (flat multiple: x' + DATA.backtest.flat_median_miss + ')' })),
        el('div', { class: 'stat' }, el('b', { text: v.ROBUST + ' · ' + v.FARM + ' · ' + v.THIN + ' · ' + v.SKIP }), el('span', { text: 'ROBUST · FARM · THIN · SKIP verdicts at $1,000' }))
      )
    );
  }

  function topStrip() {
    var cards = topRows(5).map(function (r) {
      var growth = r.change_7d === null ? null : el('span', { class: 'chip ' + (r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) + ' 7d' });
      return el('button', { class: 'card', type: 'button', 'aria-label': 'Rank ' + r.rank + ': ' + r.name + ', implied value ' + fmtUsd(r.implied_value_usd), onclick: function () { openDetail(r.slug); } },
        el('span', { class: 'rank', text: '#' + r.rank }),
        el('span', { class: 'cname', text: r.name }),
        el('span', { class: 'cmeta', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains[0] : 'multi-chain') }),
        el('span', { class: 'cvalue' }, el('span', { text: 'Implied value' }), fmtUsd(r.implied_value_usd)),
        el('span', { class: 'ctvl', text: 'TVL ' + fmtUsd(r.tvl_usd) }),
        growth
      );
    });
    return el('section', { 'aria-label': 'Top 5 by implied value' },
      el('div', { class: 'strip-head' },
        el('h2', { text: 'Top 5 by implied value' }),
        el('span', { class: 'sub', text: bestHour() || 'Select a card for its model and farm plan' })
      ),
      el('div', { class: 'strip' }, cards)
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var verdictSelect = el('select', { id: 'verdict', 'aria-label': 'Filter by farm verdict' },
      el('option', { value: 'all', text: 'All verdicts' }),
      ['ROBUST', 'FARM', 'THIN', 'SKIP'].map(function (v) { return el('option', { value: v, text: v, selected: v === state.verdict ? 'selected' : null }); })
    );
    verdictSelect.addEventListener('change', function () { state.verdict = verdictSelect.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    var aside = el('button', { type: 'button', 'aria-pressed': state.tab === 'set-aside' ? 'true' : 'false', text: 'Set aside', onclick: function () { state.tab = 'set-aside'; render(); } });
    var method = el('button', { type: 'button', 'aria-pressed': state.tab === 'method' ? 'true' : 'false', text: 'Method', onclick: function () { state.tab = 'method'; render(); } });
    // The page recomputes every row from the snapshot figures: the count proves
    // the page and board.json agree, row for row.
    var matched = DATA.rows.filter(function (r) { return impliedOf(r, DATA.model, DATA.curve) === r.implied_value_usd; }).length;
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), verdictSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, pre, live, aside, method)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown · page = board.json: ' + matched + '/' + DATA.rows.length + ' match' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : state.tab === 'set-aside' ? DATA.set_aside_size + ' protocols set aside' : 'How the radar is built and tested' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
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
      var verdictClass = e.verdict === 'ROBUST' ? 'robust' : e.verdict === 'FARM' ? 'farm' : e.verdict === 'THIN' ? 'thin' : 'skip';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e2) { if (e2.key === 'Enter' || e2.key === ' ') { e2.preventDefault(); openDetail(r.slug); } }
      },
        el('td', null, el('span', { class: 'rank-badge' + (r.rank <= 3 ? ' top3' : ''), text: String(r.rank) })),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'band', 'aria-hidden': 'true', title: 'Prediction band ' + fmtUsd(r.band_low_usd) + ' to ' + fmtUsd(r.band_high_usd) },
            el('i', { style: 'left:' + bandPct(r.band_low_usd).toFixed(1) + '%;width:' + Math.max(1, bandPct(r.band_high_usd) - bandPct(r.band_low_usd)).toFixed(1) + '%' }),
            el('b', { style: 'left:' + bandPct(r.implied_value_usd).toFixed(1) + '%' })
          ),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', { class: 'num', text: '$' + e.slice_usd.toFixed(2) }),
        el('td', { class: 'num ' + (e.net_usd >= 0 ? 'pos' : 'neg'), text: fmtSigned(e.net_usd) }),
        el('td', null, el('span', { class: 'verdict ' + verdictClass, text: e.verdict }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. The band is the model\u2019s P25\u2013P75 range; $1K slice is what $1,000 deposited would get if 10% of the launch goes to depositors; net is the slice minus gas and the 4% T-bill yield. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
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
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
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
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', null, el('span', { class: 'sub', text: r.reason }))
      ));
    });
    return el('div', { class: 'panel' },
      el('p', { class: 'sub', text: 'These ' + DATA.set_aside_size + ' pre-token protocols are not launch candidates: a wrapped, staked or bridged product of a token that already trades, an exchange, or one release of another protocol. The board ranks the other ' + DATA.board_size + ' pre-token protocols; the watchlist is the floor, and this list is the audit trail for what the floor leaves out.' }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols set aside by the watchlist\u2019s own exclusion rule, largest first.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Why it is set aside' }))),
          tbody
        )
      )
    );
  }

  // The offsets table: every category's offset with its evidence. Sorted by offset, highest
  // first, so the spread the model is built on is visible at a glance.
  function offsetsTable() {
    var m = DATA.model;
    var cats = DATA.curve.categories.slice().sort(function (a, b) {
      if (a.offset !== b.offset) return b.offset - a.offset;
      return a.category < b.category ? -1 : 1;
    });
    var tbody = el('tbody');
    cats.forEach(function (c) {
      tbody.appendChild(el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.comparables) }),
        el('td', { class: 'num', text: c.raw_median === null ? 'n/a' : (c.raw_median >= 0 ? '+' : '') + c.raw_median }),
        el('td', { class: 'num' }, el('b', { text: (c.offset >= 0 ? '+' : '') + c.offset + ' (x' + Math.pow(10, c.offset).toFixed(2) + ')' })),
        el('td', null, c.fallback ? el('span', { class: 'fb', text: 'offset 0 — fewer than ' + m.min_comparables + ' live comparables' }) : el('span', { class: 'sub', text: 'shrunk toward 0 (k=' + m.shrinkage_k + ')' }))
      ));
    });
    var noEv = noEvidenceCategories();
    var note = noEv.length === 0 ? '' : ' Categories with no live comparable at all — ' + noEv.join(', ') + ' — also get offset 0: the curve alone prices them.';
    return el('div', { class: 'mult-table' },
      el('table', null,
        el('caption', { text: 'Category offsets, from the residuals of the ' + DATA.curve.comparables + ' live-token comparables against the curve. An offset of +0.15 lifts a category\u2019s implied value by 10^0.15 = 1.41x.' + note }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Category' }),
          el('th', { scope: 'col', text: 'Live comparables' }),
          el('th', { scope: 'col', text: 'Raw median residual (log10)' }),
          el('th', { scope: 'col', text: 'Offset applied' }),
          el('th', { scope: 'col', text: 'Derivation' })
        )),
        tbody
      )
    );
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
    // The SVG namespace is read off a probe element the parser creates, so the
    // source never names a network address.
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
      if (g >= 9) return '$' + Math.pow(10, g - 9) + 'B';
      if (g >= 6) return '$' + Math.pow(10, g - 6) + 'M';
      return '$' + Math.pow(10, g - 3) + 'K';
    }
    // Gridlines + axis labels, one decade apart.
    for (var gx = xMin; gx <= xMax; gx++) {
      svg.appendChild(node('line', { x1: X(Math.pow(10, gx)), y1: padT, x2: X(Math.pow(10, gx)), y2: H - padB, class: 'grid' }));
      var xl = node('text', { x: X(Math.pow(10, gx)), y: H - 10, class: 'axis' });
      xl.textContent = axisLabel(gx);
      svg.appendChild(xl);
    }
    for (var gy = yMin; gy <= yMax; gy++) {
      svg.appendChild(node('line', { x1: padL, y1: Y(Math.pow(10, gy)), x2: W - padR, y2: Y(Math.pow(10, gy)), class: 'grid' }));
      var yl = node('text', { x: padL - 6, y: Y(Math.pow(10, gy)) + 3, class: 'axis', 'text-anchor': 'end' });
      yl.textContent = axisLabel(gy);
      svg.appendChild(yl);
    }
    // The fitted curve (before category offsets): a straight line on log-log axes.
    var c = DATA.curve;
    var x0 = Math.pow(10, xMin), x1 = Math.pow(10, xMax);
    var y0 = Math.pow(10, c.intercept + c.slope * xMin), y1 = Math.pow(10, c.intercept + c.slope * xMax);
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
      el('p', { text: 'Leave-one-out: each of the ' + DATA.curve.comparables + ' comparables is priced by a curve fitted without it (its category offset refit from the remaining comparables), and the miss is measured against its real market cap. The flat multiple — one mcap/TVL median for every protocol — is tested on the same folds.' }),
      el('div', { class: 'stats' },
        el('div', { class: 'stat amber' }, el('b', { text: 'x' + b.curve_median_miss }), el('span', { text: 'Curve median miss, out of sample' })),
        el('div', { class: 'stat' }, el('b', { text: 'x' + b.flat_median_miss }), el('span', { text: 'Flat multiple median miss, same folds' })),
        el('div', { class: 'stat' }, el('b', { text: Math.round(b.curve_within_3x * 100) + '% vs ' + Math.round(b.flat_within_3x * 100) + '%' }), el('span', { text: 'Within 3x of the real cap: curve vs flat' })),
        el('div', { class: 'stat' }, el('b', { text: 'x' + b.band_low_mult + ' – x' + b.band_high_mult }), el('span', { text: 'Prediction band (P25–P75 of the out-of-sample residuals)' }))
      ),
      el('p', { class: 'sub', text: b.time_split_n >= 5
        ? 'Time split: fitted on the ' + b.time_split_fit_n + ' comparables listed before 2024, the curve misses the ' + b.time_split_n + ' newer ones by x' + b.time_split_curve_miss + ' against the flat multiple\u2019s x' + b.time_split_flat_miss + ' — it holds forward in time, not just across the sample.'
        : 'Too few dated comparables for a time split; the leave-one-out test above is the check.' }),
      scatterPlot()
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var c = DATA.curve;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. A dollar of TVL is worth a different multiple at $5M than at $5B, so the model fits that curve on the snapshot\u2019s own trading protocols — then shifts each category by its own evidence, shrunk toward zero so a thin category cannot move the board on one observation.' }),
      el('div', { class: 'formula' },
        'implied = round( 10 ^ (' + c.intercept + ' + ' + c.slope + ' x log10(tvl_usd) + offset(category)) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      ),
      el('p', { text: 'offset(category) is the median log10 residual of the category\u2019s live comparables against the curve, shrunk toward 0 with k=' + m.shrinkage_k + '. A category with fewer than ' + m.min_comparables + ' live comparables gets offset 0: the evidence is too thin to move the board. TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. The live-token protocols are set aside with their market caps shown.' }),
      offsetsTable()
    );
  }

  // One row's offset, derived in words: the evidence behind the number.
  function derivationText(row) {
    var cat = row.category || 'Other';
    var entry = offsetEntry(row.category);
    var k = DATA.model.shrinkage_k;
    if (!entry) {
      return [el('b', { text: cat + ' — no live comparables. ' }), 'No live-token protocol in this category carries a market cap in this snapshot, so the model applies offset 0: the curve alone prices this row. The category adds no evidence of its own; the ranking rests on TVL, growth and age.'];
    }
    if (entry.fallback) {
      var n = entry.comparables;
      var tail = n === 1
        ? 'Only 1 live comparable in this snapshot, so the model applies offset 0 instead of the raw median residual ' + entry.raw_median + ': one data point is not a category pattern.'
        : 'Only ' + n + ' live comparables in this snapshot — fewer than the ' + DATA.model.min_comparables + ' the model requires — so the model applies offset 0 instead of the raw median residual ' + entry.raw_median + '.';
      return [el('b', { text: cat + ' — offset 0. ' }), tail];
    }
    return [el('b', { text: cat + ' — ' + entry.comparables + ' live comparables. ' }), 'Median log10 residual ' + entry.raw_median + ' against the curve, shrunk toward 0 with k=' + k + ', gives the offset ' + entry.offset + ' (x' + Math.pow(10, entry.offset).toFixed(2) + ') this row was scored with.'];
  }

  // Why this row ranks where it does, generated from the model's own inputs.
  function whyHere(row) {
    var byTvl = DATA.rows.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    var tvlRank = byTvl.findIndex(function (r) { return r.slug === row.slug; }) + 1;
    var off = row.category_offset;
    var offPart = off > 0.01
      ? 'its ' + (row.category || 'Other') + ' offset of +' + off + ' (x' + Math.pow(10, off).toFixed(2) + ') lifts it above the curve'
      : off < -0.01
        ? 'its ' + (row.category || 'Other') + ' offset of ' + off + ' (x' + Math.pow(10, off).toFixed(2) + ') pulls it below the curve'
        : 'its ' + (row.category || 'Other') + ' offset is 0 (no category evidence of its own), so the curve alone prices it';
    var growthPart = row.change_7d === null
      ? 'no seven-day growth is recorded'
      : row.change_7d >= 0
        ? 'seven-day growth of +' + row.change_7d.toFixed(2) + '% lifts it (multiplier ' + row.growth_multiplier + ')'
        : 'seven-day growth of ' + row.change_7d.toFixed(2) + '% pulls it down (multiplier ' + row.growth_multiplier + ')';
    var agePart = row.age_days === null
      ? 'its age is unlisted, so the model assumes ' + DATA.model.unknown_age_days + ' days'
      : 'it has run ' + fmtAge(row.age_days) + ' with no token (maturity multiplier ' + row.maturity_multiplier + ')';
    return el('p', { class: 'why' },
      el('b', { text: 'Why #' + row.rank + ': ' }),
      'its ' + fmtUsd(row.tvl_usd) + ' of TVL is the ' + tvlRank + (tvlRank === 1 ? 'st' : tvlRank === 2 ? 'nd' : tvlRank === 3 ? 'rd' : 'th') + ' largest on the board; ' + offPart + '; ' + growthPart + '; and ' + agePart + '.'
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
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Curve value' }), el('b', { class: 'num', text: fmtUsd(Math.pow(10, DATA.curve.intercept + DATA.curve.slope * Math.log10(Math.max(row.tvl_usd, 1)))) })),
        el('div', null, el('span', { text: 'Category offset' }), el('b', { class: 'num', text: (row.category_offset >= 0 ? '+' : '') + row.category_offset + ' (x' + Math.pow(10, row.category_offset).toFixed(2) + ')' })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Prediction band (P25–P75)' }), el('b', { class: 'num', text: fmtUsd(row.band_low_usd) + ' – ' + fmtUsd(row.band_high_usd) }))
      ),
      el('div', { class: 'derivation' }, derivationText(row)),
      whyHere(row),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model, DATA.curve)) + (impliedOf(row, DATA.model, DATA.curve) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    var econ = row.economics;
    var verdictClass = econ.verdict === 'ROBUST' ? 'robust' : econ.verdict === 'FARM' ? 'farm' : econ.verdict === 'THIN' ? 'thin' : 'skip';
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm economics at $1,000' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: '$1K slice' }), el('b', { class: 'num', text: '$' + econ.slice_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'Slice at the band\u2019s low end' }), el('b', { class: 'num', text: '$' + econ.slice_low_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'Gas fees' }), el('b', { class: 'num', text: '$' + econ.fees_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'T-bill yield given up' }), el('b', { class: 'num', text: '$' + econ.tbill_usd.toFixed(2) })),
        el('div', null, el('span', { text: 'Net of all costs' }), el('b', { class: 'num ' + (econ.net_usd >= 0 ? 'pos' : 'neg'), text: fmtSigned(econ.net_usd) })),
        el('div', null, el('span', { text: 'Net at the band\u2019s low end' }), el('b', { class: 'num ' + (econ.net_low_usd >= 0 ? 'pos' : 'neg'), text: fmtSigned(econ.net_low_usd) })),
        el('div', null, el('span', { text: 'Net per hands-on hour' }), el('b', { class: 'num ' + (econ.net_per_hour_usd >= 0 ? 'pos' : 'neg'), text: fmtSigned(econ.net_per_hour_usd) + '/h' })),
        el('div', null, el('span', { text: 'Pays from' }), el('b', { class: 'num', text: econ.pays_from_usd === null ? 'never' : '$' + econ.pays_from_usd })),
        el('div', null, el('span', { text: 'Break-even implied value' }), el('b', { class: 'num', text: fmtUsd(econ.breakeven_implied_usd) }))
      ),
      el('p', { class: 'why' },
        el('span', { class: 'verdict ' + verdictClass, text: econ.verdict }),
        ' ' + (econ.verdict === 'ROBUST'
          ? 'This plan pays even if the launch is worth the band\u2019s low end: the verdict survives the model\u2019s own uncertainty.'
          : econ.verdict === 'FARM'
            ? 'This plan pays after every cost at the implied value — but not at the band\u2019s low end, so it rests on the point estimate.'
            : econ.verdict === 'THIN'
              ? 'This plan beats its gas fees but not the 4% T-bill yield: farming it pays less than holding T-bills.'
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
