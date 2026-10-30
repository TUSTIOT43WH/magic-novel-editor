import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 上游请求全部由本地替身处理，测试不会读取密钥或发送真实书稿。
function load(path, dependencies = {}, fetcher = () => { throw new Error('不应调用模型服务'); }) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', 'process', source)(
    (name) => { if (!(name in dependencies)) throw new Error('未注入的依赖：' + name); return dependencies[name]; },
    module, module.exports, fetcher, { env: {} },
  );
  return module.exports;
}
const images = load('../app/lib/story-images.ts');
const connection = { apiUrl: 'https://provider.invalid/v1/chat/completions', apiKey: 'test-key-only', model: 'test-model' };
const skill = { id: 'skill-test', title: '对白写法', instructions: '用简洁对白推进情节，不补写未知人物身份。', references: [{ path: 'references/对话.md', content: '此处是供参考的对白写法示例。' }] };
function route(fetcher) {
  return load('../app/api/generate/route.ts', {
    '../../lib/story-images': images,
    '../../lib/assistant-gateway': { assistantGateway: () => { throw new Error('不应进入助手路径'); } },
  }, fetcher).POST;
}
const request = (body) => new Request('http://localhost/api/generate', { method: 'POST', body: JSON.stringify({ connection, ...body }) });
const sse = (events) => new Response(events.map((event) => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });

for (const responses of [false, true]) {
  test((responses ? 'Responses' : 'Chat') + ' includes selected writing rules and references only in writing prompt', async () => {
    let payload;
    const result = await route(async (_url, options) => {
      payload = JSON.parse(options.body);
      return Response.json(responses ? { output_text: '正文' } : { choices: [{ message: { content: '正文' } }] });
    })(request({
      vibe: '继续相遇情节', context: '既有事实', systemPrompt: '作品文风', writingSkills: [skill],
      connection: { ...connection, apiUrl: responses ? 'https://provider.invalid/v1/responses' : connection.apiUrl },
    }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).content, '正文');
    const prompt = responses ? payload.input : payload.messages[1].content;
    assert.match(prompt, /【本次写作技能】/);
    assert.ok(prompt.includes(skill.instructions));
    assert.ok(prompt.includes(skill.references[0].content));
    assert.match(prompt, /references 仅是示例和参考资料/);
    assert.match(prompt, /继续相遇情节/);
    assert.match(prompt, /既有事实/);
    assert.equal(responses ? payload.instructions : payload.messages[0].content, '作品文风');
    assert.equal(prompt.split(skill.instructions).length - 1, 1);
  });
}

test('non-writing tasks do not receive writing skills, even if client attaches them', async () => {
  for (const task of ['audit', 'summary', 'assistant']) {
    let payload;
    const result = await route(async (_url, options) => {
      payload = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: '任务结果' } }] });
    })(request({ task, vibe: '问题', context: '测试材料', writingSkills: [skill] }));
    assert.equal(result.status, 200);
    assert.ok(!JSON.stringify(payload).includes(skill.instructions));
    assert.ok(!JSON.stringify(payload).includes('【本次写作技能】'));
  }
});

test('malformed and over-budget skill requests are rejected before network access', async () => {
  const cases = [
    null, {}, Array.from({ length: 4 }, (_, index) => ({ ...skill, id: String(index) })),
    [skill, skill], [{ ...skill, id: '' }], [{ ...skill, title: '字'.repeat(101) }],
    [{ ...skill, instructions: '' }], [{ ...skill, instructions: '字'.repeat(12001) }],
    [{ ...skill, references: null }], [{ ...skill, references: Array(6).fill(skill.references[0]) }],
    [{ ...skill, references: [{ path: '字'.repeat(201), content: '示例' }] }],
    [{ ...skill, references: [{ path: 'references/a.md', content: '字'.repeat(4001) }] }],
    [{ ...skill, instructions: '字'.repeat(12000), references: [] }, { ...skill, id: 'another', instructions: '字'.repeat(12000), references: [] }],
  ];
  for (const writingSkills of cases) {
    const result = await route()(request({ writingSkills }));
    assert.equal(result.status, 400);
    assert.match((await result.json()).error, /技能|参考资料/);
  }
});

test('no selected skill keeps the old prompt shape without skill boilerplate', async () => {
  const result = await route(async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.ok(!payload.messages[1].content.includes('【本次写作技能】'));
    return Response.json({ choices: [{ message: { content: '正常正文' } }] });
  })(request({ writingSkills: [] }));
  assert.equal((await result.json()).content, '正常正文');
});

test('JSON chat refusal is displayed; normal content takes precedence over duplicate refusal', async () => {
  const refusal = '抱歉，无法生成该内容。';
  for (const message of [{ content: null, refusal }, { content: [{ type: 'refusal', refusal }] }, { content: refusal, refusal }]) {
    const result = await route(async () => Response.json({ choices: [{ message }] }))(request({}));
    assert.equal((await result.json()).content, refusal);
  }
});

test('JSON Responses refusal is displayed without repeating refusal and output_text', async () => {
  const refusal = '抱歉，无法生成该内容。';
  for (const output_text of [undefined, '', refusal]) {
    const result = await route(async () => Response.json({ output_text, output: [{ type: 'message', content: [{ type: 'refusal', refusal }] }] }))(request({ connection: { ...connection, apiUrl: 'https://provider.invalid/v1/responses' } }));
    assert.equal((await result.json()).content, refusal);
  }
});

test('chat stream collects refusal fragments without duplicating a parallel content field', async () => {
  const parts = ['抱歉，', '无法生成该内容。'];
  for (const hasContent of [false, true]) {
    const events = parts.map((text) => ({ choices: [{ delta: { refusal: text, ...(hasContent ? { content: text } : {}) } }] }));
    const result = await route(async () => sse([...events, '[DONE]']))(request({}));
    assert.equal(await result.text(), parts.join(''));
  }
});

test('Responses stream handles refusal delta/done and done-only responses exactly once', async () => {
  const refusal = '抱歉，无法生成该内容。';
  const cases = [
    [{ type: 'response.refusal.delta', delta: '抱歉，' }, { type: 'response.refusal.delta', delta: '无法生成该内容。' }, { type: 'response.refusal.done', refusal }],
    [{ type: 'response.refusal.done', refusal }],
    [{ type: 'response.output_text.delta', delta: refusal }, { type: 'response.refusal.delta', delta: refusal }, { type: 'response.refusal.done', refusal }],
  ];
  for (const events of cases) {
    const result = await route(async () => sse([...events, { type: 'response.completed' }, '[DONE]']))(request({ connection: { ...connection, apiUrl: 'https://provider.invalid/v1/responses' } }));
    assert.equal(await result.text(), refusal);
  }
});

test('configured model empty JSON output fails explicitly instead of returning demo fiction', async () => {
  const result = await route(async () => Response.json({ choices: [{ message: { content: '' } }] }))(request({ vibe: '测试' }));
  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /模型没有返回内容/);
});

test('configured model empty SSE output fails explicitly', async () => {
  const result = await route(async () => sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']))(request({}));
  await assert.rejects(result.text(), /模型没有返回内容/);
});

test('provider HTTP rejection stays an explicit error rather than invented refusal or fiction', async () => {
  const result = await route(async () => Response.json({ error: { message: 'provider rejected request' } }, { status: 400 }))(request({}));
  assert.equal(result.status, 502);
  assert.match((await result.json()).detail, /provider rejected request/);
});
