(() => {
  "use strict";

  // If already installed, do nothing.
  if (window.__n11Capture?.installed) {
    console.log("[n11-capture] already installed. Use __n11Capture.download() when ready.");
    return;
  }

  // ---------- Storage ----------
  const state = {
    installed: true,
    startedAt: new Date().toISOString(),
    requestsSeen: 0,
    hits: 0,
    errors: 0,

    // productId -> { meta, byReviewId: Map(), pages: Set(), lastSeenAt }
    products: new Map(),
  };

  function ensureProduct(productId) {
    if (!state.products.has(productId)) {
      state.products.set(productId, {
        productId,
        lastSeenAt: new Date().toISOString(),
        pages: new Set(),
        byReviewId: new Map(),
        meta: {
          sortOrder: null,
          tag: null,
          itemsPerPage: null,
          pageCount: null,
          totalCount: null,
        }
      });
    }
    return state.products.get(productId);
  }

  function parseUrl(u) {
    try {
      const url = new URL(u, location.origin);
      return url;
    } catch {
      return null;
    }
  }

  function isTarget(urlObj) {
    if (!urlObj) return false;
    // matches /getProductReviews/<digits>
    return /\/getProductReviews\/\d+/.test(urlObj.pathname);
  }

  function getProductId(urlObj) {
    const m = urlObj.pathname.match(/\/getProductReviews\/(\d+)/);
    return m?.[1] ?? null;
  }

  function getPageParams(urlObj) {
    return {
      currentPage: urlObj.searchParams.get("currentPage"),
      sortOrder: urlObj.searchParams.get("sortOrder"),
      tag: urlObj.searchParams.get("tag"),
    };
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function ingest(urlString, bodyText) {
    const urlObj = parseUrl(urlString);
    if (!isTarget(urlObj)) return;

    const productId = getProductId(urlObj);
    if (!productId) return;

    const params = getPageParams(urlObj);
    const json = safeJsonParse(bodyText);
    if (!json) return;

    const list = json.productFeedBackReviewList;
    if (!Array.isArray(list)) return;

    const p = ensureProduct(productId);
    p.lastSeenAt = new Date().toISOString();

    // meta
    if (params.sortOrder) p.meta.sortOrder = params.sortOrder;
    if (params.tag) p.meta.tag = params.tag;
    if (json?.pagination?.itemsPerPage != null) p.meta.itemsPerPage = json.pagination.itemsPerPage;
    if (json?.pagination?.pageCount != null) p.meta.pageCount = json.pagination.pageCount;
    if (json?.pagination?.totalCount != null) p.meta.totalCount = json.pagination.totalCount;

    if (params.currentPage) p.pages.add(String(params.currentPage));

    // add reviews (dedupe by review id)
    for (const r of list) {
      if (r?.id == null) continue;
      const key = String(r.id);
      if (!p.byReviewId.has(key)) p.byReviewId.set(key, r);
    }

    state.hits += 1;

    console.log(
      `[n11-capture] ${productId} page=${params.currentPage ?? "?"} +${list.length} ` +
      `(unique=${p.byReviewId.size}, pagesSeen=${p.pages.size})`
    );
  }

  // ---------- Active fetch (no manual scroll needed) ----------
  let _autofetchStop = false;

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  }

  function buildReviewsUrl(productId, page, sortOrder, tag) {
    const url = new URL(`/getProductReviews/${productId}`, location.origin);
    url.searchParams.set("currentPage", String(page));
    if (sortOrder) url.searchParams.set("sortOrder", String(sortOrder));
    if (tag) url.searchParams.set("tag", String(tag));
    return url.toString();
  }

  function inferProductIdFromLocation() {
    // e.g. https://www.n11.com/product-reviews/699789136
    const m = location.pathname.match(/\/product-reviews\/(\d+)/);
    return m?.[1] ?? null;
  }

  async function autofetchProduct({
    productId,
    sortOrder = "RECENT",
    tag = "tümü",
    delayMs = 400,
    maxPages = 500,
    autoClearOnFinish = true,
  } = {}) {
    if (!productId) throw new Error("autofetchProduct: productId is required");

    _autofetchStop = false;
    console.log(`[n11-capture] autofetch started productId=${productId} sortOrder=${sortOrder} tag=${tag}`);

    // First page: determines pageCount and meta
    let page = 1;
    let pageCount = null;

    while (!_autofetchStop && page <= maxPages) {
      const url = buildReviewsUrl(productId, page, sortOrder, tag);
      const json = await fetchJson(url);

      // Ingest as if it was captured from network
      ingest(url, JSON.stringify(json));

      pageCount ??= (json?.pagination?.pageCount ?? null);
      const lastPage = Boolean(json?.pagination?.lastPage);

      if (lastPage) break;
      if (pageCount && page >= pageCount) break;

      page += 1;
      await new Promise(r => setTimeout(r, delayMs));
    }

    if (_autofetchStop) {
      console.log("[n11-capture] autofetch stopped by user.");
    } else {
      console.log("[n11-capture] autofetch finished.");
      try {
        const name = `n11_capture_${productId}_${stamp()}.json`;
        downloadJSON(name, snapshot());
        console.log(`[n11-capture] autofetch auto-downloaded ${name}`);
        if (autoClearOnFinish) {
          clearData();
          console.log("[n11-capture] memory cleared after autofetch.");
        }
      } catch (e) {
        console.warn("[n11-capture] autofetch finished but auto-download failed:", e);
      }
    }
  }

  async function autofetchCurrent(options = {}) {
    const productId = inferProductIdFromLocation();
    if (!productId) {
      throw new Error("autofetchCurrent: could not infer productId from URL. Open an n11 /product-reviews/<id> page or pass productId explicitly.");
    }

    // If we already captured meta for this product (tag/sortOrder), prefer it
    const existing = state.products.get(productId);
    const sortOrder = options.sortOrder ?? existing?.meta?.sortOrder ?? "RECENT";
    const tag = options.tag ?? existing?.meta?.tag ?? "tümü";

    return autofetchProduct({ productId, sortOrder, tag, delayMs: options.delayMs ?? 400, maxPages: options.maxPages ?? 500 });
  }

  // ---------- Hook fetch ----------
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      state.requestsSeen += 1;

      const urlObj = parseUrl(url);
      if (isTarget(urlObj)) {
        const clone = res.clone();
        const text = await clone.text();
        ingest(url, text);
      }
    } catch (e) {
      state.errors += 1;
      // keep silent to avoid breaking the page
    }
    return res;
  };

  // ---------- Hook XHR ----------
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    let _url = null;

    const originalOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      _url = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    xhr.addEventListener("load", () => {
      try {
        state.requestsSeen += 1;
        const urlObj = parseUrl(_url);
        if (!isTarget(urlObj)) return;
        // responseText for json
        ingest(_url, xhr.responseText);
      } catch {
        state.errors += 1;
      }
    });

    return xhr;
  }
  window.XMLHttpRequest = PatchedXHR;

  // ---------- Memory management ----------
  function clearData() {
    state.products.clear();
    state.requestsSeen = 0;
    state.hits = 0;
    state.errors = 0;
    state.startedAt = new Date().toISOString();
  }

  // ---------- Export helpers ----------
  function snapshot() {
    const out = {
      startedAt: state.startedAt,
      requestsSeen: state.requestsSeen,
      hits: state.hits,
      errors: state.errors,
      products: {},
    };

    for (const [productId, p] of state.products.entries()) {
      out.products[productId] = {
        productId,
        lastSeenAt: p.lastSeenAt,
        meta: p.meta,
        pagesSeen: Array.from(p.pages).sort((a,b)=>Number(a)-Number(b)),
        reviewCountUnique: p.byReviewId.size,
        reviews: Array.from(p.byReviewId.values()),
      };
    }
    return out;
  }

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  window.__n11Capture = {
    installed: true,
    state,
    snapshot,

    // Clear all captured reviews from memory (keeps hooks installed)
    clear() {
      clearData();
      console.log("[n11-capture] cleared in-memory data.");
    },

    // Fully uninstall hooks and remove the global object
    uninstall() {
      try {
        window.fetch = originalFetch;
        window.XMLHttpRequest = OriginalXHR;
      } finally {
        delete window.__n11Capture;
      }
      console.log("[n11-capture] uninstalled.");
    },

    // download everything captured so far
    download(filename) {
      const name = filename ?? `n11_capture_${stamp()}.json`;
      downloadJSON(name, snapshot());
      console.log(`[n11-capture] downloaded ${name}`);
    },
    // quick stats
    stats() {
      const s = snapshot();
      const products = Object.keys(s.products).length;
      const totalReviews = Object.values(s.products).reduce((acc, p) => acc + p.reviewCountUnique, 0);
      return { startedAt: s.startedAt, requestsSeen: s.requestsSeen, hits: s.hits, errors: s.errors, products, totalReviews };
    },

    // Actively fetch all review pages for the current product-reviews page (no manual scrolling)
    autofetchCurrent,

    // Actively fetch all review pages for any productId you provide
    autofetchProduct,

    // Stop an in-progress autofetch
    stopAutofetch() {
      _autofetchStop = true;
    },

    // Convenience: download + return a snapshot immediately
    downloadNow(filename) {
      const name = filename ?? `n11_capture_${stamp()}.json`;
      downloadJSON(name, snapshot());
      return snapshot();
    },
  };

  console.log(
    "[n11-capture] Installed.\n" +
    "1) Passive mode: Scroll / paginate normally (it will record).\n" +
    "2) Active mode: Run __n11Capture.autofetchCurrent() to fetch all pages automatically.\n" +
    "   Stop with: __n11Capture.stopAutofetch()\n" +
    "3) Save anytime: __n11Capture.download()\n" +
    "4) Progress: __n11Capture.stats()\n" +
    "5) Clear memory: __n11Capture.clear()"
  );
})();