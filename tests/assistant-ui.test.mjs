// 独立浏览器 + 全部模拟数据。可选运行：设置 PLAYWRIGHT_MODULE 指向已安装的 playwright。
// 不会读取真实书库、API Key 或调用外部模型，不会启动新的开发服务器。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('assistant browser: streaming, stop, edits, per-book history, persistence and floating panel', { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 60000 }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p = await ctx.newPage(); const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    const makeBook = (title) => ({ book: { title, genre: '测试', systemPrompt: '', maxWords: 5000000 }, chapters: [{ id: 1, no: 1, title: '第 1 章', status: '草稿', time: '', location: '', content: '测试正文', words: 4 }], outline: [], knowledge: [], characters: [], relations: [], skills: [], timeline: [] });
    let payload = { libraryVersion: 1, activeBookId: 'a', books: [{ id: 'a', data: makeBook('测试书甲') }, { id: 'b', data: makeBook('测试书乙') }] };
    await p.route('**/api/workspace', async (r) => {
      if (r.request().method() === 'GET') await r.fulfill({ json: { payload } });
      else { payload = r.request().postDataJSON(); await r.fulfill({ json: { ok: true } }); }
    });
    await p.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.__sent = [];
      window.fetch = async (input, init) => {
        if (String(input) !== '/api/generate') return original(input, init);
        const body = JSON.parse(init.body); window.__sent.push(body);
        const text = '测试流式回答：' + body.messages.at(-1).content + '。内容结束。';
        let index = 0; let timer;
        return new Response(new ReadableStream({
          start(c) {
            const encoder = new TextEncoder();
            timer = setInterval(() => {
              if (index < text.length) { c.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text: text.slice(index, index + 2) }) + '\n')); index += 2; }
              else { clearInterval(timer); c.enqueue(encoder.encode(JSON.stringify({ type: 'done', toolCalls: [], finishReason: 'stop' }) + '\n')); c.close(); }
            }, 50);
            init.signal?.addEventListener('abort', () => { clearInterval(timer); c.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
          },
          cancel() { clearInterval(timer); },
        }), { headers: { 'Content-Type': 'application/x-ndjson' } });
      };
    });
    const openAgents = () => p.getByLabel('并行智能体', { exact: true }).click();
    const finished = () => p.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
    const question = p.getByLabel('助手问题');
    const openHistory = () => p.getByRole('button', { name: '查看历史会话', exact: true }).click();
    const closeHistory = () => p.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
    const historyRows = p.locator('.assistant-history-item');
    p.on('dialog', (d) => { errors.push('Unexpected native confirmation'); void d.dismiss(); });
    await p.goto(process.env.ASSISTANT_TEST_URL || 'http://localhost:3000/');
    // 等待模拟书库载入，确保客户端已完成 客户端初始化，再操作导航。
    await p.locator('.book-row strong').filter({ hasText: '测试书甲' }).waitFor();
    await openAgents();
    await question.fill('唐朝有哪些年号？');
    await p.getByRole('button', { name: '发送问题', exact: true }).click();
    await p.locator('.assistant-chat article.assistant p').filter({ hasText: '测试流' }).waitFor();
    assert.ok(await p.getByRole('button', { name: '停止生成', exact: true }).isVisible());
    await p.getByRole('button', { name: '停止生成', exact: true }).click();
    const partial = await p.locator('.assistant-chat article.assistant p').innerText();
    await p.waitForTimeout(250);
    assert.equal(await p.locator('.assistant-chat article.assistant p').innerText(), partial);
    await p.getByRole('button', { name: '修改重问', exact: true }).click();
    await question.fill('唐朝都城在哪里？');
    await p.getByRole('button', { name: '重新提问', exact: true }).click(); await finished();
    assert.equal(await p.locator('.assistant-chat article').count(), 2);
    assert.match(await p.locator('.assistant-chat article.assistant p').innerText(), /唐朝都城/);
    assert.ok(!(await p.locator('.assistant-chat').innerText()).includes('唐朝有哪些'));
    await question.fill('补充一个问题');
    await p.getByRole('button', { name: '发送问题', exact: true }).click(); await finished();
    assert.equal(await p.locator('.assistant-chat article').count(), 4);
    await p.getByRole('button', { name: '修改重问', exact: true }).first().click();
    await p.getByRole('button', { name: '重新提问', exact: true }).click();
    await p.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await p.locator('.assistant-chat article').count(), 4);
    await p.getByRole('button', { name: '重新提问', exact: true }).click();
    await p.getByRole('button', { name: '确认重问', exact: true }).click(); await finished();
    assert.equal(await p.locator('.assistant-chat article').count(), 2);
    await openHistory();
    assert.equal(await p.getByLabel('搜索历史会话').evaluate((el) => document.activeElement === el), true);
    await p.getByRole('button', { name: '重命名会话：唐朝都城在哪里', exact: true }).click();
    await p.getByLabel('会话标题', { exact: true }).fill('唐朝资料');
    await p.getByRole('button', { name: '保存名称', exact: true }).click();
    assert.match(await p.getByRole('dialog').innerText(), /唐朝资料/);
    await closeHistory();
    await p.getByRole('button', { name: '新建会话', exact: true }).click();
    await question.fill('如何设置悬念？');
    await p.getByRole('button', { name: '发送问题', exact: true }).click(); await finished();
    await openHistory();
    assert.equal(await historyRows.count(), 2);
    await p.getByLabel('搜索历史会话').fill('都城');
    assert.equal(await historyRows.count(), 1);
    assert.match(await historyRows.innerText(), /唐朝资料/);
    await p.getByLabel('搜索历史会话').fill('不存在的内容');
    assert.equal(await historyRows.count(), 0);
    assert.ok(await p.getByText('没有找到相关会话', { exact: true }).isVisible());
    await p.getByRole('button', { name: '清空搜索', exact: true }).click();
    if (process.env.ASSISTANT_UI_SCREENSHOT_DIR) await p.screenshot({ path: process.env.ASSISTANT_UI_SCREENSHOT_DIR + '/history.png' });
    await p.getByRole('button', { name: '打开会话：唐朝资料', exact: true }).click();
    assert.match(await p.locator('.assistant-chat').innerText(), /唐朝都城/);
    await p.getByLabel('切换书籍').selectOption('b'); await openAgents();
    await openHistory();
    assert.equal(await historyRows.count(), 0);
    await p.keyboard.press('Escape');
    assert.equal(await p.getByRole('dialog').count(), 0);
    await question.fill('乙书的问题');
    await p.getByRole('button', { name: '发送问题', exact: true }).click(); await finished();
    await p.getByLabel('切换书籍').selectOption('a'); await openAgents();
    assert.match(await p.locator('.assistant-chat').innerText(), /唐朝都城/);
    assert.ok(!(await p.locator('.assistant-chat').innerText()).includes('乙书的问题'));
    await p.waitForTimeout(900);
    assert.equal(payload.books[0].data.assistant.sessions.length, 2);
    assert.equal(payload.books[1].data.assistant.sessions.length, 1);
    await p.reload();
    await p.locator('.book-row strong').filter({ hasText: '测试书甲' }).waitFor();
    await openAgents();
    assert.match(await p.locator('.assistant-chat').innerText(), /唐朝都城/);
    await p.getByRole('button', { name: '删除问答', exact: true }).click();
    assert.ok(await p.getByRole('dialog', { name: '删除这些问答？' }).isVisible());
    assert.equal(await p.getByRole('button', { name: '取消', exact: true }).evaluate((el) => document.activeElement === el), true);
    await p.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await p.locator('.assistant-chat article').count(), 2);
    await p.getByRole('button', { name: '删除问答', exact: true }).click();
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    assert.equal(await p.locator('.assistant-chat article').count(), 0);
    await openHistory();
    await p.getByRole('button', { name: '删除会话：唐朝资料', exact: true }).click();
    if (process.env.ASSISTANT_UI_SCREENSHOT_DIR) await p.screenshot({ path: process.env.ASSISTANT_UI_SCREENSHOT_DIR + '/delete.png' });
    await p.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await historyRows.count(), 2);
    await p.getByRole('button', { name: '删除会话：唐朝资料', exact: true }).click();
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    assert.equal(await historyRows.count(), 1);
    await closeHistory();
    await p.getByLabel('写作台', { exact: true }).click();
    await p.locator('button[title="展开作者助手"]').click();
    await p.getByLabel('助手问题').fill('悬浮窗提问');
    await p.getByRole('button', { name: '发送问题', exact: true }).click(); await finished();
    const box = await p.locator('.writer-agent-float').boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 1000);
    // 回答中切书不得串写；返回旧书不能被错误地锁在“回答中”。
    await question.fill('切书前尚未结束的问题');
    await p.getByRole('button', { name: '发送问题', exact: true }).click();
    await p.locator('.float-chat article.assistant p').last().filter({ hasText: '测试流' }).waitFor();
    await p.getByLabel('切换书籍').selectOption('b');
    await p.waitForTimeout(200);
    assert.ok(!(await p.locator('.writer-agent-float').innerText()).includes('切书前尚未结束'));
    await p.getByLabel('切换书籍').selectOption('a');
    assert.ok(await p.getByRole('button', { name: '发送问题', exact: true }).isVisible());
    await p.setViewportSize({ width: 390, height: 650 });
    const stopOrSend = await p.getByRole('button', { name: '发送问题', exact: true }).boundingBox();
    assert.ok(stopOrSend.y + stopOrSend.height <= 650);
    await openHistory();
    const modalBox = await p.getByRole('dialog').boundingBox();
    assert.ok(modalBox.x >= 0 && modalBox.x + modalBox.width <= 390 && modalBox.y >= 0 && modalBox.y + modalBox.height <= 650);
    await p.getByRole('button', { name: '删除会话：悬浮窗提问', exact: true }).click();
    if (process.env.ASSISTANT_UI_SCREENSHOT_DIR) await p.screenshot({ path: process.env.ASSISTANT_UI_SCREENSHOT_DIR + '/delete-mobile.png' });
    const deleteBox = await p.getByRole('dialog').boundingBox();
    assert.ok(Math.abs(deleteBox.x + deleteBox.width / 2 - 195) < 2);
    assert.ok(Math.abs(deleteBox.y + deleteBox.height / 2 - 325) < 2);
    await p.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
