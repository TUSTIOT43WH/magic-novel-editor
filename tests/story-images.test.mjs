import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Compile the actual route in isolation and inject a mock provider: no network,
// workspace writes, or real model credentials are used by these tests.
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
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=';
const connection = { apiUrl: 'https://provider.invalid/v1/chat/completions', apiKey: 'test-only', model: 'test-vision' };
function route(fetcher) {
  return loadTs('../app/api/generate/route.ts', { '../../lib/story-images': imageModule }, fetcher).POST;
}
function request(body) {
  return new Request('http://localhost/api/generate', { method: 'POST', body: JSON.stringify(body) });
}
function sse(responses = false) {
  const event = responses ? { type: 'response.output_text.delta', delta: '故事正文' } : { choices: [{ delta: { content: '故事正文' } }] };
  return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

test('valid images preserve order; malformed, remote and oversized inputs are rejected', () => {
  assert.deepEqual(imageModule.validateStoryImages([png, png]), [png, png]);
  for (const input of [null, {}, Array(5).fill(png), ['https://example.com/image.png'], ['data:image/svg+xml;base64,PHN2Zy8+'], ['data:image/png;base64,AAAA'], ['data:image/png;base64,' + 'A'.repeat(7_000_000)]]) {
    assert.throws(() => imageModule.validateStoryImages(input));
  }
});
for (const responses of [false, true]) {
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
test('text-only requests keep their existing string content', async () => {
  const POST = route(async (_url, options) => {
    const sent = JSON.parse(options.body);
    assert.equal(typeof sent.messages[1].content, 'string');
    return sse();
  });
  assert.equal(await (await POST(request({ vibe: '继续写作', images: [], connection }))).text(), '故事正文');
});
test('invalid images and images sent to other agents never reach provider', async () => {
  const POST = route();
  assert.equal((await POST(request({ images: ['broken'], connection }))).status, 400);
  assert.equal((await POST(request({ task: 'audit', images: [png], connection }))).status, 400);
});
test('image requests without a model cannot return a demo story', async () => {
  const result = await route()(request({ images: [png] }));
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /支持图片输入/);
});
test('provider errors and empty JSON results are explicit failures', async () => {
  const blocked = await route(async () => Response.json({ error: { message: 'vision unsupported' } }, { status: 400 }))(request({ images: [png], connection }));
  assert.equal(blocked.status, 502);
  assert.match((await blocked.json()).error, /支持图片输入/);
  const empty = await route(async () => Response.json({ choices: [{ message: { content: '' } }] }))(request({ images: [png], connection }));
  assert.equal(empty.status, 502);
  assert.match((await empty.json()).error, /没有返回正文/);
});
