import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function load(path, dependencies = {}, fetcher = () => { throw new Error('Unexpected network request'); }) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', 'process', source)((name) => {
    if (!(name in dependencies)) throw new Error('Unexpected import ' + name);
    return dependencies[name];
  }, module, module.exports, fetcher, { env: {} });
  return module.exports;
}
const tools = load('../app/lib/assistant-tools.ts');
const images = load('../app/lib/story-images.ts');
const book = {
  book: { title: '测试作品' },
  chapters: [{ no: 7, title: '雨夜', summary: '测试角色甲在测试地点受伤', content: '测试角色甲在测试地点受伤。测试角色乙带她离开。' }, { no: 8, title: '旅途', summary: '', content: '测试角色乙继续赶路。'.repeat(1000) }],
  characters: [{ name: '测试角色甲', role: '主角', state: '受伤', location: '测试地点' }],
  relations: [{ from: '测试角色甲', to: '测试角色乙', label: '搭档' }],
  knowledge: [{ title: '测试地点', body: '测试地点在北方', tags: ['港口'] }],
  timeline: [{ time: '测试纪元元年', chapter: 7, title: '雨夜受伤', detail: '测试角色甲受伤' }],
  outline: [{ title: '第一卷', summary: '离开测试地点', state: '进行中' }],
};
const connection = { apiUrl: 'https://provider.invalid/v1/chat/completions', apiKey: 'test-secret', model: 'test-model' };
const call = (name, args = {}, id = 'tool-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const eventResponse = (events) => new Response(events.map((x) => JSON.stringify(x) + '\n').join(''), { headers: { 'Content-Type': 'application/x-ndjson' } });
const done = { type: 'done', toolCalls: [] };
const textResponse = (text) => eventResponse([{ type: 'delta', text }, done]);
function client(fetcher) { return load('../app/lib/assistant-client.ts', { './assistant-tools': tools }, fetcher); }
function options(overrides = {}) {
  const state = { text: '', sources: [], notices: [], progress: [] };
  return { state, opts: { question: '主角此前在哪里受伤？', history: [], data: book, allowBook: true, connection, signal: new AbortController().signal, onText: (s) => state.text = s, onSources: (s) => state.sources = s, onNotice: (s) => state.notices.push(s), onProgress: (s) => state.progress.push(s), ...overrides } };
}
function gateway(fetcher) { return load('../app/lib/assistant-gateway.ts', { './assistant-tools': tools }, fetcher).assistantGateway; }
const req = () => new Request('https://local.invalid/api/generate', { method: 'POST' });
const msg = [{ role: 'user', content: '测试' }];
const sse = (values) => new Response(values.map((x) => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('all seven tools are read-only, bounded, scoped to supplied book and validate parameters', () => {
  const before = JSON.stringify(book);
  for (const [name, args] of [['search_chapters', { query: '测试角色甲' }], ['read_chapter', { no: 8, maxChars: 4000 }], ['get_character', { name: '测试角色甲' }], ['get_relations', {}], ['get_timeline', { chapter: 7 }], ['search_knowledge', { query: '测试地点' }], ['get_outline', {}]]) {
    const result = tools.executeAssistantTool(book, name, JSON.stringify(args));
    assert.ok(result.text.length <= 4000);
    assert.ok(JSON.parse(result.text));
    assert.ok(result.sources.length);
  }
  assert.equal(JSON.stringify(book), before);
  assert.match(tools.executeAssistantTool(book, 'read_chapter', '{"no":8,"offset":-1}').text, /error/);
  assert.match(tools.executeAssistantTool(book, 'delete_book', '{}').text, /不允许/);
  assert.match(tools.executeAssistantTool(book, 'search_chapters', '{broken').text, /error/);
  const empty = { ...book, chapters: [], characters: [], knowledge: [] };
  assert.equal(JSON.parse(tools.executeAssistantTool(empty, 'search_chapters', '{"query":"测试角色甲"}').text).found, false);
  const page = JSON.parse(tools.executeAssistantTool(book, 'read_chapter', '{"no":8,"offset":100,"maxChars":4000}').text).data;
  assert.equal(page.nextOffset, 100 + page.excerpt.length);
  assert.ok(!JSON.parse(tools.executeAssistantTool(book, 'search_knowledge', '{"query":"唐朝"}').text).found);
});

test('local intent and local automatic title', () => {
  assert.equal(tools.detectStoryIntent('唐朝有哪些年号？', book).isStory, false);
  assert.equal(tools.detectStoryIntent('第七章发生了什么？', book).isStory, true);
  assert.equal(tools.detectStoryIntent('测试角色甲在哪里？', book).isStory, true);
  assert.equal(client().assistantTitle('请问唐朝有哪些年号？还有其他资料吗？'), '唐朝有哪些年号');
});

test('story question executes tool and feeds real tool messages with reasoning back', async () => {
  let count = 0;
  const c = client(async (_url, init) => {
    const body = JSON.parse(init.body); count++;
    assert.equal(body.tools.length, 7);
    if (count === 1) return eventResponse([{ type: 'done', toolCalls: [call('search_chapters', { query: '测试角色甲 受伤' })], reasoning: 'provider-reasoning' }]);
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.match(body.messages.at(-1).content, /测试地点/);
    assert.equal(body.messages.at(-2).reasoning_content, 'provider-reasoning');
    return textResponse('第7章记载测试角色甲在测试地点受伤。');
  });
  const { state, opts } = options();
  await c.runWritingAssistant(opts);
  assert.equal(count, 2); assert.match(state.text, /测试地点/); assert.match(state.sources.join(' '), /第 7 章/);
});

test('general knowledge uses one request with no prefetch or fake sources', async () => {
  let count = 0;
  const c = client(async (_url, init) => {
    count++; const body = JSON.parse(init.body);
    assert.ok(!JSON.stringify(body.messages).includes('测试地点'));
    return textResponse('唐太宗使用贞观年号。');
  });
  const { state, opts } = options({ question: '唐朝有哪些年号？', prefetch: '不应发送的预取' });
  await c.runWritingAssistant(opts); assert.equal(count, 1); assert.deepEqual(state.sources, []);
});

test('missing knowledge is reported as a search miss with a visible trace', async () => {
  let count = 0;
  const c = client(async (_url, init) => {
    count++;
    if (count === 1) return eventResponse([{ type: 'done', toolCalls: [call('search_knowledge', { query: '唐朝' })] }]);
    const body = JSON.parse(init.body);
    assert.equal(JSON.parse(body.messages.at(-1).content).found, false);
    return textResponse('本次未查到唐朝设定；以下是一般历史知识。');
  });
  const { state, opts } = options({ question: '本书里有唐朝设定吗？' });
  await c.runWritingAssistant(opts); assert.match(state.sources.join(' '), /未命中/);
});

test('permission off sends neither tools, prefetch nor earlier book-derived messages', async () => {
  const c = client(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    assert.ok(!JSON.stringify(body.messages).includes('测试地点'));
    return textResponse('普通回答');
  });
  await c.runWritingAssistant(options({ allowBook: false, prefetch: '测试地点', history: [{ role: 'assistant', content: '测试地点受伤', bookContext: true }] }).opts);
});

test('three tool rounds, four requests, total tool content capped at 12000', async () => {
  let count = 0; let total = 0;
  const c = client(async (_url, init) => {
    const body = JSON.parse(init.body); count++;
    total = body.messages.filter((m) => m.role === 'tool').reduce((n, m) => n + m.content.length, 0);
    if (body.toolChoice === 'none') return textResponse('预算内总结');
    return eventResponse([{ type: 'done', toolCalls: [call('read_chapter', { no: 8, offset: 0, maxChars: 4000 }, 'a' + count), call('get_outline', {}, 'b' + count)] }]);
  });
  await c.runWritingAssistant(options().opts);
  assert.ok(count <= 4); assert.ok(total <= 12000);
});

test('tool capability failure downgrades once; model/URL failures remain visible', async () => {
  let count = 0;
  const c = client(async (_url, init) => {
    count++;
    if (count === 1) return Response.json({ error: 'tools unsupported', code: 'TOOLS_UNSUPPORTED' }, { status: 502 });
    assert.equal(JSON.parse(init.body).tools, undefined);
    return textResponse('降级回答');
  });
  const { state, opts } = options();
  await c.runWritingAssistant(opts); assert.equal(count, 2); assert.match(state.notices.join(' '), /不支持工具/);
  await assert.rejects(client(async () => Response.json({ error: '模型不存在', code: 'PROVIDER_ERROR' }, { status: 502 })).runWritingAssistant(options().opts), /模型不存在/);
});

test('Responses uses genuine history, without tools, and displays downgrade notice', async () => {
  const c = client(async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.tools, undefined);
    assert.ok(body.messages.some((m) => m.role === 'assistant' && m.content === '历史回答'));
    return textResponse('新的回答');
  });
  const { state, opts } = options({ connection: { ...connection, apiUrl: 'https://provider.invalid/v1/responses' }, history: [{ role: 'author', content: '原问题' }, { role: 'assistant', content: '历史回答' }] });
  await c.runWritingAssistant(opts); assert.match(state.notices.join(' '), /Responses/);
});

