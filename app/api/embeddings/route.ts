import { MAX_EMBEDDING_BATCH, MAX_EMBEDDING_INPUT_CHARACTERS, normalizeEmbeddingApiUrl, validateEmbeddingVectors } from '../../lib/embeddings';

// 通过本站转发兼容 Embedding 请求；密钥只用于本次上游调用，不写入作品或向量缓存。
export async function POST(request: Request) {
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 160000) return Response.json({ error: 'Embedding 请求过大，请分批提交' }, { status: 413 });
    body = JSON.parse(raw);
  } catch { return Response.json({ error: 'Embedding 请求格式无效' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Embedding 请求格式无效' }, { status: 400 });
  const { connection, input } = body as { connection?: { apiUrl?: unknown; apiKey?: unknown; model?: unknown }; input?: unknown };
  if (!connection || typeof connection.apiUrl !== 'string' || typeof connection.apiKey !== 'string' || typeof connection.model !== 'string' || !connection.apiKey.trim() || !connection.model.trim() || connection.apiUrl.length > 2000 || connection.apiKey.length > 2000 || connection.model.length > 200) return Response.json({ error: '请填写有效的 Embedding 地址、API Key 和模型名称' }, { status: 400 });
  if (!Array.isArray(input) || !input.length || input.length > MAX_EMBEDDING_BATCH || input.some((text) => typeof text !== 'string' || !text.trim() || text.length > MAX_EMBEDDING_INPUT_CHARACTERS)) return Response.json({ error: 'Embedding 每批最多 10 段，每段须为 1～12000 字符' }, { status: 400 });
  let apiUrl: string;
  try { apiUrl = normalizeEmbeddingApiUrl(connection.apiUrl); }
  catch { return Response.json({ error: '请填写有效的 http/https Embedding 接口地址，不能使用聊天接口' }, { status: 400 }); }
  const apiKey = connection.apiKey.trim();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timeout = setTimeout(cancel, 60000);
  try {
    const upstream = await fetch(apiUrl, {
      method: 'POST', signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: connection.model.trim(), input, encoding_format: 'float' }),
    });
    if (!upstream.ok) {
      // 不回显上游原文，避免兼容服务把密钥或作者原文夹在错误消息中。
      const hint = upstream.status === 401 || upstream.status === 403 ? '请检查 API Key、地域与模型权限' : upstream.status === 404 ? '请检查 Embedding 接口路径和模型名称' : upstream.status === 429 ? '请求过于频繁或余额不足，请稍后重试' : '请稍后重试或检查模型服务状态';
      await upstream.body?.cancel();
      return Response.json({ error: `Embedding 服务返回 ${upstream.status}：${hint}` }, { status: 502 });
    }
    const raw: unknown = await upstream.json();
    if (!raw || typeof raw !== 'object' || !('data' in raw) || !Array.isArray(raw.data) || raw.data.length !== input.length) throw new Error('Embedding 服务返回的向量数量不正确');
    const seen = new Set<number>();
    const ordered: unknown[] = Array(input.length);
    for (const item of raw.data) {
      if (!item || typeof item !== 'object' || typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || seen.has(item.index)) throw new Error('Embedding 服务返回的向量编号无效');
      seen.add(item.index); ordered[item.index] = item.embedding;
    }
    const vectors = validateEmbeddingVectors(ordered, input.length);
    return Response.json({ vectors, dimensions: vectors[0].length });
  } catch (error) {
    const message = abort.signal.aborted ? 'Embedding 请求已取消或超过一分钟，请重试' : error instanceof Error && /^Embedding (?:服务返回|返回)/.test(error.message) ? error.message : 'Embedding 请求失败，请检查网络、接口格式和模型配置';
    return Response.json({ error: message.replaceAll(apiKey, '[已隐藏]') }, { status: 502 });
  } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', cancel); }
}
