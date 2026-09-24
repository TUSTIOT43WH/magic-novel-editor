import { ASSISTANT_TOOLS } from './assistant-tools';
import type { AssistantEvent, ModelMessage, ToolCall } from './assistant-types';

type GatewayBody = { messages?: ModelMessage[]; tools?: unknown[]; toolChoice?: 'auto' | 'none' };
export async function assistantGateway(request: Request, body: GatewayBody, apiUrl: string, apiKey: string, model: string) {
  // 服务端只开放本站七个只读工具，不透传任意工具参数定义。
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 80 || JSON.stringify(body.messages).length > 220000) {
    return Response.json({ error: '助手对话过长或格式无效，请新建会话' }, { status: 400 });
  }
  const messages: ModelMessage[] = [];
  for (const m of body.messages) {
    if (!m || !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string' || (m.tool_calls && (!Array.isArray(m.tool_calls) || m.tool_calls.length > 8 || m.tool_calls.some((c) => !c || typeof c.id !== 'string' || c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')))) {
      return Response.json({ error: '助手消息格式无效' }, { status: 400 });
    }
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') return Response.json({ error: '缺少工具调用编号' }, { status: 400 });
    messages.push({ role: m.role, content: m.content, ...(m.role === 'assistant' && m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.role === 'assistant' && typeof m.reasoning_content === 'string' ? { reasoning_content: m.reasoning_content } : {}), ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id } : {}) });
  }
  const responses = new URL(apiUrl).pathname.replace(/\/+$/, '').endsWith('/responses');
  if (responses && body.tools?.length) return Response.json({ error: '当前 Responses 端点暂不支持本助手的工具调用', code: 'TOOLS_UNSUPPORTED' }, { status: 400 });
  const withTools = Boolean(body.tools?.length) && !responses;
  const abort = new AbortController();
  const abortUpstream = () => abort.abort();
  request.signal.addEventListener('abort', abortUpstream, { once: true });
  if (request.signal.aborted) abort.abort();
  const timeout = setTimeout(abortUpstream, 180000);
  const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abortUpstream); };
  let upstream: Response;
  try {
    upstream = await fetch(apiUrl, {
      method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(responses
        ? { model, instructions: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'), input: messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })), stream: true, max_output_tokens: 6144 }
        : { model, messages, stream: true, max_tokens: 6144, ...(withTools ? { tools: ASSISTANT_TOOLS, tool_choice: body.toolChoice === 'none' ? 'none' : 'auto' } : {}), ...(/(^|\.)deepseek\.com$/i.test(new URL(apiUrl).hostname) ? { thinking: { type: 'disabled' } } : {}) }),
    });
  } catch {
    cleanup();
    return Response.json({ error: abort.signal.aborted ? '请求已停止或超过三分钟，请缩短问题后重试' : '无法连接模型服务，请检查网络与 API 地址' }, { status: 502 });
  }
  if (!upstream.ok) {
    const raw = (await upstream.text()).replaceAll(apiKey, '[已隐藏]').slice(0, 1500);
    cleanup();
    // 只有明确的工具能力错误才允许降级，不掩盖认证、限流或路径错误。
    const unsupported = withTools && [400, 404, 422].includes(upstream.status) && /tool|function[_ -]?call/i.test(raw) && /not support|unsupported|not allowed|unknown|unrecognized|不支持|不允许/i.test(raw);
    let detail = raw;
    try { const parsed = JSON.parse(raw); const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message; detail = typeof message === 'string' ? message : raw; } catch { detail = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); }
    return Response.json({ error: '模型服务返回 ' + upstream.status + '：' + detail.slice(0, 400), code: unsupported ? 'TOOLS_UNSUPPORTED' : 'PROVIDER_ERROR' }, { status: 502 });
  }
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AssistantEvent) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); };
      let reasoning = ''; let finishReason = ''; let terminal = false; let textCount = 0;
      const calls = new Map<number, ToolCall>();
      const consume = (value: Record<string, unknown>, json = false) => {
        if (value.error || value.type === 'error' || value.type === 'response.failed') throw new Error('模型在生成过程中返回错误，请稍后重试');
        if (responses) {
          if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') { textCount += value.delta.length; emit({ type: 'delta', text: value.delta }); }
          if (value.type === 'response.completed' || value.type === 'response.incomplete') { terminal = true; if (value.type === 'response.incomplete') finishReason = 'length'; }
          if (json) {
            const output = value as { output_text?: string; output?: { content?: { text?: string }[] }[]; status?: string };
            const text = output.output_text || output.output?.flatMap((x) => x.content || []).map((x) => x.text || '').join('') || '';
            if (text) { textCount += text.length; emit({ type: 'delta', text }); } terminal = true;
            if (output.status === 'incomplete') finishReason = 'length';
          }
          return;
        }
        const choices = value.choices as { index?: number; delta?: Record<string, unknown>; message?: Record<string, unknown>; finish_reason?: string }[] | undefined;
        const choice = choices?.find((c) => c.index === undefined || c.index === 0);
        if (!choice) return;
        if (choice.finish_reason) { terminal = true; finishReason = choice.finish_reason; }
        const delta = (json ? choice.message : choice.delta) || {};
        if (typeof delta.content === 'string') { textCount += delta.content.length; emit({ type: 'delta', text: delta.content }); }
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) for (let i = 0; i < delta.tool_calls.length; i++) {
          const part = delta.tool_calls[i] as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
          const index = part.index ?? i;
          if (!Number.isInteger(index) || index < 0 || index >= 8) throw new Error('单轮工具调用超过8个，请缩小问题范围');
          const call = calls.get(index) || { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
          if (call.function.arguments.length > 12000) throw new Error('工具参数过长');
          calls.set(index, call);
        }
        if (json) terminal = true;
      };
      try {
        if ((upstream.headers.get('content-type') || '').includes('application/json')) {
          consume(await upstream.json() as Record<string, unknown>, true);
        } else {
          if (!upstream.body) throw new Error('模型没有返回内容');
          reader = upstream.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
          const line = (input: string) => {
            if (!input.startsWith('data:')) return;
            const raw = input.slice(5).trim(); if (raw === '[DONE]') { terminal = true; return; }
            if (!raw) return;
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(raw); } catch { return; }
            consume(parsed);
          };
          while (!cancelled) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 1000000) throw new Error('模型事件过长');
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; lines.forEach(line);
          }
          buffer += decoder.decode(); if (buffer) line(buffer);
        }
        if (!terminal) throw new Error('模型连接提前结束，已保留收到的内容，请重试');
        if (!textCount && !calls.size) throw new Error('模型没有返回内容，请检查模型配置或重试');
        const toolCalls = [...calls.values()];
        if (toolCalls.some((c) => !c.id || !c.function.name)) throw new Error('模型返回了不完整的工具调用');
        emit({ type: 'done', toolCalls, reasoning, finishReason });
      } catch (error) {
        emit({ type: 'error', error: abort.signal.aborted ? '请求已停止或超时' : error instanceof Error ? error.message : '流式回答中断' });
      } finally { cleanup(); if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } if (!cancelled) controller.close(); }
    },
    cancel() { cancelled = true; abort.abort(); void reader?.cancel().catch(() => {}); cleanup(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
}
