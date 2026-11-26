/* G1 ACQ request-side diagnostics.
 * Observes eligible HTTPS requests without changing them or making network calls.
 * Only recognized SKU IDs and route categories are retained; not URLs/params/cookies.
 */
"use strict";
(function () {
  var KEY = "g1.request.trace.v1";
  var VERSION = "g1-request-v7.12.3-pathfix";
  var MAX_RECENT = 80, MAX_SKUS = 100, MAX_SINGLEREQ = 20;
  var request = typeof $request === "object" && $request ? $request : {};
  var url = typeof request.url === "string" ? request.url : "";
  var m = /^https:\/\/([^/?#]+)(\/[^?#]*)?/.exec(url);
  if (!m) { $done({}); return; }
  var host = m[1].toLowerCase();
  var path = (m[2] || "/").replace(/\/+$/, "") || "/";
  var route = "";
  if (host === "one.google.com") {
    if (path === "/ai" || path === "/upsell") route = path;
    else if (/^\/u\/\d+\/ai$/.test(path)) route = "/u/{n}/ai";
    else if (/^\/u\/\d+\/upsell$/.test(path)) route = "/u/{n}/upsell";
    else if (path === "/_/SubscriptionsManagementUi/data/batchexecute") route = "/subscriptions-rpc";
  } else if (host === "subscriptionsmobile-pa.googleapis.com" ||
             host === "subscriptionsmanagement-pa.googleapis.com") {
    route = "/subscription-api";
  }
  if (!route) { $done({}); return; }

  function decodeBase64(raw) {
    try { raw = decodeURIComponent(raw).replace(/-/g, "+").replace(/_/g, "/"); }
    catch (e) { return ""; }
    if (raw.length > 16000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return "";
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var bits = 0, acc = 0, out = "";
    for (var i = 0; i < raw.length; i += 1) {
      if (raw.charAt(i) === "=") break;
      var n = alphabet.indexOf(raw.charAt(i));
      if (n === -1) return "";
      acc = (acc << 6) | n;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 255);
        acc &= (1 << bits) - 1;
      }
    }
    return out;
  }

  var query = /[?&]sc=([^&#]*)/.exec(url);
  var decoded = query ? decodeBase64(query[1]) : "";
  var match = decoded.match(/(?:g1\.|com\.google\.(?:one|gemini)\.)[A-Za-z0-9._-]{1,160}/g) || [];
  var ids = [], seen = Object.create(null);
  for (var k = 0; k < match.length; k += 1) {
    var id = match[k];
    if (!/^(?:g1\.|com\.google\.(?:one|gemini)\.)[A-Za-z0-9._-]{1,160}$/.test(id) || seen[id]) continue;
    seen[id] = true;
    ids.push(id);
    if (ids.length >= MAX_SINGLEREQ) break;
  }

  var at = new Date().toISOString();
  var event = {
    at: at, host: host, route: route,
    method: request.method === "POST" ? "POST" : "GET",
    hasSc: !!query, skuCount: ids.length, skus: ids
  };
  try {
    var store = typeof $persistentStore !== "undefined" ? $persistentStore : null;
    if (store && typeof store.read === "function" && typeof store.write === "function") {
      var state;
      try { state = JSON.parse(store.read(KEY) || "{}"); }
      catch (e) { state = {}; }
      if (!state || typeof state !== "object" || state.schemaVersion !== 1) state = {};
      var events = Array.isArray(state.recentRequests) ? state.recentRequests.slice(-MAX_RECENT + 1) : [];
      events.push(event);
      var byHost = state.byHost && typeof state.byHost === "object" ? state.byHost : {};
      var byRoute = state.byRoute && typeof state.byRoute === "object" ? state.byRoute : {};
      byHost[host] = (Number(byHost[host]) || 0) + 1;
      byRoute[route] = (Number(byRoute[route]) || 0) + 1;
      var previous = Array.isArray(state.skus) ? state.skus : [];
      var skuMap = Object.create(null), order = [];
      previous.slice(0, MAX_SKUS).forEach(function (row) {
        if (!row || typeof row.id !== "string" ||
            !/^(?:g1\.|com\.google\.(?:one|gemini)\.)[A-Za-z0-9._-]{1,160}$/.test(row.id) ||
            skuMap[row.id]) return;
        skuMap[row.id] = { id: row.id, count: Math.max(0, Number(row.count) || 0), lastSeen: row.lastSeen || "" };
        order.push(row.id);
      });
      ids.forEach(function (id) {
        if (!skuMap[id] && order.length < MAX_SKUS) {
          skuMap[id] = { id: id, count: 0, lastSeen: at };
          order.push(id);
        }
        if (skuMap[id]) { skuMap[id].count += 1; skuMap[id].lastSeen = at; }
      });
      var newState = {
        schemaVersion: 1, version: VERSION, updatedAt: at,
        total: (Number(state.total) || 0) + 1,
        byHost: byHost, byRoute: byRoute,
        recentRequests: events.slice(-MAX_RECENT),
        skus: order.map(function (id) { return skuMap[id]; })
      };
      if (!store.write(JSON.stringify(newState), KEY)) {
        console.log("[g1-request] local-write-failed");
      } else {
        console.log("[g1-request] " + route + " skuCount=" + ids.length);
      }
    }
  } catch (e) { console.log("[g1-request] diagnostic-store-error"); }
  $done({});
})();