// ==UserScript==
// @name         Migaku Memory – Review Batcher
// @namespace    https://ferchus.com
// @version      1.0.0
// @description  Auto-closes when your batch is cleared. Persistent hide toggles (counter / labels / progress), instant batch size apply, SPA-safe.
// @author       Ferchus
// @match        *://study.migaku.com/*
// @icon         https://study.migaku.com/favicon.ico
// @run-at       document-idle
// @noframes
// @grant        GM_addStyle
// @homepageURL  https://github.com/FerchusGames/Migaku-Memory-Review-Batcher
// @supportURL   https://github.com/FerchusGames/Migaku-Memory-Review-Batcher/issues
// @updateURL    https://raw.githubusercontent.com/FerchusGames/Migaku-Memory-Review-Batcher/main/Migaku-Memory-Review-Batcher.user.js
// @downloadURL  https://raw.githubusercontent.com/FerchusGames/Migaku-Memory-Review-Batcher/main/Migaku-Memory-Review-Batcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ==== Adjust here ====
  const BOX_RIGHT_OFFSET = 105; // ← Distance from the right edge (px)

  // --- Config ---
  const DEFAULT_BATCH_SIZE = 10;
  const ROUTE = '/study';
  const POLL_MS = 1000;
  const SELECTOR_COUNTER = '.StudyHeader__reviewsLeft';          // "123 left"
  const SELECTOR_CLOSE   = 'button[aria-label="ID:StudyHeader.close"]';
  const LS = {
    BATCH_SIZE: 'migaku_reviews_threshold', // keeping key for backward compatibility
    HIDE_COUNTER: 'migaku_hide_counter',
    HIDE_LABELS: 'migaku_hide_labels',
    HIDE_PROGRESS: 'migaku_hide_progress',
  };

  // --- Persistent settings ---
  let batchSize    = loadBatchSize();
  let hideCounter  = localStorage.getItem(LS.HIDE_COUNTER)  === 'true';
  let hideLabels   = localStorage.getItem(LS.HIDE_LABELS)   === 'true';
  let hideProgress = localStorage.getItem(LS.HIDE_PROGRESS) === 'true';

  // --- Ephemeral (resets on reload & when leaving /study) ---
  let baseline = null;
  let current = null;
  let attached = false;
  let goalClicked = false;
  let elementObserver = null;
  let pollId = null;

  // --- Styles ---
  GM_addStyle(`
    #reviewsDropBox {
      position: fixed;
      right: ${BOX_RIGHT_OFFSET}px; /* ← distance from the right */
      bottom: 16px;
      z-index: 2147483647;
      min-width: 130px;
      padding: 12px 14px;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      color: #ffffff;
      background: #202047;
      border-radius: 12px;
      box-shadow: 0 4px 18px rgba(0,0,0,.25);
      border: 1px solid rgba(255,255,255,0.1);
      user-select: none;
      pointer-events: auto;
    }
    #reviewsDropBox.green { box-shadow: 0 0 12px #ff8b29; }
    #reviewsDropBox .title { font-weight: 600; margin-bottom: 8px; font-size: 14px; }
    #reviewsDropBox .controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

    /* Compact number input (3 digits) */
    #reviewsDropBox label { font-size: 12px; opacity: .9; display: flex; gap: 6px; align-items: center; }
    #reviewsDropBox input[type="number"] {
      width: 44px; /* ~3 digits */
      padding: 3px 6px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.4);
      background: transparent; color: #fff; outline: none;
      text-align: right;
    }

    /* Gradient checkboxes with centered white checkmark */
    #reviewsDropBox input[type="checkbox"] {
      -webkit-appearance: none; appearance: none;
      width: 16px; height: 16px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.3);
      background: linear-gradient(to bottom, #ff8b29, #f42768);
      cursor: pointer; position: relative;
      display: inline-flex; align-items: center; justify-content: center;
      transition: filter 0.2s ease;
    }
    #reviewsDropBox input[type="checkbox"]::after {
      content: ""; width: 6px; height: 10px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
      opacity: 0; transition: opacity 0.2s ease;
    }
    #reviewsDropBox input[type="checkbox"]:hover { filter: brightness(1.1); }
    #reviewsDropBox input[type="checkbox"]:checked::after { opacity: 1; }
  `);

  // Persistent hide rules stylesheet (applies across reloads/SPA)
  const HIDE_STYLE_ID = 'migaku-hide-prefs-style';
  function ensureHideStyleEl() {
    let el = document.getElementById(HIDE_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = HIDE_STYLE_ID;
      document.head.appendChild(el);
    }
    return el;
  }
  function applyHideStyles() {
    const el = ensureHideStyleEl();
    let css = '';
    if (hideCounter)  css += `${SELECTOR_COUNTER}{visibility:hidden !important;}\n`;
    if (hideLabels)   css += `.Status__container, .DeckItem__labels{visibility:hidden !important;}\n`;
    if (hideProgress) css += `.UiProgressBar__svg, .UiProgressBar__squiggle{visibility:hidden !important;}\n`;
    el.textContent = css;
  }

  // --- UI ---
  function createBox() {
    if (document.getElementById('reviewsDropBox')) return;
    const box = document.createElement('div');
    box.id = 'reviewsDropBox';
    box.innerHTML = `
      <div class="title">Review Batcher</div>

      <div class="controls" style="margin-bottom:6px;">
        <label title="Amount of cards to study in a session">
          Batch size:
          <input id="rdb-batch" type="number" inputmode="numeric" min="1" max="999" step="1" value="${batchSize}">
        </label>
      </div>

      <div class="controls" style="flex-direction:column; align-items:flex-start;">
        <label title="Hide the top study progress visuals">
          <input id="rdb-hide-progress" type="checkbox" ${hideProgress ? 'checked' : ''}>
          Hide progress
        </label>
        <label title="Hide the 'x left' counter shown at the top of the study screen">
          <input id="rdb-hide-counter" type="checkbox" ${hideCounter ? 'checked' : ''}>
          Hide counter
        </label>
        <label title="Hide the 'reviews' and 'new' badges shown around the page">
          <input id="rdb-hide-labels" type="checkbox" ${hideLabels ? 'checked' : ''}>
          Hide labels
        </label>
      </div>
    `;
    (document.body || document.documentElement).appendChild(box);

    // Instant batch size update & persist (clamped 1..999, numeric only, 3 digits)
    const batch = document.getElementById('rdb-batch');
    batch.addEventListener('input', () => {
      batch.value = (batch.value || '').replace(/\D+/g, '').slice(0, 3);
      const n = Math.min(999, Math.max(1, parseInt(batch.value || '0', 10)));
      if (Number.isFinite(n)) {
        batchSize = n;
        saveBatchSize(n);
        updateUI();
      }
    });

    // Hide toggles (persist + apply via stylesheet)
    document.getElementById('rdb-hide-counter').addEventListener('change', (e) => {
      hideCounter = e.target.checked;
      localStorage.setItem(LS.HIDE_COUNTER, String(hideCounter));
      applyHideStyles();
    });
    document.getElementById('rdb-hide-labels').addEventListener('change', (e) => {
      hideLabels = e.target.checked;
      localStorage.setItem(LS.HIDE_LABELS, String(hideLabels));
      applyHideStyles();
    });
    document.getElementById('rdb-hide-progress').addEventListener('change', (e) => {
      hideProgress = e.target.checked;
      localStorage.setItem(LS.HIDE_PROGRESS, String(hideProgress));
      applyHideStyles();
    });

    // Quick toggle if overlapped: Shift+G
    window.addEventListener('keydown', (e) => {
      if (e.shiftKey && e.key.toLowerCase() === 'g') {
        box.style.display = (box.style.display === 'none') ? '' : 'none';
      }
    });
  }

  // --- UI color & auto-close on goal ---
  function updateUI() {
    const box = document.getElementById('reviewsDropBox') || (createBox(), document.getElementById('reviewsDropBox'));
    const goalOk =
      Number.isFinite(baseline) &&
      Number.isFinite(current) &&
      Number.isFinite(batchSize) &&
      current <= Math.max(baseline - batchSize, 0);

    box.classList.toggle('green', goalOk);
    if (goalOk) autoClickClose();
  }

  function hasNewBadge() {
  const el = document.querySelector('span.UiTypo.UiTypo__smallCaption.-emphasis');
  // Only block if the badge actually says "New"
  return !!(el && el.textContent && el.textContent.trim().toLowerCase() === 'new');
  }

  function autoClickClose() {
    // If there's a "New" badge on the page, do nothing.
    if (hasNewBadge()) return;

    if (goalClicked) return;
    goalClicked = true;
    const btn = document.querySelector(SELECTOR_CLOSE);
    if (btn) btn.click();
  }

  // --- Counter parsing/observer ---
  function parseCount(text) {
    if (!text) return NaN;
    const m = text.trim().match(/^(\d+)\s+left/i);
    return m ? parseInt(m[1], 10) : NaN;
  }
  const getCounterEl = () => document.querySelector(SELECTOR_COUNTER);

  function attachCounterObserver(el) {
    if (elementObserver) elementObserver.disconnect();
    elementObserver = new MutationObserver(handleCounterChange);
    elementObserver.observe(el, { characterData: true, childList: true, subtree: true });
  }

  function handleCounterChange() {
    const el = getCounterEl();
    if (!el) return;
    const val = parseCount(el.textContent);
    if (!Number.isFinite(val)) return;

    if (!Number.isFinite(baseline) || baseline <= 0) {
      baseline = val;            // per-visit baseline
      goalClicked = false;
    }
    current = val;
    updateUI();
  }

  // --- Route handling (SPA-aware) ---
  function onRouteChange() {
    const onStudy = location.pathname.startsWith(ROUTE);

    if (onStudy && !attached) {
      attached = true;

      // Reset ephemeral state on every entry to /study
      resetBaseline();
      goalClicked = false;

      createBox();

      // reflect saved UI state in controls
      const bs = document.getElementById('rdb-batch'); if (bs) bs.value = String(batchSize);
      const c1 = document.getElementById('rdb-hide-counter'); if (c1) c1.checked = hideCounter;
      const c2 = document.getElementById('rdb-hide-labels');  if (c2) c2.checked = hideLabels;
      const c3 = document.getElementById('rdb-hide-progress'); if (c3) c3.checked = hideProgress;

      // Apply hide rules immediately (global + counter/labels/progress)
      applyHideStyles();

      // Start with the tracker box HIDDEN on /study entry
      const box = document.getElementById('reviewsDropBox'); if (box) box.style.display = 'none';

      waitAndAttachCounter();
      startPoll();

    } else if (!onStudy && attached) {
      // Leaving /study → reset ephemeral state
      attached = false;
      resetBaseline();
      goalClicked = false;
      if (elementObserver) { elementObserver.disconnect(); elementObserver = null; }
      updateUI();

      // Show the tracker box again on base route
      const box = document.getElementById('reviewsDropBox'); if (box) box.style.display = '';
      // Re-apply global hide prefs
      applyHideStyles();
    } else {
      // base or other routes (not transitioning) → still enforce global hide prefs
      applyHideStyles();

      // ensure visible on base
      if (!onStudy) {
        const box = document.getElementById('reviewsDropBox'); if (box) box.style.display = '';
      }
    }
  }

  function waitAndAttachCounter(timeoutMs = 20000) {
    const start = Date.now();
    (function tryAttach() {
      if (!attached) return;
      const el = getCounterEl();
      if (el) {
        attachCounterObserver(el);
        handleCounterChange();
      } else if (Date.now() - start < timeoutMs) {
        requestAnimationFrame(tryAttach);
      }
    })();
  }

  function startPoll() {
    if (pollId) return;
    pollId = setInterval(() => {
      if (!attached) return;
      const t = getCounterEl();
      if (t && !elementObserver) attachCounterObserver(t);
      handleCounterChange();
    }, POLL_MS);
  }

  // --- SPA navigation hooks ---
  (function hookHistory() {
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function () { const r = _push.apply(this, arguments); window.dispatchEvent(new Event('locationchange')); return r; };
    history.replaceState = function () { const r = _replace.apply(this, arguments); window.dispatchEvent(new Event('locationchange')); return r; };
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
    window.addEventListener('locationchange', onRouteChange);
  })();

  // --- Helpers ---
  function loadBatchSize() {
    const n = Number(localStorage.getItem(LS.BATCH_SIZE));
    return Number.isFinite(n) && n >= 1 ? Math.min(999, n) : DEFAULT_BATCH_SIZE;
  }
  function saveBatchSize(n) { localStorage.setItem(LS.BATCH_SIZE, String(n)); }
  function resetBaseline() { baseline = null; current = null; }

  // --- Boot ---
  createBox();
  applyHideStyles();  // enforce hide prefs immediately on load
  onRouteChange();
})();