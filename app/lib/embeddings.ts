// 向量仅缓存在当前浏览器；模型凭据不会写入索引或作品数据。
export type EmbeddingConnection = { apiUrl: string; apiKey: string; model: string };
export type EmbeddingDocument = { id: string; title: string; body: string; tags?: string[]; source: string; type?: string };
export type EmbeddingHit = { documentId: string; chunkId: string; title: string; body: string; tags: string[]; source: string; type: string; score: number };
export type EmbeddingProgress = { stage: 'indexing' | 'searching'; completed: number; total: number; cached: number };
export type EmbeddingSearchResult = { hits: EmbeddingHit[]; indexed: number; cached: number; dimensions: number };

export const MAX_EMBEDDING_BATCH = 10;
export const MAX_EMBEDDING_INPUT_CHARACTERS = 12000;
export const MAX_EMBEDDING_CHUNKS = 10000;
const DATABASE_NAME = 'mojing-local-embeddings-v1';
const STORE_NAME = 'vectors';
const INDEX_VERSION = 'chunk-v1';
type CachedVector = { key: string; bookId: string; profile: string; dimensions: number; hash: string; vector: number[] };
type Chunk = { document: EmbeddingDocument; id: string; body: string; input: string; hash: string };

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消向量检索', 'AbortError');
}

// 可以填写兼容接口根地址、/v1，或者完整的 /embeddings 路径。
export function normalizeEmbeddingApiUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Embedding API 地址必须是有效的 http 或 https 地址');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) url.pathname = '/v1/embeddings';
  else if (!path.endsWith('/embeddings')) {
    if (/\/(?:chat\/completions|responses)$/.test(path)) throw new Error('请填写 Embedding 接口地址，不能使用聊天或 Responses 接口');
    url.pathname = path + '/embeddings';
  } else url.pathname = path;
  url.hash = '';
  return url.toString();
}

// 向量数量、顺序、维度与数值必须完整有效，不能用缺失的向量继续检索。
export function validateEmbeddingVectors(input: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(input) || input.length !== expectedCount) throw new Error('Embedding 返回的向量数量不正确');
  let dimensions = 0;
  return input.map((value) => {
    if (!Array.isArray(value) || !value.length || value.length > 4096 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n)) || !value.some((n) => n !== 0)) throw new Error('Embedding 返回了无效向量');
    if (dimensions && value.length !== dimensions) throw new Error('Embedding 返回的向量维度不一致');
    dimensions = value.length;
    return value as number[];
  });
}

export async function requestEmbeddings(connection: EmbeddingConnection, inputs: string[], options: { signal?: AbortSignal } = {}) {
  abortIfNeeded(options.signal);
  if (!connection.apiKey.trim() || !connection.model.trim()) throw new Error('请先填写 Embedding API Key 和模型名称');
  const apiUrl = normalizeEmbeddingApiUrl(connection.apiUrl);
  if (!inputs.length || inputs.length > MAX_EMBEDDING_BATCH || inputs.some((input) => typeof input !== 'string' || !input.trim() || input.length > MAX_EMBEDDING_INPUT_CHARACTERS)) throw new Error('Embedding 每批最多 10 段，每段须为 1～12000 字符');
  const response = await fetch('/api/embeddings', {
    method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection: { ...connection, apiUrl }, input: inputs }),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? String(result.error) : 'Embedding 请求失败，请检查服务地址和网络';
    throw new Error(error.replaceAll(connection.apiKey.trim(), '[已隐藏]'));
  }
  abortIfNeeded(options.signal);
  if (!result || typeof result !== 'object' || !('vectors' in result)) throw new Error('Embedding 接口没有返回有效向量');
  return validateEmbeddingVectors(result.vectors, inputs.length);
}

// 以段落或句尾为优先边界，保留少量重叠；不截掉正文，也不拆开表情等代理对。
export function splitEmbeddingText(text: string, size = 900, overlap = 100) {
  if (!Number.isInteger(size) || size < 100 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size / 2) throw new Error('向量分段参数无效');
  const characters = Array.from(text.replace(/\r\n?/g, '\n').trim());
  const result: string[] = [];
  for (let start = 0; start < characters.length;) {
    let end = Math.min(characters.length, start + size);
    if (end < characters.length) {
      for (let boundary = end - 1; boundary >= start + Math.floor(size * 0.65); boundary -= 1) {
        if (/[\n。！？!?]/.test(characters[boundary])) { end = boundary + 1; break; }
      }
    }
    const chunk = characters.slice(start, end).join('').trim();
    if (chunk) result.push(chunk);
    if (end === characters.length) break;
    start = end - overlap;
  }
  return result;
}

