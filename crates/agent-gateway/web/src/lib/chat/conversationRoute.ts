// Re-export shared conversation deep-link helpers from @liveagent/ui so the
// headless (agent-gui) and gateway WebUI stay on one implementation.
export {
  CONVERSATION_QUERY_KEY,
  isRoutableConversationId,
  readConversationIdFromLocation,
  readLastConversationId,
  resolveConversationIdToRestore,
  syncActiveConversationRoute,
  writeConversationIdToLocation,
  writeLastConversationId,
} from "@liveagent/ui/lib/chat/conversationRoute";
