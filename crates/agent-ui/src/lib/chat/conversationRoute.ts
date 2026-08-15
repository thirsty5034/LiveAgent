// Active-conversation deep link + refresh restore for the headless WebUI.
//
// The chat surface keeps selected conversation id only in React state. A page
// reload therefore lands on the empty welcome view even when the conversation
// still exists (and may still be streaming). Gateway stream buffers already
// support late join / chat.subscribe replay; the missing piece is restoring
// the selection so the client re-subscribes.
//
// Strategy:
//   - URL query `?c=<conversationId>` is the primary restore source (survives
//     hard refresh, is shareable within the same agent scope).
//   - sessionStorage mirrors the last real conversation per agent as a
//     fallback when the URL has no `c` (e.g. user landed on `/`).
//   - Local draft ids are never written — they are ephemeral and meaningless
//     after a reload.

export const CONVERSATION_QUERY_KEY = "c";

const LAST_CONVERSATION_STORAGE_KEY = "liveagent.webui.lastConversation.v1";

const LOCAL_DRAFT_PREFIX = "__local_draft__:";

export function isRoutableConversationId(conversationId: string): boolean {
  const id = conversationId.trim();
  return id !== "" && !id.startsWith(LOCAL_DRAFT_PREFIX);
}

function readSearchParams(search: string): URLSearchParams {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(raw);
}

/** Read `?c=` from a location-like object (defaults to window.location). */
export function readConversationIdFromLocation(
  location: Pick<Location, "search"> | null | undefined = globalThis.window?.location,
): string {
  if (!location) {
    return "";
  }
  try {
    const value = readSearchParams(location.search).get(CONVERSATION_QUERY_KEY) ?? "";
    return isRoutableConversationId(value) ? value.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Write or clear the conversation id in the URL via replaceState (no history
 * spam on every switch). Leaves unrelated query params intact. No-ops when the
 * visible URL already matches.
 */
export function writeConversationIdToLocation(
  conversationId: string | null | undefined,
  location: Pick<Location, "pathname" | "search" | "hash"> | null | undefined = globalThis.window
    ?.location,
  historyApi: Pick<History, "replaceState"> | null | undefined = globalThis.window?.history,
): boolean {
  if (!location || !historyApi) {
    return false;
  }
  const nextId = isRoutableConversationId(conversationId ?? "") ? (conversationId ?? "").trim() : "";
  try {
    const params = readSearchParams(location.search);
    const current = params.get(CONVERSATION_QUERY_KEY) ?? "";
    if (nextId) {
      if (current === nextId) {
        return false;
      }
      params.set(CONVERSATION_QUERY_KEY, nextId);
    } else if (!params.has(CONVERSATION_QUERY_KEY)) {
      return false;
    } else {
      params.delete(CONVERSATION_QUERY_KEY);
    }
    const query = params.toString();
    const nextUrl = `${location.pathname}${query ? `?${query}` : ""}${location.hash || ""}`;
    const state =
      typeof globalThis.window !== "undefined" && globalThis.window.history === historyApi
        ? globalThis.window.history.state
        : {};
    historyApi.replaceState(state, "", nextUrl);
    return true;
  } catch {
    return false;
  }
}

type LastConversationRecord = {
  agentId: string;
  conversationId: string;
};

function readStorage(): Storage | null {
  try {
    return globalThis.window?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function parseRecord(raw: string | null): LastConversationRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LastConversationRecord> | null;
    const agentId = typeof parsed?.agentId === "string" ? parsed.agentId.trim() : "";
    const conversationId =
      typeof parsed?.conversationId === "string" ? parsed.conversationId.trim() : "";
    if (!agentId || !isRoutableConversationId(conversationId)) {
      return null;
    }
    return { agentId, conversationId };
  } catch {
    return null;
  }
}

/** Last real conversation for this agent (session-scoped). */
export function readLastConversationId(agentId: string): string {
  const normalizedAgent = agentId.trim();
  if (!normalizedAgent) {
    return "";
  }
  const storage = readStorage();
  if (!storage) {
    return "";
  }
  try {
    const record = parseRecord(storage.getItem(LAST_CONVERSATION_STORAGE_KEY));
    if (!record || record.agentId !== normalizedAgent) {
      return "";
    }
    return record.conversationId;
  } catch {
    return "";
  }
}

export function writeLastConversationId(agentId: string, conversationId: string | null | undefined): void {
  const normalizedAgent = agentId.trim();
  const storage = readStorage();
  if (!storage || !normalizedAgent) {
    return;
  }
  try {
    const nextId = isRoutableConversationId(conversationId ?? "")
      ? (conversationId ?? "").trim()
      : "";
    if (!nextId) {
      const existing = parseRecord(storage.getItem(LAST_CONVERSATION_STORAGE_KEY));
      if (existing?.agentId === normalizedAgent) {
        storage.removeItem(LAST_CONVERSATION_STORAGE_KEY);
      }
      return;
    }
    const payload: LastConversationRecord = {
      agentId: normalizedAgent,
      conversationId: nextId,
    };
    storage.setItem(LAST_CONVERSATION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage may be unavailable (private mode / quota); URL alone still works.
  }
}

/**
 * Resolve which conversation to restore after a full page load.
 * Prefer the URL (explicit), then the per-agent session fallback.
 */
export function resolveConversationIdToRestore(params: {
  agentId: string;
  location?: Pick<Location, "search"> | null;
}): string {
  const fromUrl = readConversationIdFromLocation(params.location);
  if (fromUrl) {
    return fromUrl;
  }
  return readLastConversationId(params.agentId);
}

/**
 * Persist the active real conversation into URL + sessionStorage. Pass an empty
 * / draft / null id to clear both.
 */
export function syncActiveConversationRoute(params: {
  agentId: string;
  conversationId: string | null | undefined;
  location?: Pick<Location, "pathname" | "search" | "hash"> | null;
  historyApi?: Pick<History, "replaceState"> | null;
}): void {
  const id = isRoutableConversationId(params.conversationId ?? "")
    ? (params.conversationId ?? "").trim()
    : "";
  writeConversationIdToLocation(id || null, params.location, params.historyApi);
  writeLastConversationId(params.agentId, id || null);
}