export async function embeddingTextHash(text: string) {
  if (!globalThis.crypto?.subtle) throw new Error('本地向量缓存需要安全浏览器环境，请通过 localhost 或 HTTPS 打开');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

export function vectorCosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) throw new Error('向量维度不一致，请更新向量索引');
  let leftScale = 0; let rightScale = 0;
  for (let i = 0; i < left.length; i += 1) { leftScale = Math.max(leftScale, Math.abs(left[i])); rightScale = Math.max(rightScale, Math.abs(right[i])); }
  if (!Number.isFinite(leftScale) || !Number.isFinite(rightScale)) throw new Error('向量包含无效数值');
  if (!leftScale || !rightScale) return 0;
  let dot = 0; let a = 0; let b = 0;
  for (let i = 0; i < left.length; i += 1) { const x = left[i] / leftScale; const y = right[i] / rightScale; dot += x * y; a += x * x; b += y * y; }
  return a && b ? Math.max(-1, Math.min(1, dot / Math.sqrt(a * b))) : 0;
}

let databasePromise: Promise<IDBDatabase> | undefined;
let currentDatabase: IDBDatabase | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前浏览器无法使用 IndexedDB，请关闭 Embedding 检索或更换浏览器'));
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(message)); } };
    const timer = setTimeout(() => fail('打开本地向量缓存超时，请关闭占用此存储的旧页面后重试'), 8000);
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      store.createIndex('bookId', 'bookId');
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true; clearTimeout(timer); currentDatabase = database;
      const reset = () => {
        if (currentDatabase === database) { currentDatabase = undefined; databasePromise = undefined; }
      };
      database.onversionchange = () => { reset(); database.close(); };
      // 清除站点数据或浏览器强制关闭连接后，下次操作重新建立连接。
      database.onclose = reset;
      resolve(database);
    };
    request.onerror = () => fail('无法打开本地向量缓存，请检查浏览器存储权限');
    request.onblocked = () => fail('本地向量缓存被其他页面占用，请关闭旧页面后重试');
  }).catch((error: unknown) => { databasePromise = undefined; throw error; });
  return databasePromise;
}

async function cachedVectors(bookId: string) {
  const database = await openDatabase();
  return new Promise<CachedVector[]>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).index('bookId').getAll(bookId);
    request.onsuccess = () => resolve(request.result as CachedVector[]);
    request.onerror = () => reject(new Error('读取本地向量缓存失败'));
  });
}

async function writeVectors(vectors: CachedVector[], obsolete: string[] = []) {
  if (!vectors.length && !obsolete.length) return;
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    vectors.forEach((vector) => store.put(vector));
    obsolete.forEach((key) => store.delete(key));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('保存本地向量失败，浏览器存储可能已满'));
    transaction.onabort = () => reject(new Error('本地向量缓存写入已中断'));
  });
}

export async function clearEmbeddingCache(bookId: string) {
  if (!bookId) throw new Error('缺少书籍编号');
  const vectors = await cachedVectors(bookId);
  await writeVectors([], vectors.map((vector) => vector.key));
}

