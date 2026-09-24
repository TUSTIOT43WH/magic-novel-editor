import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 不写入工作区，也不使用真实模型凭据。
// 用 模拟请求函数 隔离加载路由模块，测试不产生网络请求，也不读写真实模型配置。
function loadTs(path, dependencies = {}, fetcher = () => { throw new Error('Unexpected provider request'); }) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', 'process', compiled)(
    (name) => { if (!(name in dependencies)) throw new Error('Unexpected import: ' + name); return dependencies[name]; },
    compiledModule, compiledModule.exports, fetcher, { env: {} },
  );
  return compiledModule.exports;
}
const imageModule = loadTs('../app/lib/story-images.ts');
// 1×1 透明 PNG，作为唯一被接受的正常图片样本。
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=';
// 测试用连接信息，域名不可解析，保证请求只会命中注入的 fetcher。
const connection = { apiUrl: 'https://provider.invalid/v1/chat/completions', apiKey: 'test-only', model: 'test-vision' };
// 带上图片模块依赖并注入假上游，取出路由的 POST 处理函数。
function route(fetcher) {
  return loadTs('../app/api/generate/route.ts', { '../../lib/story-images': imageModule, '../../lib/assistant-gateway': { assistantGateway: () => { throw new Error('Unexpected assistant request'); } } }, fetcher).POST;
}
// 把请求体包装成网关接口收到的 HTTP 请求。
function request(body) {
  return new Request('http://localhost/api/generate', { method: 'POST', body: JSON.stringify(body) });
}
// 造一个上游 SSE 响应，按参数选用 Responses 或 chat/completions 的事件结构，末尾带 [DONE]。
function sse(responses = false) {
  const event = responses ? { type: 'response.output_text.delta', delta: '故事正文' } : { choices: [{ delta: { content: '故事正文' } }] };
  return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

// 覆盖图片校验：正常图片按原顺序通过，非数组、超量、远程链接、SVG、伪造 base64
// 与超限体积等输入都必须被拒绝。
test('valid images preserve order; malformed, remote and oversized inputs are rejected', () => {
  assert.deepEqual(imageModule.validateStoryImages([png, png]), [png, png]);
  for (const input of [null, {}, Array(5).fill(png), ['https://example.com/image.png'], ['data:image/svg+xml;base64,PHN2Zy8+'], ['data:image/png;base64,AAAA'], ['data:image/png;base64,' + 'A'.repeat(7_000_000)]]) {
    assert.throws(() => imageModule.validateStoryImages(input));
  }
});
// 同一组断言在 chat/completions 与 Responses 两种接口上各跑一遍。
for (const responses of [false, true]) {
  // 覆盖多模态请求：Vibe、上下文与负向要求都进入首段文本，两张图片按对应接口的格式附带，
  // 自定义系统提示词生效，并且以流式返回拼接后的正文。
  test((responses ? 'Responses' : 'Chat Completions') + ' sends images, Vibe and context together and streams text', async () => {
    let sent;
    const POST = route(async (_url, options) => { sent = JSON.parse(options.body); return sse(responses); });
    const result = await POST(request({
      vibe: '图1中的人物在雨夜相遇', positive: '悬疑', negative: '不要穿越', context: '既有设定',
      images: [png, png], systemPrompt: '本书文风',
      connection: { ...connection, apiUrl: responses ? 'https://provider.invalid/v1/responses' : connection.apiUrl },
    }));
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '故事正文');
    assert.equal(sent.stream, true);
    const parts = responses ? sent.input[0].content : sent.messages[1].content;
    assert.equal(parts.length, 3);
    assert.match(parts[0].text, /图1中的人物在雨夜相遇/);
    assert.match(parts[0].text, /既有设定/);
    assert.match(parts[0].text, /不要穿越/);
    assert.equal(responses ? parts[1].image_url : parts[1].image_url.url, png);
    assert.equal(parts[1].type, responses ? 'input_image' : 'image_url');
    assert.equal(responses ? sent.instructions : sent.messages[0].content, '本书文风');
  });
}
// 覆盖纯文字请求：没有图片时 content 仍是字符串，不会退化成数组格式。
test('text-only requests keep their existing string content', async () => {
  const POST = route(async (_url, options) => {
    const sent = JSON.parse(options.body);
    assert.equal(typeof sent.messages[1].content, 'string');
    return sse();
  });
  assert.equal(await (await POST(request({ vibe: '继续写作', images: [], connection }))).text(), '故事正文');
});
// 覆盖前置拦截：图片非法、或把图片发给写作以外的智能体时都返回 400，
// fetcher 仍是默认实现，说明请求没有到达上游。
test('invalid images and images sent to other agents never reach provider', async () => {
  const POST = route();
  assert.equal((await POST(request({ images: ['broken'], connection }))).status, 400);
  assert.equal((await POST(request({ task: 'audit', images: [png], connection }))).status, 400);
});
// 覆盖无连接时的图片请求：不能静默返回示例稿，而是提示需要支持图片输入的模型。
test('image requests without a model cannot return a demo story', async () => {
  const result = await route()(request({ images: [png] }));
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /支持图片输入/);
});
// 覆盖上游异常：接口报错转成带图片提示的 502，返回空正文同样按失败处理而不是回落示例稿。
test('provider errors and empty JSON results are explicit failures', async () => {
  const blocked = await route(async () => Response.json({ error: { message: 'vision unsupported' } }, { status: 400 }))(request({ images: [png], connection }));
  assert.equal(blocked.status, 502);
  assert.match((await blocked.json()).error, /支持图片输入/);
  const empty = await route(async () => Response.json({ choices: [{ message: { content: '' } }] }))(request({ images: [png], connection }));
  assert.equal(empty.status, 502);
  assert.match((await empty.json()).error, /没有返回正文/);
});
