import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

// 仅使用模拟向量和浏览器存储，不向真实模型发送资料。
function loadTs(path, dependencies = {}, fetcher = () => { throw new Error('Unexpected network request'); }, indexed = undefined) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', 'indexedDB', 'crypto', compiled)(
    (name) => { if (!(name in dependencies)) throw new Error('Unexpected import ' + name); return dependencies[name]; },
    result, result.exports, fetcher, indexed, webcrypto,
  );
  return result.exports;
}

// 模拟最低限度的 IndexedDB 事务，覆盖真实缓存读写路径而不依赖新包。
function indexedDb() {
  const rows = new Map();
  const database = {
    createObjectStore: () => ({ createIndex() {} }), close() {},
    transaction() {
      const transaction = {
        objectStore: () => ({
          index: () => ({ getAll(bookId) {
            const request = {};
            queueMicrotask(() => { request.result = [...rows.values()].filter((row) => row.bookId === bookId); request.onsuccess?.(); });
            return request;
          } }),
          put(row) { rows.set(row.key, structuredClone(row)); },
          delete(key) { rows.delete(key); },
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  return { rows, database, opens: 0, open() {
    this.opens += 1;
    const request = { result: database };
    queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } };
}

const connection = { apiUrl: 'https://embedding.invalid/compatible-mode/v1', apiKey: 'private-test-key', model: 'text-embedding-test' };
const module = loadTs('../app/lib/embeddings.ts');
const route = (fetcher) => loadTs('../app/api/embeddings/route.ts', { '../../lib/embeddings': module }, fetcher).POST;
const request = (body, signal) => new Request('http://localhost/api/embeddings', { method: 'POST', body: JSON.stringify(body), signal });

test('Embedding endpoints accept compatible roots and reject chat paths and credentials', () => {
  assert.equal(module.normalizeEmbeddingApiUrl('https://embedding.invalid'), 'https://embedding.invalid/v1/embeddings');
  assert.equal(module.normalizeEmbeddingApiUrl(connection.apiUrl), 'https://embedding.invalid/compatible-mode/v1/embeddings');
  assert.equal(module.normalizeEmbeddingApiUrl(connection.apiUrl + '/embeddings/'), connection.apiUrl + '/embeddings');
  for (const value of ['https://embedding.invalid/v1/chat/completions', 'https://embedding.invalid/responses', 'file:///secret', 'https://user:password@embedding.invalid']) assert.throws(() => module.normalizeEmbeddingApiUrl(value));
});

test('Chunking preserves trailing text, overlap and complete Unicode characters', () => {
  const text = '第一段。' + '甲'.repeat(810) + '。\n\n' + '🌧'.repeat(150) + '乙'.repeat(1800) + '正文结尾';
  const chunks = module.splitEmbeddingText(text);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 900));
  assert.ok(chunks.every((chunk) => Array.from(chunk).every((character) => character.length !== 1 || !/[\uD800-\uDFFF]/.test(character))));
  assert.ok(chunks.at(-1).endsWith('正文结尾'));
  assert.ok(chunks[0].endsWith(chunks[1].slice(0, 100).trim()));
});

test('Invalid vectors and mismatched dimensions are rejected rather than scored', () => {
  assert.deepEqual(module.validateEmbeddingVectors([[1, 0], [0, 1]], 2), [[1, 0], [0, 1]]);
  for (const input of [[], [[0, 0]], [[NaN, 1]], [[Infinity]], [[1], [1, 2]]]) assert.throws(() => module.validateEmbeddingVectors(input, input.length || 1));
  assert.equal(module.vectorCosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(module.vectorCosineSimilarity([1, 0], [0, 1]), 0);
  assert.throws(() => module.vectorCosineSimilarity([1], [1, 0]));
});

test('Gateway forwards float embeddings and restores provider index order', async () => {
  let sent;
  const POST = route(async (url, options) => {
    sent = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
  });
  const response = await POST(request({ connection, input: ['甲', '乙'] }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).vectors, [[1, 0], [0, 1]]);
  assert.equal(sent.url, connection.apiUrl + '/embeddings');
  assert.equal(sent.headers.Authorization, 'Bearer ' + connection.apiKey);
  assert.deepEqual(sent.body, { model: connection.model, input: ['甲', '乙'], encoding_format: 'float' });
});

test('Gateway rejects bad inputs without making a provider request', async () => {
  let count = 0;
  const POST = route(async () => { count += 1; throw new Error('Unexpected network'); });
  for (const body of [{}, { connection, input: [] }, { connection, input: Array(11).fill('甲') }, { connection, input: ['甲'.repeat(12001)] }, { connection: { ...connection, apiKey: '' }, input: ['甲'] }, { connection: { ...connection, apiUrl: 'https://embedding.invalid/chat/completions' }, input: ['甲'] }]) assert.equal((await POST(request(body))).status, 400);
  assert.equal(count, 0);
});

test('Gateway never exposes upstream credentials or returns fake vectors on failure', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const response = await route(async () => new Response(connection.apiKey + ' private manuscript', { status }))(request({ connection, input: ['甲'] }));
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes(connection.apiKey)); assert.ok(!text.includes('private manuscript')); assert.ok(!text.includes('vectors'));
  }
  for (const data of [[{ index: 0, embedding: [0, 0] }], [{ index: 3, embedding: [1, 0] }], []]) {
    const response = await route(async () => Response.json({ data }))(request({ connection, input: ['甲'] }));
    assert.equal(response.status, 502);
  }
});

test('Gateway propagates cancellation to the upstream request', async () => {
  const abort = new AbortController(); abort.abort();
  let seenSignal;
  const response = await route(async (_url, options) => { seenSignal = options.signal; throw new DOMException('Aborted', 'AbortError'); })(request({ connection, input: ['甲'] }, abort.signal));
  assert.equal(seenSignal.aborted, true); assert.equal(response.status, 502);
  assert.match((await response.json()).error, /取消|一分钟/);
});

test('Browser client rejects malformed responses and removes keys from error text', async () => {
  const client = loadTs('../app/lib/embeddings.ts', {}, async () => Response.json({ error: 'bad ' + connection.apiKey }, { status: 500 }));
  await assert.rejects(client.requestEmbeddings(connection, ['查询']), (error) => error.message.includes('[已隐藏]') && !error.message.includes(connection.apiKey));
  const empty = loadTs('../app/lib/embeddings.ts', {}, async () => Response.json({}));
  await assert.rejects(empty.requestEmbeddings(connection, ['查询']), /没有返回有效向量/);
});

test('Incremental search reuses unchanged chunks and isolates books, models and dimensions', async () => {
  const cache = indexedDb(); const calls = []; let dimensions = 2;
  const client = loadTs('../app/lib/embeddings.ts', {}, async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body.input);
    return Response.json({ vectors: body.input.map((text) => text.includes('无关') ? Array.from({ length: dimensions }, (_, index) => index === 1 ? 1 : 0) : Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0)) });
  }, cache);
  const documents = [{ id: 'a', title: '线索', body: '关键线索', source: 'knowledge' }, { id: 'b', title: '无关', body: '无关设定', source: 'knowledge' }];
  const args = { bookId: 'book-a', query: '查询线索', connection, documents };
  const first = await client.searchEmbeddings(args);
  assert.equal(first.indexed, 2); assert.equal(first.cached, 0); assert.equal(first.hits[0].documentId, 'a');
  assert.equal(calls.length, 2);
  const repeat = await client.searchEmbeddings(args);
  assert.equal(repeat.cached, 2); assert.equal(repeat.indexed, 0); assert.equal(calls.length, 3);
  const edited = await client.searchEmbeddings({ ...args, documents: [{ ...documents[0], body: '修改后的关键线索' }, documents[1]] });
  assert.equal(edited.indexed, 1); assert.equal(edited.cached, 1);
  assert.equal([...cache.rows.values()].filter((row) => row.bookId === args.bookId).length, 3);
  assert.equal((await client.searchEmbeddings({ ...args, bookId: 'book-b' })).indexed, 2);
  assert.equal((await client.searchEmbeddings({ ...args, connection: { ...connection, model: 'another-model' } })).indexed, 2);
  dimensions = 3;
  assert.equal((await client.searchEmbeddings(args)).indexed, 2);
  assert.equal([...cache.rows.values()].filter((row) => row.bookId === args.bookId && row.profile.includes(connection.model) && row.dimensions === 3).length, 2);
  assert.ok(!JSON.stringify([...cache.rows.values()]).includes(connection.apiKey));
  assert.ok(!JSON.stringify([...cache.rows.values()]).includes('关键线索'));
  await client.clearEmbeddingCache('book-a');
  assert.ok([...cache.rows.values()].every((row) => row.bookId === 'book-b'));
});

