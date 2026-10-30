import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import ts from 'typescript';

// 加载纯技能模块，所有 ZIP 均在内存中构造，不读取作者的技能包或模型凭据。
const compiled = ts.transpileModule(readFileSync(new URL('../app/lib/writing-skills.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledModule = { exports: {} };
new Function('module', 'exports', compiled)(compiledModule, compiledModule.exports);
const { getWritingSkillId, prepareWritingSkills, getWritingSkillCommand, importWritingSkillZip, MAX_WRITING_SKILL_CHARACTERS } = compiledModule.exports;

function skill(title, instructions, extra = {}) { return { id: title, title, instructions, description: '技能简介', enabled: true, ...extra }; }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

// 支持构造存储和 deflate 两种 ZIP，同时允许针对目录字段制造畸形输入。
function zip(files, { deflate = false } = {}) {
  const local = []; const central = [];
  let offset = 0;
  for (const { path, text = '', flags = 0x800, attributes = 0, declaredSize } of files) {
    const name = Buffer.from(path); const data = Buffer.from(text); const compressed = deflate ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(deflate ? 8 : 0, 8); header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(declaredSize ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(deflate ? 8 : 0, 10); record.writeUInt32LE(crc32(data), 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(declaredSize ?? data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(attributes >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([...local, directory, end]);
}

test('only selected enabled skills are sent, old descriptions remain usable', () => {
  const legacy = { title: '旧技能', description: '保留原有文风规则', enabled: true };
  const id = getWritingSkillId(legacy, 0);
  assert.equal(id, getWritingSkillId(legacy, 0));
  const result = prepareWritingSkills([legacy, skill('禁用', '不应发送', { enabled: false }), skill('未选', '不应发送')], [id, '禁用'], '继续');
  assert.equal(result.writingSkills.length, 1);
  assert.equal(result.writingSkills[0].instructions, legacy.description);
  assert.deepEqual(prepareWritingSkills([legacy], [], '继续').writingSkills, []);
});

test('complete core rules are preserved and oversized selections fail instead of truncating', () => {
  const rules = '必须保留的核心规则。'.repeat(100);
  assert.equal(prepareWritingSkills([skill('核心', rules)], ['核心'], '').writingSkills[0].instructions, rules);
  assert.throws(() => prepareWritingSkills([skill('过长', '文'.repeat(12001))], ['过长'], ''), /12000/);
  assert.throws(() => prepareWritingSkills([skill('一', '文'.repeat(12000)), skill('二', '文'.repeat(12000))], ['一', '二'], ''), /24000/);
  assert.throws(() => prepareWritingSkills(['一', '二', '三', '四'].map((title) => skill(title, '规则')), ['一', '二', '三', '四'], ''), /最多选择 3/);
});

test('references are loaded on demand within the shared budget', () => {
  const skills = [skill('悬疑', '保留核心要求', { references: [{ path: 'references/悬疑节奏.md', content: '悬疑节奏'.repeat(1600) }, { path: 'references/恋爱.md', content: '恋爱对白' }] })];
  const match = prepareWritingSkills(skills, ['悬疑'], '悬疑节奏');
  assert.equal(match.referencesLoaded, 1);
  assert.match(match.writingSkills[0].references[0].path, /悬疑/);
  assert.ok(match.writingSkills[0].references[0].content.length <= 3000);
  assert.ok(match.chars <= MAX_WRITING_SKILL_CHARACTERS);
  assert.equal(prepareWritingSkills(skills, ['悬疑'], '继续').referencesLoaded, 0);
  const crowded = [skill('一', '文'.repeat(11900)), skill('二', '文'.repeat(11900), { references: [{ path: 'references/悬疑.md', content: '悬疑'.repeat(2000) }] })];
  assert.ok(prepareWritingSkills(crowded, ['一', '二'], '悬疑').chars <= MAX_WRITING_SKILL_CHARACTERS);
});

test('long reference excerpts include a match near the end instead of an unrelated opening', () => {
  const reference = { path: 'references/技巧.md', content: '无关开头。'.repeat(1100) + '\n只有尾部出现关键技巧：悬疑节奏应逐步加快，结尾留下线索。\n' + '收尾说明。'.repeat(40) };
  const result = prepareWritingSkills([skill('悬疑', '必须完整发送的核心', { references: [reference] })], ['悬疑'], '悬疑节奏');
  const excerpt = result.writingSkills[0].references[0].content;
  assert.match(excerpt, /只有尾部出现关键技巧：悬疑节奏/);
  assert.match(excerpt, /参考资料节选/);
  assert.ok(excerpt.length <= 3000);
  assert.ok(result.chars <= MAX_WRITING_SKILL_CHARACTERS);
  assert.equal(result.writingSkills[0].instructions, '必须完整发送的核心');
});

test('slash commands only match command positions and preserve text around the caret', () => {
  assert.deepEqual(getWritingSkillCommand('/悬疑'), { start: 0, end: 3, query: '悬疑' });
  assert.deepEqual(getWritingSkillCommand('继续 /对白 后续', 6), { start: 3, end: 6, query: '对白' });
  assert.equal(getWritingSkillCommand('https://example.com/path'), null);
  assert.equal(getWritingSkillCommand('他/她'), null);
  assert.equal(getWritingSkillCommand('/悬疑\n继续'), null);
});

for (const deflate of [false, true]) test((deflate ? 'deflated' : 'stored') + ' ZIP imports metadata, rules and references as text', async () => {
  const result = await importWritingSkillZip(zip([
    { path: 'suspense/SKILL.md', text: '---\nname: "悬疑推进"\ndescription: 放慢真相揭示\n---\n# 核心规则\n强化感官细节，控制信息揭示。' },
    { path: 'suspense/references/节奏.md', text: '悬疑节奏参考。' },
    { path: 'suspense/scripts/run.js', text: 'throw new Error("不执行")' },
  ], { deflate }));
  assert.equal(result.title, '悬疑推进');
  assert.equal(result.description, '放慢真相揭示');
  assert.equal(result.instructions, '# 核心规则\n强化感官细节，控制信息揭示。');
  assert.deepEqual(result.references, [{ path: 'references/节奏.md', content: '悬疑节奏参考。' }]);
  assert.ok(result.id);
  assert.equal(result.enabled, true);
});

test('ZIP parser rejects path traversal, duplicate names, encrypted files and symbolic links', async () => {
  const core = { path: 'SKILL.md', text: '# 正常技能\n规则' };
  await assert.rejects(importWritingSkillZip(zip([core, { path: '../outside.md', text: '不能越界' }])), /不安全/);
  await assert.rejects(importWritingSkillZip(zip([core, { path: 'C:/outside.md', text: '不能越界' }])), /不安全/);
  await assert.rejects(importWritingSkillZip(zip([core, { ...core, path: 'skill.md' }])), /重复/);
  await assert.rejects(importWritingSkillZip(zip([{ ...core, flags: 1 }])), /加密/);
  await assert.rejects(importWritingSkillZip(zip([{ ...core, attributes: 0xa0000000 }])), /符号链接/);
});

test('ZIP parser rejects malformed, excessive or dishonest payloads', async () => {
  await assert.rejects(importWritingSkillZip(new Blob(['not zip'])), /无法识别/);
  await assert.rejects(importWritingSkillZip(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)])), /2 MB/);
  await assert.rejects(importWritingSkillZip(zip([{ path: 'README.md', text: 'missing' }])), /SKILL.md/);
  await assert.rejects(importWritingSkillZip(zip([{ path: 'SKILL.md', text: '规则', declaredSize: 140000 }])), /解压体积/);
  await assert.rejects(importWritingSkillZip(zip([{ path: 'SKILL.md', text: '# 名称\n' + '规则'.repeat(6200) }])), /12000/);
  await assert.rejects(importWritingSkillZip(zip([{ path: 'SKILL.md', text: '---\nname: 未结束\n# 正文' }])), /结束分隔线/);
  await assert.rejects(importWritingSkillZip(zip([{ path: 'SKILL.md', text: '规则', declaredSize: 1 }], { deflate: true })), /解压体积/);
  const corrupted = new Uint8Array(await zip([{ path: 'SKILL.md', text: '规则' }]).arrayBuffer());
  corrupted[30 + 'SKILL.md'.length] ^= 1;
  await assert.rejects(importWritingSkillZip(new Blob([corrupted])), /校验失败/);
});

test('blank frontmatter fields do not swallow the following metadata line', async () => {
  const result = await importWritingSkillZip(zip([{ path: 'SKILL.md', text: '---\nname:\ndescription: 一行简介\n---\n# 标题兜底\n正文规则' }]));
  assert.equal(result.title, '标题兜底');
  assert.equal(result.description, '一行简介');
});
