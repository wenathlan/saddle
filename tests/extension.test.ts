/**
 * extension tests prove protocol and routing without Chrome, credentials or network access.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createcommand, createerror, createsnapshot, isfreshsnapshot, snapshotdiff } from "../browser.js";
import { createworkerrouter } from "../browser.js";
import { startworker } from "../browser.js";
import { extensionpermissions, permissionpolicy, requestpermission } from "../browser.js";
import { buildextension } from "../browser.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* the content and pagebridge sections of the merged browser.ts register
   globalThis.saddlecontent and globalThis.saddlepagebridge at module load —
   the former side-effect imports of extension/content.js and
   extension/pagebridge.js are covered by the browser.js imports above. */

test("creates versioned extension commands and correlated responses", async () => {
  const command = createcommand("snapshot", { tabid: 7 }, { id: "request1" });
  assert.deepEqual(command, { version: 1, type: "command", id: "request1", command: "snapshot", payload: { tabid: 7 } });
  const error = createerror(command, new Error("stale page"), { code: "stale_snapshot" });
  assert.equal(error.requestid, "request1");
  assert.equal(error.error.code, "stale_snapshot");
});

test("creates snapshots and rejects stale references by identity", () => {
  const snapshot = createsnapshot({ snapshotid: "snap1", url: "https://example.com", elements: [{ ref: "e1", role: "button", name: "Run" }] });
  assert.equal(snapshot.elements[0].ref, "e1");
  assert.equal(isfreshsnapshot("snap1", snapshot.snapshotid), true);
  assert.equal(isfreshsnapshot("snap0", snapshot.snapshotid), false);
});

test("computes extension snapshot diffs and detects context changes", () => {
  const previous = createsnapshot({ snapshotid: "snap1", windowid: "window1", tabid: "tab1", frameid: "main", elements: [{ ref: "e1", role: "button", name: "Run" }, { ref: "e2", role: "link", name: "Docs" }] });
  const current = createsnapshot({ snapshotid: "snap2", windowid: "window1", tabid: "tab1", frameid: "frame2", elements: [{ ref: "e1", role: "button", name: "Running" }, { ref: "e3", role: "link", name: "Guide" }] });
  const diff = snapshotdiff(previous, current);
  assert.equal(diff.contextchanged, true);
  assert.equal(diff.added[0].ref, "e3");
  assert.equal(diff.removed[0].ref, "e2");
  assert.equal(diff.changed[0].name, "Running");
});

test("routes commands through scripting and tabs while persisting snapshot state", async () => {
  const calls = [];
  const router = createworkerrouter({
    scripting: { async executeScript(input) { calls.push(["script", input]); } },
    tabs: { async sendMessage(tabid, message) { calls.push(["message", tabid, message]); return { type: "response", payload: { snapshotid: "snap2" } }; } },
    storage: { async set(value) { calls.push(["set", value]); }, async get() { return { saddleextensionstate: { snapshotid: "snap1" } }; } }
  });
  const response = await router.handle(createcommand("snapshot", { tabid: 9 }), { tab: { id: 9, windowId: 4 }, frameId: 2 });
  assert.equal(response.payload.snapshotid, "snap2");
  assert.deepEqual({ tabid: response.payload.tabid, frameid: response.payload.frameid, windowid: response.payload.windowid }, { tabid: "9", frameid: "2", windowid: "4" });
  assert.deepEqual(calls.map(([kind, value]) => kind), ["set", "script", "message", "set"]);
  assert.deepEqual(calls[3][1].saddleextensionstate.pending, []);
  assert.equal(calls[0][1].saddleextensionstate.pending[0].requestid, calls[2][2].id);
  assert.deepEqual(await router.readstate(), { snapshotid: "snap1" });
});

test("content bridge returns bounded snapshots and executes only referenced clicks", () => {
  let clicked = false;
  const element = { tagName: "BUTTON", innerText: "Run", getAttribute(name) { return name === "role" ? "button" : null; }, click() { clicked = true; } };
  const documentref = { location: { href: "https://example.com" }, title: "Example", body: { innerText: "Visible content" }, querySelectorAll() { return [element]; } };
  const bridge = globalThis.saddlecontent.createbridge(documentref, () => 100);
  const snapshot = bridge.snapshotpage();
  assert.equal(snapshot.elements[0].ref, "e1");
  const result = bridge.handle(createcommand("clickref", { ref: "e1", snapshotid: snapshot.snapshotid }));
  assert.equal(result.clicked, true);
  assert.equal(clicked, true);
  assert.throws(() => bridge.handle(createcommand("clickref", { ref: "e1", snapshotid: "stale" })), (error) => error.code === "stale_snapshot");
});