test('client renders first delta before completion; stop prevents further answer/tool rounds', async () => {
  let controller; let first; const arrived = new Promise((resolve) => first = resolve);
  const abort = new AbortController();
  const c = client(async () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'delta', text: '先到的字' }) + '\n')); } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  const { opts } = options({ signal: abort.signal, onText: () => first() });
  const pending = c.runWritingAssistant(opts);
  await arrived; abort.abort(); controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'delta', text: '不应显示' }) + '\n')); controller.close();
  await assert.rejects(pending, /abort/i);
});

test('gateway merges fragmented tool calls, preserves reasoning and streams text', async () => {
  let sent;
  const route = gateway(async (_url, init) => {
    sent = JSON.parse(init.body);
    return sse([{ choices: [{ delta: { reasoning_content: 'thought', tool_calls: [{ index: 0, id: 'abc', function: { name: 'search_', arguments: '{"query":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'chapters', arguments: '"测试角色甲"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']);
  });
  const result = await route(req(), { messages: msg, tools: [{}] }, connection.apiUrl, connection.apiKey, connection.model);
  const events = (await result.text()).trim().split('\n').map(JSON.parse);
  const final = events.at(-1);
  assert.equal(final.toolCalls[0].function.name, 'search_chapters');
  assert.equal(final.toolCalls[0].function.arguments, '{"query":"测试角色甲"}');
  assert.equal(final.reasoning, 'thought');
  assert.equal(sent.stream, true); assert.equal(sent.tools.length, 7);
});

test('gateway recognizes truncation, errors, Responses and empty results', async () => {
  for (const [upstream, expected] of [
    [sse([{ choices: [{ delta: { content: '半截' } }] }]), /提前结束/],
    [sse([{ error: { message: 'failure' } }]), /生成过程中/],
    [Response.json({ choices: [{ message: { content: '' } }] }), /没有返回内容/],
  ]) {
    const result = await gateway(async () => upstream)(req(), { messages: msg }, connection.apiUrl, connection.apiKey, connection.model);
    assert.match(await result.text(), expected);
  }
  const result = await gateway(async () => sse([{ type: 'response.output_text.delta', delta: '响应正文' }, { type: 'response.completed' }]))(req(), { messages: msg }, 'https://provider.invalid/responses', connection.apiKey, connection.model);
  assert.match(await result.text(), /响应正文/);
});

test('downstream cancellation aborts upstream fetch signal', async () => {
  let signal;
  const route = gateway(async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"首字"}}]}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } }); });
  const result = await route(req(), { messages: msg }, connection.apiUrl, connection.apiKey, connection.model);
  const reader = result.body.getReader(); await reader.read(); await reader.cancel(); assert.equal(signal.aborted, true);
});

test('unconfigured assistant returns an explicit configuration error', async () => {
  const route = load('../app/api/generate/route.ts', { '../../lib/story-images': images, '../../lib/assistant-gateway': { assistantGateway: () => { throw new Error('No configured model'); } } }).POST;
  const result = await route(new Request('http://local.invalid/api/generate', { method: 'POST', body: JSON.stringify({ task: 'assistant', messages: msg }) }));
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /配置并启用模型连接/);
});