test('Search excludes deleted documents, de-duplicates results and keeps chapter evidence short', async () => {
  const cache = indexedDb();
  const client = loadTs('../app/lib/embeddings.ts', {}, async (_url, options) => Response.json({ vectors: JSON.parse(options.body).input.map(() => [1, 0]) }), cache);
  const documents = [{ id: 'chapter-1', title: '第1章', body: '正文。'.repeat(900), source: 'chapter' }, { id: 'knowledge-1', title: '设定', body: '独立设定', source: 'knowledge' }];
  const args = { bookId: 'book', query: '查询', connection, documents };
  const result = await client.searchEmbeddings(args);
  assert.equal(result.hits.filter((hit) => hit.documentId === 'chapter-1').length, 1);
  assert.ok(result.hits[0].body.length < documents[0].body.length);
  const next = await client.searchEmbeddings({ ...args, documents: [documents[1]] });
  assert.ok(next.hits.every((hit) => hit.documentId === 'knowledge-1'));
  assert.ok(cache.rows.size > 1);
});

test('Unavailable local storage and cancellation stop before sending manuscript content', async () => {
  let count = 0;
  const client = loadTs('../app/lib/embeddings.ts', {}, async () => { count += 1; throw new Error('Unexpected'); });
  const args = { bookId: 'book', documents: [{ id: 'a', title: 'a', body: '正文', source: 'knowledge' }], query: '查询', connection };
  await assert.rejects(client.searchEmbeddings(args), /IndexedDB/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.searchEmbeddings({ ...args, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(count, 0);
});

test('Browser storage reopens after forced close or a version change', async () => {
  const cache = indexedDb();
  const client = loadTs('../app/lib/embeddings.ts', {}, undefined, cache);
  await client.clearEmbeddingCache('book');
  assert.equal(cache.opens, 1);
  cache.database.onclose();
  await client.clearEmbeddingCache('book');
  assert.equal(cache.opens, 2);
  cache.database.onversionchange();
  await client.clearEmbeddingCache('book');
  assert.equal(cache.opens, 3);
});

test('Switching from chapter 20 to 2 and back reuses the later chapter cache', async () => {
  const cache = indexedDb();
  const client = loadTs('../app/lib/embeddings.ts', {}, async (_url, options) => Response.json({ vectors: JSON.parse(options.body).input.map(() => [1, 0]) }), cache);
  const documents = [{ id: 'chapter-1', title: '第1章', body: '较早章节正文', source: 'chapter' }, { id: 'chapter-19', title: '第19章', body: '后续章节正文', source: 'chapter' }];
  const args = { bookId: 'book', query: '查询', connection, documents };
  assert.equal((await client.searchEmbeddings(args)).indexed, 2);
  const early = await client.searchEmbeddings({ ...args, documents: [documents[0]] });
  assert.equal(early.indexed, 0); assert.equal(early.cached, 1);
  assert.deepEqual(early.hits.map((hit) => hit.documentId), ['chapter-1']);
  const later = await client.searchEmbeddings(args);
  assert.equal(later.indexed, 0); assert.equal(later.cached, 2);
  assert.equal(cache.rows.size, 2);
});
