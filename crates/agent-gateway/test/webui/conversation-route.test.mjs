import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const route = loader.loadModule("src/lib/chat/conversationRoute.ts");

function installWindow(initial = {}) {
  const session = new Map();
  let pathname = initial.pathname || "/";
  let search = initial.search || "";
  let hash = initial.hash || "";
  let state = {};
  const history = {
    get state() {
      return state;
    },
    replaceState(nextState, _title, url) {
      state = nextState;
      const parsed = new URL(String(url), "http://example.test");
      pathname = parsed.pathname;
      search = parsed.search;
      hash = parsed.hash;
    },
  };
  const location = {
    get pathname() {
      return pathname;
    },
    get search() {
      return search;
    },
    get hash() {
      return hash;
    },
  };
  globalThis.window = {
    location,
    history,
    sessionStorage: {
      getItem(key) {
        return session.has(key) ? session.get(key) : null;
      },
      setItem(key, value) {
        session.set(key, String(value));
      },
      removeItem(key) {
        session.delete(key);
      },
    },
  };
  return { location, history, session, getUrl: () => `${pathname}${search}${hash}` };
}

test("isRoutableConversationId rejects drafts and blanks", () => {
  assert.equal(route.isRoutableConversationId(""), false);
  assert.equal(route.isRoutableConversationId("  "), false);
  assert.equal(route.isRoutableConversationId("__local_draft__:abc"), false);
  assert.equal(route.isRoutableConversationId("conv-123"), true);
});

test("writeConversationIdToLocation sets and clears ?c= without clobbering other params", () => {
  const env = installWindow({ pathname: "/", search: "?foo=1" });
  assert.equal(route.writeConversationIdToLocation("conv-a"), true);
  assert.equal(env.getUrl(), "/?foo=1&c=conv-a");
  assert.equal(route.readConversationIdFromLocation(), "conv-a");
  assert.equal(route.writeConversationIdToLocation("conv-a"), false);
  assert.equal(route.writeConversationIdToLocation(null), true);
  assert.equal(env.getUrl(), "/?foo=1");
  assert.equal(route.readConversationIdFromLocation(), "");
});

test("syncActiveConversationRoute mirrors sessionStorage per agent and prefers URL on restore", () => {
  installWindow({ pathname: "/", search: "" });
  route.syncActiveConversationRoute({ agentId: "agent-1", conversationId: "conv-1" });
  assert.equal(route.readLastConversationId("agent-1"), "conv-1");
  assert.equal(route.readLastConversationId("agent-2"), "");
  assert.equal(route.readConversationIdFromLocation(), "conv-1");

  route.syncActiveConversationRoute({ agentId: "agent-1", conversationId: null });
  assert.equal(route.readLastConversationId("agent-1"), "");
  assert.equal(route.readConversationIdFromLocation(), "");

  route.writeLastConversationId("agent-1", "from-storage");
  assert.equal(route.resolveConversationIdToRestore({ agentId: "agent-1" }), "from-storage");

  route.writeConversationIdToLocation("from-url");
  assert.equal(route.resolveConversationIdToRestore({ agentId: "agent-1" }), "from-url");
});

test("draft conversation ids never land in URL or storage", () => {
  installWindow({ pathname: "/", search: "?c=real" });
  route.syncActiveConversationRoute({
    agentId: "agent-1",
    conversationId: "__local_draft__:x",
  });
  assert.equal(route.readConversationIdFromLocation(), "");
  assert.equal(route.readLastConversationId("agent-1"), "");
});
