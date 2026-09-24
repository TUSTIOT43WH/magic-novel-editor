export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string; reasoning_content?: string };
export type AssistantEvent = { type: 'delta'; text: string } | { type: 'done'; toolCalls: ToolCall[]; reasoning?: string; finishReason?: string } | { type: 'error'; error: string };
export type AssistantMessage = { id: string; role: 'author' | 'assistant'; content: string; sources?: string[]; bookContext?: boolean; notice?: string; status?: 'running' | 'complete' | 'stopped' | 'error' };
export type AssistantSession = { id: string; title: string; manualTitle?: boolean; createdAt: number; messages: AssistantMessage[] };
export type AssistantStore = { sessions: AssistantSession[]; activeId?: string; allowBook?: boolean };
export type AssistantConnection = { apiUrl: string; apiKey: string; model: string };
