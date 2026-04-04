(() => {
  "use strict";

  if (window.__n11ListingCapture?.installed) {
    console.log("[n11-listing-capture] already installed.");
    return;
  }

  const state = {
    installed: true,
    startedAt: new Date().toISOString(),
    requestsSeen: 0,
    hits: 0,
    errors: 0,
    productIds: new Set(),
    lastListingUrl: null,
    pageSignatures: new Map(),
    debug: false,
  };

  function parseUrl(u) {
    try {
      return new URL(u, location.origin);
    } catch {
      return null;
    }
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function normalizeIds(ids) {
    return ids.map(x => String(x).trim()).filter(Boolean);
  }

  function makeSignature(ids) {
    return normalizeIds(ids).join(",");
  }

  function getPageFromUrl(urlObj) {
    if (!urlObj) return null;
    const raw = urlObj.searchParams.get("pg");
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function extractIdsFromText(text) {
    let m = text.match(/"listingProductIds"\s*:\s*\[([\s\S]*?)\]/);
    if (m) {
      return m[1]
        .split(",")
        .map(x => x.replace(/[^\d]/g, "").trim())
        .filter(Boolean);
    }

    const matches = [
      ...text.matchAll(/"productId"\s*:\s*(\d+)/g),
      ...text.matchAll(/"id"\s*:\s*(\d+)/g),
    ];

    return [...new Set(matches.map(m => m[1]))];
  }

  function looksLikeListingPacket(urlObj, json, rawText = "") {
    if (Array.isArray(json?.data?.listingProductIds)) return true;
    if (Array.isArray(json?.data?.adbiddingProductListingItems)) return true;
    if (rawText && /"listingProductIds"\s*:\s*\[/.test(rawText)) return true;
    if (rawText && /"adbiddingProductListingItems"\s*:\s*\[/.test(rawText)) return true;

    if (!urlObj) return false;
    return urlObj.searchParams.get("vueSearch") === "1" && urlObj.searchParams.has("pg");
  }

  function extractIds(json, rawText = "") {
    if (Array.isArray(json?.data?.listingProductIds)) {
      return normalizeIds(json.data.listingProductIds);
    }

    if (Array.isArray(json?.data?.adbiddingProductListingItems)) {
      return normalizeIds(
        json.data.adbiddingProductListingItems
          .map(p => p?.id ?? p?.productId ?? null)
          .filter(Boolean)
      );
    }

    if (Array.isArray(json?.listingProductIds)) {
      return normalizeIds(json.listingProductIds);
    }

    if (Array.isArray(json?.productIds)) {
      return normalizeIds(json.productIds);
    }

    if (Array.isArray(json?.products)) {
      return normalizeIds(
        json.products.map(p => p?.id ?? p?.productId ?? null).filter(Boolean)
      );
    }

    if (rawText) {
      return extractIdsFromText(rawText);
    }

    return [];
  }

  function ingest(urlString, bodyText) {
    const urlObj = parseUrl(urlString);
    const json = safeJsonParse(bodyText);

    if (!looksLikeListingPacket(urlObj, json, bodyText)) return false;

    const ids = extractIds(json, bodyText);
    if (!ids.length) {
      if (state.debug) {
        console.log("[n11-listing-capture][debug] candidate packet but no ids:", urlString, bodyText.slice(0, 1000));
      }
      return false;
    }

    const page = getPageFromUrl(urlObj) ?? 1;
    const signature = makeSignature(ids);

    state.lastListingUrl = urlObj ? urlObj.toString() : null;

    const existingSig = state.pageSignatures.get(page);
    if (existingSig === signature) {
      console.log(`[n11-listing-capture] duplicate packet ignored for pg=${page}`);
      return true;
    }

    state.pageSignatures.set(page, signature);

    for (const id of ids) {
      state.productIds.add(id);
    }

    state.hits++;

    console.log(
      `[n11-listing-capture] pg=${page} +${ids.length} ids (unique total=${state.productIds.size})`
    );

    return true;
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      state.requestsSeen++;
      const clone = res.clone();
      const text = await clone.text();
      ingest(url, text);
    } catch (e) {
      state.errors++;
      if (state.debug) console.warn("[n11-listing-capture][debug] fetch hook error:", e);
    }
    return res;
  };

  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    let _url = null;

    const originalOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      _url = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    xhr.addEventListener("load", () => {
      try {
        state.requestsSeen++;
        ingest(_url, xhr.responseText);
      } catch (e) {
        state.errors++;
        if (state.debug) console.warn("[n11-listing-capture][debug] xhr hook error:", e);
      }
    });

    return xhr;
  }
  window.XMLHttpRequest = PatchedXHR;

  let _stop = false;

  function buildListingUrl(page) {
    if (!state.lastListingUrl) {
      throw new Error("No listing URL template available.");
    }
    const url = new URL(state.lastListingUrl, location.origin);
    url.searchParams.set("pg", String(page));
    return url.toString();
  }

  function requestListing(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");

      xhr.onload = function () {
        const text = xhr.responseText || "";
        const json = safeJsonParse(text);
        resolve({
          status: xhr.status,
          text,
          json,
        });
      };

      xhr.onerror = function () {
        reject(new Error(`Network error for ${url}`));
      };

      xhr.send();
    });
  }

  function downloadIds(filename) {
    const blob = new Blob(
      [JSON.stringify(Array.from(state.productIds), null, 2)],
      { type: "application/json;charset=utf-8" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clearState() {
    state.productIds.clear();
    state.pageSignatures.clear();
    state.lastListingUrl = null;
    state.requestsSeen = 0;
    state.hits = 0;
    state.errors = 0;
    state.startedAt = new Date().toISOString();
  }

  async function autofetchCurrentListing({
    startPage,
    maxPages = 100,
    delayMs = 500,
    autoDownloadOnFinish = true,
    autoClearOnFinish = true,
  } = {}) {
    if (!state.lastListingUrl) {
      throw new Error(
        "No listing packet captured yet. Use setTemplate(url) or trigger one real listing request first."
      );
    }

    _stop = false;

    const templateUrl = new URL(state.lastListingUrl, location.origin);
    const detectedStartPage = getPageFromUrl(templateUrl) ?? 1;
    const firstPage = startPage ?? detectedStartPage;

    console.log(`[n11-listing-capture] autofetch started from pg=${firstPage}`);

    let previousSignature = null;

    for (let page = firstPage; page <= maxPages; page++) {
      if (_stop) break;

      const url = buildListingUrl(page);
      const { status, text, json } = await requestListing(url);

      if (status < 200 || status >= 300) {
        console.log(`[n11-listing-capture] HTTP ${status} at pg=${page}, stopping.`);
        break;
      }

      const ids = extractIds(json, text);
      const signature = makeSignature(ids);

      if (!ids.length) {
        if (state.debug) {
          console.log("[n11-listing-capture][debug] raw response head:", text.slice(0, 1500));
        }
        console.log(`[n11-listing-capture] empty or invalid listing at pg=${page}, stopping.`);
        break;
      }

      if (previousSignature && signature === previousSignature) {
        console.log(`[n11-listing-capture] repeated content at pg=${page}, stopping.`);
        break;
      }

      const existingSig = state.pageSignatures.get(page);
      if (existingSig === signature) {
        console.log(`[n11-listing-capture] pg=${page} already captured, skipping duplicate.`);
      } else {
        ingest(url, text);
      }

      previousSignature = signature;
      await new Promise(r => setTimeout(r, delayMs));
    }

    if (_stop) {
      console.log("[n11-listing-capture] autofetch stopped by user.");
      return;
    }

    console.log("[n11-listing-capture] autofetch finished.");

    try {
      if (autoDownloadOnFinish) {
        const name = `n11_product_ids_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        downloadIds(name);
        console.log(`[n11-listing-capture] auto-downloaded ${name}`);
      }

      if (autoClearOnFinish) {
        clearState();
        console.log("[n11-listing-capture] memory cleared after finish.");
      }
    } catch (e) {
      console.warn("[n11-listing-capture] finish actions failed:", e);
    }
  }

  function setTemplate(urlString) {
    const urlObj = parseUrl(urlString);
    if (!urlObj) throw new Error("Invalid URL.");
    state.lastListingUrl = urlObj.toString();
    console.log("[n11-listing-capture] template set:", state.lastListingUrl);
  }

  window.__n11ListingCapture = {
    installed: true,
    state,

    stats() {
      return {
        startedAt: state.startedAt,
        requestsSeen: state.requestsSeen,
        hits: state.hits,
        errors: state.errors,
        totalIds: state.productIds.size,
        hasTemplate: !!state.lastListingUrl,
        templateUrl: state.lastListingUrl,
        capturedPages: Array.from(state.pageSignatures.keys()).sort((a, b) => a - b),
      };
    },

    setTemplate,
    autofetchCurrentListing,

    debug(on = true) {
      state.debug = !!on;
      console.log("[n11-listing-capture] debug =", state.debug);
    },

    stop() {
      _stop = true;
    },

    clear() {
      clearState();
      console.log("[n11-listing-capture] cleared.");
    },

    downloadNow(filename) {
      const name = filename || `n11_product_ids_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      downloadIds(name);
      console.log(`[n11-listing-capture] downloaded ${name}`);
    }
  };

  console.log(
    "[n11-listing-capture] Installed.\n" +
    "1) Run __n11ListingCapture.setTemplate('FULL_URL')\n" +
    "2) Then run __n11ListingCapture.autofetchCurrentListing()"
  );
})();