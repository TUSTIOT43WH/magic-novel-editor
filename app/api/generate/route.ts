type GenerateBody = {
  vibe?: string;
  positive?: string;
  negative?: string;
  systemPrompt?: string;
  context?: string;
  connection?: { apiUrl?: string; apiKey?: string; model?: string };
};

function normalizeApiUrl(value: string) {
  const url = new URL(value.trim());
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) url.pathname = '/v1/chat/completions';
  else if (path.endsWith('/v1')) url.pathname = `${path}/chat/completions`;
  return url.toString();
}

function responseText(result: unknown) {
  if (!result || typeof result !== 'object') return '';
  const data = result as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (typeof data.output_text === 'string') return data.output_text;
  return data.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('') || '';
}

function chatResponseText(result: unknown) {
  if (!result || typeof result !== 'object') return '';
  const data = result as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

function streamDelta(result: unknown, usesResponsesApi: boolean) {
  if (!result || typeof result !== 'object') return '';
  if (usesResponsesApi) {
    const data = result as { type?: string; delta?: string };
    return data.type === 'response.output_text.delta' && typeof data.delta === 'string' ? data.delta : '';
  }
  const data = result as { choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> } }> };
  const content = data.choices?.[0]?.delta?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((item) => item.text || '').join('') : '';
}

function readableError(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message || parsed.message || detail;
  } catch {
    return detail.replace(/\s+/g, ' ').trim();
  }
}

export async function POST(request: Request) {
  const body = await request.json() as GenerateBody;
  const sessionConnection = body.connection;
  const hasCompleteSessionConnection = Boolean(sessionConnection?.apiUrl && sessionConnection?.apiKey && sessionConnection?.model);
  const rawApiUrl = hasCompleteSessionConnection ? sessionConnection?.apiUrl?.trim() : process.env.AI_API_URL;
  const apiKey = hasCompleteSessionConnection ? sessionConnection?.apiKey?.trim() : process.env.AI_API_KEY;
  const model = hasCompleteSessionConnection ? sessionConnection?.model?.trim() : process.env.AI_MODEL;
  if (!rawApiUrl || !apiKey || !model) {
    return Response.json({ error: '请先在设置中完整配置并启用模型连接' }, { status: 400 });
  }
  let apiUrl: string;
  try {
    apiUrl = normalizeApiUrl(rawApiUrl);
    const parsed = new URL(apiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    return Response.json({ error: 'API 地址必须是有效的 http 或 https 地址' }, { status: 400 });
  }
  const systemPrompt = body.systemPrompt || '你是一位严谨的中文长篇小说家。';
  const userPrompt = `相关设定：\n${body.context || '无'}\n\n剧情意图：${body.vibe || ''}\n正向要求：${body.positive || '无'}\n避免：${body.negative || '无'}\n\n只输出小说正文。完整写完本次情节，不要停在半句话；接近输出限制时优先自然收束。`;
  const usesResponsesApi = new URL(apiUrl).pathname.replace(/\/+$/, '').endsWith('/responses');
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(usesResponsesApi
      ? { model, instructions: systemPrompt, input: userPrompt, stream: true, max_output_tokens: 16384 }
      : { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], stream: true, max_tokens: 16384 }),
  });
  if (!response.ok) {
    const detail = await response.text();
    const endpoint = new URL(apiUrl).pathname;
    const hint = response.status === 404 ? `模型接口不存在或模型名称无效（404），当前请求路径：${endpoint}` : `模型服务返回 ${response.status}`;
    return Response.json({ error: hint, detail: readableError(detail).slice(0, 500) }, { status: 502 });
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || !response.body) {
    const result = await response.json() as unknown;
    const content = usesResponsesApi ? responseText(result) : chatResponseText(result);
    if (!content) return Response.json({ error: '模型完成了请求，但没有返回可解析的正文' }, { status: 502 });
    return Response.json({ content, provider: model });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      const emitLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const delta = streamDelta(JSON.parse(data), usesResponsesApi);
          if (delta) controller.enqueue(encoder.encode(delta));
        } catch {
          // Ignore non-JSON heartbeat events from compatible providers.
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          lines.forEach(emitLine);
        }
        buffer += decoder.decode();
        if (buffer) emitLine(buffer);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Model-Provider': model,
    },
  });
}