test("content isolation reads page-world facts through a correlated message boundary", async () => {
  const events = new Set();
  const documentref = { location: { href: "https://example.com/page" }, title: "Page world", body: { innerText: "Facts from the page world" } };
  const windowref = {
    document: documentref,
    addEventListener(type, listener) { if (type === "message") events.add(listener); },
    removeEventListener(type, listener) { if (type === "message") events.delete(listener); },
    setTimeout,
    clearTimeout,
    postMessage(data) { queueMicrotask(() => { for (const listener of events) listener({ source: windowref, data }); }); }
  };
  const pagebridge = globalThis.saddlepagebridge.createpagebridge(windowref);
  events.add(pagebridge.listener);
  const bridge = globalThis.saddlecontent.createbridge(documentref, () => 100, { pagechannel: globalThis.saddlecontent.createpagechannel(windowref, () => 100, 50) });
  const facts = await bridge.handle(createcommand("pagefacts", {}, { id: "facts1" }));
  assert.deepEqual(facts, { url: "https://example.com/page", title: "Page world", text: "Facts from the page world" });
  bridge.pagechannel.dispose();
  events.delete(pagebridge.listener);
});

test("content isolation rejects a missing page-world response with a stable timeout", async () => {
  const events = new Set();
  const windowref = { addEventListener(type, listener) { if (type === "message") events.add(listener); }, removeEventListener(type, listener) { if (type === "message") events.delete(listener); }, setTimeout, clearTimeout, postMessage() {} };
  const channel = globalThis.saddlecontent.createpagechannel(windowref, () => 100, 5);
  await assert.rejects(() => channel.readpage(), (error) => error.code === "page_bridge_timeout");
  channel.dispose();
});

test("keeps extension permissions minimal and optional escalation caller-owned", async () => {
  const policy = permissionpolicy({ optional: ["activeTab"] });
  assert.deepEqual(policy.hostpermissions, []);
  assert.equal(policy.allows("storage"), true);
  assert.deepEqual(policy.missing(["storage", "scripting"]), []);
  assert.equal(extensionpermissions.includes("scripting"), true);
  assert.deepEqual(await requestpermission(policy, "activeTab", async () => true), { permission: "activeTab", granted: true });
  await assert.rejects(() => requestpermission(policy, "storage", async () => true), /not optional/);
});

test("builds a versioned unpacked extension artifact without mutating the source manifest", async () => {
  const output = await mkdtemp(join(tmpdir(), "saddle-extension-"));
  try {
    const result = await buildextension({ output, version: "1.8.1" });
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.equal(result.manifest.version, "1.8.1");
    assert.equal(manifest.version, "1.8.1");
    assert.equal(manifest.permissions.includes("storage"), true);
    assert.equal(manifest.host_permissions, undefined);
    assert.match(await readFile(join(output, "pagebridge.js"), "utf8"), /saddle\.pagefacts\.v1/);
  } finally {
    await rm(output, { force: true, recursive: true });
  }
});

test("rehydrates and explicitly resumes pending commands after worker termination", async () => {
  const command = createcommand("snapshot", { tabid: 11 }, { id: "pending1" });
  const writes = [];
  const router = createworkerrouter({
    scripting: { async executeScript() {} },
    tabs: { async sendMessage(tabid, message) { return { type: "response", payload: { tabid, snapshotid: `snap-${message.id}` } }; } },
    storage: { async get() { return { saddleextensionstate: { pending: [{ requestid: command.id, command: command.command, message: command, tabid: 11, frameid: "frame2", windowid: "window1", attempts: 1, createdat: 1, updatedat: 2 }] } }; }, async set(value) { writes.push(value); } }
  });
  const state = await router.rehydrate();
  assert.equal(state.pending[0].requestid, "pending1");
  const response = await router.resume("pending1");
  assert.equal(response.payload.snapshotid, "snap-pending1");
  assert.deepEqual({ frameid: response.payload.frameid, windowid: response.payload.windowid }, { frameid: "frame2", windowid: "window1" });
  assert.deepEqual(writes.at(-1).saddleextensionstate.pending, []);
  await assert.rejects(() => router.resume("missing"), (error) => error.code === "PENDING_NOT_FOUND");
});

test("registers startup rehydration without automatic command replay", async () => {
  let startup;
  let added;
  let removed;
  const chromeapi = {
    runtime: { onMessage: { addListener(listener) { added = listener; }, removeListener() {} }, onStartup: { addListener(listener) { startup = listener; }, removeListener(listener) { removed = listener; } } },
    tabs: { async sendMessage() { return { type: "response", payload: {} }; } },
    scripting: { async executeScript() {} },
    storage: { session: { async get() { return { saddleextensionstate: { pending: [] } }; }, async set() {} } }
  };
  const worker = startworker(chromeapi);
  await startup();
  assert.equal(typeof added, "function");
  worker.dispose();
  assert.equal(removed, startup);
});
