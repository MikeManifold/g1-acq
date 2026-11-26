"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const requestSource = fs.readFileSync(path.join(root, "g1-request-observer.js"), "utf8");
const responseSource = fs.readFileSync(path.join(root, "g1-acq-discount.js"), "utf8");
const reportSource = fs.readFileSync(path.join(root, "g1-sku-report-discount.js"), "utf8");
const requestKey = "g1.request.trace.v1";

function run(source, url, store, body) {
  let calls = 0, output, logs = [];
  const ctx = {
    $request: { url, method: "GET", headers: { Cookie: "PRIVATE_COOKIE" } },
    $response: { body },
    $persistentStore: {
      read: key => store.get(key) || null,
      write: (value, key) => { store.set(key, value); return true; }
    },
    $done: value => { calls++; output = value; },
    console: { log: (...a) => logs.push(a.join(" ")) }
  };
  vm.runInNewContext(source, ctx, { timeout: 2000 });
  assert.equal(calls, 1, "each script must finish exactly once");
  return { output, logs };
}
function q(url) { return "https://one.google.com" + url; }

test("request observer decodes Base64 protobuf SKU IDs and stores no session details", () => {
  const store = new Map();
  const sc = Buffer.from("\x12g1.ios.30gb.m.3month_ip_75p\x0eg1.ios.100gb.m\x00").toString("base64");
  const full = q("/u/1/upsell?sc=" + sc + "&session_id=SESSION_SECRET&token=PRIVATE_TOKEN");
  const { output } = run(requestSource, full, store);
  assert.equal(Object.keys(output).length, 0);
  const state = JSON.parse(store.get(requestKey));
  assert.equal(state.total, 1);
  assert.equal(state.byHost["one.google.com"], 1);
  assert.equal(state.byRoute["/u/{n}/upsell"], 1);
  assert.deepEqual(Array.from(state.skus, x => x.id), [
    "g1.ios.30gb.m.3month_ip_75p", "g1.ios.100gb.m"
  ]);
  assert.deepEqual(Array.from(state.recentRequests[0].skus), [
    "g1.ios.30gb.m.3month_ip_75p", "g1.ios.100gb.m"
  ]);
  const stored = JSON.stringify(state);
  for (const secret of ["SESSION_SECRET", "PRIVATE_TOKEN", "PRIVATE_COOKIE", sc]) {
    assert(!stored.includes(secret), "must not persist " + secret);
  }
  assert(!store.has("g1.sku.scan.v1"), "request SKU must not pollute response scan");
});

test("counts are independent across one.google.com and subscription APIs", () => {
  const store = new Map();
  const hosts = [
    q("/ai?authuser=1"),
    "https://subscriptionsmobile-pa.googleapis.com/v1/example",
    "https://subscriptionsmanagement-pa.googleapis.com/v1/another"
  ];
  for (const url of hosts) run(requestSource, url, store);
  const state = JSON.parse(store.get(requestKey));
  assert.equal(state.total, 3);
  assert.equal(state.byHost["one.google.com"], 1);
  assert.equal(state.byHost["subscriptionsmobile-pa.googleapis.com"], 1);
  assert.equal(state.byHost["subscriptionsmanagement-pa.googleapis.com"], 1);
  assert.equal(state.byRoute["/subscription-api"], 2);
  assert.equal(state.recentRequests.length, 3);
  assert.equal(state.recentRequests[0].route, "/ai");
});

test("report separates request-side observations from response-side scan", () => {
  const store = new Map();
  const sc = Buffer.from("\x00g1.ios.30gb.m.3month_ip_75p\x01g1.ios.100gb.m").toString("base64");
  run(requestSource, q("/u/1/upsell?sc=" + sc), store);
  run(requestSource, "https://subscriptionsmobile-pa.googleapis.com/v1/test", store);
  run(responseSource, q("/robots.txt"), store, "User-agent: *");
  const json = JSON.parse(run(reportSource, q("/g1-sku-report-pathfix?format=json"), store).output.response.body);
  assert.equal(json.reportVersion, "v7.12.3-pathfix");
  assert.equal(json.scan.version, "g1-acq-v7.12.3-pathfix");
  assert.equal(json.scan.scannedResponses, 1);
  assert.equal(json.scan.skus.length, 0);
  assert.equal(json.test.hitCount, 0);
  assert.equal(json.requestTrace.total, 2);
  assert.equal(json.requestTrace.skus.length, 2);
  assert.equal(json.requestTrace.recentRequests[0].route, "/u/{n}/upsell");
  const html = run(reportSource, q("/g1-sku-report-pathfix"), store).output.response.body;
  assert(html.includes("请求级诊断（与响应采集分开）"));
  assert(html.includes("g1.ios.30gb.m.3month_ip_75p"));
  assert(html.includes("已捕获请求：2 次"));
  assert(html.includes("北京时间 UTC+8"));
  assert(html.includes("subscriptionsmobile-pa.googleapis.com"));
  assert(!html.includes("PRIVATE_COOKIE"));
});

test("non-matching hosts and report pages are no-op", () => {
  const store = new Map();
  for (const url of [
    q("/g1-sku-report-pathfix"), q("/robots.txt"),
    "https://one.google.com.evil/ai",
    "https://accounts.google.com/foo"
  ]) {
    const r = run(requestSource, url, store);
    assert.equal(Object.keys(r.output).length, 0);
  }
  assert(!store.has(requestKey));
});

test("module captures only desired paths and has one request observer", () => {
  const module = fs.readFileSync(path.join(root, "g1-acq-ultra-discount.sgmodule"), "utf8");
  const lines = module.split("\n").filter(x => x.startsWith("g1-request-observer = "));
  assert.equal(lines.length, 1);
  const pattern = lines[0].match(/pattern=([^,]+),requires-body=/)[1];
  const re = new RegExp(pattern);
  for (const url of [
    q("/ai?x=1"),q("/u/1/upsell?sc=123"),
    q("/_/SubscriptionsManagementUi/data/batchexecute?rpcids=abc"),
    "https://subscriptionsmobile-pa.googleapis.com/v1",
    "https://subscriptionsmanagement-pa.googleapis.com/v1"
  ]) assert(re.test(url), url);
  for (const url of [q("/g1-sku-report-pathfix"),"https://one.google.com.evil/ai"]) assert(!re.test(url), url);
  assert.match(module, /hostname = %APPEND% one\.google\.com/);
  assert(!module.includes("192.168."));
  assert.equal(module.split("script-path=").length - 1, 4);
});