export async function searchEmbeddings(options: {
  bookId: string; documents: EmbeddingDocument[]; query: string; connection: EmbeddingConnection;
  signal?: AbortSignal; onProgress?: (progress: EmbeddingProgress) => void; limit?: number;
}): Promise<EmbeddingSearchResult> {
  const { bookId, documents, connection, signal, onProgress } = options;
  abortIfNeeded(signal);
  if (!bookId) throw new Error('缺少书籍编号');
  const query = options.query.trim();
  if (!query) throw new Error('请先输入剧情意图，再进行 Embedding 检索');
  const profile = JSON.stringify([INDEX_VERSION, await embeddingTextHash(normalizeEmbeddingApiUrl(connection.apiUrl)), connection.model.trim()]);
  // 先检查浏览器存储，避免缓存不可用时仍发送整本资料。
  const existing = await cachedVectors(bookId);
  abortIfNeeded(signal);
  const chunks: Chunk[] = [];
  for (const document of documents) {
    abortIfNeeded(signal);
    const parts = splitEmbeddingText(document.body);
    for (let index = 0; index < parts.length; index += 1) {
      const body = parts[index];
      const input = [document.title.slice(0, 200), (document.tags || []).join(' ').slice(0, 300), body].filter(Boolean).join('\n');
      chunks.push({ document, id: `${document.id}::${index}`, body, input, hash: await embeddingTextHash(input) });
      if (chunks.length > MAX_EMBEDDING_CHUNKS) throw new Error(`本次资料超过 ${MAX_EMBEDDING_CHUNKS} 个向量片段，请缩小范围后重试`);
    }
  }
  if (!chunks.length) throw new Error('当前书没有可建立向量索引的资料');
  onProgress?.({ stage: 'searching', completed: 0, total: chunks.length, cached: 0 });
  // 查询向量同时确认当前模型的维度，旧维度的缓存不会混入本次检索。
  const [queryVector] = await requestEmbeddings(connection, [query], { signal });
  const dimensions = queryVector.length;
  const cache = new Map(existing.filter((row) => row.profile === profile && row.dimensions === dimensions && Array.isArray(row.vector) && row.vector.length === dimensions && row.vector.every(Number.isFinite) && row.vector.some((n) => n !== 0)).map((row) => [row.hash, row]));
  const uniqueChunks = [...new Map(chunks.map((chunk) => [chunk.hash, chunk])).values()];
  const pending = uniqueChunks.filter((chunk) => !cache.has(chunk.hash));
  const cached = uniqueChunks.length - pending.length;
  let indexed = 0;
  onProgress?.({ stage: 'indexing', completed: cached, total: uniqueChunks.length, cached });
  for (let offset = 0; offset < pending.length; offset += MAX_EMBEDDING_BATCH) {
    abortIfNeeded(signal);
    const batch = pending.slice(offset, offset + MAX_EMBEDDING_BATCH);
    const vectors = await requestEmbeddings(connection, batch.map((chunk) => chunk.input), { signal });
    if (vectors.some((vector) => vector.length !== dimensions)) throw new Error('Embedding 模型的向量维度在请求间变化，请检查模型配置后重试');
    const rows = batch.map((chunk, index): CachedVector => ({ key: JSON.stringify([bookId, profile, dimensions, chunk.hash]), bookId, profile, dimensions, hash: chunk.hash, vector: vectors[index] }));
    abortIfNeeded(signal);
    await writeVectors(rows);
    rows.forEach((row) => cache.set(row.hash, row));
    indexed += rows.length;
    onProgress?.({ stage: 'indexing', completed: cached + indexed, total: uniqueChunks.length, cached });
  }
  abortIfNeeded(signal);
  // 只对本次范围中的最新片段排名；范围外缓存保留，切回早章不会删除后文章节索引。
  // 旧正文和其他维度即使留在缓存，也没有进入下面的候选列表。
  abortIfNeeded(signal);
  const ranked: { chunk: Chunk; score: number }[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    // 较长作品每扫描一批就归还主线程，取消按钮和页面交互可以及时响应。
    if (index && index % 128 === 0) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); abortIfNeeded(signal); }
    const chunk = chunks[index];
    ranked.push({ chunk, score: vectorCosineSimilarity(queryVector, cache.get(chunk.hash)!.vector) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const seenDocuments = new Set<string>();
  const seenBodies = new Set<string>();
  const hits: EmbeddingHit[] = [];
  const limit = Math.max(1, Math.min(18, Math.floor(options.limit || 8)));
  for (const { chunk, score } of ranked) {
    if (score <= 0 || seenDocuments.has(chunk.document.id) || seenBodies.has(chunk.body)) continue;
    seenDocuments.add(chunk.document.id); seenBodies.add(chunk.body);
    hits.push({ documentId: chunk.document.id, chunkId: chunk.id, title: chunk.document.title, body: chunk.body, tags: chunk.document.tags || [], source: chunk.document.source, type: chunk.document.type || '向量召回', score });
    if (hits.length >= limit) break;
  }
  onProgress?.({ stage: 'searching', completed: uniqueChunks.length, total: uniqueChunks.length, cached });
  return { hits, indexed, cached, dimensions };
}
