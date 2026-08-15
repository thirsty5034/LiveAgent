import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

import {
  assistantMessageHasVisibleText,
  isStreamInterruptedAssistant,
} from "./chatAbort";
import {
  type ConversationViewState,
  getActiveSegment,
  STREAM_RESUME_MESSAGE_TEXT,
} from "./conversationState";

const PENDING_STREAM_RESUME_PREFIX = "liveagent:pending-stream-resume:";

function storageKey(conversationId: string) {
  return `${PENDING_STREAM_RESUME_PREFIX}${conversationId.trim()}`;
}

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

/** Set on pagehide/beforeunload while a turn is still streaming. */
export function markPendingStreamResume(conversationId: string): void {
  const id = conversationId.trim();
  if (!id || !canUseSessionStorage()) return;
  try {
    window.sessionStorage.setItem(storageKey(id), "1");
  } catch {
    // Private mode / quota — durable interrupt marker is the fallback.
  }
}

export function clearPendingStreamResume(conversationId: string): void {
  const id = conversationId.trim();
  if (!id || !canUseSessionStorage()) return;
  try {
    window.sessionStorage.removeItem(storageKey(id));
  } catch {
    // ignore
  }
}

/** Returns true once and clears the same-tab refresh intent. */
export function consumePendingStreamResume(conversationId: string): boolean {
  const id = conversationId.trim();
  if (!id || !canUseSessionStorage()) return false;
  try {
    const key = storageKey(id);
    if (window.sessionStorage.getItem(key) !== "1") return false;
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function peekPendingStreamResume(conversationId: string): boolean {
  const id = conversationId.trim();
  if (!id || !canUseSessionStorage()) return false;
  try {
    return window.sessionStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
}

export function getTrailingAssistantMessage(
  state: ConversationViewState,
): AssistantMessage | null {
  const messages = getActiveSegment(state).messages as Message[];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "toolResult") continue;
    if (message.role === "assistant") return message as AssistantMessage;
    return null;
  }
  return null;
}

/**
 * After a headless refresh, resume only when the same tab left a pending intent
 * (or the durable unload marker) and the transcript still ends on a partial
 * assistant answer — never after an explicit user Stop.
 */
export function conversationNeedsStreamResume(
  state: ConversationViewState,
  conversationId: string,
): boolean {
  const trailing = getTrailingAssistantMessage(state);
  if (!trailing || !assistantMessageHasVisibleText(trailing)) {
    return false;
  }
  if (trailing.stopReason !== "aborted") {
    return false;
  }
  if (isStreamInterruptedAssistant(trailing)) {
    return true;
  }
  return peekPendingStreamResume(conversationId);
}

export { STREAM_RESUME_MESSAGE_TEXT };
