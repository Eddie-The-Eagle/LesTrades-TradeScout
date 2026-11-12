// ==UserScript==
// @name         Lestrades Trade Scout
// @namespace    https://lestrades.com/
// @author       eddie-the-eagle
// @version      1.04
// @description  Ratio from your POV (get ÷ give), sorted closest to 1. 1:2 / 1:3 groups with best combos and live ratio. Unpriced items listed for custom prices. Non-game items (keys etc.) get their own Item Trades section: any ratio, adjustable quantity, optional extra game. Open Scan matches all games without selecting any. Game names link to the Steam store. 1:1 trades grouped by shared game. 2:1 / 3:1 work exactly like 1:2 / 1:3. Item amounts (x4) read from Lestrade's. Item Trades: pick a quantity, see the games in your ratio. Tick several non-clashing 1:1 trades for one combined offer, or Auto-pick the best of each group. gg.deals link and a ✎ price editor next to every game. Preview sets up one offer and clicks Preview offer. Match Radar on /matches/ pages: ranks every trader by their best trade in your ratio, finds what your keys/items can get across all traders, loads full lists, and Prepare offer opens the offer page with the trade ticked. Fetched trader lists are cached for 30 minutes (IndexedDB) and loading backs off when the server asks to slow down.
// @match        https://lestrades.com/*
// @match        https://www.lestrades.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    console.log("[Trade Scout] Script initialized (v1.03).");

    // =====================================================================
    // Shared helpers
    // =====================================================================

    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const byId = id => document.getElementById(id);
    // Stable key of a game/item entry (used for grouping and de-duplication)
    const rowKey = g => g.baseId ?? g.id ?? g.title;

    // Lestrade's own stylesheet hides plain <select> boxes (it swaps them for its custom dropdowns),
    // centres text and restyles checkboxes. Undo that inside our panel and results window only.
    const ST_CSS = `
        #smart-trade-panel, #st-trade-modal { text-align: left !important; line-height: 1.35; }
        #smart-trade-panel *, #st-trade-modal * { box-sizing: border-box; text-align: inherit; }
        #smart-trade-panel select, #st-trade-modal select {
            display: inline-block !important; visibility: visible !important; opacity: 1 !important;
            position: static !important; height: auto !important; min-height: 24px;
            -webkit-appearance: menulist !important; appearance: auto !important;
            background: #1a1a2b !important; color: #fff !important; border: 1px solid #555 !important;
            border-radius: 4px; padding: 3px 4px; font-size: 12px; max-width: 100%;
        }
        #smart-trade-panel select { display: block !important; width: 100% !important; }
        #smart-trade-panel select option, #st-trade-modal select option { background: #1a1a2b; color: #fff; }
        #smart-trade-panel input[type="checkbox"], #st-trade-modal input[type="checkbox"] {
            display: inline-block !important; visibility: visible !important; opacity: 1 !important;
            position: relative !important; -webkit-appearance: checkbox !important; appearance: auto !important;
            width: 15px !important; height: 15px !important; margin: 0 4px 0 0; flex: none;
        }
        #smart-trade-panel input[type="number"], #st-trade-modal input[type="number"] {
            display: inline-block !important; visibility: visible !important;
        }
        #st-trade-modal label { display: flex; }
        /* Lestrade's stylesheet draws its own checkmarks with ::before/::after; those escape to the corner of our window */
        #smart-trade-panel *::before, #smart-trade-panel *::after,
        #st-trade-modal *::before, #st-trade-modal *::after { content: none !important; display: none !important; }
        #st-trade-modal .st-inline-label { display: inline-flex !important; align-items: center; gap: 4px; }
    `;
    if (typeof GM_addStyle === 'function') {
        GM_addStyle(ST_CSS);
    } else {
        const style = document.createElement('style');
        style.textContent = ST_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    let customPrices = GM_getValue('st_custom_prices', {});
    let matchedTradeQueue = [];
    let tradeMap = new Map();      // trade id -> trade
    let renderedCards = new Map(); // cardId -> 1:N card data (for live ratio + execution)
    const gamesOnly = () => !!byId('st-games-only')?.checked;
    let itemTradeCards = [];       // non-game item trades found by the last scan
    let itemCardMap = new Map();   // item card id -> card

    function createControlPanel() {
        if (byId('smart-trade-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'smart-trade-panel';
        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 2147483647;
            width: 320px;
            background: #1e1e2f;
            color: #fff;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.8);
            font-family: sans-serif;
            font-size: 12px;
            border: 1px solid #555;
        `;

        panel.innerHTML = `
            <h3 style="margin: 0 0 10px 0; font-size: 14px; color: #4e9af1;">🔭 Trade Scout</h3>

            <label style="display: block; margin-bottom: 3px; font-weight: bold;">Match Direction:</label>
            <select id="st-direction" style="display: block; width: 100%; padding: 6px; margin-bottom: 10px; background: #2a2a40; border: 1px solid #777; color: #fff; border-radius: 4px; font-size: 12px;">
                <option value="my_to_theirs">Match My Game(s) ➔ Their Games</option>
                <option value="their_to_mine">Match Their Game(s) ➔ My Games</option>
            </select>

            <label style="display: block; margin-bottom: 3px; font-weight: bold;" id="st-select-label">Select Game (or leave blank for multi-checked):</label>
            <select id="st-game-select" style="display: block; width: 100%; padding: 6px; margin-bottom: 10px; background: #2a2a40; border: 1px solid #777; color: #fff; border-radius: 4px; font-size: 12px;">
                <option value="">-- Leave blank to use all checked games --</option>
            </select>

            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <div style="flex: 1;">
                    <label style="display: block; margin-bottom: 2px;" title="Ratio = what you get ÷ what you give. Above 1 = you receive more value than you give.">Min Ratio (get÷give):</label>
                    <input type="number" id="st-min-ratio" value="0.7" step="0.05" style="width: 100%; padding: 5px; background: #2a2a40; border: 1px solid #444; color: #fff; border-radius: 4px;">
                </div>
                <div style="flex: 1;">
                    <label style="display: block; margin-bottom: 2px;" title="Ratio = what you get ÷ what you give. Above 1 = you receive more value than you give.">Max Ratio (get÷give):</label>
                    <input type="number" id="st-max-ratio" value="1.3" step="0.05" style="width: 100%; padding: 5px; background: #2a2a40; border: 1px solid #444; color: #fff; border-radius: 4px;">
                </div>
            </div>

            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <div style="flex: 1;">
                    <label style="display: block; margin-bottom: 2px;" title="How many of their games can go into one trade (1–3). 3 enables 1:3 trades.">Max Their Games:</label>
                    <input type="number" id="st-max-their" value="2" min="1" max="3" step="1" style="width: 100%; padding: 5px; background: #2a2a40; border: 1px solid #444; color: #fff; border-radius: 4px;">
                </div>
                <label style="flex: 1; display: flex; align-items: center; gap: 5px; cursor: pointer; padding-top: 14px;" title="Leave out keys and other non-game items: no Item Trades section"><input type="checkbox" id="st-games-only"> Games only</label>
            </div>

            <div style="margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                    <label style="font-weight: bold;" title="Items without a price on the page are listed here automatically. Type a price and it saves straight away.">Custom Prices:</label>
                    <span style="display: flex; align-items: center; gap: 6px;">
                        <label style="font-size: 11px; color: #aaa; cursor: pointer;" title="Also list items that already have a price, so you can override them"><input type="checkbox" id="st-show-all-prices" style="vertical-align: middle;"> All items</label>
                        <button id="st-refresh-prices" title="Re-read the items on the page" style="padding: 2px 6px; background: #555; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">↻</button>
                    </span>
                </div>
                <div id="st-price-list" style="max-height: 180px; overflow-y: auto; background: #2a2a40; border: 1px solid #444; border-radius: 4px; padding: 4px;"></div>
            </div>

            <div style="display: flex; gap: 6px;">
                <button id="st-scan-btn" title="Match the game you picked (or ticked) against the other side" style="flex: 1; padding: 9px; background: #4e9af1; color: #fff; border: none; font-weight: bold; border-radius: 4px; cursor: pointer;">🔍 Scan Trades</button>
                <button id="st-open-scan-btn" title="Match ALL your games against ALL their games. No selection needed." style="flex: 1; padding: 9px; background: #6c5ce7; color: #fff; border: none; font-weight: bold; border-radius: 4px; cursor: pointer;">🌐 Open Scan</button>
            </div>
            <div id="st-status" style="margin-top: 8px; font-style: italic; color: #aaa; text-align: center;">Ready to scan.</div>
        `;

        document.body.appendChild(panel);
        populateDropdowns();
        renderPriceList();

        byId('st-direction').addEventListener('change', populateDropdowns);
        byId('st-refresh-prices').addEventListener('click', () => { resetRowCaches(); renderPriceList(); populateDropdowns(); });
        byId('st-show-all-prices').addEventListener('change', renderPriceList);
        byId('st-price-list').addEventListener('change', onPriceInputChange);
        byId('st-scan-btn').addEventListener('click', scanPageAndOpenModal);
        byId('st-open-scan-btn').addEventListener('click', openScanAndOpenModal);
        const go = byId('st-games-only');
        go.checked = !!GM_getValue('st_games_only', false);
        go.addEventListener('change', () => GM_setValue('st_games_only', go.checked));
        afterPriceEdit = rerunLastScan;
    }

    // ---------- Custom prices ----------

    let priceRows = []; // rows currently shown in the Custom Prices list

    function normTitle(t) {
        return (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    // Normalised lookup map, rebuilt only after a price changes
    let priceMap = null;
    const buildPriceMap = () => (priceMap = new Map(Object.entries(customPrices).map(([k, v]) => [normTitle(k), v])));

    // Exact (case-insensitive) title match only, so a price for "Half-Life 2"
    // never leaks onto "Half-Life 2: Episode One"
    function getCustomPrice(title) {
        const t = normTitle(title);
        if (!t) return null;
        const v = (priceMap || buildPriceMap()).get(t);
        return v === undefined ? null : v;
    }

    // Sets (number) or removes (null) the custom price for a title and saves it
    function setCustomPrice(title, val) {
        const t = normTitle(title);
        Object.keys(customPrices).forEach(k => { if (normTitle(k) === t) delete customPrices[k]; });
        if (val !== null) customPrices[title] = val;
        priceMap = null;
        GM_setValue('st_custom_prices', customPrices);
    }

    function renderPriceList() {
        const box = byId('st-price-list');
        if (!box) return;
        const showAll = byId('st-show-all-prices')?.checked;

        const seen = new Map();
        [[true, 'You'], [false, 'Them']].forEach(([isMySide, sideLabel]) => {
            getSideElements(isMySide).forEach(el => {
                const title = getCleanTitle(el);
                if (!title) return;
                const key = normTitle(title);
                const sitePrice = getSitePrice(el);
                const game = isGameElement(el);
                const amount = getAmount(el);
                if (seen.has(key)) {
                    const row = seen.get(key);
                    if (!row.sides.includes(sideLabel)) row.sides.push(sideLabel);
                    row.sitePrice = row.sitePrice || sitePrice;
                    row.isGame = row.isGame || game;
                    row.amount = Math.max(row.amount, amount);
                    return;
                }
                seen.set(key, { title, sitePrice, sides: [sideLabel], isGame: game, amount });
            });
        });

        priceRows = [...seen.values()]
            .map(r => ({ ...r, custom: getCustomPrice(r.title) }))
            // Always listed: unpriced items, custom prices, and non-game items (for the multi option)
            .filter(r => showAll || r.sitePrice <= 0 || r.custom !== null || !r.isGame)
            // Unpriced without a custom price first, then alphabetical
            .sort((a, b) => {
                const aNeed = a.sitePrice <= 0 && a.custom === null;
                const bNeed = b.sitePrice <= 0 && b.custom === null;
                if (aNeed !== bNeed) return aNeed ? -1 : 1;
                return a.title.localeCompare(b.title);
            });

        if (priceRows.length === 0) {
            box.innerHTML = '<div style="color: #888; font-style: italic; padding: 4px;">Every game on this page has a price. Tick "All items" to override one.</div>';
            return;
        }

        const missing = priceRows.filter(r => r.sitePrice <= 0 && r.custom === null).length;
        box.innerHTML = (missing ? `<div style="color: #f39c12; font-size: 11px; padding: 2px 4px 4px;">${missing} item${missing > 1 ? 's' : ''} without a price (skipped when scanning until you set one)</div>` : '') +
            priceRows.map((r, i) => {
                const needs = r.sitePrice <= 0 && r.custom === null;
                const placeholder = r.sitePrice > 0 ? `site $${r.sitePrice.toFixed(2)}` : 'no price';
                const value = r.custom !== null ? r.custom.toFixed(2) : '';
                return `<div style="display: flex; align-items: center; gap: 5px; padding: 3px 4px; border-bottom: 1px solid #333;">
                    <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${needs ? '#f39c12' : '#fff'};" title="${esc(r.title)}">${esc(r.title)}</span>
                    ${r.amount > 1 ? `<span style="font-size: 10px; color: #4e9af1;" title="Amount available">×${r.amount}</span>` : ''}
                    <span style="font-size: 10px; color: #888;">${r.sides.join('/')}</span>
                    <input type="number" class="st-price-input" data-row="${i}" value="${value}" placeholder="${placeholder}" min="0" step="0.10" style="width: 72px; padding: 3px; background: #1e1e2f; border: 1px solid ${needs ? '#f39c12' : '#444'}; color: #fff; border-radius: 3px;">
                </div>`;
            }).join('');
    }

    // Saves as soon as a price is typed (on change/Enter); clearing the box removes the custom price
    function onPriceInputChange(e) {
        if (!e.target.classList.contains('st-price-input')) return;
        const row = priceRows[+e.target.dataset.row];
        if (!row) return;

        const raw = e.target.value.trim();
        const status = byId('st-status');
        let val = null;
        if (raw !== '') {
            val = parseFloat(raw);
            if (isNaN(val) || val < 0) {
                alert("Please enter a valid price (0 or higher).");
                return;
            }
        }
        setCustomPrice(row.title, val);
        if (status) status.innerText = val !== null ? `Saved: ${row.title} = $${val.toFixed(2)}` : `Removed custom price for ${row.title}`;

        populateDropdowns();
        renderPriceList();
    }

    function getRatioLimits() {
        return {
            min: parseFloat(byId('st-min-ratio')?.value) || 0.7,
            max: parseFloat(byId('st-max-ratio')?.value) || 1.3
        };
    }

    // How far a ratio is from a perfectly even trade (1.00); used for sorting
    function closeness(ratio) {
        return Math.abs(parseFloat(ratio) - 1);
    }

    // Titles are stable for a row, so they are computed once (cleared on ↻ and at the start of every scan)
    let titleCache = new WeakMap();
    function resetRowCaches() { titleCache = new WeakMap(); appIdCache.t = 0; qtyMap.t = 0; }
    function getCleanTitle(el) {
        let t = titleCache.get(el);
        if (t === undefined) {
            t = computeCleanTitle(el);
            titleCache.set(el, t);
        }
        return t;
    }

    function computeCleanTitle(el) {
        let text = "";

        const c999 = el.querySelector('.c999');
        if (c999) {
            const clone = c999.cloneNode(true);
            clone.querySelectorAll('a, table, span.store, span.cred, i, br, div').forEach(node => node.remove());
            text = clone.textContent.trim();
        }

        if (!text || text.length < 2) {
            const gdata = el.querySelector('.gdata');
            if (gdata) {
                const strong = gdata.querySelector('strong');
                text = strong ? strong.innerText : gdata.innerText;
            } else {
                const label = el.querySelector('label') || el;
                const clone = label.cloneNode(true);
                clone.querySelectorAll('a, table, span, input, br, i, div').forEach(node => node.remove());
                text = clone.textContent.trim();
            }
        }

        if (!text || text.length < 2) {
            const link = el.querySelector('a[href*="/game/"]');
            if (link) text = link.innerText.trim();
        }

        return text.replace(/[↗★⇄]/g, '').replace(/\s*\d+\.\d+\s*$/, '').replace(/\(\s*\)/g, '').trim();
    }

    // Price shown on the page itself (data-rv or data-gg), ignoring custom prices
    function getSitePrice(el) {
        const rv = el.getAttribute('data-rv');
        if (rv) {
            const cents = parseInt(rv, 10);
            if (!isNaN(cents) && cents > 0) return cents / 100;
        }

        const link = el.querySelector('a[data-gg]');
        if (link) {
            const gg = link.getAttribute('data-gg');
            const parts = gg.split(',');
            if (parts.length > 0) {
                const cents = parseInt(parts[0], 10);
                if (!isNaN(cents) && cents > 0) return cents / 100;
            }
        }
        return 0;
    }

    // Custom price wins over the site price
    function getPriceFromElement(el) {
        const custom = getCustomPrice(getCleanTitle(el));
        if (custom !== null) return custom;
        return getSitePrice(el);
    }

    // A row is a game if it links to a game/app page; anything else (TF2 keys, gems, gift cards…) is an item
    // On Lestrade's every real game's ↗ link carries data-appid / data-gg; items such as
    // "TF2 key" link to /game/… too but have neither, and show their amount as <span class="qs">x4</span>.
    const appIdCache = { t: 0, v: false };
    function pageHasAppIds() {
        if (Date.now() - appIdCache.t > 2000) {
            appIdCache.t = Date.now();
            appIdCache.v = !!document.querySelector('#new-offer [data-appid], .tradside [data-appid], .wishside [data-appid]');
        }
        return appIdCache.v;
    }
    function isGameElement(el) {
        if (el.querySelector('[data-appid], a[data-gg], a[href*="store.steampowered.com/"]')) return true;
        if (el.querySelector('.qs')) return false;
        if (pageHasAppIds()) return false;
        // Other layouts: fall back to "has a game link and no amount box"
        if (el.querySelector('a[href*="/game/"], a[href*="/app/"]')) return true;
        return !el.querySelector('input[type="number"], select');
    }

    // The amount field for a row: one inside the row, or Lestrade's form field amount[ID] / dol[ID]
    // (ID = the row's checkbox value), which the site adds once the item is ticked.
    // The form's amount[ID] / dol[ID] fields are indexed once (searching the whole form for every row was quadratic).
    // The index is short-lived because the site adds a field when a row is ticked; code that ticks rows resets it.
    const qtyMap = { t: 0, form: null, map: null };
    function qtyFieldFor(form, id) {
        const now = Date.now();
        if (qtyMap.form !== form || !qtyMap.map || now - qtyMap.t > 1000) {
            const map = new Map();
            form.querySelectorAll('[name^="amount["], [name^="dol["]').forEach(f => {
                if (f.classList.contains('st-amount')) return;
                const m = /^(?:amount|dol)\[(.*)\]$/.exec(f.name);
                if (m && !map.has(m[1])) map.set(m[1], f);
            });
            qtyMap.form = form; qtyMap.map = map; qtyMap.t = now;
        }
        return qtyMap.map.get(id) || null;
    }
    function getQtyControl(el) {
        const own = el.querySelector('input[type="number"], select');
        if (own) return own;
        const id = getRowCheckbox(el)?.value;
        if (!id) return null;
        return qtyFieldFor(el.closest('form') || document, id);
    }

    // How many of this item are available
    function getAmount(el) {
        // Lestrade's shows the amount as <span class="qs">x4</span>
        const qs = el.querySelector('.qs');
        if (qs) {
            const m = qs.textContent.match(/(\d+)/);
            if (m && +m[1] > 0) return +m[1];
        }
        const ctrl = getQtyControl(el);
        if (ctrl) {
            if (ctrl.tagName === 'SELECT') {
                const nums = [...ctrl.options].map(o => parseInt(o.value || o.textContent, 10)).filter(n => !isNaN(n));
                if (nums.length) return Math.max(1, ...nums);
            } else {
                const max = parseInt(ctrl.getAttribute('max'), 10);
                if (!isNaN(max) && max > 0) return max;
            }
        }
        const text = (el.textContent || '').replace(/\s+/g, ' ');
        const m = text.match(/(?:^|[^a-z0-9])[x×]\s?(\d{1,4})\b/i) ||
                  text.match(/\b(\d{1,4})\s?[x×](?:\s|$)/i) ||
                  text.match(/\b(?:qty|quantity|amount|count)\s*[:=]?\s*(\d{1,4})\b/i);
        const n = m ? parseInt(m[1], 10) : 1;
        return n > 0 ? n : 1;
    }

    // Steam store link for a row: a store link on the page, else an app/sub id found in any link,
    // data attribute or Steam image on the row. Null if none (we fall back to a Steam search).
    function getSteamUrl(el) {
        const store = el.querySelector('a[href*="store.steampowered.com/app/"], a[href*="store.steampowered.com/sub/"]');
        if (store) return store.href;
        for (const a of el.querySelectorAll('a[href]')) {
            const m = a.href.match(/\/(app|sub|bundle)\/(\d+)/);
            if (m) return `https://store.steampowered.com/${m[1]}/${m[2]}/`;
        }
        const idEl = el.matches('[data-appid]') ? el : el.querySelector('[data-appid]');
        if (idEl && /^\d+$/.test(idEl.getAttribute('data-appid'))) return `https://store.steampowered.com/app/${idEl.getAttribute('data-appid')}/`;
        for (const img of el.querySelectorAll('img[src]')) {
            const m = img.src.match(/\/(apps|subs)\/(\d+)\//);
            if (m) return `https://store.steampowered.com/${m[1] === 'apps' ? 'app' : 'sub'}/${m[2]}/`;
        }
        return null;
    }

    function steamUrlFor(g) {
        return g.steamUrl || `https://store.steampowered.com/search/?term=${encodeURIComponent(g.title)}`;
    }

    // Game name that opens its Steam page in a new tab (styled like the surrounding text)
    function gameLink(g) {
        const exact = !!g.steamUrl;
        const lt = !exact && g.lestradesUrl ? ` data-lt="${esc(g.lestradesUrl)}"` : '';
        return `<a href="${esc(steamUrlFor(g))}"${lt} data-exact="${exact ? 1 : 0}" target="_blank" rel="noopener noreferrer" class="st-steam" title="Open on Steam (new tab)" style="color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; cursor: pointer;">${esc(g.title)}</a>${ggLink(g)}`;
    }

    // ---- GG.deals link: exact page when the site gives us the slug, otherwise looked up from the game's Lestrade's page ----
    const ggLookup = GM_getValue('st_gg_lookup', {});
    function ggLink(g) {
        if (!g || g.isGame === false) return '';
        const cached = g.lestradesUrl && ggLookup[g.lestradesUrl];
        const href = g.ggu ? `https://gg.deals/game/${g.ggu}/` : cached || `https://gg.deals/games/?title=${encodeURIComponent(g.title)}`;
        const lt = !g.ggu && !cached && g.lestradesUrl ? ` data-lt="${esc(g.lestradesUrl)}"` : '';
        return `<a href="${esc(href)}"${lt} class="st-gg" target="_blank" rel="noopener noreferrer" title="Open on GG.deals (new tab)" style="margin-left:4px; padding:0 3px; font-size:9px; font-weight:bold; color:#8ab4f8; border:1px solid #556; border-radius:3px; text-decoration:none; vertical-align:middle;">gg</a>`;
    }

    // Opens a link whose real target must be looked up from the game's Lestrade's page first (result cached)
    function openLookup(link, cache, cacheKey, extract) {
        const lt = link.dataset.lt;
        if (!lt || (cacheKey === 'st_steam_lookup' && link.dataset.exact === '1')) { window.open(link.href, '_blank', 'noopener'); return; }
        if (cache[lt]) { window.open(cache[lt], '_blank', 'noopener'); return; }
        const win = window.open('about:blank', '_blank'); // opened now so the popup blocker allows it
        fetch(lt, { credentials: 'same-origin' })
            .then(r => r.text())
            .then(html => {
                const url = extract(html) || link.href; // nothing found: search page
                if (url !== link.href) { cache[lt] = url; GM_setValue(cacheKey, cache); }
                if (win) { try { win.opener = null; } catch (e) {} win.location.href = url; }
                else window.open(url, '_blank', 'noopener');
            })
            .catch(() => { if (win) win.location.href = link.href; });
    }
    const steamLookup = GM_getValue('st_steam_lookup', {});
    const extractGg = html => {
        const m1 = html.match(/https?:\/\/(?:www\.)?gg\.deals\/game\/[a-z0-9-]+\/?/i);
        const m2 = html.match(/data-ggu="([a-z0-9-]+)"/i);
        return m1 ? m1[0] : m2 ? `https://gg.deals/game/${m2[1]}/` : null;
    };
    const extractSteam = html => {
        const store = html.match(/store\.steampowered\.com\/(app|sub|bundle)\/(\d+)/);
        const appid = html.match(/data-appid="(\d+)"/);
        return store ? `https://store.steampowered.com/${store[1]}/${store[2]}/` : appid ? `https://store.steampowered.com/app/${appid[1]}/` : null;
    };
    // One click handler for both kinds of look-up links
    function handleLookupClick(e) {
        const link = e.target.closest && e.target.closest('a.st-steam, a.st-gg');
        if (!link) return false;
        e.preventDefault();
        e.stopPropagation();
        if (link.classList.contains('st-gg')) openLookup(link, ggLookup, 'st_gg_lookup', extractGg);
        else openLookup(link, steamLookup, 'st_steam_lookup', extractSteam);
        return true;
    }

    // ---- Price with a small ✎ that edits the custom price right there ----
    let afterPriceEdit = () => {};
    function pTag(title, shown, unit) {
        if (unit === undefined) unit = shown;
        const custom = getCustomPrice(title) !== null;
        return `($<span class="st-pv">${shown.toFixed(2)}</span><button type="button" class="st-edit" data-title="${esc(title)}" data-unit="${unit}" title="${custom ? 'Custom price (click to change)' : 'Edit price'}" style="background:none; border:none; padding:0 2px; margin-left:2px; cursor:pointer; font-size:11px; color:${custom ? '#f39c12' : '#777'};">✎</button>)`;
    }
    function startPriceEdit(btn) {
        const pv = btn.previousElementSibling;
        if (!pv || !pv.classList.contains('st-pv')) return;
        const title = btn.dataset.title, unit = parseFloat(btn.dataset.unit) || 0;
        const input = document.createElement('input');
        input.type = 'number'; input.step = '0.01'; input.min = '0'; input.value = unit.toFixed(2); input.placeholder = 'price';
        input.style.cssText = 'width:66px; padding:1px 3px; background:#1a1a2b; color:#fff; border:1px solid #4e9af1; border-radius:3px; font-size:12px;';
        pv.replaceWith(input);
        btn.style.display = 'none';
        let done = false;
        const finish = save => {
            if (done) return;
            done = true;
            const raw = input.value.trim();
            const val = parseFloat(raw);
            const had = getCustomPrice(title) !== null;
            const unchanged = !save || (raw !== '' && val === unit && !had) || (raw === '' && !had);
            if (unchanged) { input.replaceWith(pv); btn.style.display = ''; return; }
            setCustomPrice(title, raw !== '' && !isNaN(val) && val >= 0 ? val : null);
            afterPriceEdit(title);
        };
        input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
        input.addEventListener('click', ev => ev.stopPropagation());
        input.addEventListener('blur', () => finish(true));
        input.focus(); input.select();
    }
    document.addEventListener('click', e => {
        const btn = e.target.classList && e.target.classList.contains('st-edit') ? e.target : null;
        if (!btn) return;
        e.preventDefault(); e.stopPropagation();
        startPriceEdit(btn);
    }, true);

    // Turns one page row into a trade item (non-game items use the Item Trades quantity box instead of copies)
    function makeItem(el, idx, checkbox) {
        const title = getCleanTitle(el);
        const price = getPriceFromElement(el);
        if (!title || price <= 0) return null;
        const game = isGameElement(el);
        return {
            title, price, checkbox, element: el,
            qtyControl: getQtyControl(el),
            amount: getAmount(el), isGame: game,
            steamUrl: game ? getSteamUrl(el) : null,
            lestradesUrl: el.querySelector('a[href*="/game/"]')?.href || null,
            ggu: el.querySelector('a[data-ggu]')?.getAttribute('data-ggu') || null,
            baseId: idx,
            id: idx
        };
    }

    function getSideElements(isMySide) {
        // A game row is any row with a price attribute OR its own checkbox,
        // so games without a price (no data-rv) are still found
        // ...and rows with an amount selector, so items like keys are included too
        const isGameRow = el => el.hasAttribute('data-rv') || el.querySelector('input[type="checkbox"], input[type="number"], select');

        const userSides = document.querySelectorAll('#new-offer .user-side');
        if (userSides.length >= 2) {
            const targetSideContainer = userSides[isMySide ? 1 : 0];
            if (targetSideContainer) {
                return Array.from(targetSideContainer.querySelectorAll('tr, li')).filter(isGameRow);
            }
        }

        const rows = isMySide
            ? [...document.querySelectorAll('.tradside tr')].filter(isGameRow).concat([...document.querySelectorAll('fieldset.tradables li')])
            : [...document.querySelectorAll('.wishside tr')].filter(isGameRow);
        return [...new Set(rows)];
    }

    function populateDropdowns() {
        const select = byId('st-game-select');
        const direction = byId('st-direction').value;
        const label = byId('st-select-label');
        if (!select) return;

        select.innerHTML = '<option value="">-- Leave blank to use all checked games --</option>';
        const uniqueGames = new Map();

        const isMySide = (direction === 'my_to_theirs');
        label.innerText = isMySide ? "Select Your Game (or multi-check):" : "Select Their Game (or multi-check):";

        getSideElements(isMySide).forEach(el => {
            const title = getCleanTitle(el);
            if (title && !uniqueGames.has(title)) uniqueGames.set(title, getPriceFromElement(el));
        });

        const frag = document.createDocumentFragment();
        uniqueGames.forEach((price, title) => {
            const opt = document.createElement('option');
            opt.value = title;
            opt.dataset.price = price;
            opt.textContent = price > 0 ? `${title} ($${price.toFixed(2)})` : `${title} (no price – set one below)`;
            frag.appendChild(opt);
        });
        select.appendChild(frag);
    }

    function getRowCheckbox(el) {
        return el.querySelector('input[type="checkbox"]') || el.closest('tr, li')?.querySelector('input[type="checkbox"]') || null;
    }

    function getActiveItems(isMySide) {
        const items = [];
        getSideElements(isMySide).forEach((el, idx) => {
            const it = makeItem(el, idx, getRowCheckbox(el));
            if (it) items.push(it);
        });
        return items;
    }

    // Rows the script ticked for a Preview stay ticked on the page; they must not act as "your selection" in the next scan.
    // Remembered by checkbox value; as soon as you tick/untick a box yourself it counts again.
    const AUTO_KEY = 'st_auto_ticked';
    let autoIds = null, autoBusy = false;
    const pageU = () => new URLSearchParams(location.search).get('u');
    function getAutoIds() {
        if (!autoIds) {
            const a = GM_getValue(AUTO_KEY, null);
            autoIds = a && String(a.u) === String(pageU()) && Date.now() - a.ts < 6 * 3600 * 1000 ? new Set(a.ids) : new Set();
        }
        return autoIds;
    }
    function saveAutoIds(set) {
        autoIds = set;
        GM_setValue(AUTO_KEY, { u: pageU(), ts: Date.now(), ids: [...set] });
    }
    document.addEventListener('change', e => {
        const cb = e.target;
        if (autoBusy || !cb || cb.type !== 'checkbox' || !getAutoIds().has(cb.value)) return;
        const next = new Set(getAutoIds());
        next.delete(cb.value);
        saveAutoIds(next);
    }, true);

    // "Checked" = ticked checkbox, or an amount above 0 for rows that only have an amount selector
    function getCheckedItems(isMySide) {
        const items = [];
        const auto = getAutoIds();
        getSideElements(isMySide).forEach((el, idx) => {
            const cb = getRowCheckbox(el);
            const qty = getQtyControl(el);
            const selected = cb ? (cb.checked && !auto.has(cb.value)) : (qty ? parseInt(qty.value, 10) > 0 : false);
            if (!selected) return;
            const it = makeItem(el, idx, cb);
            if (it) items.push(it);
        });
        return items;
    }

    function combinations(arr, maxLen) {
        const comb = [];
        const taxa = [];
        const helper = start => {
            if (taxa.length > 0 && taxa.length <= maxLen) comb.push([...taxa]);
            if (taxa.length === maxLen) return;
            for (let i = start; i < arr.length; i++) {
                taxa.push(arr[i]);
                helper(i + 1);
                taxa.pop();
            }
        };
        helper(0);
        return comb;
    }

    // Skip groups with an extreme price gap between their cheapest and most expensive game
    function hasExtremeDisparity(group) {
        if (group.length < 2) return false;
        let hi = -Infinity, lo = Infinity;
        for (const g of group) { if (g.price > hi) hi = g.price; if (g.price < lo) lo = g.price; }
        return hi > lo * 3.2 && (hi - lo) > 4.50;
    }

    // All combinations of exactly k items
    function combinationsExact(arr, k) {
        const out = [];
        const cur = [];
        const walk = start => {
            if (cur.length === k) { out.push([...cur]); return; }
            for (let i = start; i <= arr.length - (k - cur.length); i++) {
                cur.push(arr[i]);
                walk(i + 1);
                cur.pop();
            }
        };
        walk(0);
        return out;
    }

    function nCr(n, r) {
        if (r > n) return 0;
        let x = 1;
        for (let i = 1; i <= r; i++) x = x * (n - r + i) / i;
        return Math.round(x);
    }

    // First index in a sorted array whose value is >= v
    function lowerBound(arr, v) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < v) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    // Indices of the k values closest to target (sorted array), staying inside [lo, hi]
    function nearestK(sorted, target, lo, hi, k) {
        let r = lowerBound(sorted, target), l = r - 1;
        const out = [];
        while (out.length < k) {
            const lOk = l >= 0 && sorted[l] >= lo;
            const rOk = r < sorted.length && sorted[r] <= hi;
            if (!lOk && !rOk) break;
            if (lOk && (!rOk || target - sorted[l] <= sorted[r] - target)) out.push(l--);
            else out.push(r++);
        }
        return out;
    }

    // Open scan: ALL your games against ALL their games, no selection needed.
    // To stay fast on big lists it keeps only the best matches per game:
    //   1:1 → 10 per your game, 1:2 / 1:3 → 15 per your game, 2:1 → 10 per their game.
    let lastScanFn = null;
    async function rerunLastScan() {
        renderPriceList();
        if (!lastScanFn) return;
        const find = () => document.querySelector('#st-trade-modal div[style*="overflow-y: auto"]');
        const top = find() ? find().scrollTop : 0;
        await lastScanFn();
        if (find()) find().scrollTop = top;
    }

    function finishTradeQueue() {
        tradeMap = new Map(matchedTradeQueue.map(t => [t.id, t]));
    }

    async function openScanAndOpenModal() {
        lastScanFn = openScanAndOpenModal;
        const status = byId('st-status');
        const { min: minRatio, max: maxRatio } = getRatioLimits();
        const maxTheir = Math.min(3, Math.max(1, parseInt(byId('st-max-their').value, 10) || 2));
        const yieldUI = () => new Promise(r => setTimeout(r, 0));

        status.innerText = "Open scan: reading all games...";
        await yieldUI();
        matchedTradeQueue = [];
        resetRowCaches();
        renderPriceList();

        const myGames = getActiveItems(true).filter(i => i.isGame !== false);
        const theirGames = getActiveItems(false).filter(i => i.isGame !== false);
        itemTradeCards = gamesOnly() ? [] : buildItemTradeCards(null, '', myGames, theirGames, true);

        if ((!myGames.length || !theirGames.length) && !itemTradeCards.length) {
            status.innerText = "Open scan: no priced games found on one of the sides.";
            return;
        }

        const notes = [];
        const sum = list => list.reduce((s, g) => s + g.price, 0);
        const byCloseness = ratioOf => (a, b) => closeness(ratioOf(a)) - closeness(ratioOf(b));

        // You give 1 ⇄ they give 1, 2 or 3
        for (let size = 1; size <= maxTheir && myGames.length && theirGames.length; size++) {
            if (nCr(theirGames.length, size) > 300000) {
                notes.push(`1:${size} skipped (too many of their games for an open scan; tick some games and use Scan instead)`);
                continue;
            }
            status.innerText = `Open scan: checking 1:${size} trades...`;
            await yieldUI();

            const combos = (size === 1 ? theirGames.map(g => [g]) : combinationsExact(theirGames, size))
                .filter(c => !hasExtremeDisparity(c))
                .map(c => ({ games: c, total: sum(c) }))
                .sort((a, b) => a.total - b.total);
            const totals = new Float64Array(combos.map(c => c.total));
            const keep = size === 1 ? 10 : 15;

            for (let mIdx = 0; mIdx < myGames.length; mIdx++) {
                if (mIdx % 100 === 99) await yieldUI();
                const mg = myGames[mIdx];
                const found = nearestK(totals, mg.price, mg.price * minRatio, mg.price * maxRatio, keep).map(i => combos[i]);
                found.sort(byCloseness(c => c.total / mg.price));
                found.forEach((c, k) => {
                    matchedTradeQueue.push({
                        id: `open-1${size}-${mIdx}-${k}`,
                        type: `1:${size} Trade`,
                        myGames: [mg],
                        theirGames: c.games,
                        myValue: mg.price.toFixed(2),
                        theirValue: c.total.toFixed(2),
                        ratio: (c.total / mg.price).toFixed(2)
                    });
                });
            }
        }

        // You give 2 ⇄ they give 1
        if (myGames.length >= 2 && theirGames.length) {
            if (nCr(myGames.length, 2) > 300000) {
                notes.push('2:1 skipped (too many of your games for an open scan)');
            } else {
                status.innerText = "Open scan: checking 2:1 trades...";
                await yieldUI();
                const pairs = combinationsExact(myGames, 2)
                    .filter(c => !hasExtremeDisparity(c))
                    .map(c => ({ games: c, total: sum(c) }))
                    .sort((a, b) => a.total - b.total);
                const totals = new Float64Array(pairs.map(p => p.total));

                for (let tIdx = 0; tIdx < theirGames.length; tIdx++) {
                    if (tIdx % 100 === 99) await yieldUI();
                    const tg = theirGames[tIdx];
                    // ratio = their price ÷ your total, so your total must be between price/max and price/min
                    const found = nearestK(totals, tg.price, tg.price / maxRatio, tg.price / minRatio, 10).map(i => pairs[i]);
                    found.sort(byCloseness(p => tg.price / p.total));
                    found.forEach((p, k) => {
                        matchedTradeQueue.push({
                            id: `open-21-${tIdx}-${k}`,
                            type: '2:1 Trade',
                            myGames: p.games,
                            theirGames: [tg],
                            myValue: p.total.toFixed(2),
                            theirValue: tg.price.toFixed(2),
                            ratio: (tg.price / p.total).toFixed(2)
                        });
                    });
                }
            }
        }

        finishTradeQueue();
        status.innerText = `Open scan (${myGames.length} of yours × ${theirGames.length} of theirs): found ${matchedTradeQueue.length} trade options` +
            (itemTradeCards.length ? ` + ${itemTradeCards.length} item trade${itemTradeCards.length > 1 ? 's' : ''}.` : '.') +
            (notes.length ? ' ' + notes.join('. ') + '.' : '');
        openTradeModal();
    }

    async function scanPageAndOpenModal() {
        lastScanFn = scanPageAndOpenModal;
        const status = byId('st-status');
        const select = byId('st-game-select');
        const direction = byId('st-direction').value;
        if (!select) return;

        const chosenOption = select.options[select.selectedIndex];
        const chosenTitle = select.value;
        const { min: minRatio, max: maxRatio } = getRatioLimits();
        const maxTheir = Math.min(3, Math.max(1, parseInt(byId('st-max-their').value, 10) || 2));

        status.innerText = "Scanning trades...";
        matchedTradeQueue = [];
        resetRowCaches();
        renderPriceList();

        const unpricedCount = [true, false].reduce((n, side) =>
            n + getSideElements(side).filter(el => getCleanTitle(el) && isGameElement(el) && getPriceFromElement(el) <= 0).length, 0);

        // Read each side from the page once
        const allMine = getActiveItems(true);
        const allTheirs = getActiveItems(false);
        let checkedMyItems = getCheckedItems(true);
        let checkedTheirItems = getCheckedItems(false);

        // Use the real page row so its checkbox can be ticked on Preview
        const chosenFrom = all => {
            const first = all.find(i => i.title === chosenTitle);
            return first ? all.filter(i => i.title === chosenTitle && i.baseId === first.baseId) : [];
        };
        const fallbackItem = () => [{ title: chosenTitle, price: parseFloat(chosenOption.dataset.price) || 0, checkbox: null }];

        let myItems = [];
        let theirItems = [];

        if (direction === 'my_to_theirs') {
            if (chosenTitle) {
                const found = chosenFrom(allMine);
                myItems = found.length ? found : fallbackItem();
            } else if (checkedMyItems.length > 0) {
                myItems = checkedMyItems;
            }
            theirItems = allTheirs;
        } else {
            if (chosenTitle) {
                const found = chosenFrom(allTheirs);
                theirItems = found.length ? found : fallbackItem();
            } else if (checkedTheirItems.length > 0) {
                theirItems = checkedTheirItems;
            }
            myItems = allMine;
        }

        // Unpriced games can't be matched (a $0 game would make every ratio wrong).
        // Non-game items (keys etc.) are handled separately in the Item Trades section.
        const chosenUnpriced = chosenTitle && !(parseFloat(chosenOption.dataset.price) > 0);
        myItems = myItems.filter(i => i.price > 0 && i.isGame !== false);
        theirItems = theirItems.filter(i => i.price > 0 && i.isGame !== false);
        checkedTheirItems = checkedTheirItems.filter(i => i.isGame !== false);
        checkedMyItems = checkedMyItems.filter(i => i.isGame !== false);

        itemTradeCards = gamesOnly() ? [] : buildItemTradeCards(direction, chosenTitle, myItems, theirItems);

        if (itemTradeCards.length === 0) {
            if (chosenUnpriced && (myItems.length === 0 || theirItems.length === 0)) {
                status.innerText = `"${chosenTitle}" has no price yet. Set one under Custom Prices.`;
                return;
            }
            if (myItems.length === 0 || theirItems.length === 0) {
                status.innerText = "Error: Please check items on the page or pick a game from the dropdown!";
                return;
            }
        }

        const myCombos = (myItems.length === 1 && checkedMyItems.length === 0) ? [myItems] : combinations(myItems, 2);
        let theirCombos = (theirItems.length === 1 && checkedTheirItems.length === 0) ? [theirItems] : combinations(theirItems, maxTheir);

        if (direction === 'their_to_mine' && checkedTheirItems.length > 0 && !chosenTitle) {
            theirCombos = [checkedTheirItems];
        }

        // Pre-compute totals and disparity once per combo instead of once per pair
        const prep = combos => combos
            .filter(g => !hasExtremeDisparity(g))
            .map(g => ({ g, total: g.reduce((s, x) => s + x.price, 0) }))
            .filter(x => x.total > 0);
        const myPrep = prep(myCombos), theirPrep = prep(theirCombos);

        myPrep.forEach(({ g: myGroup, total: myTotalVal }, mIdx) => {
            theirPrep.forEach(({ g: theirGroup, total: theirTotalVal }, tIdx) => {
                // Ratio from YOUR point of view: value you get ÷ value you give (above 1 = you gain)
                const ratio = theirTotalVal / myTotalVal;
                if (ratio >= minRatio && ratio <= maxRatio) {
                    matchedTradeQueue.push({
                        id: `trade-${mIdx}-${tIdx}`,
                        type: `${myGroup.length}:${theirGroup.length} Trade`,
                        myGames: myGroup,
                        theirGames: theirGroup,
                        myValue: myTotalVal.toFixed(2),
                        theirValue: theirTotalVal.toFixed(2),
                        ratio: ratio.toFixed(2)
                    });
                }
            });
        });

        finishTradeQueue();
        status.innerText = `${chosenTitle ? `Matched "${chosenTitle}": ` : ''}Found ${matchedTradeQueue.length} trade options` +
            (itemTradeCards.length ? ` + ${itemTradeCards.length} item trade${itemTradeCards.length > 1 ? 's' : ''}.` : '.') +
            (unpricedCount ? ` Skipped ${unpricedCount} unpriced game${unpricedCount > 1 ? 's' : ''}.` : '');
        openTradeModal();
    }

    // ---------- Multi-game cards: 1:2 / 1:3 (you give 1) and 2:1 / 3:1 (they give 1) ----------

    // One card per FIXED game (your game for 1:N, their game for N:1). Every game on the other
    // side that appears in a valid combo is listed once, split into two columns:
    //   HIGHER VALUE: worth at least 1/N of the fixed game (for 1:2 / 2:1 → at least half)
    //   LOWER VALUE:  worth less than that
    // Each game shows how much of the fixed game it covers, best combos are one-click picks,
    // and the ratio updates live. Both directions work exactly the same way.
    function buildOneToManyCards(trades, mirror = false) {
        const fixedOf = t => mirror ? t.theirGames[0] : t.myGames[0];
        const pickedOf = t => mirror ? t.myGames : t.theirGames;

        const byFixed = new Map();
        trades.forEach(t => {
            const k = rowKey(fixedOf(t));
            if (!byFixed.has(k)) byFixed.set(k, []);
            byFixed.get(k).push(t);
        });

        const cards = [];
        byFixed.forEach(list => {
            const fixed = fixedOf(list[0]);
            const size = pickedOf(list[0]).length;
            const threshold = fixed.price / size;

            const games = new Map();
            list.forEach(t => pickedOf(t).forEach(g => games.set(rowKey(g), g)));
            const all = [...games.values()].sort((a, b) => b.price - a.price);
            const sortedTrades = [...list].sort((a, b) => closeness(a.ratio) - closeness(b.ratio));

            cards.push({
                mirror,
                fixed,
                myGame: mirror ? null : fixed,
                size,
                threshold,
                higher: all.filter(g => g.price >= threshold),
                lower: all.filter(g => g.price < threshold),
                trades: sortedTrades,
                best: closeness(sortedTrades[0].ratio)
            });
        });

        cards.sort((a, b) => a.best - b.best);
        return cards;
    }

    function cardPickedGames(card, trade) {
        return card.mirror ? trade.myGames : trade.theirGames;
    }

    // Ratio from your point of view (get ÷ give) for a total on the picked side
    function cardRatio(card, pickedTotal) {
        if (card.mirror) return pickedTotal > 0 ? card.fixed.price / pickedTotal : 0;
        return card.fixed.price > 0 ? pickedTotal / card.fixed.price : 0;
    }

    function renderOneToManyCard(card) {
        const cardId = `card-${renderedCards.size}`;
        card.id = cardId;
        card.gameList = [];
        card.gameIndex = new Map();
        renderedCards.set(cardId, card);

        const fixed = card.fixed;
        const pickedVals = card.trades.map(t => parseFloat(card.mirror ? t.myValue : t.theirValue));
        const ratios = card.trades.map(t => parseFloat(t.ratio));
        const range = (arr, prefix = '') => {
            const lo = Math.min(...arr).toFixed(2), hi = Math.max(...arr).toFixed(2);
            return lo === hi ? `${prefix}${lo}` : `${prefix}${lo}–${prefix}${hi}`;
        };

        const pickSide = card.mirror ? 'YOU GIVE' : 'THEY GIVE';
        const pickColor = card.mirror ? '#28a745' : '#e74c3c';
        const fixedColor = card.mirror ? '#e74c3c' : '#28a745';

        // Big cards: the games from the best combos come first, the rest sit in collapsed value bands, and as soon as you
        // tick one game only the games that make a valid trade with it stay visible
        const featured = new Set();
        card.trades.slice(0, 5).forEach(t => cardPickedGames(card, t).forEach(g => featured.add(rowKey(g))));
        const rowHTML = (g, col, band) => {
            const gIdx = card.gameList.push(g) - 1;
            card.gameIndex.set(rowKey(g), gIdx);
            const share = (g.price / fixed.price).toFixed(2);
            return `<label class="st-row" data-card-id="${cardId}" data-band="${col}:${band}" data-t="${esc(g.title.toLowerCase())}" style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; background: #1a1a2b; padding: 6px 8px; border-radius: 4px; border: 1px solid #2a2a40; cursor: pointer;">
                <span style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                    <input type="checkbox" class="st-pick" data-card-id="${cardId}" data-game-idx="${gIdx}" style="width: 15px; height: 15px; cursor: pointer; flex: none;">
                    <span style="font-size: 12px; color: #fff;">${gameLink(g)} <span style="color:${pickColor}; font-weight:bold;">${pTag(g.title, g.price)}</span></span>
                </span>
                <span style="display: flex; align-items: center; gap: 4px; flex: none;">
                    <span id="st-proj-${cardId}-${gIdx}" style="font-size: 10px; color: #888; white-space: nowrap;"></span>
                    <span style="font-size: 10px; color: #4e9af1; background: #33334d; padding: 2px 5px; border-radius: 3px; white-space: nowrap;" title="This game is worth ${share} of ${esc(fixed.title)}. Picks adding up to about 1.00 make an even trade.">+${share}</span>
                </span>
            </label>`;
        };
        const bandHeader = (col, id, label, open) => `<button type="button" class="st-band" data-card-id="${cardId}" data-band="${col}:${id}" data-label="${esc(label)}" data-open="${open ? 1 : 0}" style="display: block; width: 100%; text-align: left; margin: 6px 0 4px; padding: 5px 8px; background: #2a2a40; color: #8ab4f8; border: 1px solid #3a3a55; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;"></button>`;
        const column = (title, games, col) => {
            let body = '';
            if (games.length <= 10) {
                body = games.map(g => rowHTML(g, col, 'all')).join('');
            } else {
                const feat = games.filter(g => featured.has(rowKey(g)));
                const rest = games.filter(g => !featured.has(rowKey(g)));
                if (feat.length) body += bandHeader(col, 'f', '★ In the best combos', true) + feat.map(g => rowHTML(g, col, 'f')).join('');
                if (rest.length) {
                    const w = Math.max(0.25, Math.ceil(((rest[0].price - rest[rest.length - 1].price) / 7) * 4) / 4);
                    const bands = new Map();
                    rest.forEach(g => {
                        const k = Math.floor((rest[0].price - g.price) / w);
                        if (!bands.has(k)) bands.set(k, []);
                        bands.get(k).push(g);
                    });
                    bands.forEach((list, k) => {
                        const hi = list[0].price, lo = list[list.length - 1].price;
                        const label = hi.toFixed(2) === lo.toFixed(2) ? `$${hi.toFixed(2)}` : `$${lo.toFixed(2)}–$${hi.toFixed(2)}`;
                        body += bandHeader(col, `b${k}`, label, false) + list.map(g => rowHTML(g, col, `b${k}`)).join('');
                    });
                }
            }
            return `<div style="flex: 1; min-width: 0;">
            <div style="font-size: 10px; font-weight: bold; color: ${pickColor}; margin-bottom: 4px;">${title} · ${games.length} game${games.length === 1 ? '' : 's'}</div>
            ${body}
        </div>`;
        };

        const th = card.threshold.toFixed(2);
        const columnsHTML = (card.higher.length && card.lower.length)
            ? column(`${pickSide} – HIGHER VALUE ($${th}+):`, card.higher, 'h') + column(`${pickSide} – LOWER VALUE (under $${th}):`, card.lower, 'l')
            : column(`${pickSide}:`, card.higher.length ? card.higher : card.lower, 'a');
        const totalGames = card.higher.length + card.lower.length;
        card.totalGames = totalGames;
        const filterHTML = totalGames > 12 ? `<input type="text" class="st-filter" data-card-id="${cardId}" placeholder="Filter ${totalGames} games by name…" style="width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 6px 8px; background: #1a1a2b; color: #fff; border: 1px solid #444; border-radius: 4px; font-size: 12px;">
            <div id="st-narrow-${cardId}" style="display: none; margin-bottom: 6px; padding: 5px 8px; background: #2d3a2d; color: #9fe29f; border-radius: 4px; font-size: 11px;"></div>` : '';

        const combosHTML = card.trades.slice(0, 5).map((t, i) => {
            const names = cardPickedGames(card, t).map(g => esc(g.title)).join(' + ');
            return `<button type="button" class="st-combo" data-card-id="${cardId}" data-combo-idx="${i}" title="Tick exactly these games" style="background: #2a2a40; color: #fff; border: 1px solid #444; border-radius: 12px; padding: 3px 9px; font-size: 11px; cursor: pointer; text-align: left;">${names} <b style="color: #4e9af1;">→ ${t.ratio}</b></button>`;
        }).join('');

        const fixedBlock = `<div style="flex: 0 0 200px;">
            <div style="font-size: 10px; font-weight: bold; color: ${fixedColor}; margin-bottom: 4px;">${card.mirror ? 'THEY GIVE:' : 'YOU GIVE:'}</div>
            <span style="color: ${fixedColor}; font-weight: bold;">${gameLink(fixed)} ${pTag(fixed.title, fixed.price)}</span>
        </div>`;
        const pickBlock = `<div style="flex: 1; min-width: 0;">
            <div style="font-size: 10px; font-weight: bold; color: #aaa; margin-bottom: 4px;">BEST COMBOS:</div>
            <div style="display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px;">${combosHTML}</div>
            ${filterHTML}
            <div style="display: flex; gap: 15px;">${columnsHTML}</div>
            <div id="st-live-${cardId}" style="margin-top: 6px; padding: 6px 8px; background: #1a1a2b; border-radius: 4px; font-size: 12px; color: #888;">Tick games (or pick a best combo) to see the live ratio.</div>
        </div>`;

        const header = card.mirror
            ? `⚡ Total Value: You Give ${range(pickedVals, '$')} ⇄ They Give $${fixed.price.toFixed(2)}`
            : `⚡ Total Value: You Give $${fixed.price.toFixed(2)} ⇄ They Give ${range(pickedVals, '$')}`;

        return `
            <div style="margin-bottom: 12px;">
                <div style="font-size: 11px; font-weight: bold; color: #f39c12; margin-bottom: 3px;">${header} (Ratio: ${range(ratios)}, ${card.trades.length} combo${card.trades.length > 1 ? 's' : ''})</div>
                <div style="display: flex; align-items: center; gap: 12px; background: #222235; padding: 10px 12px; border-radius: 6px; border: 1px solid #333;">
                    ${card.mirror ? pickBlock : fixedBlock}
                    <span style="color: #aaa; font-size: 16px;">⇄</span>
                    ${card.mirror ? fixedBlock : pickBlock}
                </div>
            </div>
        `;
    }

    // DOM nodes of one card, looked up once after the window is on the page (not on every tick)
    function cardDom(cardId) {
        const card = renderedCards.get(cardId);
        if (!card) return null;
        if (!card._dom) {
            const all = s => [...document.querySelectorAll(s)];
            const boxes = all(`.st-pick[data-card-id="${cardId}"]`);
            card._dom = {
                boxes,
                proj: boxes.map(cb => byId(`st-proj-${cardId}-${cb.dataset.gameIdx}`)),
                rows: all(`.st-row[data-card-id="${cardId}"]`).map(row => ({ row, cb: row.querySelector('input') })),
                bands: all(`.st-band[data-card-id="${cardId}"]`),
                filter: document.querySelector(`.st-filter[data-card-id="${cardId}"]`),
                note: byId(`st-narrow-${cardId}`),
                live: byId(`st-live-${cardId}`)
            };
        }
        return card._dom;
    }

    // Which rows of a big card are visible: ticked ones always; with a filter, matches; after one tick, only games that fit with it; otherwise open bands
    function refreshCardRows(cardId) {
        const card = renderedCards.get(cardId);
        const dom = cardDom(cardId);
        if (!card || !dom) return;
        const q = dom.filter ? dom.filter.value.trim().toLowerCase() : '';
        const picks = dom.boxes.filter(cb => cb.checked).map(cb => rowKey(card.gameList[+cb.dataset.gameIdx]));
        let cand = null;
        if (picks.length && picks.length < card.size) {
            if (!card._tk) card._tk = card.trades.map(t => new Set(cardPickedGames(card, t).map(rowKey)));
            cand = new Set();
            card._tk.forEach(ks => { if (picks.every(k => ks.has(k))) ks.forEach(k => { if (!picks.includes(k)) cand.add(k); }); });
        }
        const open = {};
        dom.bands.forEach(b => { open[b.dataset.band] = b.dataset.open === '1'; });
        const counts = {};
        dom.rows.forEach(({ row, cb }) => {
            const key = rowKey(card.gameList[+cb.dataset.gameIdx]);
            const matchQ = !q || row.dataset.t.includes(q);
            const inScope = cb.checked || (matchQ && (!cand || cand.has(key)));
            let show;
            if (cb.checked) show = true;
            else if (!inScope) show = false;
            else if (cand || q) show = true;
            else show = open[row.dataset.band] !== false;
            const disp = show ? 'flex' : 'none';
            if (row.style.display !== disp) row.style.display = disp;
            if (inScope) counts[row.dataset.band] = (counts[row.dataset.band] || 0) + 1;
        });
        dom.bands.forEach(b => {
            const n = counts[b.dataset.band] || 0;
            const isOpen = b.dataset.open === '1' || cand || q;
            b.style.display = n ? 'block' : 'none';
            b.textContent = `${isOpen ? '▾' : '▸'} ${b.dataset.label} · ${n} game${n === 1 ? '' : 's'}`;
        });
        if (dom.note) {
            dom.note.style.display = cand ? 'block' : 'none';
            if (cand) dom.note.textContent = `Showing the ${cand.size} game${cand.size === 1 ? '' : 's'} that make a valid trade with your pick (of ${card.totalGames}). Untick it to see everything again.`;
        }
    }

    // Ticks exactly the games of one suggested combo in a card
    function applyCombo(cardId, comboIdx) {
        const card = renderedCards.get(cardId);
        const trade = card?.trades[comboIdx];
        if (!trade) return;
        const wanted = new Set(cardPickedGames(card, trade).map(g => card.gameIndex.get(rowKey(g))));
        clearOtherSelections(cardId);
        cardDom(cardId).boxes.forEach(cb => { cb.checked = wanted.has(+cb.dataset.gameIdx); });
        refreshCardRows(cardId);
        updateCardRatio(cardId);
    }

    function updateCardRatio(cardId) {
        const card = renderedCards.get(cardId);
        const dom = cardDom(cardId);
        const liveEl = dom && dom.live;
        if (!card || !liveEl) return;

        const { min, max } = getRatioLimits();
        const picks = dom.boxes.filter(cb => cb.checked);
        const pickedTotal = picks.reduce((s, cb) => s + card.gameList[+cb.dataset.gameIdx].price, 0);

        // "→ x.xx" next to unticked games = what the ratio becomes if you add that game
        dom.boxes.forEach((cb, i) => {
            const proj = dom.proj[i];
            if (!proj) return;
            if (cb.checked || picks.length === 0) {
                proj.textContent = '';
                return;
            }
            const r = cardRatio(card, pickedTotal + card.gameList[+cb.dataset.gameIdx].price);
            proj.textContent = `→ ${r.toFixed(2)}`;
            proj.style.color = (r >= min && r <= max) ? '#28a745' : '#666';
        });

        if (picks.length === 0) {
            liveEl.textContent = 'Tick games (or pick a best combo) to see the live ratio.';
            liveEl.style.color = '#888';
            return;
        }

        const ratio = cardRatio(card, pickedTotal); // get ÷ give
        const ok = ratio >= min && ratio <= max;
        const give = card.mirror ? pickedTotal : card.fixed.price;
        const get = card.mirror ? card.fixed.price : pickedTotal;

        liveEl.innerHTML = `Selected: You Give $${give.toFixed(2)} ⇄ They Give $${get.toFixed(2)} (${picks.length} game${picks.length > 1 ? 's' : ''} picked) — <b>Live Ratio: ${ratio.toFixed(2)}</b>${ok ? '' : ` (outside ${min}–${max})`}`;
        liveEl.style.color = ok ? '#28a745' : '#e74c3c';
    }

    // ---------- Item trades (non-game items such as TF2 keys) ----------

    function isRowSelected(el) {
        const cb = getRowCheckbox(el);
        const q = getQtyControl(el);
        return cb ? cb.checked : (q ? parseInt(q.value, 10) > 0 : false);
    }

    function buildItemEntry(el, idx, isMine) {
        const title = getCleanTitle(el);
        if (!title || isGameElement(el)) return null;
        const amount = getAmount(el);
        return {
            title, isMine, amount,
            price: getPriceFromElement(el),               // may be 0 (no price yet) – still listed
            maxQty: amount, // always allowed to use any number up to the amount available
            checkbox: getRowCheckbox(el), qtyControl: getQtyControl(el),
            element: el, baseId: idx, isGame: false
        };
    }

    // From YOUR point of view: value you get ÷ value you give
    function itemTradeRatio(item, qty, counterpart, extra) {
        const itemVal = item.price * qty + (extra ? extra.price : 0);
        const give = item.isMine ? itemVal : counterpart.price;
        const get = item.isMine ? counterpart.price : itemVal;
        return { give, get, ratio: give > 0 ? get / give : 0 };
    }

    // One card per item. Items on the side you're matching from only count if ticked/chosen;
    // items on the other side are always included. Shown regardless of the ratio range.
    function buildItemTradeCards(direction, chosenTitle, myGamesList, theirGamesList, openMode = false) {
        const primaryMine = direction === 'my_to_theirs';
        const collect = (isMine, isPrimary) => {
            const rows = getSideElements(isMine);
            const anySelected = isPrimary && rows.some(isRowSelected);
            return rows.map((el, idx) => {
                const it = buildItemEntry(el, idx, isMine);
                if (!it) return null;
                if (!isPrimary) return it;
                return (anySelected ? isRowSelected(el) : it.title === chosenTitle) ? it : null;
            }).filter(Boolean);
        };

        // Open scan: every item on both sides; otherwise only selected items on the side you match from
        const items = [...collect(true, !openMode && primaryMine), ...collect(false, !openMode && !primaryMine)];
        const { min, max } = getRatioLimits();

        return items.map(item => {
            const counterparts = item.isMine ? theirGamesList : myGamesList;
            if (!counterparts.length) return null;
            const extras = item.isMine ? myGamesList : theirGamesList;

            // Per quantity: how many games fall inside the ratio range, and the closest ratio
            const perQty = [];
            for (let q = 1; q <= item.maxQty; q++) {
                let inRange = 0, best = Infinity;
                if (item.price > 0) {
                    counterparts.forEach(cp => {
                        const r = itemTradeRatio(item, q, cp, null).ratio;
                        if (r >= min && r <= max) inRange++;
                        best = Math.min(best, closeness(r));
                    });
                }
                perQty.push({ qty: q, inRange, best });
            }
            // Start on the quantity with the most games in range (ties: the closest to 1.00)
            const start = [...perQty].sort((a, b) => (b.inRange - a.inRange) || (a.best - b.best))[0];

            return {
                item,
                counterparts: [...counterparts].sort((a, b) => b.price - a.price),
                extras,
                perQty,
                bestQty: start.qty,
                bestScore: Math.min(...perQty.map(p => p.best)),
                totalInRange: perQty.reduce((s, p) => s + p.inRange, 0)
            };
        }).filter(Boolean).sort((a, b) => (b.totalInRange > 0) - (a.totalInRange > 0) || a.bestScore - b.bestScore);
    }

    function renderItemTradeCard(card, i) {
        const id = `item-${i}`;
        card.id = id;
        itemCardMap.set(id, card);
        const it = card.item;
        const ctl = 'display: inline-block !important; visibility: visible !important; opacity: 1 !important; position: static !important; background: #1a1a2b; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 3px; font-size: 12px;';

        const priceTxt = it.price > 0 ? `$${it.price.toFixed(2)} each` : '<span style="color:#f39c12;">no price – set one in Custom Prices</span>';
        const qtyOptions = card.perQty.map(p => {
            const total = it.price > 0 ? ` ($${(it.price * p.qty).toFixed(2)})` : '';
            const count = it.price > 0 ? ` – ${p.inRange} game${p.inRange === 1 ? '' : 's'} in ratio` : '';
            return `<option value="${p.qty}" ${p.qty === card.bestQty ? 'selected' : ''}>${p.qty} × ${esc(it.title)}${total}${count}</option>`;
        }).join('');

        const itemColor = it.isMine ? '#28a745' : '#e74c3c';
        const otherColor = it.isMine ? '#e74c3c' : '#28a745';
        const itemBlock = `<div style="flex: 0 0 300px; min-width: 0;">
            <div style="font-size: 10px; font-weight: bold; color: ${itemColor}; margin-bottom: 4px;">${it.isMine ? 'YOU GIVE:' : 'THEY GIVE:'}</div>
            <div><span style="font-weight: bold; color: ${itemColor};">🔑 ${esc(it.title)}</span> <span style="font-size: 11px; color: #aaa;">(${priceTxt}, ${it.amount} available)</span></div>
            <div style="margin-top: 6px;">
                <select class="st-item-qty" data-item-card="${id}" style="${ctl} width: 100%;">${qtyOptions}</select>
            </div>
            ${card.extras.length ? `<div style="margin-top: 6px;">
                <select class="st-item-extra" data-item-card="${id}" style="${ctl} width: 100%;">
                    <option value="">+ add a game to this side (optional)</option>
                    ${card.extras.map((g, k) => `<option value="${k}">${esc(g.title)} ($${g.price.toFixed(2)})</option>`).join('')}
                </select>
            </div>` : ''}
        </div>`;
        const listBlock = `<div style="flex: 1; min-width: 0;">
            <div id="st-item-head-${id}" style="font-size: 10px; font-weight: bold; color: ${otherColor}; margin-bottom: 4px;"></div>
            <div id="st-item-list-${id}"></div>
        </div>`;

        return `<div style="margin-bottom: 10px; background: #222235; padding: 10px 12px; border-radius: 6px; border: 1px solid #333;">
            <div style="display: flex; align-items: flex-start; gap: 12px;">
                ${it.isMine ? itemBlock : listBlock}
                <span style="color: #aaa; font-size: 16px; align-self: center;">⇄</span>
                ${it.isMine ? listBlock : itemBlock}
            </div>
            <div id="st-item-live-${id}" style="margin-top: 6px; padding: 6px 8px; background: #1a1a2b; border-radius: 4px; font-size: 12px; color: #888;"></div>
        </div>`;
    }

    // Reads the card's controls: quantity, optional extra game and the picked game (if any)
    function readItemCard(id) {
        const card = itemCardMap.get(id);
        if (!card) return null;
        const q = document.querySelector(`.st-item-qty[data-item-card="${id}"]`);
        const ex = document.querySelector(`.st-item-extra[data-item-card="${id}"]`);
        const pick = document.querySelector(`.st-item-pick[data-item-card="${id}"]:checked`);
        let qty = parseInt(q?.value, 10);
        if (isNaN(qty) || qty < 1) qty = 1;
        qty = Math.min(qty, card.item.maxQty);
        return {
            card,
            qty,
            extra: ex && ex.value !== '' ? card.extras[+ex.value] : null,
            counterpart: pick ? card.counterparts[+pick.dataset.cpIdx] : null
        };
    }

    // Lists the games that fit the chosen quantity: everything inside your ratio range,
    // or the closest few when nothing fits.
    const ITEM_LIST_LIMIT = 30;
    function renderItemList(id) {
        const sel = readItemCard(id);
        const listEl = byId(`st-item-list-${id}`);
        const headEl = byId(`st-item-head-${id}`);
        if (!sel || !listEl || !headEl) return;
        const it = sel.card.item;
        const { min, max } = getRatioLimits();
        const otherSide = it.isMine ? 'THEY GIVE' : 'YOU GIVE';
        const otherColor = it.isMine ? '#e74c3c' : '#28a745';
        const what = `${sel.qty} × ${it.title}${sel.extra ? ` + ${sel.extra.title}` : ''}`;

        const scored = sel.card.counterparts.map((cp, k) => ({ k, cp, ...itemTradeRatio(it, sel.qty, cp, sel.extra) }));
        let shown, note = '';
        if (!(it.price > 0)) {
            shown = scored.slice(0, ITEM_LIST_LIMIT);
            headEl.textContent = `${otherSide} (pick one – no ratio until ${it.title} has a price):`;
        } else {
            const inRange = scored.filter(s => s.ratio >= min && s.ratio <= max).sort((a, b) => closeness(a.ratio) - closeness(b.ratio));
            if (inRange.length) {
                shown = inRange.slice(0, ITEM_LIST_LIMIT);
                headEl.textContent = `${otherSide} – ${inRange.length} game${inRange.length === 1 ? '' : 's'} in your ratio for ${what} (pick one):`;
                if (inRange.length > shown.length) note = `+${inRange.length - shown.length} more with a weaker ratio`;
            } else {
                shown = scored.sort((a, b) => closeness(a.ratio) - closeness(b.ratio)).slice(0, 3);
                headEl.innerHTML = `${otherSide} – <span style="color:#f39c12;">nothing within ${min}–${max} for ${esc(what)}.</span> Closest:`;
            }
        }
        headEl.style.color = otherColor;

        listEl.innerHTML = shown.map(s => {
            const inR = it.price > 0 && s.ratio >= min && s.ratio <= max;
            const ratioTxt = it.price > 0 ? s.ratio.toFixed(2) : '?';
            return `<label style="display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; background: #1a1a2b; padding: 6px 8px; border-radius: 4px; border: 1px solid #2a2a40; cursor: pointer; ${inR || !(it.price > 0) ? '' : 'opacity: 0.7;'}">
                <span style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                    <input type="checkbox" class="st-item-pick" data-item-card="${id}" data-cp-idx="${s.k}" style="width: 15px; height: 15px; cursor: pointer; flex: none;">
                    <span style="font-size: 12px; color: #fff;">${gameLink(s.cp)} <span style="color: ${otherColor}; font-weight: bold;">${pTag(s.cp.title, s.cp.price)}</span></span>
                </span>
                <span style="font-size: 10px; color: #4e9af1; background: #33334d; padding: 2px 5px; border-radius: 3px; white-space: nowrap;">Ratio: ${ratioTxt}</span>
            </label>`;
        }).join('') + (note ? `<div style="font-size: 11px; color: #888;">${note}</div>` : '');

        updateItemCard(id);
    }

    function updateItemCard(id) {
        const sel = readItemCard(id);
        const liveEl = byId(`st-item-live-${id}`);
        if (!sel || !liveEl) return;
        const it = sel.card.item;
        const itemSide = `${it.title} ×${sel.qty}${sel.extra ? ` + ${sel.extra.title}` : ''}`;

        if (!sel.counterpart) {
            liveEl.textContent = `Pick a game to trade for ${itemSide}.`;
            liveEl.style.color = '#888';
            return;
        }
        if (!(it.price > 0)) {
            liveEl.textContent = `${itemSide} ⇄ ${sel.counterpart.title}. Set a price for ${it.title} in Custom Prices to see the ratio (you can still preview it).`;
            liveEl.style.color = '#f39c12';
            return;
        }

        const { min, max } = getRatioLimits();
        const { give, get, ratio } = itemTradeRatio(it, sel.qty, sel.counterpart, sel.extra);
        const ok = ratio >= min && ratio <= max;
        const giveTxt = it.isMine ? itemSide : sel.counterpart.title;
        const getTxt = it.isMine ? sel.counterpart.title : itemSide;
        liveEl.innerHTML = `You Give ${esc(giveTxt)} ($${give.toFixed(2)}) ⇄ They Give ${esc(getTxt)} ($${get.toFixed(2)}) — <b>Ratio: ${ratio.toFixed(2)}</b>${ok ? '' : ` (outside ${min}–${max})`}`;
        liveEl.style.color = ok ? '#28a745' : '#f39c12';
    }

    // Only one offer can be previewed at a time: selecting something clears selections elsewhere.
    // keepCardId = the 1:2 / 1:3 card whose picks should stay (null clears all card picks).
    function clearOtherSelections(keepCardId, keepTradeBox = null, keepItemBox = null, keepTrades = false) {
        if (!keepTrades) document.querySelectorAll('.st-trade-check:checked').forEach(cb => { if (cb !== keepTradeBox) cb.checked = false; });
        const touchedItems = new Set();
        document.querySelectorAll('.st-item-pick:checked').forEach(cb => {
            if (cb !== keepItemBox) { cb.checked = false; touchedItems.add(cb.dataset.itemCard); }
        });
        touchedItems.forEach(id => updateItemCard(id));
        renderedCards.forEach((card, id) => {
            if (id === keepCardId) return;
            const dom = cardDom(id);
            if (!dom || !dom.boxes.some(cb => cb.checked)) return;
            dom.boxes.forEach(cb => { cb.checked = false; });
            updateCardRatio(id);
            refreshCardRows(id);
        });
        refreshTradeSelection();
    }

    // ---------- Selecting several whole trades (1:1 etc.) for one combined offer ----------
    let tradeGroupSeq = 0;
    const keyIds = new WeakMap();
    let keySeq = 0;
    const tradeKeyCache = new Map();
    function selKey(side, g) {
        const o = g.element || g.checkbox || (g.baseId !== undefined ? 'b' + g.baseId : g.title);
        if (typeof o !== 'object') return side + ':' + o;
        if (!keyIds.has(o)) keyIds.set(o, ++keySeq);
        return side + ':' + keyIds.get(o);
    }
    const tradeById = id => tradeMap.get(id);
    function tradeKeysOf(t) {
        if (!tradeKeyCache.has(t.id)) tradeKeyCache.set(t.id, new Set([...t.myGames.map(g => selKey('m', g)), ...t.theirGames.map(g => selKey('t', g))]));
        return tradeKeyCache.get(t.id);
    }
    const SEL_HINT = "Tick one trade, or several that don't share a game: they go into one offer together. Preview unticks everything else on the page and opens the site's offer preview.";

    // Ticking a trade: drops any picks in the 1:2 / item sections, and unticks trades that use the same game
    // (so each group is "choose 1 out of x")
    function onTradeToggled(cb) {
        if (cb.checked) {
            clearOtherSelections(null, null, null, true);
            const me = tradeById(cb.getAttribute('data-trade-id'));
            const mine = me ? tradeKeysOf(me) : new Set();
            document.querySelectorAll('.st-trade-check:checked').forEach(o => {
                if (o === cb) return;
                const other = tradeById(o.getAttribute('data-trade-id'));
                const sameGroup = o.dataset.group && o.dataset.group === cb.dataset.group;
                if (sameGroup || (other && [...tradeKeysOf(other)].some(k => mine.has(k)))) o.checked = false;
            });
        }
        refreshTradeSelection();
    }

    function refreshTradeSelection() {
        const sum = byId('st-sel-summary');
        if (!sum) return;
        const all = [...document.querySelectorAll('.st-trade-check')];
        const checked = all.filter(cb => cb.checked);
        const used = new Set(), groups = new Set();
        let give = 0, get = 0, n = 0;
        checked.forEach(cb => {
            const t = tradeById(cb.getAttribute('data-trade-id'));
            if (!t) return;
            n++;
            groups.add(cb.dataset.group);
            tradeKeysOf(t).forEach(k => used.add(k));
            give += t.myGames.reduce((x, g) => x + g.price, 0);
            get += t.theirGames.reduce((x, g) => x + g.price, 0);
        });
        // Dim options that clash with the current picks (they swap in if clicked)
        all.forEach(cb => {
            const box = cb.closest('label') || cb.parentElement;
            let dim = false;
            if (n && !cb.checked && !groups.has(cb.dataset.group)) {
                const t = tradeById(cb.getAttribute('data-trade-id'));
                dim = !!t && [...tradeKeysOf(t)].some(k => used.has(k));
            }
            const op = dim ? '0.4' : '';
            if (box.style.opacity !== op) box.style.opacity = op;
            box.title = dim ? 'Shares a game with a trade you already ticked. Clicking it swaps that trade out.' : '';
        });
        if (!n) { sum.style.color = '#aaa'; sum.textContent = SEL_HINT; return; }
        const { min, max } = getRatioLimits();
        const r = give > 0 ? get / give : 0;
        sum.style.color = r >= min && r <= max ? '#28a745' : '#f39c12';
        sum.textContent = `${n} trade${n === 1 ? '' : 's'} selected: You Give $${give.toFixed(2)} ⇄ They Give $${get.toFixed(2)} (Ratio ${r.toFixed(2)})`;
    }

    // Ticks the best trade of every group (closest to 1.00), never using one game twice
    function autoPickBest() {
        clearOtherSelections(null, null, null, false);
        const cand = [...document.querySelectorAll('.st-trade-check')]
            .map(cb => ({ cb, t: tradeById(cb.getAttribute('data-trade-id')) }))
            .filter(x => x.t && x.t.type === '1:1 Trade')
            .sort((a, b) => closeness(a.t.ratio) - closeness(b.t.ratio));
        const used = new Set(), groups = new Set();
        let n = 0;
        cand.forEach(({ cb, t }) => {
            if (groups.has(cb.dataset.group)) return;
            const keys = tradeKeysOf(t);
            if ([...keys].some(k => used.has(k))) return;
            cb.checked = true;
            groups.add(cb.dataset.group);
            keys.forEach(k => used.add(k));
            n++;
        });
        refreshTradeSelection();
        const status = byId('st-status');
        if (status) status.innerText = n ? `Auto-picked ${n} trade${n === 1 ? '' : 's'}: the best of each group, no game used twice.` : 'No 1:1 trades to pick from.';
    }

    // ---------- 1:1 rows and groups ----------

    function renderOneToOneRow(t) {
        const myG = t.myGames[0], theirG = t.theirGames[0];
        return `<div style="margin-bottom: 8px;">
            <div style="font-size: 11px; font-weight: bold; color: #f39c12; margin-bottom: 3px;">⚡ Total Value: You Give $${t.myValue} ⇄ They Give $${t.theirValue} (Ratio: ${t.ratio})</div>
            <div style="display: flex; align-items: center; justify-content: space-between; background: #222235; padding: 8px 12px; border-radius: 6px; border: 1px solid #333;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <input type="checkbox" class="st-trade-check" data-trade-id="${t.id}" data-group="r${t.id}" style="width: 16px; height: 16px; cursor: pointer;">
                    <span style="color: #28a745; font-weight: bold;">${gameLink(myG)} ${pTag(myG.title, myG.price)}</span>
                </div>
                <span style="color: #aaa;">⇄</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="color: #e74c3c; font-weight: bold;">${gameLink(theirG)} ${pTag(theirG.title, theirG.price)}</span>
                    <span style="font-size: 10px; color: #4e9af1; background: #33334d; padding: 2px 5px; border-radius: 3px;">Ratio: ${t.ratio}</span>
                </div>
            </div>
        </div>`;
    }

    // One game on one side, a pick-one list of the games it can be swapped for on the other
    function renderOneToOneGroup(g, optionLimit) {
        const gid = 'g' + (++tradeGroupSeq);
        const fixed = g.fixed;
        const shown = g.trades;
        const { min: rMin, max: rMax } = getRatioLimits();
        const ratios = g.trades.map(t => parseFloat(t.ratio));
        const lo = Math.min(...ratios).toFixed(2), hi = Math.max(...ratios).toFixed(2);
        const otherColor = g.byMine ? '#e74c3c' : '#28a745';

        const options = shown.map((t, i) => {
            const other = g.byMine ? t.theirGames[0] : t.myGames[0];
            return `<label class="st-opt" data-xtra="${i >= optionLimit ? 1 : 0}" style="display: ${i >= optionLimit ? 'none' : 'flex'}; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; background: #1a1a2b; padding: 6px 8px; border-radius: 4px; border: 1px solid #2a2a40; cursor: pointer;">
                <span style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                    <input type="checkbox" class="st-trade-check" data-trade-id="${t.id}" data-group="${gid}" style="width: 15px; height: 15px; cursor: pointer; flex: none;">
                    <span style="font-size: 12px; color: #fff;">${gameLink(other)} <span style="color: ${otherColor}; font-weight: bold;">${pTag(other.title, other.price)}</span></span>
                </span>
                <span style="font-size: 10px; color: #4e9af1; background: #33334d; padding: 2px 5px; border-radius: 3px; white-space: nowrap;">Ratio: ${t.ratio}</span>
            </label>`;
        }).join('') + (g.trades.length > optionLimit
            ? `<button type="button" class="st-opt-more" data-n="${g.trades.length - optionLimit}" data-open="0" style="width: 100%; padding: 5px; background: #2a2a40; color: #8ab4f8; border: 1px dashed #556; border-radius: 4px; cursor: pointer; font-size: 11px;" title="Every option here is inside your ratio range (${rMin}–${rMax}); the list just starts with the ones closest to 1.00.">Show ${g.trades.length - optionLimit} more (all inside your ${rMin}–${rMax} ratio, closest to 1.00 first)</button>` : '');

        const fixedBlock = `<div style="flex: 0 0 200px;">
            <div style="font-size: 10px; font-weight: bold; color: ${g.byMine ? '#28a745' : '#e74c3c'}; margin-bottom: 4px;">${g.byMine ? 'YOU GIVE:' : 'THEY GIVE:'}</div>
            <span style="color: ${g.byMine ? '#28a745' : '#e74c3c'}; font-weight: bold;">${gameLink(fixed)} ${pTag(fixed.title, fixed.price)}</span>
        </div>`;
        const listBlock = `<div class="st-opt-group" style="flex: 1; min-width: 0;">
            <div style="font-size: 10px; font-weight: bold; color: ${otherColor}; margin-bottom: 4px;">${g.byMine ? 'THEY GIVE' : 'YOU GIVE'} (PICK ONE, ${g.trades.length} OPTIONS):</div>
            ${options}
        </div>`;

        return `<div style="margin-bottom: 12px;">
            <div style="font-size: 11px; font-weight: bold; color: #f39c12; margin-bottom: 3px;">⚡ ${g.byMine ? 'You Give' : 'They Give'} $${fixed.price.toFixed(2)} for any of ${g.trades.length} games (Ratio: ${lo === hi ? lo : `${lo}–${hi}`})</div>
            <div style="display: flex; align-items: center; gap: 12px; background: #222235; padding: 10px 12px; border-radius: 6px; border: 1px solid #333;">
                ${g.byMine ? fixedBlock : listBlock}
                <span style="color: #aaa; font-size: 16px;">⇄</span>
                ${g.byMine ? listBlock : fixedBlock}
            </div>
        </div>`;
    }

    // ---------- Modal ----------

    function openTradeModal() {
        const existingModal = byId('st-trade-modal');
        if (existingModal) existingModal.remove();
        renderedCards = new Map();
        itemCardMap = new Map();
        tradeKeyCache.clear();

        const modal = document.createElement('div');
        modal.id = 'st-trade-modal';
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 2147483648;
            width: 1000px;
            max-width: 95vw;
            max-height: 85vh;
            background: #181824;
            color: #fff;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.9);
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            border: 1px solid #4e9af1;
            text-align: left;
        `;

        // Display limits so big (open) scans stay fast; everything is sorted best-first, so only the weakest are hidden
        const LIST_LIMIT = 100, CARD_LIMIT = 30, OPTION_LIMIT = 15;
        const limitNote = (shown, total, what) => `<div style="font-size: 11px; color: #888; margin: -4px 0 8px;">Showing the best ${shown} of ${total} ${what}.</div>`;

        const typeOrder = ["1:1 Trade", "1:2 Trade", "1:3 Trade", "2:1 Trade", "3:1 Trade", "2:2 Trade", "2:3 Trade"];
        const typeGroups = {};
        typeOrder.forEach(t => typeGroups[t] = []);
        typeGroups["Multi-Game Trades"] = [];

        matchedTradeQueue.forEach(trade => {
            (typeGroups[trade.type] || typeGroups["Multi-Game Trades"]).push(trade);
        });

        const parts = [`
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 15px;">
                <h2 style="margin: 0; font-size: 16px; color: #4e9af1;">🤝 Available Trade Matches (${matchedTradeQueue.length}${itemTradeCards.length ? ` + ${itemTradeCards.length} item` : ''})</h2>
                <button id="st-close-modal" style="background: transparent; border: none; color: #aaa; font-size: 18px; cursor: pointer;">✖</button>
            </div>
            <div style="overflow-y: auto; flex-grow: 1; padding-right: 5px;">
        `];

        if (matchedTradeQueue.length === 0 && itemTradeCards.length === 0) {
            parts.push(`<div style="text-align: center; padding: 30px; color: #888;">No valid trade matches found within ratio limits.</div>`);
        } else {
            Object.keys(typeGroups).forEach(tradeType => {
                const trades = typeGroups[tradeType];
                if (trades.length === 0) return;

                // Sort every section so the ratio closest to 1.00 comes first
                trades.sort((a, b) => closeness(a.ratio) - closeness(b.ratio));

                // 1:2 / 1:3 layout (you give 1, they give 2+): one group per your game, higher/lower value columns, best combos + live ratio
                // 2:1 / 3:1 (they give 1): the same cards, mirrored – their game fixed, your games to pick from
                const isOneToMany = /^1:\d+ Trade$/.test(tradeType) && tradeType !== "1:1 Trade";
                const isManyToOne = /^\d+:1 Trade$/.test(tradeType) && tradeType !== "1:1 Trade";
                if (isOneToMany || isManyToOne) {
                    const cards = buildOneToManyCards(trades, isManyToOne);
                    const whose = isManyToOne ? 'their' : 'your';
                    parts.push(`<h4 style="margin: 15px 0 8px 0; color: #f39c12; border-bottom: 1px solid #444; padding-bottom: 4px;">${tradeType}s (${trades.length} combos for ${cards.length} of ${whose} game${cards.length > 1 ? 's' : ''})</h4>`);
                    cards.slice(0, CARD_LIMIT).forEach(card => parts.push(renderOneToManyCard(card)));
                    if (cards.length > CARD_LIMIT) parts.push(limitNote(CARD_LIMIT, cards.length, 'groups'));
                    return;
                }

                parts.push(`<h4 style="margin: 15px 0 8px 0; color: #f39c12; border-bottom: 1px solid #444; padding-bottom: 4px;">${tradeType}s (${trades.length})</h4>`);
                if (trades.length > LIST_LIMIT && tradeType !== "2:1 Trade" && tradeType !== "1:1 Trade") parts.push(limitNote(LIST_LIMIT, trades.length, 'trades'));

                // 1:1 Trade layout: "You Give" always on left with checkbox on far left, ⇄ in middle, "They Give" on right
                if (tradeType === "1:1 Trade") {
                    // Group trades that share a game: each trade joins the bigger group of its two games
                    const myCount = new Map(), theirCount = new Map();
                    trades.forEach(t => {
                        const mk = rowKey(t.myGames[0]), tk = rowKey(t.theirGames[0]);
                        myCount.set(mk, (myCount.get(mk) || 0) + 1);
                        theirCount.set(tk, (theirCount.get(tk) || 0) + 1);
                    });
                    const groups = new Map(); // trades are sorted best-first, so groups come out best-first too
                    trades.forEach(t => {
                        const mk = rowKey(t.myGames[0]), tk = rowKey(t.theirGames[0]);
                        const byMine = myCount.get(mk) >= theirCount.get(tk);
                        const gk = byMine ? `m:${mk}` : `t:${tk}`;
                        if (!groups.has(gk)) groups.set(gk, { byMine, fixed: byMine ? t.myGames[0] : t.theirGames[0], trades: [] });
                        groups.get(gk).trades.push(t);
                    });
                    const list = [...groups.values()];
                    if (list.length > LIST_LIMIT) parts.push(limitNote(LIST_LIMIT, list.length, 'groups'));
                    list.slice(0, LIST_LIMIT).forEach(g => {
                        parts.push(g.trades.length === 1 ? renderOneToOneRow(g.trades[0]) : renderOneToOneGroup(g, OPTION_LIMIT));
                    });
                    return;
                }

                // General fallback for other trades
                trades.slice(0, LIST_LIMIT).forEach(t => {
                    const myTitles = t.myGames.map(g => `${gameLink(g)} ${pTag(g.title, g.price)}`).join(' + ');
                    const theirTitles = t.theirGames.map(g => `${gameLink(g)} ${pTag(g.title, g.price)}`).join(' + ');
                    parts.push(`<div style="margin-bottom: 8px;">
                        <div style="font-size: 11px; font-weight: bold; color: #f39c12; margin-bottom: 3px;">⚡ Total Value: You Give $${t.myValue} ⇄ They Give $${t.theirValue} (Ratio: ${t.ratio})</div>
                        <div style="display: flex; align-items: center; justify-content: space-between; background: #222235; padding: 8px 12px; border-radius: 6px; border: 1px solid #333;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <input type="checkbox" class="st-trade-check" data-trade-id="${t.id}" data-group="r${t.id}" style="width: 16px; height: 16px; cursor: pointer;">
                                <span style="color: #28a745; font-weight: bold;">${myTitles}</span>
                            </div>
                            <span style="color: #aaa;">⇄</span>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="color: #e74c3c; font-weight: bold;">${theirTitles}</span>
                                <span style="font-size: 10px; color: #4e9af1; background: #33334d; padding: 2px 5px; border-radius: 3px;">Ratio: ${t.ratio}</span>
                            </div>
                        </div>
                    </div>`);
                });
            });
        }

        // Item Trades: keys and other non-game items, shown regardless of ratio, with adjustable quantity
        if (itemTradeCards.length) {
            parts.push(`<h4 style="margin: 20px 0 4px 0; color: #f39c12; border-bottom: 1px solid #444; padding-bottom: 4px;">🔑 Item Trades (${itemTradeCards.length})</h4>
                <div style="font-size: 11px; color: #888; margin-bottom: 8px;">Keys and other non-game items. Shown whatever the ratio. Change the quantity or add a game to bring the ratio closer to 1.00.</div>`);
            itemTradeCards.forEach((card, i) => parts.push(renderItemTradeCard(card, i)));
        }

        parts.push(`
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #333; padding-top: 12px; margin-top: 15px;">
                <span id="st-sel-summary" style="font-size: 12px; color: #aaa; padding-right: 12px;">${SEL_HINT}</span>
                <span style="display: flex; gap: 8px; flex: none;">
                    <button id="st-autopick-btn" title="Tick the best trade in every group, never using one game twice" style="padding: 8px 12px; background: #6c5ce7; color: #fff; border: none; font-weight: bold; border-radius: 4px; cursor: pointer; white-space: nowrap;">✨ Auto-pick best</button>
                    <button id="st-clear-sel-btn" style="padding: 8px 12px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Clear</button>
                    <button id="st-execute-trades-btn" style="padding: 8px 16px; background: #28a745; color: #fff; border: none; font-weight: bold; border-radius: 4px; cursor: pointer; white-space: nowrap;">👁 Preview</button>
                </span>
            </div>
        `);

        modal.innerHTML = parts.join('');
        document.body.appendChild(modal);

        byId('st-close-modal').onclick = () => modal.remove();

        // Steam / gg links: open in a new tab and don't tick/untick the row they sit in (capture phase, before the label acts)
        modal.addEventListener('click', handleLookupClick, true);

        // One delegated click handler
        modal.addEventListener('click', e => {
            const t = e.target;
            if (!t.closest) return;
            const more = t.closest('.st-opt-more');
            if (more) {
                const open = more.dataset.open !== '1';
                more.dataset.open = open ? '1' : '0';
                more.closest('.st-opt-group').querySelectorAll('.st-opt[data-xtra="1"]').forEach(r => { r.style.display = open ? 'flex' : 'none'; });
                more.textContent = open ? 'Show fewer' : `Show ${more.dataset.n} more (all inside your ratio, closest to 1.00 first)`;
                return;
            }
            const band = t.closest('.st-band');
            if (band) {
                band.dataset.open = band.dataset.open === '1' ? '0' : '1';
                refreshCardRows(band.dataset.cardId);
                return;
            }
            const combo = t.closest('.st-combo');
            if (combo) applyCombo(combo.dataset.cardId, +combo.dataset.comboIdx);
        });

        // One delegated change handler: selection + live ratio, item quantity / extra game
        modal.addEventListener('change', e => {
            const t = e.target;
            if (!t.classList) return;
            if (t.classList.contains('st-trade-check')) onTradeToggled(t);
            else if (t.classList.contains('st-pick')) {
                if (t.checked) clearOtherSelections(t.dataset.cardId);
                refreshCardRows(t.dataset.cardId);
                updateCardRatio(t.dataset.cardId);
            } else if (t.classList.contains('st-item-pick')) {
                if (t.checked) clearOtherSelections(null, null, t);
                updateItemCard(t.dataset.itemCard);
            } else if (t.classList.contains('st-item-qty') || t.classList.contains('st-item-extra')) {
                renderItemList(t.dataset.itemCard);
            }
        });

        modal.addEventListener('input', e => {
            if (e.target.classList && e.target.classList.contains('st-filter')) refreshCardRows(e.target.dataset.cardId);
        });

        itemCardMap.forEach((_, id) => renderItemList(id));
        renderedCards.forEach((_, id) => refreshCardRows(id));

        byId('st-execute-trades-btn').onclick = previewSelectedTrade;
        byId('st-autopick-btn').onclick = autoPickBest;
        byId('st-clear-sel-btn').onclick = () => { clearOtherSelections(null); };
    }

    // Finds the site's own "Preview offer" button (never one of ours)
    function findPreviewButton() {
        const exact = document.querySelector('#new-offer button.preview-offer, button.preview-offer');
        if (exact) return exact;
        const panel = byId('smart-trade-panel');
        const candidates = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a')]
            .filter(el => !(panel && panel.contains(el)) && !el.closest('#st-trade-modal'))
            .filter(el => /preview/i.test((el.value || el.textContent || '').trim()));
        return candidates.find(el => /preview\s*offer/i.test(el.value || el.textContent)) || candidates[0] || null;
    }

    // Every game checkbox on both sides of the page (unique)
    function getAllPageGameCheckboxes() {
        const boxes = new Set();
        [true, false].forEach(side => getSideElements(side).forEach(el => {
            const cb = el.querySelector('input[type="checkbox"]') || el.closest('tr, li')?.querySelector('input[type="checkbox"]');
            if (cb) boxes.add(cb);
        }));
        return boxes;
    }

    async function previewSelectedTrade() {
        const modal = byId('st-trade-modal');
        let myGames = null, theirGames = null;

        // Either one or several whole trades (1:1, 2:1, …) or the picks of one 1:2 / 1:3 card
        const tradeBoxes = [...document.querySelectorAll('.st-trade-check:checked')];
        const picks = [...document.querySelectorAll('.st-pick:checked')];
        const itemBox = document.querySelector('.st-item-pick:checked');

        if (tradeBoxes.length) {
            // one or several whole trades: they all go into the same offer
            myGames = []; theirGames = [];
            tradeBoxes.forEach(cb => {
                const trade = tradeById(cb.getAttribute('data-trade-id'));
                if (trade) { myGames.push(...trade.myGames); theirGames.push(...trade.theirGames); }
            });
        } else if (picks.length) {
            const card = renderedCards.get(picks[0].dataset.cardId);
            if (card) {
                const picked = picks.filter(cb => cb.dataset.cardId === card.id).map(cb => card.gameList[+cb.dataset.gameIdx]);
                if (card.mirror) { myGames = picked; theirGames = [card.fixed]; }
                else { myGames = [card.fixed]; theirGames = picked; }
            }
        } else if (itemBox) {
            // Item trade: the item repeated qty times (preview sets the amount), plus optional extra game
            const sel = readItemCard(itemBox.dataset.itemCard); // counterpart = the picked game
            if (sel && sel.counterpart) {
                const itemSide = [...Array(sel.qty).fill(sel.card.item), ...(sel.extra ? [sel.extra] : [])];
                if (sel.card.item.isMine) { myGames = itemSide; theirGames = [sel.counterpart]; }
                else { myGames = [sel.counterpart]; theirGames = itemSide; }
            }
        }

        if (!myGames || !theirGames || !theirGames.length || !myGames.length) {
            alert("Please pick a trade, an item trade, or tick games in one group to preview.");
            return;
        }

        modal.remove();
        await setupOfferOnPage(myGames, theirGames);
    }

    // Unticks everything else, ticks exactly these games/items (with amounts) and clicks Preview offer.
    // Used by the results window and by "Prepare offer" from the Match Radar.
    async function setupOfferOnPage(myGames, theirGames) {
        autoBusy = true;
        saveAutoIds(new Set([...myGames, ...theirGames].map(g => g.checkbox && g.checkbox.value).filter(Boolean)));
        try { await setupOfferOnPageInner(myGames, theirGames); } finally { autoBusy = false; }
    }
    async function setupOfferOnPageInner(myGames, theirGames) {
        const status = byId('st-status') || { innerText: '' };
        status.innerText = "Setting up the offer...";

        const allGames = [...myGames, ...theirGames];

        // Group copies of the same page row: row element -> how many we need
        const rows = new Map();
        allGames.forEach(g => {
            const key = g.element || g;
            if (!rows.has(key)) rows.set(key, { game: g, count: 0 });
            rows.get(key).count++;
        });

        const wanted = new Set(allGames.map(g => g.checkbox).filter(Boolean));
        const wantedRows = new Set([...rows.keys()]);
        const missing = [];
        const amountWarnings = [];

        const fire = el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const setQty = (ctrl, n) => {
            if (ctrl.tagName === 'SELECT') {
                const opt = [...ctrl.options].find(o => parseInt(o.value || o.textContent, 10) === n);
                if (!opt) return false;
                ctrl.value = opt.value;
            } else {
                ctrl.value = String(n);
            }
            fire(ctrl);
            return true;
        };

        qtyMap.t = 0;
        // 1. Untick every other game/item on the page (and zero out other amount selectors)
        for (const cb of getAllPageGameCheckboxes()) {
            if (cb.checked && !wanted.has(cb)) {
                cb.click();
                await sleep(40);
            }
        }
        [true, false].forEach(side => getSideElements(side).forEach(el => {
            if (wantedRows.has(el) || getRowCheckbox(el)) return;
            const ctrl = getQtyControl(el);
            if (ctrl && parseInt(ctrl.value, 10) > 0) {
                const min = ctrl.getAttribute && ctrl.getAttribute('min');
                if (ctrl.tagName === 'SELECT' || min === null || min === '' || +min <= 0) setQty(ctrl, 0);
            }
        }));

        // 2. Tick exactly this trade's games/items and set amounts
        document.querySelectorAll('input.st-amount').forEach(i => i.remove()); // amounts from an earlier preview
        for (const { game, count } of rows.values()) {
            if (!game.checkbox && !(game.element && getQtyControl(game.element))) {
                missing.push(game.title);
                continue;
            }
            if (game.checkbox && !game.checkbox.checked) {
                game.checkbox.click();
                await sleep(80);
            }
            // Look again after ticking: the site may add its own amount field now
            qtyMap.t = 0;
            const ctrl = game.element ? getQtyControl(game.element) : game.qtyControl;
            if (ctrl) {
                if (!setQty(ctrl, count)) amountWarnings.push(`${game.title} ×${count}`);
            } else if (count > 1) {
                // No amount field on the page: send Lestrade's amount[ID] with the form ourselves
                const form = byId('new-offer');
                const id = game.checkbox?.value;
                if (form && id) {
                    const hidden = document.createElement('input');
                    hidden.type = 'hidden';
                    hidden.className = 'st-amount';
                    hidden.name = `amount[${id}]`;
                    hidden.value = String(count);
                    form.appendChild(hidden);
                } else {
                    amountWarnings.push(`${game.title} ×${count}`);
                }
            }
        }

        if (missing.length) {
            status.innerText = `Couldn't find a checkbox for: ${missing.join(', ')}. Tick it yourself, then click Preview offer.`;
            return;
        }
        if (amountWarnings.length) {
            status.innerText = `Couldn't set the amount for: ${amountWarnings.join(', ')}. Set it yourself, then click Preview offer.`;
            return;
        }

        // 3. Open the site's preview
        await sleep(250);
        const previewBtn = findPreviewButton();
        if (!previewBtn) {
            status.innerText = "Games ticked, but the Preview offer button wasn't found. Click it on the page yourself.";
            return;
        }
        const label = list => {
            const counts = new Map();
            list.forEach(g => counts.set(g.title, (counts.get(g.title) || 0) + 1));
            return [...counts].map(([t, n]) => n > 1 ? `${t} ×${n}` : t).join(' + ');
        };
        status.innerText = `Opening preview: ${label(myGames)} ⇄ ${label(theirGames)}`;
        previewBtn.click();
    }

    // =====================================================================
    // Match Radar: /matches/ pages (one trader or the big list of everyone)
    // =====================================================================

    const RADAR_KEY = 'st_radar_settings';
    const radarSettings = Object.assign(
        { min: 0.7, max: 1.3, maxSide: 2, hideShady: true, skipLocked: false, onlyItems: false, onlyGames: false, sort: 'best', search: '' },
        GM_getValue(RADAR_KEY, {})
    );
    let radarTraders = [];
    let radarTab = 'traders';
    let radarItemResults = [];
    const radarItemChoice = { id: '', qty: 1 };
    const radarTheirChoice = { id: '', qty: 1 };
    let radarFind = '', radarPrevTab = null;
    let radarItemShown = 25, radarItemSort = 'fit', radarItemFilter = '', radarTraderShown = 40;

    function saveRadarSettings() { GM_setValue(RADAR_KEY, radarSettings); }
    const hasValue = e => priceOf(e) > 0; // anything without a value is left out of the matches
    const radarShady = t => radarSettings.hideShady && t.shady;

    // Custom price wins over the site (GG.deals) price
    function priceOf(e) {
        const c = getCustomPrice(e.title);
        return c !== null ? c : e.sitePrice;
    }

    // One column of a trader's match table ("Wished" = theirs, "Tradables" = mine)
    function parseMatchCell(td, isMine) {
        const entries = new Map();
        if (!td) return { entries: [], more: null };
        td.querySelectorAll('a[href*="/game/"]').forEach(a => {
            if (a.closest('.cusnote, .show-more')) return;
            const m = (a.getAttribute('href') || '').match(/\/game\/(\d+)/);
            if (!m) return;
            const gameId = m[1];
            const title = a.textContent.replace(/\s+/g, ' ').trim();
            const gg = a.getAttribute('data-gg');
            const cents = gg ? parseInt(gg, 10) : NaN;
            const appid = a.getAttribute('data-appid');
            const subid = a.getAttribute('data-subid');

            // Tags after the link, up to the line break: amount, estimated value, notes, region locks…
            let qty = 1, cusval = null;
            const notes = [], flags = [], warns = [];
            for (let n = a.nextSibling; n && n.nodeName !== 'BR'; n = n.nextSibling) {
                if (n.nodeType !== 1) continue;
                if (n.matches('a[href*="/game/"]')) break;
                const cl = n.classList;
                if (cl.contains('qs')) { qty = parseInt(n.textContent.replace(/\D/g, ''), 10) || 1; continue; }
                if (cl.contains('qinf')) continue;
                if (cl.contains('cusval')) { cusval = parseFloat(n.textContent.replace(/[^\d.]/g, '')) || null; continue; }
                if (cl.contains('cusnote')) {
                    const t = n.textContent.replace(/\s+/g, ' ').trim();
                    if (t) notes.push({ text: t, byThem: cl.contains('tag-want') });
                    continue;
                }
                if (cl.contains('cred')) { warns.push(n.textContent.replace(/\s+/g, ' ').trim()); continue; }
                n.querySelectorAll('span[title]').forEach(sp => flags.push(sp.textContent.replace(/\s+/g, ' ').trim()));
            }

            if (entries.has(gameId)) { entries.get(gameId).amount += qty; return; } // listed twice = more copies
            entries.set(gameId, {
                gameId, title, isMine,
                sitePrice: cents > 0 ? cents / 100 : 0,
                isGame: !!(gg || appid || subid),
                amount: qty, cusval, notes, flags, warns,
                ggu: a.getAttribute('data-ggu') || null,
                locked: flags.some(f => /lock/i.test(f)),
                steamUrl: appid ? `https://store.steampowered.com/app/${appid}/` : subid ? `https://store.steampowered.com/sub/${subid}/` : null,
                lestradesUrl: new URL(a.getAttribute('href'), location.origin).href
            });
        });
        const more = td.querySelector('.show-more');
        const moreLink = more?.querySelector('a');
        return {
            entries: [...entries.values()],
            more: moreLink ? { url: new URL(moreLink.getAttribute('href'), location.origin).href, count: +((more.textContent.match(/(\d+)\s+more/) || [])[1] || 0) } : null
        };
    }

    function parseTraders(root) {
        return [...root.querySelectorAll('h1.trader')].map((h1, idx) => {
            let table = h1.nextElementSibling;
            while (table && !table.matches('table.matches')) {
                if (table.matches('h1.trader')) { table = null; break; }
                table = table.nextElementSibling;
            }
            if (!table) return null;
            const offerA = h1.querySelector('a[href*="/offer/?u="]');
            const u = offerA ? ((offerA.getAttribute('href') || '').match(/u=(\d+)/) || [])[1] : null;
            const profA = h1.querySelector('a[href^="/@"]');
            const text = h1.textContent.replace(/\s+/g, ' ');
            const rows = table.querySelectorAll('tr');
            const cells = rows[0] ? rows[0].children : [];
            const theirs = parseMatchCell(cells[0], false);
            const mine = parseMatchCell(cells[1], true);
            return {
                idx, u, h1,
                name: profA ? profA.textContent.trim() : `User ${u}`,
                profile: profA ? new URL(profA.getAttribute('href'), location.origin).href : null,
                done: +((text.match(/\((\d+) offers? completed/) || [])[1] || 0),
                last: ((text.match(/last (.+?)\)/) || [])[1] || '').trim(),
                status: (h1.querySelector('.ggd')?.getAttribute('title') || '').replace('Trader status: ', ''),
                balance: (text.match(/Lest balance: \$([\d.]+)/) || [])[1] || null,
                shady: /Didn't set a trader status/.test(text) || table.classList.contains('hide'),
                history: rows[1] ? rows[1].textContent.replace(/\s+/g, ' ').trim() : '',
                theirs: theirs.entries, mine: mine.entries,
                theirsMore: theirs.more, mineMore: mine.more,
                host: cells[1] || table, // where our badge lives: never inside the site's own header
                deep: false, deals: [], families: [], dealCount: 0, closest: null,
                stale: true, _keys: null
            };
        }).filter(t => t && t.u);
    }

    // Normalised titles a trader's lists contain (lets a price edit recompute only the traders it touches)
    function traderTitleKeys(t) {
        if (!t._keys) t._keys = new Set([...t.mine, ...t.theirs].map(e => normTitle(e.title)));
        return t._keys;
    }

    // Everything one side could put in a trade: single games, item amounts, and (optionally) pairs
    function bundleOptions(entries, maxSide, filter) {
        const singles = [];
        entries.forEach(e => {
            const p = priceOf(e);
            if (!(p > 0) || (filter && !filter(e))) return;
            if (radarSettings.onlyGames && !e.isGame) return;
            const maxQ = e.isGame ? 1 : Math.min(e.amount || 1, 10);
            for (let q = 1; q <= maxQ; q++) singles.push({ parts: [{ e, q }], value: p * q, hasItem: !e.isGame });
        });
        const out = singles.slice();
        if (maxSide >= 2 && singles.length <= 60) {
            for (let i = 0; i < singles.length; i++) {
                for (let j = i + 1; j < singles.length; j++) {
                    const a = singles[i], b = singles[j];
                    if (a.parts[0].e === b.parts[0].e) continue;
                    out.push({ parts: [a.parts[0], b.parts[0]], value: a.value + b.value, hasItem: a.hasItem || b.hasItem });
                }
            }
        }
        return out;
    }

    const bundleSig = b => b.parts.map(p => p.e.gameId + 'x' + p.q).sort().join('+');

    // Keeps the list narrow: per thing you give, a few single games first, and a pair only when it is very close to 1.00
    function pruneOptions(cands, maxSingles = 3, maxPairs = 2, pairTight = 0.08, sigOf = d => bundleSig(d.get)) {
        cands.sort((a, b) => a.score - b.score);
        const out = [], used = new Set();
        let singles = 0, pairs = 0;
        for (const d of cands) {
            const sig = sigOf(d);
            if (used.has(sig)) continue;
            if (d.get.parts.length + d.give.parts.length > 2) {
                if (pairs >= maxPairs || closeness(d.ratio) > pairTight) continue;
                pairs++;
            } else {
                if (singles >= maxSingles) continue;
                singles++;
            }
            used.add(sig);
            out.push(d);
        }
        return out;
    }

    function computeTraderDeals(t) {
        const { min, max } = getRatioLimits();
        const maxSide = radarSettings.maxSide;
        const give = bundleOptions(t.mine, maxSide);
        const get = bundleOptions(t.theirs, maxSide, e => !(radarSettings.skipLocked && e.locked)).sort((a, b) => a.value - b.value);
        const values = new Float64Array(get.map(g => g.value));
        const families = [];
        let closest = null;

        for (const g of give) {
            if (!(g.value > 0)) continue;
            const lo = g.value * min, hi = g.value * max;
            const i = lowerBound(values, lo);
            const cands = [];
            for (let k = Math.max(0, i - 1); k < get.length && values[k] <= hi; k++) {
                const r = get[k].value / g.value;
                const deal = { give: g, get: get[k], ratio: r };
                if (!closest || closeness(r) < closeness(closest.ratio)) closest = deal;
                if (r < min || r > max) continue;
                if (radarSettings.onlyItems && !g.hasItem && !get[k].hasItem) continue;
                deal.score = closeness(r) + 0.04 * (g.parts.length + get[k].parts.length - 2);
                cands.push(deal);
            }
            if (!closest && get.length) {
                const j = Math.min(i, get.length - 1);
                closest = { give: g, get: get[j], ratio: get[j].value / g.value };
            }
            const options = pruneOptions(cands);
            if (options.length) families.push({ give: g, options });
        }
        families.sort((a, b) => a.options[0].score - b.options[0].score);
        t.families = families.slice(0, 40);
        t.deals = t.families.flatMap(f => f.options); // flat list, in display order (Prepare buttons point into it)
        t.dealCount = t.deals.length;
        t.closest = t.dealCount ? null : closest;
        t.stale = false;
    }

    // scope: undefined = every trader (settings changed), a normalised title = only traders listing it (price edit),
    // 'stale' = only traders that were loaded but not computed yet
    function radarRecompute(scope) {
        radarTraders.forEach(t => {
            if (scope === undefined || (scope === 'stale' ? t.stale : traderTitleKeys(t).has(scope))) computeTraderDeals(t);
        });
        updateRadarBadges();
        renderRadarPriceList();
        const visible = radarTraders.filter(t => !radarShady(t));
        const withDeals = visible.filter(t => t.dealCount);
        const status = byId('st-status');
        if (status) status.innerText = `${withDeals.length} of ${visible.length} traders have trades in your ratio.`;
        if (byId('st-trade-modal')) renderRadarBody();
    }

    // ---------- Badges next to each trader on the page ----------

    function updateRadarBadges() {
        radarTraders.forEach(t => {
            // The badge floats in the top-right corner of the trader's table. It is absolutely positioned, so it takes no
            // space and the site's header (Send Offer / Skip …) keeps its original layout.
            const host = t.host || t.h1;
            let b = host.querySelector(':scope > .st-radar-badge');
            if (!b) {
                b = document.createElement('span');
                b.className = 'st-radar-badge';
                b.style.cssText = 'position:absolute; top:6px; right:10px; z-index:3; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold; cursor:pointer; font-family:sans-serif; white-space:nowrap; line-height:1.4;';
                b.addEventListener('click', e => { e.preventDefault(); openRadarModal('traders', t.u); });
                if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
                host.appendChild(b);
            }
            const best = t.deals[0];
            if (t.dealCount) {
                b.textContent = `📡 ${t.dealCount} trade${t.dealCount === 1 ? '' : 's'} · best ${best.ratio.toFixed(2)}`;
                b.style.background = '#1e6b34'; b.style.color = '#fff';
            } else {
                b.textContent = t.closest ? `📡 none in ratio (closest ${t.closest.ratio.toFixed(2)})` : '📡 no priced trade';
                b.style.background = '#444'; b.style.color = '#ccc';
            }
            b.title = t.dealCount ? 'Open this trader in Match Radar' : 'No trade inside your ratio range';
        });
    }

    // ---------- Floating panel ----------

    // Everything on this page that needs (or has) a custom price. Saved prices for games that aren't
    // on this page stay stored, they're just not listed here.
    function radarPriceRows(showAll) {
        const map = new Map();
        radarTraders.forEach(t => [...t.mine, ...t.theirs].forEach(e => {
            const k = normTitle(e.title);
            if (!map.has(k)) map.set(k, { title: e.title, isGame: e.isGame, sitePrice: e.sitePrice, traders: new Set(), amount: e.amount });
            const r = map.get(k);
            r.sitePrice = r.sitePrice || e.sitePrice;
            r.isGame = r.isGame || e.isGame;
            r.traders.add(t.u);
        }));
        return [...map.values()]
            .map(r => ({ ...r, custom: getCustomPrice(r.title) }))
            .filter(r => showAll || r.sitePrice <= 0 || r.custom !== null || !r.isGame)
            .sort((a, b) => {
                const an = a.sitePrice <= 0 && a.custom === null, bn = b.sitePrice <= 0 && b.custom === null;
                return an !== bn ? (an ? -1 : 1) : a.title.localeCompare(b.title);
            });
    }

    function renderRadarPriceList() {
        const box = byId('st-radar-prices');
        if (!box) return;
        const showAll = byId('st-radar-allprices')?.checked;
        const rows = radarPriceRows(showAll);
        const missing = rows.filter(r => r.sitePrice <= 0 && r.custom === null).length;
        box.innerHTML = rows.length ? (missing ? `<div style="color:#f39c12; font-size:11px; padding:2px 0;">${missing} without a price (left out of the matches until you set one)</div>` : '') + rows.map(r => {
            const needs = r.sitePrice <= 0 && r.custom === null;
            return `<div style="display:flex; align-items:center; gap:5px; margin-top:3px;">
                <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${needs ? '#f39c12' : '#fff'};" title="${esc(r.title)}">${r.isGame ? '' : '🔑 '}${esc(r.title)}</span>
                <span style="font-size:10px; color:#888;" title="Traders on this page with it">${r.traders.size}</span>
                <span style="color:#aaa;">$</span>
                <input type="number" step="0.01" min="0" class="st-radar-price" data-title="${esc(r.title)}" value="${r.custom !== null ? r.custom : ''}" placeholder="${r.sitePrice > 0 ? r.sitePrice.toFixed(2) : 'price'}"
                    style="width:66px; background:#1a1a2b; color:#fff; border:1px solid ${needs ? '#f39c12' : '#555'}; border-radius:4px; padding:3px;">
            </div>`;
        }).join('') : '<div style="color:#777;">Every game on this page has a price. Tick "All" to override one.</div>';
    }

    function initRadar() {
        if (byId('smart-trade-panel')) return;
        radarTraders = parseTraders(document);

        const panel = document.createElement('div');
        panel.id = 'smart-trade-panel';
        panel.style.cssText = 'position:fixed; top:80px; right:20px; z-index:2147483647; width:290px; background:#1e1e2f; color:#fff; padding:12px 14px; border-radius:8px; box-shadow:0 5px 20px rgba(0,0,0,0.8); font-family:sans-serif; font-size:12px; border:1px solid #555;';
        const inp = 'width:100%; background:#1a1a2b; color:#fff; border:1px solid #555; border-radius:4px; padding:4px;';
        panel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <b style="font-size:14px; color:#4e9af1;">📡 Match Radar</b>
                <button id="st-radar-min" title="Minimise" style="background:none; border:none; color:#aaa; cursor:pointer; font-size:16px;">–</button>
            </div>
            <div id="st-radar-panel-body">
                <div id="st-radar-count" style="color:#aaa; margin:4px 0 8px;">${radarTraders.length} trader${radarTraders.length === 1 ? '' : 's'} on this page. Ratio = what you get ÷ what you give.</div>
                <div style="display:flex; gap:8px;">
                    <label style="flex:1;">Min ratio<input id="st-min-ratio" type="number" step="0.05" value="${radarSettings.min}" style="${inp}"></label>
                    <label style="flex:1;">Max ratio<input id="st-max-ratio" type="number" step="0.05" value="${radarSettings.max}" style="${inp}"></label>
                </div>
                <label style="display:block; margin-top:6px;">Games per side
                    <select id="st-radar-side"><option value="1">1 (simple swaps)</option><option value="2">up to 2</option></select>
                </label>
                <label style="display:flex; align-items:center; margin-top:6px; cursor:pointer;"><input type="checkbox" id="st-radar-shady">Hide traders with no status / hidden lists</label>
                <label style="display:flex; align-items:center; margin-top:4px; cursor:pointer;"><input type="checkbox" id="st-radar-locked">Skip region-locked games</label>
                <label style="display:flex; align-items:center; margin-top:4px; cursor:pointer;"><input type="checkbox" id="st-radar-items">Only trades with keys / items</label>
                <label style="display:flex; align-items:center; margin-top:4px; cursor:pointer;" title="Leaves keys and other non-game items out completely"><input type="checkbox" id="st-radar-games">Only trades with games (no items)</label>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                    <b>Custom prices</b>
                    <label style="font-size:11px; color:#aaa; display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="st-radar-allprices">All</label>
                </div>
                <div id="st-radar-prices" style="max-height:170px; overflow-y:auto; background:#2a2a40; border:1px solid #444; border-radius:4px; padding:4px;"></div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:10px; width:100%; box-sizing:border-box;">
                    <button id="st-radar-open" style="grid-column:1 / -1; box-sizing:border-box; width:100%; margin:0; min-width:0; padding:8px; background:#4e9af1; color:#fff; border:none; font-weight:bold; border-radius:4px; cursor:pointer;">📡 Show trades</button>
                    <button id="st-radar-keys" style="box-sizing:border-box; width:100%; margin:0; min-width:0; padding:8px; background:#e67e22; color:#fff; border:none; font-weight:bold; border-radius:4px; cursor:pointer;">🔑 By my item</button>
                    <button id="st-radar-theirs" style="box-sizing:border-box; width:100%; margin:0; min-width:0; padding:8px; background:#8e44ad; color:#fff; border:none; font-weight:bold; border-radius:4px; cursor:pointer;">🎮 By their item</button>
                    <button id="st-radar-refresh" title="Forget the cached lists (kept 30 min) and load everything again. Use it after you change your own wishes or tradables." style="grid-column:1 / -1; box-sizing:border-box; width:100%; margin:0; min-width:0; padding:6px; background:#33334d; color:#8ab4f8; border:1px solid #556; border-radius:4px; cursor:pointer; font-size:11px;">↻ Refresh data (clear cache)</button>
                </div>
                <div id="st-status" style="margin-top:8px; font-style:italic; color:#aaa; text-align:center;"></div>
            </div>`;
        document.body.appendChild(panel);

        byId('st-radar-side').value = String(radarSettings.maxSide);
        byId('st-radar-shady').checked = radarSettings.hideShady;
        byId('st-radar-locked').checked = radarSettings.skipLocked;
        byId('st-radar-items').checked = radarSettings.onlyItems;
        byId('st-radar-games').checked = radarSettings.onlyGames;

        const onSettings = ev => {
            radarSettings.min = parseFloat(byId('st-min-ratio').value) || 0.7;
            radarSettings.max = parseFloat(byId('st-max-ratio').value) || 1.3;
            radarSettings.maxSide = +byId('st-radar-side').value;
            radarSettings.hideShady = byId('st-radar-shady').checked;
            radarSettings.skipLocked = byId('st-radar-locked').checked;
            // games-only and items-only exclude each other
            if (ev && ev.target && ev.target.id === 'st-radar-games' && byId('st-radar-games').checked) byId('st-radar-items').checked = false;
            if (ev && ev.target && ev.target.id === 'st-radar-items' && byId('st-radar-items').checked) byId('st-radar-games').checked = false;
            radarSettings.onlyItems = byId('st-radar-items').checked;
            radarSettings.onlyGames = byId('st-radar-games').checked;
            saveRadarSettings();
            radarRecompute();
            if (!radarSettings.hideShady) deepLoad(radarTraders); // lists of previously hidden traders were skipped
        };
        ['st-min-ratio', 'st-max-ratio', 'st-radar-side', 'st-radar-shady', 'st-radar-locked', 'st-radar-items', 'st-radar-games']
            .forEach(id => byId(id).addEventListener('change', onSettings));
        byId('st-radar-prices').addEventListener('change', e => {
            if (!e.target.classList.contains('st-radar-price')) return;
            const title = e.target.dataset.title;
            const raw = e.target.value.trim();
            let v = null;
            if (raw !== '') {
                v = parseFloat(raw);
                if (isNaN(v) || v < 0) { alert('Please enter a valid price (0 or higher).'); return; }
            }
            setCustomPrice(title, v);
            radarRecompute(normTitle(title));
        });
        byId('st-radar-allprices').addEventListener('change', renderRadarPriceList);
        afterPriceEdit = title => radarRecompute(normTitle(title));
        byId('st-radar-min').addEventListener('click', () => {
            const body = byId('st-radar-panel-body');
            const hide = body.style.display !== 'none';
            body.style.display = hide ? 'none' : '';
            byId('st-radar-min').textContent = hide ? '+' : '–';
        });
        byId('st-radar-open').addEventListener('click', () => openRadarModal('traders'));
        byId('st-radar-keys').addEventListener('click', () => openRadarModal('items'));
        byId('st-radar-theirs').addEventListener('click', () => openRadarModal('theirs'));
        byId('st-radar-refresh').addEventListener('click', async () => { await cacheClear(); location.reload(); });
        // /matches/?wid=ID (a game I want) or ?tid=ID (a game I have that they want): open the matching item view straight away
        const qs = new URLSearchParams(location.search);
        const wid = qs.get('wid'), tid = qs.get('tid');
        if (wid || tid) {
            if (wid) Object.assign(radarTheirChoice, { id: wid, qty: 1 }); else Object.assign(radarItemChoice, { id: tid, qty: 1 });
            setTimeout(() => openRadarModal(wid ? 'theirs' : 'items'), 700);
        }
        // Everything loads by itself: the other pages of the list, then each trader's full list
        cachePrune();
        setTimeout(() => { loadEverything(); }, 400);

        radarRecompute();
        if (radarPriceRows(false).some(r => r.sitePrice <= 0 && r.custom === null)) {
            byId('st-status').innerText += ' Items with no price are left out: set one under Custom prices to include them.';
        }
    }

    // ---------- Cache (IndexedDB) + polite fetching ----------
    // Fetched /matches/ pages and trader lists are kept for CACHE_TTL so a reload doesn't hit the server again.
    // Prices are NOT baked in: custom prices are applied live on top of the cached data.
    // Stale after you change your own wishes/tradables: use "Refresh data" in the panel.
    const CACHE_TTL = 30 * 60 * 1000, CACHE_VER = 1;
    let dbPromise = null;
    function cacheDb() {
        if (!dbPromise) {
            dbPromise = new Promise(res => {
                try {
                    const r = indexedDB.open('trade-scout', 1);
                    r.onupgradeneeded = () => r.result.createObjectStore('kv');
                    r.onsuccess = () => res(r.result);
                    r.onerror = r.onblocked = () => res(null);
                } catch (e) { res(null); }
            });
        }
        return dbPromise;
    }
    // Runs one request against the store; always resolves (null when IndexedDB is unavailable)
    async function cacheOp(mode, fn) {
        const db = await cacheDb();
        if (!db) return null;
        return new Promise(res => {
            try {
                const tx = db.transaction('kv', mode);
                const q = fn(tx.objectStore('kv'));
                if (q) { q.onsuccess = () => res(q.result === undefined ? null : q.result); q.onerror = () => res(null); }
                else tx.oncomplete = () => res(true);
                tx.onerror = tx.onabort = () => res(null);
            } catch (e) { res(null); }
        });
    }
    async function cacheGet(key) {
        const v = await cacheOp('readonly', st => st.get(key));
        return v && v.v === CACHE_VER && Date.now() - v.ts < CACHE_TTL ? v : null;
    }
    const cacheSet = (key, val) => cacheOp('readwrite', st => st.put({ v: CACHE_VER, ts: Date.now(), ...val }, key));
    const cacheClear = () => cacheOp('readwrite', st => st.clear());
    // Drops expired records (runs once when the radar starts)
    async function cachePrune() {
        const db = await cacheDb();
        if (!db) return;
        try {
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').openCursor().onsuccess = e => {
                const c = e.target.result;
                if (!c) return;
                if (!c.value || c.value.v !== CACHE_VER || Date.now() - c.value.ts >= CACHE_TTL) c.delete();
                c.continue();
            };
        } catch (e) { /* cache is optional */ }
    }

    // Only plain data goes into the cache (no DOM nodes, no computed deals)
    const slimTrader = t => ({
        idx: t.idx, u: t.u, name: t.name, profile: t.profile, done: t.done, last: t.last, status: t.status,
        balance: t.balance, shady: t.shady, history: t.history,
        theirs: t.theirs, mine: t.mine, theirsMore: t.theirsMore, mineMore: t.mineMore
    });
    const rehydrateTrader = r => Object.assign({}, r, {
        h1: document.createElement('h1'), // traders from other pages are not on this page anyway
        host: document.createElement('div'),
        deep: false, deals: [], families: [], dealCount: 0, closest: null, stale: true, _keys: null
    });

    // Fetch that slows down or stops when the server asks us to (429 / 503), instead of hammering it
    let radarAbort = false;
    // Request starts are spaced REQ_GAP apart across all workers (about 8 per second at most). The gap widens by itself
    // while the server answers slowly and shrinks back when it recovers. Cached data costs nothing.
    const REQ_GAP = 125;
    let reqGap = REQ_GAP, nextSlot = 0;
    async function paceRequest() {
        const now = Date.now(), at = Math.max(now, nextSlot);
        nextSlot = at + reqGap;
        if (at > now) await sleep(at - now);
    }
    async function politeFetch(url) {
        for (let attempt = 0; ; attempt++) {
            if (radarAbort) throw new Error('aborted');
            await paceRequest();
            const t0 = Date.now();
            const r = await fetch(url, { credentials: 'same-origin' });
            const took = Date.now() - t0;
            reqGap = took > 2000 ? Math.min(1000, reqGap * 1.5) : Math.max(REQ_GAP, reqGap * 0.95);
            if (r.ok) return r.text();
            if (r.status !== 429 && r.status !== 503) throw new Error(`HTTP ${r.status}`);
            if (attempt >= 2) {
                radarAbort = true;
                const msg = `Stopped loading: the server is asking us to slow down (HTTP ${r.status}). What is already loaded is kept. Try again in a few minutes.`;
                const st = byId('st-status');
                if (st) st.innerText = msg;
                setLoadNote(msg);
                throw new Error('rate limited');
            }
            const ra = r.headers.get('Retry-After');
            let wait = parseInt(ra, 10);
            if (isNaN(wait)) { const d = Date.parse(ra); wait = isNaN(d) ? NaN : Math.ceil((d - Date.now()) / 1000); }
            wait = Math.min(60, Math.max(1, isNaN(wait) ? 5 * 2 ** attempt : wait));
            setLoadNote(`The server asked us to slow down (HTTP ${r.status}). Waiting ${wait}s…`);
            await sleep(wait * 1000);
        }
    }

    // ---------- Other pages of the list (page 2, 3 …) ----------
    // The pagination markup isn't known for sure, so this looks for links to /matches/ that carry a page number
    function findOtherPageLinks(doc, baseUrl) {
        const here = new URL(baseUrl);
        const out = new Set();
        doc.querySelectorAll('a[href]').forEach(a => {
            if (a.closest('#smart-trade-panel, #st-trade-modal')) return;
            let u;
            try { u = new URL(a.getAttribute('href'), here); } catch (err) { return; }
            if (u.origin !== here.origin || !/^\/matches(\/|$)/.test(u.pathname)) return;
            const pageParam = ['page', 'p', 'pg', 'offset', 'start'].some(k => u.searchParams.has(k));
            const pathPage = /^\/matches\/(?:page\/)?\d+\/?$/.test(u.pathname);
            if (!pageParam && !pathPage) return;
            u.hash = '';
            if (u.href !== here.href) out.add(u.href);
        });
        return [...out];
    }

    async function loadOtherPages() {
        const status = byId('st-status');
        const here = new URL(location.href);
        const linked = findOtherPageLinks(document, location.href);
        const starts = linked.map(l => parseInt(new URL(l).searchParams.get('start'), 10)).filter(n => n > 0);
        const otherStyle = linked.filter(l => !new URL(l).searchParams.has('start'));
        const curStart = parseInt(here.searchParams.get('start'), 10) || 0;
        // The page lists its pages ("Page: 1 2 3 … 8"): the highest ?start= link is the last page. The step is what they all divide by (100).
        const gcd = (a, b) => b ? gcd(b, a % b) : a;
        const step = [...starts, curStart].filter(n => n > 0).reduce(gcd, 0) || 100;
        let maxStart = Math.max(curStart, ...starts, 0);
        const useOffsets = starts.length > 0 || curStart > 0;
        const seen = new Set([location.href]);
        const known = new Set(radarTraders.map(t => t.u));
        let loaded = 0, added = 0;

        const take = async url => {
            const key = 'page:' + url;
            let found, links, fromCache = false;
            const hit = await cacheGet(key);
            if (hit) {
                found = hit.traders.map(rehydrateTrader);
                links = hit.links;
                fromCache = true;
            } else {
                const doc = new DOMParser().parseFromString(await politeFetch(url), 'text/html');
                found = parseTraders(doc);
                links = findOtherPageLinks(doc, url);
                cacheSet(key, { traders: found.map(slimTrader), links });
            }
            found.forEach(t => { if (!known.has(t.u)) { known.add(t.u); radarTraders.push(t); added++; } });
            loaded++;
            // later pages may reveal a higher last page
            links.forEach(l => {
                const st = parseInt(new URL(l).searchParams.get('start'), 10);
                if (st > maxStart) maxStart = st;
            });
            return { links, count: found.length, fromCache };
        };
        const progress = () => {
            const msg = `Loading other pages… ${loaded} done, ${added} more traders`;
            if (status) status.innerText = msg;
            setLoadNote(msg);
        };

        radarLoading = true;
        try {
            if (useOffsets) {
                for (let off = 0, n = 0; off <= maxStart && n < 60; off += step, n++) {
                    if (off === curStart) continue;
                    const u = new URL(location.href);
                    u.searchParams.set('start', off);
                    u.hash = '';
                    if (seen.has(u.href)) continue;
                    seen.add(u.href);
                    progress();
                    const r = await take(u.href);
                    if (r.count === 0 && off > curStart) break;
                }
            } else {
                const queue = otherStyle.slice();
                otherStyle.forEach(l => seen.add(l));
                while (queue.length && loaded < 40) {
                    const url = queue.shift();
                    progress();
                    const r = await take(url);
                    r.links.forEach(l => { if (!seen.has(l)) { seen.add(l); queue.push(l); } });
                }
            }
        } catch (err) {
            console.warn('[Match Radar] could not load other pages', err);
        }
        radarLoading = false;
        setLoadNote('');
        const count = byId('st-radar-count');
        if (count && loaded) count.textContent = `${radarTraders.length} traders (${loaded} other page${loaded === 1 ? '' : 's'} loaded). Ratio = what you get ÷ what you give.`;
        return added;
    }

    // Other pages first (so every trader is known), then every partial list in full
    async function loadEverything() {
        const status = byId('st-status');
        const single = radarTraders.length < 2 && /[?&]u=\d+/.test(location.search);
        if (!single) {
            await loadOtherPages();
            radarRecompute('stale');
        }
        await deepLoad(radarTraders);
        if (status && !single) status.innerText = `All pages and full lists loaded: ${radarTraders.length} traders. ` + status.innerText;
    }

    // ---------- Loading a trader's full list ----------

    let radarLoading = false, radarLoadNote = '';
    function setLoadNote(msg) {
        radarLoadNote = msg;
        const el = byId('st-radar-loadnote');
        if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
    }
    async function deepLoad(list, manual) {
        if (radarLoading) return;
        if (manual) radarAbort = false; // an explicit click may retry after a rate-limit stop
        // Hidden (no-status) traders are skipped unless asked for; traders that already look promising go first
        const todo = list.filter(t => !t.deep && (t.theirsMore || t.mineMore) && (manual || !radarShady(t)))
            .sort((a, b) => (b.dealCount > 0) - (a.dealCount > 0) || b.done - a.done);
        const status = byId('st-status');
        if (!todo.length) { if (status) status.innerText = 'All lists are already complete.'; return; }
        radarLoading = true;
        let next = 0, done = 0, cached = 0, ok = 0;
        const worker = async () => {
            while (next < todo.length && !radarAbort) {
                const t = todo[next++];
                let fromCache = false;
                try {
                    let full = null;
                    const hit = await cacheGet('trader:' + t.u);
                    if (hit) {
                        full = hit;
                        fromCache = true;
                        cached++;
                    } else {
                        const doc = new DOMParser().parseFromString(await politeFetch(`${location.origin}/matches/?u=${t.u}`), 'text/html');
                        const parsed = parseTraders(doc).find(x => x.u === t.u);
                        if (parsed) {
                            full = { theirs: parsed.theirs, mine: parsed.mine, theirsMore: parsed.theirsMore, mineMore: parsed.mineMore };
                            cacheSet('trader:' + t.u, full);
                        }
                    }
                    if (full) {
                        t.theirs = full.theirs; t.mine = full.mine;
                        t.theirsMore = full.theirsMore; t.mineMore = full.mineMore;
                        t._keys = null;
                    }
                    t.deep = true;
                    ok++;
                    computeTraderDeals(t);
                } catch (err) {
                    console.warn('[Match Radar] could not load', t.name, err);
                }
                done++;
                const msg = `Loading full lists ${done}/${todo.length}…`;
                if (status && !radarAbort) status.innerText = msg;
                if (!radarAbort) setLoadNote(msg + ' the results update when they are all in.');
                if (done % 10 === 0) updateRadarBadges();
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        radarLoading = false;
        if (!radarAbort) setLoadNote('');
        radarRecompute('stale'); // traders were already computed as they loaded; this only refreshes the UI
        if (status) {
            const note = radarAbort ? 'Stopped early (server rate limit). ' : '';
            status.innerText = `${note}Full lists loaded for ${ok} of ${todo.length} trader${todo.length === 1 ? '' : 's'}${cached ? ` (${cached} from cache)` : ''}. ` + status.innerText;
        }
    }

    // ---------- Results window ----------

    function radarLink(e) {
        const exact = !!e.steamUrl;
        const href = e.steamUrl || `https://store.steampowered.com/search/?term=${encodeURIComponent(e.title)}`;
        const lt = !exact && e.lestradesUrl ? ` data-lt="${esc(e.lestradesUrl)}"` : '';
        return `<a href="${esc(href)}"${lt} data-exact="${exact ? 1 : 0}" class="st-steam" target="_blank" rel="noopener noreferrer" title="Open on Steam (new tab)" style="color:inherit; text-decoration:none; border-bottom:1px dotted currentColor;">${esc(e.title)}</a>${ggLink(e)}`;
    }

    // pivot = 'mine' | 'theirs': adds a small ⇆ that jumps to "By my item" / "By their item" for that game
    function partsHtml(b, pivot) {
        return b.parts.map(({ e, q }) => {
            const p = priceOf(e) * q;
            const pv = pivot ? ` <button class="st-pivot" data-id="${esc(e.gameId)}" data-side="${pivot}" title="Show every trader for this ${pivot === 'mine' ? 'item of yours' : 'game'}" style="background:none; border:1px solid #445; border-radius:3px; color:#8ab4f8; cursor:pointer; font-size:10px; padding:0 3px; line-height:14px;">⇆</button>` : '';
            return `${e.isGame ? '' : '🔑 '}${e.isGame ? radarLink(e) : esc(e.title)}${q > 1 ? ` ×${q}` : ''} <span style="color:#888;">${pTag(e.title, p, priceOf(e))}</span>${pv}`;
        }).join(' + ');
    }

    // Small print the trader added: region locks, "may keep", their own value, notes like "4 TF2"
    function dealNoteParts(d, giveToo = true) {
        const out = [];
        d.get.parts.forEach(({ e }) => {
            const bits = [...e.flags, ...e.notes.map(n => n.text), ...(e.cusval ? [`they value it at $${e.cusval}`] : []), ...e.warns];
            if (bits.length) out.push(`<b>${esc(e.title)}</b>: ${esc(bits.join(' · '))}`);
        });
        if (giveToo) d.give.parts.forEach(({ e }) => {
            const bits = [...e.notes.filter(n => n.byThem).map(n => n.text), ...(e.cusval ? [`they value yours at $${e.cusval}`] : [])];
            if (bits.length) out.push(`their note on your <b>${esc(e.title)}</b>: ${esc(bits.join(' · '))}`);
        });
        return out;
    }
    function dealNotes(d, giveToo = true) {
        const out = dealNoteParts(d, giveToo);
        return out.length ? `<div style="font-size:11px; color:#999; margin-top:3px;">${out.join('<br>')}</div>` : '';
    }
    // Notes inside a button row become a small icon (hover for the text, click to open it on its own line under the row),
    // so they never push the ratio and the Prepare offer button out of place.
    function noteIcon(parts) {
        if (!parts.length) return { icon: '', body: '' };
        const plain = parts.join(' · ').replace(/<[^>]+>/g, '');
        const warn = /region|lock/i.test(plain);
        return {
            icon: `<button type="button" class="st-note" title="${esc(plain)}" style="background:none; border:1px solid #445; border-radius:10px; padding:0 5px; cursor:pointer; font-size:11px; line-height:16px; color:${warn ? '#f39c12' : '#8ab4f8'};">${warn ? '⚠' : '📝'}</button>`,
            body: `<div class="st-note-body" style="display:none; flex:0 0 100%; font-size:11px; color:#aaa; padding:2px 0 0 4px;">${parts.join('<br>')}</div>`
        };
    }

    function ratioBadge(r, ok = true) {
        return `<span style="font-size:11px; font-weight:bold; color:${ok ? '#4e9af1' : '#f39c12'}; background:#33334d; padding:2px 6px; border-radius:3px; white-space:nowrap;">${r.toFixed(2)}</span>`;
    }

    function dealRow(d, attrs) {
        return `<div style="background:#1a1a2b; border:1px solid #2a2a40; border-radius:4px; padding:6px 8px; margin-top:5px;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="color:#28a745; font-weight:bold; font-size:10px;">YOU GIVE</span><span>${partsHtml(d.give, 'mine')}</span>
                <span style="color:#aaa;">⇄</span>
                <span style="color:#e74c3c; font-weight:bold; font-size:10px;">THEY GIVE</span><span>${partsHtml(d.get, 'theirs')}</span>
                <span style="margin-left:auto; display:flex; gap:6px; align-items:center;">
                    ${ratioBadge(d.ratio, d.score !== undefined)}
                    <button class="st-radar-prep" ${attrs} style="padding:4px 8px; background:#28a745; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">Prepare offer ↗</button>
                </span>
            </div>
            ${dealNotes(d)}
        </div>`;
    }

    function traderHeader(t) {
        const bits = [
            t.status && `<span title="Trader status">${esc(t.status)}</span>`,
            `${t.done} offers done`,
            t.last && `last seen ${esc(t.last)}`,
            t.balance && `Lest $${esc(t.balance)}`
        ].filter(Boolean).join(' · ');
        return `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <a href="${esc(t.profile || '#')}" target="_blank" style="color:#fff; font-weight:bold; font-size:14px; text-decoration:none;">${esc(t.name)}</a>
                ${t.shady ? '<span style="color:#e74c3c; font-size:11px; font-weight:bold;">⚠ no trader status – be careful</span>' : ''}
                <span style="color:#999; font-size:11px;">${bits}</span>
                <a href="${location.origin}/offer/?u=${t.u}" target="_blank" style="margin-left:auto; color:#4e9af1; font-size:11px;">Open offer page ↗</a>
            </div>
            ${t.history ? `<div style="color:#888; font-size:11px; margin-top:2px;">${esc(t.history)}</div>` : ''}`;
    }

    function sortedVisibleTraders() {
        const q = normTitle(radarSettings.search);
        const list = radarTraders.filter(t => !radarShady(t))
            .filter(t => !q || normTitle(t.name).includes(q) || [...t.theirs, ...t.mine].some(e => normTitle(e.title).includes(q)));
        const by = {
            best: (a, b) => (b.dealCount > 0) - (a.dealCount > 0) || (a.deals[0]?.score ?? 9) - (b.deals[0]?.score ?? 9),
            most: (a, b) => b.dealCount - a.dealCount,
            value: (a, b) => (b.deals[0] ? b.deals[0].get.value : 0) - (a.deals[0] ? a.deals[0].get.value : 0),
            reliable: (a, b) => b.done - a.done,
            page: (a, b) => a.idx - b.idx
        }[radarSettings.sort] || (() => 0);
        return list.sort(by);
    }

    const radarExpanded = new Set();

    function optionRow(o, attrs) {
        const n = noteIcon(dealNoteParts(o, false));
        return `<div class="st-deal-row" style="display:flex; align-items:center; gap:8px; padding:4px 0 2px 14px; border-top:1px solid #2a2a40; margin-top:4px; flex-wrap:wrap;">
            <span style="color:#e74c3c; font-weight:bold; font-size:10px;">THEY GIVE</span><span>${partsHtml(o.get, 'theirs')}</span>
            <span style="margin-left:auto; display:flex; gap:6px; align-items:center; flex:none;">
                ${n.icon}${ratioBadge(o.ratio, true)}
                <button class="st-radar-prep" ${attrs} style="padding:4px 8px; background:#28a745; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">Prepare offer ↗</button>
            </span>
            ${n.body}
        </div>`;
    }

    // One thing you give, a short pick-one list of what you can get for it
    function familyHtml(f, attrsFor) {
        const giveNotes = dealNotes({ give: f.give, get: { parts: [] } }, true);
        return `<div style="background:#1a1a2b; border:1px solid #2a2a40; border-radius:4px; padding:6px 8px; margin-top:6px;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="color:#28a745; font-weight:bold; font-size:10px;">YOU GIVE</span><span>${partsHtml(f.give, 'mine')}</span>
                <span style="color:#aaa; font-size:11px;">⇄ for one of ${f.options.length}:</span>
            </div>
            ${giveNotes}
            ${f.options.map(o => optionRow(o, attrsFor(o))).join('')}
        </div>`;
    }

    function renderTradersTab() {
        const list = sortedVisibleTraders();
        const sel = (v, l) => `<option value="${v}" ${radarSettings.sort === v ? 'selected' : ''}>${l}</option>`;
        const top = `<div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
            <input id="st-radar-search" type="text" placeholder="Filter by trader or game…" value="${esc(radarSettings.search)}" style="flex:1; min-width:180px; background:#1a1a2b; color:#fff; border:1px solid #555; border-radius:4px; padding:5px;">
            <span style="color:#aaa;">Sort</span>
            <select id="st-radar-sort">${sel('best', 'Best trade first')}${sel('most', 'Most trades')}${sel('value', 'Biggest trade value')}${sel('reliable', 'Most completed offers')}${sel('page', 'Page order')}</select>
        </div>`;
        if (!list.length) return top + '<div style="color:#aaa; padding:20px; text-align:center;">No traders match.</div>';
        const pageList = list.slice(0, radarTraderShown);
        const moreBtn = list.length > pageList.length ? `<button class="st-radar-moretraders" style="width:100%; padding:8px; background:#33334d; color:#8ab4f8; border:1px solid #556; border-radius:4px; cursor:pointer;">Show ${Math.min(40, list.length - pageList.length)} more traders (${list.length - pageList.length} left)</button>` : '';
        return top + pageList.map(t => {
            const partial = (t.theirsMore || t.mineMore) && !t.deep;
            const FAM_SHOWN = 4;
            const open = radarExpanded.has(t.u);
            const famList = open ? t.families : t.families.slice(0, FAM_SHOWN);
            const dealIdx = new Map(t.deals.map((d, i) => [d, i]));
            const deals = t.deals.length
                ? famList.map(f => familyHtml(f, o => `data-u="${t.u}" data-k="${dealIdx.get(o)}"`)).join('') +
                  (t.families.length > FAM_SHOWN ? `<button class="st-radar-more" data-u="${t.u}" style="margin-top:6px; padding:4px 10px; background:#33334d; color:#8ab4f8; border:1px solid #556; border-radius:4px; cursor:pointer; font-size:11px;">${open ? 'Show fewer' : `Show all ${t.families.length} ways to trade with ${esc(t.name)}`}</button>` : '')
                : t.closest
                    ? `<div style="color:#f39c12; font-size:12px; margin-top:6px;">Nothing within ${radarSettings.min}–${radarSettings.max}. Closest:</div>${dealRow(t.closest, `data-u="${t.u}" data-k="closest"`)}`
                    : `<div style="color:#888; font-size:12px; margin-top:6px;">No priced games to compare${t.mine.some(e => !e.isGame) ? ' – set a price for your items in the panel' : ''}.</div>`;
            return `<div id="st-rt-${t.u}" style="background:#222235; border:1px solid #333; border-radius:6px; padding:10px 12px; margin-bottom:10px;">
                ${traderHeader(t)}
                <div style="color:#aaa; font-size:11px; margin-top:4px;">
                    They have ${t.theirs.filter(hasValue).length} of your wishes · want ${t.mine.filter(hasValue).length} of your tradables
                    ${t.dealCount ? ` · <b style="color:#28a745;">${t.dealCount} trade${t.dealCount === 1 ? '' : 's'} in ratio</b>` : ''}
                    ${partial ? ` · <span style="color:#f39c12;">partial list</span> <button class="st-radar-load" data-u="${t.u}" style="padding:1px 6px; font-size:11px; background:#6c5ce7; color:#fff; border:none; border-radius:3px; cursor:pointer;">Load full list</button>` : ''}
                </div>
                ${deals}
            </div>`;
        }).join('') + moreBtn;
    }

    // Every item you could pick: your tradables ('mine') or the games the traders have ('theirs')
    function itemOptions(mode) {
        const map = new Map();
        radarTraders.filter(t => !radarShady(t)).forEach(t => (mode === 'mine' ? t.mine : t.theirs).forEach(e => {
            if (!hasValue(e)) return; // no value, no match
            if (radarSettings.onlyGames && !e.isGame) return;
            if (mode === 'theirs' && radarSettings.skipLocked && e.locked) return;
            const k = e.gameId;
            if (!map.has(k)) map.set(k, { e, amount: e.amount, traders: 0 });
            const o = map.get(k);
            o.traders++;
            o.amount = Math.max(o.amount, e.amount);
        }));
        return [...map.values()].sort((a, b) => (a.e.isGame - b.e.isGame) || b.traders - a.traders || a.e.title.localeCompare(b.e.title));
    }

    // Every trader's games you could get for one of your tradables (e.g. 3 TF2 keys), or the reverse
    function computeItemResults(mode) {
        const mine = mode === 'mine';
        const choice = mine ? radarItemChoice : radarTheirChoice;
        const opts = itemOptions(mode);
        if (!opts.length) return { mode, opts, rows: [], groups: [], itemGroups: [] };
        let opt = opts.find(o => o.e.gameId === choice.id);
        if (!opt) { opt = opts[0]; choice.id = opt.e.gameId; choice.qty = 1; }
        const qty = Math.min(choice.qty, opt.e.isGame ? 1 : Math.min(opt.amount, 10));
        const price = priceOf(opt.e);
        const { min, max } = getRatioLimits();
        const groups = [];
        if (price > 0) {
            radarTraders.filter(t => !radarShady(t)).forEach(t => {
                const fixedE = (mine ? t.mine : t.theirs).find(e => e.gameId === opt.e.gameId);
                if (!fixedE) return;
                const fixed = { parts: [{ e: fixedE, q: qty }], value: price * qty, hasItem: !fixedE.isGame };
                const cands = [];
                const others = mine ? bundleOptions(t.theirs, radarSettings.maxSide, e => !(radarSettings.skipLocked && e.locked))
                                    : bundleOptions(t.mine, radarSettings.maxSide);
                others.forEach(other => {
                    const give = mine ? fixed : other, get = mine ? other : fixed;
                    const r = get.value / give.value;
                    if (r < min || r > max) return;
                    cands.push({ give, get, ratio: r, score: closeness(r) + 0.04 * (other.parts.length - 1) });
                });
                const options = pruneOptions(cands, 5, 2, 0.08, mine ? (d => bundleSig(d.get)) : (d => bundleSig(d.give)));
                if (options.length) groups.push({ t, fixed, options, total: cands.length });
            });
        }
        // Regroup by the other side: one block per game (or pair), the traders offering it behind it
        const byOther = new Map();
        groups.forEach(g => g.options.forEach(o => {
            const other = mine ? o.get : o.give;
            const k = bundleSig(other);
            if (!byOther.has(k)) byOther.set(k, { other, fixed: g.fixed, entries: [] });
            byOther.get(k).entries.push({ t: g.t, d: o });
        }));
        const itemGroups = [...byOther.values()];
        itemGroups.forEach(ig => ig.entries.sort((x, y) => x.d.score - y.d.score));
        itemGroups.sort((x, y) => x.entries[0].d.score - y.entries[0].d.score || y.entries.length - x.entries.length);
        const rows = [];
        itemGroups.forEach(ig => { ig.off = rows.length; ig.entries.forEach(en => rows.push(en)); });
        return { mode, opts, opt, qty, price, rows, groups, itemGroups };
    }

    function renderItemsTab(mode) {
        const mine = mode === 'mine';
        const { opts, opt, qty, price, rows, groups, itemGroups } = computeItemResults(mode);
        radarItemResults = rows;
        if (!opts.length) return `<div style="color:#aaa; padding:20px; text-align:center;">${mine ? 'None of your tradables with a price are wanted on this page. Set prices under Custom prices.' : 'No priced game from the traders on this page. Set prices under Custom prices.'}</div>`;
        const find = radarFind.trim().toLowerCase();
        let visible = find ? opts.filter(o => o.e.title.toLowerCase().includes(find)) : opts;
        const total = visible.length;
        visible = visible.slice(0, 400);
        if (!visible.includes(opt)) visible.unshift(opt);
        const maxQ = opt.e.isGame ? 1 : Math.min(opt.amount, 10);
        const qtyOpts = [];
        for (let q = 1; q <= maxQ; q++) qtyOpts.push(`<option value="${q}" ${q === qty ? 'selected' : ''}>${q} × ${esc(opt.e.title)}${price > 0 ? ` ($${(price * q).toFixed(2)})` : ''}</option>`);
        const tabNames = { traders: 'Traders', items: 'By my item', theirs: 'By their item' };
        const head = `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
            ${radarPrevTab && radarPrevTab !== radarTab ? `<button class="st-radar-back" style="padding:3px 10px; background:#33334d; color:#8ab4f8; border:1px solid #556; border-radius:4px; cursor:pointer;">← ${tabNames[radarPrevTab]}</button>` : ''}
            <span style="color:#aaa;">${mine ? 'I want to trade away' : 'I want to get'}</span>
            <input id="st-radar-itemfind" placeholder="Find a game…" value="${esc(radarFind)}" style="width:150px; padding:4px 8px; background:#1a1a2b; color:#fff; border:1px solid #444; border-radius:4px;">
            <select id="${mine ? 'st-radar-item' : 'st-radar-titem'}" style="max-width:360px;">${visible.map(o => `<option value="${o.e.gameId}" ${o === opt ? 'selected' : ''}>${o.e.isGame ? '' : '🔑 '}${esc(o.e.title)} – ${mine ? 'wanted by' : 'offered by'} ${o.traders}</option>`).join('')}</select>
            ${total > 400 ? `<span style="color:#888; font-size:11px;">(first 400 of ${total}: type to find)</span>` : ''}
            ${maxQ > 1 ? `<select id="st-radar-qty">${qtyOpts.join('')}</select>` : ''}
        </div>`;
        if (!(price > 0)) return head + `<div style="color:#f39c12; padding:10px;">Set a price for ${esc(opt.e.title)} in the panel first.</div>`;
        if (!groups.length) return head + `<div style="color:#f39c12; padding:10px;">${mine ? `No trader has anything within ${radarSettings.min}–${radarSettings.max} for ${qty} × ${esc(opt.e.title)}.` : `Nothing of yours is within ${radarSettings.min}–${radarSettings.max} of ${qty} × ${esc(opt.e.title)} for any trader who has it.`} Try another amount, or widen the ratio.</div>`;
        const list = itemGroups.slice().sort((x, y) => radarItemSort === 'many'
            ? y.entries.length - x.entries.length || x.entries[0].d.score - y.entries[0].d.score
            : x.entries[0].d.score - y.entries[0].d.score);
        const fl = radarItemFilter.trim().toLowerCase();
        const matching = fl ? list.filter(ig => ig.other.parts.some(p => p.e.title.toLowerCase().includes(fl))) : list;
        const { min: rMin, max: rMax } = getRatioLimits();
        const chip = (en, idx, hidden) => {
            const k = traderKind(en.t);
            const tr = theirRatio(en.d);
            const notes = dealNotes(en.d, true).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const tip = `${en.t.name} · ${k.label}${k.why ? ' (' + k.why + ')' : ''} · ${en.t.done} offers done${tr !== null ? ' · their own ratio ' + tr.toFixed(2) : ''}${notes ? ' · ' + notes : ''}${en.t.shady ? ' · no trader status' : ''}`;
            const trHtml = tr !== null ? ` <span style="color:${tr >= rMin && tr <= rMax ? '#7bd88f' : '#f39c12'};" title="Ratio using the values this trader set">their ${tr.toFixed(2)}</span>` : '';
            return `<button class="st-radar-prep st-chip" data-item="${idx}" title="${esc(tip)}" style="display:${hidden ? 'none' : 'inline-block'}; margin:2px 4px 2px 0; padding:2px 8px; background:#2a2a40; color:#fff; border:1px solid #444; border-left:3px solid ${k.color}; border-radius:12px; cursor:pointer; font-size:11px;">${esc(en.t.name)} <span style="color:#888;">${en.t.done}</span>${trHtml}${notes || en.t.shady ? ' <span style="color:#f39c12;">⚠</span>' : ''}</button>`;
        };
        // One line per game: the game, a "Show N traders" button (or the trader when there is only one), the ratio
        const isRes = k => /reseller|retrader/i.test(k.label);
        const rowHTML = ig => {
            const all = ig.entries.map((en, i) => ({ en, idx: ig.off + i, k: traderKind(en.t) }))
                .sort((x, y) => (isRes(x.k) - isRes(y.k)) || y.en.t.done - x.en.t.done);
            const multi = all.length > 1;
            const quick = multi ? '' : chip(all[0].en, all[0].idx, false);
            const byKind = new Map();
            all.forEach(x => {
                if (!byKind.has(x.k.label)) byKind.set(x.k.label, { k: x.k, arr: [] });
                byKind.get(x.k.label).arr.push(x);
            });
            const full = [...byKind.values()].map(({ k, arr }) => `<span style="display:inline-flex; align-items:center; flex-wrap:wrap; margin-right:12px;">
                <span title="${esc(k.why)}" style="font-size:10px; padding:2px 7px; border-radius:8px; background:${k.color}; color:#fff; margin-right:5px;">${esc(k.label)} · ${arr.length}</span>${arr.map(x => chip(x.en, x.idx, false)).join('')}</span>`).join('');
            return `<div class="st-item-row" style="background:#1a1a2b; border:1px solid #2a2a40; border-radius:4px; padding:4px 8px; margin-bottom:3px;">
                <div style="display:flex; align-items:center; gap:10px; white-space:nowrap;">
                    <span style="flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; color:#fff;">${partsHtml(ig.other, mine ? 'theirs' : 'mine')}</span>
                    <span style="flex:none;">${multi ? `<button class="st-radar-rowmore" data-n="${all.length}" style="padding:2px 10px; background:#2a2a40; color:#8ab4f8; border:1px solid #556; border-radius:12px; cursor:pointer; font-size:11px;">Show ${all.length} traders ▾</button>` : quick}</span>
                    <span style="flex:none;">${ratioBadge(ig.entries[0].d.ratio, true)}</span>
                </div>
                ${multi ? `<div class="st-item-full" style="display:none; margin:4px 0 2px 4px; padding-top:4px; border-top:1px solid #2a2a40;">${full}</div>` : ''}
            </div>`;
        };
        const fixedLabel = mine ? 'YOU GIVE:' : 'YOU GET:';
        const fixedColor = mine ? '#28a745' : '#e74c3c';
        const otherColor = mine ? '#e74c3c' : '#28a745';
        const section = (title, label, items) => {
            if (!items.length) return '';
            const part = items.slice(0, radarItemShown);
            return `<h4 style="margin:14px 0 6px; color:#f39c12; border-bottom:1px solid #444; padding-bottom:4px;">${title} (${items.length})</h4>
            <div style="display:flex; align-items:flex-start; gap:12px; background:#222235; padding:10px 12px; border-radius:6px; border:1px solid #333;">
                <div style="flex:0 0 200px; position:sticky; top:0;">
                    <div style="font-size:10px; font-weight:bold; color:${fixedColor}; margin-bottom:4px;">${fixedLabel}</div>
                    <span style="color:${fixedColor}; font-weight:bold;">${partsHtml(groups[0].fixed)}</span>
                </div>
                <span style="color:#aaa; font-size:16px;">⇄</span>
                <div style="flex:1; min-width:0;">
                    <div style="font-size:10px; font-weight:bold; color:${otherColor}; margin-bottom:4px;">${label} (PICK ONE, ${items.length} OPTION${items.length === 1 ? '' : 'S'}):</div>
                    ${part.map(rowHTML).join('')}
                    ${items.length > part.length ? `<button class="st-radar-moregames" style="margin-top:6px; padding:6px 14px; background:#33334d; color:#8ab4f8; border:1px solid #556; border-radius:4px; cursor:pointer;">Show ${Math.min(25, items.length - part.length)} more (${items.length - part.length} left)</button>` : ''}
                </div>
            </div>`;
        };
        return head + `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:4px 0 8px;">
                <input id="st-radar-itemfilter" placeholder="Filter the list…" value="${esc(radarItemFilter)}" style="width:170px; padding:4px 8px; background:#1a1a2b; color:#fff; border:1px solid #444; border-radius:4px;">
                <select id="st-radar-itemsort"><option value="fit" ${radarItemSort === 'fit' ? 'selected' : ''}>Closest to 1.00 first</option><option value="many" ${radarItemSort === 'many' ? 'selected' : ''}>Most traders first</option></select>
                <span style="color:#888; font-size:11px;">⇆ next to a game shows every trader for that game. Click a trader to prepare the offer · number = offers done · "their" = ratio with the values they set · ⚠ = note or no status</span>
            </div>
            ${section('1:1 Trades', mine ? 'YOU GET ONE GAME' : 'YOU GIVE ONE GAME', matching.filter(ig => ig.other.parts.length === 1))}
            ${section(mine ? '1:2 Trades' : '2:1 Trades', mine ? 'YOU GET TWO GAMES' : 'YOU GIVE TWO GAMES', matching.filter(ig => ig.other.parts.length > 1))}`;
    }

    // What kind of trader this is: the site's own status, or a guess when the status doesn't say
    function traderKind(t) {
        const st = t.status || '';
        if (/retrader/i.test(st)) return { label: 'Retrader', color: '#8e44ad', why: "Trader status: retrader" };
        if (/reseller/i.test(st)) return { label: 'Reseller', color: '#d35400', why: 'Trader status: reseller' };
        const stock = t.theirs.length + (t.theirsMore ? t.theirsMore.count : 0);
        if (stock >= 80 || t.done >= 1000) return { label: `${st || 'No status'} · likely reseller`, color: '#b9770e', why: stock >= 80 ? `Has ${stock} games matching your wishes: a very large stock` : `${t.done} offers done` };
        return { label: st || 'No status', color: '#3d566e', why: st ? '' : "Didn't set a trader status" };
    }

    // The ratio from the trader's side, using the values they set (only when they set any for this trade)
    function theirRatio(d) {
        let any = false;
        const val = ({ e, q }) => { if (e.cusval) { any = true; return e.cusval * q; } return priceOf(e) * q; };
        const receive = d.give.parts.reduce((x, p) => x + val(p), 0);
        const give = d.get.parts.reduce((x, p) => x + val(p), 0);
        return any && give > 0 ? receive / give : null;
    }

    function renderRadarBody() {
        const body = byId('st-radar-body');
        if (!body) return;
        body.innerHTML = `<div id="st-radar-loadnote" style="display:${radarLoadNote ? 'block' : 'none'}; margin-bottom:8px; padding:6px 10px; background:#2d2a3a; color:#c9b8ff; border-radius:4px; font-size:12px;">${esc(radarLoadNote)}</div>` + (radarTab === 'traders' ? renderTradersTab() : renderItemsTab(radarTab === 'theirs' ? 'theirs' : 'mine'));
        document.querySelectorAll('.st-radar-tab').forEach(b => {
            const on = b.dataset.tab === radarTab;
            b.style.background = on ? '#4e9af1' : '#2a2a40';
            b.style.color = on ? '#fff' : '#aaa';
        });
    }

    function openRadarModal(tab, scrollToU) {
        if (tab) { radarTab = tab; radarPrevTab = null; }
        let modal = byId('st-trade-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'st-trade-modal';
            modal.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:2147483648; width:1000px; max-width:95vw; max-height:85vh; background:#181824; color:#fff; border:1px solid #555; border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,0.9); font-family:sans-serif; font-size:13px; display:flex; flex-direction:column;';
            modal.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid #333;">
                    <b style="font-size:16px; color:#4e9af1; margin-right:8px;">📡 Match Radar</b>
                    <button class="st-radar-tab" data-tab="traders" style="padding:6px 12px; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">Traders</button>
                    <button class="st-radar-tab" data-tab="items" style="padding:6px 12px; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">🔑 By my item</button>
                    <button class="st-radar-tab" data-tab="theirs" style="padding:6px 12px; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">🎮 By their item</button>
                    <button id="st-radar-close" style="margin-left:auto; background:#e74c3c; color:#fff; border:none; border-radius:4px; padding:6px 12px; cursor:pointer;">Close</button>
                </div>
                <div id="st-radar-body" style="padding:12px 16px; overflow-y:auto;"></div>`;
            document.body.appendChild(modal);

            modal.addEventListener('click', e => {
                const t = e.target;
                if (handleLookupClick(e)) return;
                if (t.id === 'st-radar-close') { modal.remove(); return; }
                if (t.classList.contains('st-radar-tab')) { radarTab = t.dataset.tab; radarPrevTab = null; radarFind = ''; radarItemShown = 25; renderRadarBody(); return; }
                if (t.classList.contains('st-pivot')) {
                    // jump to every trader for this game (their item or one of yours), with a way back
                    const mineSide = t.dataset.side === 'mine';
                    radarPrevTab = radarTab;
                    Object.assign(mineSide ? radarItemChoice : radarTheirChoice, { id: t.dataset.id, qty: 1 });
                    radarTab = mineSide ? 'items' : 'theirs';
                    radarFind = ''; radarItemFilter = ''; radarItemShown = 25;
                    renderRadarBody();
                    byId('st-radar-body').scrollTop = 0;
                    return;
                }
                if (t.classList.contains('st-radar-back')) { radarTab = radarPrevTab || 'traders'; radarPrevTab = null; radarFind = ''; renderRadarBody(); return; }
                if (t.classList.contains('st-radar-rowmore')) {
                    const panel = t.closest('.st-item-row').querySelector('.st-item-full');
                    const open = panel.style.display === 'none';
                    panel.style.display = open ? 'block' : 'none';
                    t.textContent = open ? 'Hide traders ▴' : `Show ${t.dataset.n} traders ▾`;
                    return;
                }
                if (t.classList.contains('st-radar-moregames')) { radarItemShown += 25; renderRadarBody(); return; }
                if (t.classList.contains('st-radar-moretraders')) { radarTraderShown += 40; renderRadarBody(); return; }
                if (t.classList.contains('st-radar-more')) {
                    if (radarExpanded.has(t.dataset.u)) radarExpanded.delete(t.dataset.u); else radarExpanded.add(t.dataset.u);
                    renderRadarBody();
                    return;
                }
                if (t.classList.contains('st-radar-load')) {
                    const tr = radarTraders.find(x => x.u === t.dataset.u);
                    if (tr) { t.disabled = true; t.textContent = 'Loading…'; deepLoad([tr], true); }
                    return;
                }
                const noteBtn = t.closest && t.closest('.st-note');
                if (noteBtn) {
                    const body = noteBtn.closest('.st-deal-row')?.querySelector(':scope > .st-note-body');
                    if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
                    return;
                }
                if (t.classList.contains('st-radar-prep') || t.closest('.st-radar-prep')) {
                    const btn = t.classList.contains('st-radar-prep') ? t : t.closest('.st-radar-prep');
                    let trader, deal;
                    if (btn.dataset.item !== undefined) {
                        const r = radarItemResults[+btn.dataset.item];
                        if (r) { trader = r.t; deal = r.d; }
                    } else {
                        trader = radarTraders.find(x => x.u === btn.dataset.u);
                        deal = trader && (btn.dataset.k === 'closest' ? trader.closest : trader.deals[+btn.dataset.k]);
                    }
                    if (trader && deal) prepareOffer(trader, deal);
                }
            });
            modal.addEventListener('change', e => {
                const t = e.target;
                if (t.id === 'st-radar-sort') { radarSettings.sort = t.value; radarTraderShown = 40; saveRadarSettings(); renderRadarBody(); }
                else if (t.id === 'st-radar-item') { Object.assign(radarItemChoice, { id: t.value, qty: 1 }); radarItemShown = 25; renderRadarBody(); }
                else if (t.id === 'st-radar-itemsort') { radarItemSort = t.value; radarItemShown = 25; renderRadarBody(); }
                else if (t.id === 'st-radar-titem') { Object.assign(radarTheirChoice, { id: t.value, qty: 1 }); radarItemShown = 25; renderRadarBody(); }
                else if (t.id === 'st-radar-qty') { (radarTab === 'theirs' ? radarTheirChoice : radarItemChoice).qty = +t.value; renderRadarBody(); }
            });
            let searchTimer = null;
            // Debounced re-render that keeps the caret in the box being typed in
            const typing = (e, id, apply) => {
                apply(e.target.value);
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    const pos = e.target.selectionStart;
                    renderRadarBody();
                    const box = byId(id);
                    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
                }, 250);
            };
            modal.addEventListener('input', e => {
                const id = e.target.id;
                if (id === 'st-radar-itemfind') {
                    typing(e, id, v => {
                        radarFind = v;
                        const mode = radarTab === 'theirs' ? 'theirs' : 'mine';
                        const q = radarFind.trim().toLowerCase();
                        const first = q ? itemOptions(mode).find(o => o.e.title.toLowerCase().includes(q)) : null;
                        if (first) Object.assign(mode === 'mine' ? radarItemChoice : radarTheirChoice, { id: first.e.gameId, qty: 1 });
                        radarItemShown = 25;
                    });
                } else if (id === 'st-radar-itemfilter') {
                    typing(e, id, v => { radarItemFilter = v; radarItemShown = 25; });
                } else if (id === 'st-radar-search') {
                    typing(e, id, v => { radarSettings.search = v; radarTraderShown = 40; });
                }
            });
        }
        if (scrollToU) {
            const at = sortedVisibleTraders().findIndex(x => x.u === scrollToU);
            if (at >= radarTraderShown) radarTraderShown = at + 1;
        }
        renderRadarBody();
        if (scrollToU) {
            const card = byId(`st-rt-${scrollToU}`);
            if (card) {
                card.scrollIntoView({ block: 'start' });
                card.style.outline = '2px solid #4e9af1';
            } else {
                const status = byId('st-status');
                if (status) status.innerText = 'That trader is hidden by your filters.';
            }
        }
    }

    // ---------- Handing a trade over to the offer page ----------

    function prepareOffer(trader, deal) {
        const pack = parts => parts.map(({ e, q }) => ({ gameId: e.gameId, title: e.title, qty: q }));
        GM_setValue('st_pending_offer', {
            u: trader.u, ts: Date.now(),
            mine: pack(deal.give.parts), theirs: pack(deal.get.parts)
        });
        window.open(`${location.origin}/offer/?u=${trader.u}`, '_blank');
        const status = byId('st-status');
        if (status) status.innerText = `Opened the offer page for ${trader.name} – it will tick the trade and open the preview.`;
    }

    // On the offer page: tick the trade chosen in the Match Radar, then open the preview
    async function applyPendingOffer() {
        const p = GM_getValue('st_pending_offer', null);
        if (!p) return;
        const u = new URLSearchParams(location.search).get('u');
        if (String(p.u) !== String(u) || Date.now() - p.ts > 15 * 60 * 1000) return;
        GM_setValue('st_pending_offer', null);

        const status = byId('st-status');
        for (let i = 0; i < 40 && !getSideElements(true).length && !getSideElements(false).length; i++) await sleep(250);

        const missing = [];
        const resolve = (list, isMine) => {
            const rows = getSideElements(isMine);
            const used = new Set();
            const out = [];
            list.forEach(w => {
                let cands = rows.filter(el => el.querySelector(`a[href*="/game/${w.gameId}/"]`));
                if (!cands.length) cands = rows.filter(el => normTitle(getCleanTitle(el)) === normTitle(w.title));
                if (!cands.length) { missing.push(w.title); return; }
                for (let q = 0; q < w.qty; q++) {
                    // games: use a different row per copy if there is one; items: same row, amount goes up
                    const el = cands.find(c => !used.has(c)) || cands[0];
                    used.add(el);
                    out.push({ title: getCleanTitle(el) || w.title, element: el, checkbox: getRowCheckbox(el), qtyControl: getQtyControl(el) });
                }
            });
            return out;
        };
        const myGames = resolve(p.mine, true);
        const theirGames = resolve(p.theirs, false);
        if (missing.length || !myGames.length || !theirGames.length) {
            if (status) status.innerText = `Match Radar trade: couldn't find ${missing.join(', ') || 'the games'} on this page. Tick them yourself.`;
            return;
        }
        await setupOfferOnPage(myGames, theirGames);
    }

    function initScript() {
        if (/^\/matches\/?/.test(location.pathname) && document.querySelector('h1.trader')) {
            initRadar();
            return;
        }
        createControlPanel();
        if (byId('new-offer')) applyPendingOffer();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initScript);
    } else {
        initScript();
    }
})();
