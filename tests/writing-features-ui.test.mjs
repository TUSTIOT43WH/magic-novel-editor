// 独立浏览器与完整模拟书库；不会读取真实作品、凭据或访问任何外部模型。
// 设置 PLAYWRIGHT_MODULE 指向 Playwright，WRITING_FEATURES_TEST_URL 指向已启动的开发服务后运行。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);

// 内存构造一个常规 ZIP，验证真实文件选择与浏览器解压流程。
function skillZip() {
  const files = [
    { path: 'example/SKILL.md', text: '---\nname: 测试导入技能\ndescription: 仅用于自动化测试\n---\n# 必须遵守的规则\n通过动作和对白推进相遇情节，不新增角色。' },
    { path: 'example/references/重逢.md', text: '重逢场景参考：让角色先停下脚步，再通过一句对白确认身份。' },
  ];
  const local = []; const central = []; let offset = 0;
  const checksum = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  for (const file of files) {
    const name = Buffer.from(file.path); const data = Buffer.from(file.text); const crc = checksum(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(record, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const makeBook = (letter) => ({
  book: { title: `界面测试书${letter}`, genre: '自动化测试', systemPrompt: '保持本书设定', maxWords: 5000000 },
  chapters: [
    { id: 1, no: 1, title: `${letter}书第一章`, status: '已入库', time: '2026年10月30日', location: '旧车站', content: `${letter}书前文原文：离别时留下的暗号是琥珀灯。`, words: 25 },
    { id: 2, no: 2, title: `${letter}书第二章`, status: '草稿', time: '2026年10月31日', location: '回声塔', content: `${letter}书当前章原有内容。`, words: 10 },
    { id: 3, no: 3, title: `${letter}书第三章`, status: '尚未开始', time: '', location: '', content: `绝对不能索引的${letter}书未来章节。`, words: 20 },
  ],
  outline: [], knowledge: [{ type: '地点', title: `${letter}书回声塔`, body: `语义证据${letter}：多年未见的人在回声塔重逢，窗边挂着银色风铃。`, tags: ['旧识'] }],
  characters: [], relations: [], timeline: [],
  skills: letter === '甲' ? [
    { title: '旧版悬疑', description: '通过动作营造悬念，不解释异常来源。', enabled: true },
    { id: 'disabled-skill', title: '禁用技能', description: '不应发送到模型', enabled: false },
  ] : [{ id: 'b-skill', title: '乙书对白', description: '只用于乙书的自然对白。', enabled: true }],
});

test('writing browser: optional embeddings, local incremental cache, selected skills, ZIP import and per-book isolation', { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 180000 }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const screenshotDir = process.env.WRITING_FEATURES_SCREENSHOT_DIR || path.resolve('tmp/writing-features-qa');
  await mkdir(screenshotDir, { recursive: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); p.setDefaultTimeout(12000);
    const errors = []; const externalRequests = []; const embeddingRequests = []; const generationRequests = [];
    let payload = { libraryVersion: 1, activeBookId: 'a', books: [{ id: 'a', data: makeBook('甲') }, { id: 'b', data: makeBook('乙') }] };
    p.on('pageerror', (error) => errors.push(error.message));
    p.on('dialog', (dialog) => { errors.push('出现未预期的原生确认框'); void dialog.dismiss(); });
    const base = new URL(process.env.WRITING_FEATURES_TEST_URL || 'http://localhost:3010/');
    // 外部字体等请求一律拦截，避免测试环境访问公网；本地代码资源正常加载。
    await p.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) { externalRequests.push(url.origin); await route.abort(); }
      else await route.continue();
    });
    await p.route('**/api/workspace', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: { payload } });
      else { payload = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); }
    });
    await p.route('**/api/embeddings', async (route) => {
      const body = route.request().postDataJSON(); embeddingRequests.push(body);
      assert.ok(Array.isArray(body.input));
      await route.fulfill({ json: { vectors: body.input.map((input) => input.includes('语义证据乙') ? [0, 1, 0] : input.includes('前文原文') ? [0.8, 0.2, 0] : [1, 0, 0]) } });
    });
    await p.route('**/api/generate', async (route) => {
      generationRequests.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'text/plain; charset=utf-8', body: '抱歉，无法生成该内容。' });
    });
    const settings = () => p.getByLabel('作品设置', { exact: true }).click();
    const writer = () => p.getByLabel('写作台', { exact: true }).click();
    const skills = () => p.getByLabel('写作技能', { exact: true }).click();
    const vibe = p.getByLabel('剧情意图', { exact: true });
    const searchButton = p.getByRole('button', { name: '检索／更新', exact: true });
    const semanticCards = () => p.locator('.recall-option').filter({ has: p.locator('header span').filter({ hasText: /语义命中/ }) });
    const waitSearch = async () => { await searchButton.waitFor({ state: 'visible' }); await p.locator('.embedding-status').filter({ hasText: /^命中/ }).waitFor(); };
    const checkDock = async (height) => {
      const box = await p.locator('.vibe-dock').boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= height + 1, `写作输入区超出 ${height}px 视口`);
      const button = await p.locator('.generate').boundingBox();
      assert.ok(button && button.y >= box.y && button.y + button.height <= height, '生成按钮超出可见区域');
    };
    const checkMenu = async () => {
      const option = p.getByRole('listbox', { name: '可用写作技能' }).getByRole('option').first(); await option.waitFor();
      const box = await option.boundingBox();
      const viewport = p.viewportSize();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, '斜杠菜单超出视口');
      const clickable = await option.evaluate((element) => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); });
      assert.ok(clickable, '斜杠菜单被输入区边界或其他元素遮挡');
    };

    await p.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.locator('.book-row strong').filter({ hasText: '界面测试书甲' }).waitFor();
    await settings();
    const embeddingSettings = p.getByLabel('Embedding 模型设置', { exact: true });
    await p.getByLabel('Embedding API 地址', { exact: true }).fill('https://embedding.invalid/compatible-mode/v1');
    await p.getByLabel('Embedding API Key', { exact: true }).fill('fake-embedding-key-only-for-ui-test');
    await p.getByLabel('Embedding 模型名称', { exact: true }).fill('test-embedding-model');
    await p.getByRole('button', { name: '启用 Embedding 连接', exact: true }).click();
    assert.equal(embeddingRequests.length, 0, '启用配置不应自动发送书稿');
    await p.getByRole('button', { name: '测试 Embedding 连接', exact: true }).click();
    await embeddingSettings.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
    assert.equal(embeddingRequests.length, 1);
    assert.deepEqual(embeddingRequests[0].input, ['小说创作资料检索连接测试']);
    await p.screenshot({ path: path.join(screenshotDir, 'embedding-settings.png') });

    await writer();
    await p.locator('.chapter-select').filter({ hasText: '甲书第二章' }).click();
    await vibe.fill('让旧友重逢');
    await p.waitForTimeout(250);
    assert.equal(embeddingRequests.length, 1, '输入文字不能触发 Embedding');
    assert.equal(await p.getByLabel('Embedding 检索', { exact: true }).isChecked(), false);
    assert.equal(await searchButton.isDisabled(), true);
    await p.locator('.generate').click();
    await p.getByText('AI 草稿已生成', { exact: true }).waitFor();
    assert.equal(embeddingRequests.length, 1, '开关关闭时生成不能调用 Embedding');
    assert.match(await p.locator('.manuscript-input').inputValue(), /抱歉，无法生成该内容。/);

    // 旧 Skill 迁移后通过菜单选择，禁用项不会出现，选择命令从剧情意图删除。
    await vibe.fill('让旧友重逢 /');
    await p.getByRole('listbox', { name: '可用写作技能' }).waitFor();
    assert.equal(await p.getByRole('option').filter({ hasText: '禁用技能' }).count(), 0);
    await checkMenu();
    await p.screenshot({ path: path.join(screenshotDir, 'skills-menu-1440.png') });
    await vibe.press('Enter');
    assert.match(await p.locator('.writing-skill-chips').innerText(), /旧版悬疑/);
    assert.equal(await vibe.inputValue(), '让旧友重逢 ');
    await p.getByLabel('Embedding 检索', { exact: true }).check();
    await p.waitForTimeout(150);
    assert.equal(embeddingRequests.length, 1, '仅打开开关不能发送资料');
    await searchButton.click(); await waitSearch();
    const firstSearch = embeddingRequests.slice(1);
    const inputs = firstSearch.flatMap((request) => request.input);
    assert.ok(inputs.some((text) => text === '让旧友重逢'));
    assert.ok(inputs.some((text) => text.includes('语义证据甲')));
    assert.ok(inputs.some((text) => text.includes('甲书前文原文')));
    assert.ok(!inputs.some((text) => text.includes('未来章节') || text.includes('乙书')));
    assert.ok(await semanticCards().count() > 0);
    await checkDock(1000);
    await p.screenshot({ path: path.join(screenshotDir, 'semantic-recall-1440.png') });

    const afterFirstSearch = embeddingRequests.length;
    await searchButton.click(); await waitSearch();
    assert.equal(embeddingRequests.length, afterFirstSearch + 1, '相同资料检索只应重新向量化问题');
    assert.deepEqual(embeddingRequests.at(-1).input, ['让旧友重逢']);
    assert.match(await p.locator('.embedding-status').innerText(), /新建 0 段/);

    // 只改动前文一段，索引应仅更新该段，不重新发送未变的知识设定。
    await p.locator('.chapter-select').filter({ hasText: '甲书第一章' }).click();
    await p.locator('.manuscript-input').fill('甲书前文原文：离别时留下的暗号是琥珀灯。新增唯一索引修改片段。');
    await p.locator('.chapter-select').filter({ hasText: '甲书第二章' }).click();
    const beforeIncremental = embeddingRequests.length;
    await searchButton.click(); await waitSearch();
    const incremental = embeddingRequests.slice(beforeIncremental).flatMap((request) => request.input);
    assert.ok(incremental.some((text) => text.includes('新增唯一索引修改片段')));
    assert.ok(!incremental.some((text) => text.includes('语义证据甲')));
    assert.match(await p.locator('.embedding-status').innerText(), /新建 1 段/);

    const beforeInput = embeddingRequests.length;
    await vibe.fill('让旧友重逢，并谈起过去');
    await p.waitForTimeout(150);
    assert.equal(embeddingRequests.length, beforeInput);
    assert.equal(await semanticCards().count(), 0, '意图变化必须立即隐藏旧的语义结果');

    // 真实文件选择走 ZIP 导入，选择后核心及相关参考资料进入生成请求。
    await skills();
    await p.getByLabel('导入 Skill ZIP', { exact: true }).setInputFiles({ name: 'example-writing-skill.zip', mimeType: 'application/zip', buffer: skillZip() });
    await p.locator('.skill-edit h3').filter({ hasText: '测试导入技能' }).waitFor();
    await writer();
    await vibe.fill('让旧友重逢 /测试导入');
    await p.getByRole('option').filter({ hasText: '测试导入技能' }).click();
    assert.equal(await p.locator('.writing-skill-chips>span').count(), 2);
    await p.locator('.generate').click();
    await p.getByText('AI 草稿已生成', { exact: true }).waitFor();
    const sent = generationRequests.at(-1);
    assert.equal(sent.writingSkills.length, 2);
    assert.ok(sent.writingSkills.some((item) => item.instructions === '通过动作营造悬念，不解释异常来源。'));
    const imported = sent.writingSkills.find((item) => item.title === '测试导入技能');
    assert.match(imported.instructions, /通过动作和对白推进相遇情节/);
    assert.equal(imported.references.length, 1);
    assert.match(sent.context, /Embedding 语义命中|语义命中/);
    assert.match(sent.context, /语义证据甲/);
    assert.ok(!JSON.stringify(sent).includes('禁用技能'));
    assert.match(await p.locator('.manuscript-input').inputValue(), /抱歉，无法生成该内容。/);

    // 低高度窗口里仍能操作生成与斜杠菜单。
    await p.setViewportSize({ width: 1366, height: 768 });
    await checkDock(768);
    await p.getByLabel('移除写作技能 旧版悬疑', { exact: true }).click();
    await vibe.fill('让旧友重逢 /');
    await checkMenu();
    await p.screenshot({ path: path.join(screenshotDir, 'skills-menu-1366.png') });
    await vibe.press('Enter');

    await p.getByLabel('切换书籍', { exact: true }).selectOption('b');
    await writer();
    assert.equal(await p.locator('.writing-skill-chips>span').count(), 0, '乙书不能沿用甲书技能选择');
    assert.equal(await p.getByLabel('Embedding 检索', { exact: true }).isChecked(), false);
    assert.equal(await semanticCards().count(), 0, '切书后不能继续展示旧书向量结果');
    await vibe.fill('/'); await vibe.press('Enter');
    assert.match(await p.locator('.writing-skill-chips').innerText(), /乙书对白/);
    await vibe.fill('乙书角色重逢');
    await p.getByLabel('Embedding 检索', { exact: true }).check();
    const beforeBookB = embeddingRequests.length;
    await searchButton.click(); await waitSearch();
    const bookBInputs = embeddingRequests.slice(beforeBookB).flatMap((request) => request.input);
    assert.ok(bookBInputs.some((text) => text.includes('语义证据乙')));
    assert.ok(!bookBInputs.some((text) => text.includes('语义证据甲') || text.includes('甲书前文')));
    await p.getByLabel('切换书籍', { exact: true }).selectOption('a');
    assert.match(await p.locator('.writing-skill-chips').innerText(), /测试导入技能/);
    assert.ok(!(await p.locator('.writing-skill-chips').innerText()).includes('乙书对白'));
    assert.equal(await semanticCards().count(), 0);
    await p.waitForTimeout(800);
    assert.ok(payload.books[0].data.skills[0].id, '旧 Skill 应迁移出稳定 ID');
    assert.equal(payload.books[0].data.writingPreferences.selectedSkillIds.length, 2);
    assert.equal(payload.books[1].data.writingPreferences.selectedSkillIds.length, 1);
    assert.ok(!JSON.stringify(payload).includes('fake-embedding-key-only-for-ui-test'), '书库不能保存 Embedding 凭据');
    const vectors = await p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('mojing-local-embeddings-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const rows = await new Promise((resolve, reject) => { const request = db.transaction('vectors').objectStore('vectors').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close(); return rows;
    });
    assert.ok(vectors.length > 0);
    assert.ok(vectors.some((row) => row.bookId === 'a') && vectors.some((row) => row.bookId === 'b'));
    assert.ok(!JSON.stringify(vectors).includes('fake-embedding-key-only-for-ui-test'), '向量缓存不能包含 API Key');
    assert.ok(!JSON.stringify(vectors).includes('apiKey'));
    assert.deepEqual(errors, []);
    assert.ok(!externalRequests.some((host) => host.includes('embedding.invalid')), '浏览器不能直连外部 Embedding 服务');
  } finally { await browser.close(); }
});
