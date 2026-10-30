import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// 仅测试召回材料的本地组织，不读取真实书稿，也不调用模型。
const compiled = ts.transpileModule(readFileSync(new URL('../app/lib/writing-recall.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { writingEmbeddingDocuments, mergeEmbeddingRecall, writingRecallContext } = loaded.exports;

function item(overrides = {}) {
  return { id: 'knowledge-0', source: 'knowledge', type: '地点', title: '雨港', body: '原始设定', tags: ['世界观'], score: 30, reason: '关键词匹配', recommended: true, ...overrides };
}
function hit(overrides = {}) {
  return { documentId: 'knowledge-0', chunkId: 'knowledge-0::0', source: 'knowledge', type: '地点', title: '雨港', body: '匹配到的原文片段', tags: ['世界观'], score: 0.8, ...overrides };
}

test('Embedding corpus excludes current, future and empty chapters while preserving document identity', () => {
  const data = {
    knowledge: [
      { type: '地点', title: '旧港', body: '地点详情', tags: ['港口'] },
      { type: '规则', title: '空设定', body: ' \n\t ', tags: [] },
      { type: '伏笔', title: '信封', body: '没有署名的信封', tags: ['线索'] },
    ],
    chapters: [
      { id: 101, no: 1, title: '雨夜', content: '第一章原文' },
      { id: 202, no: 2, title: '空章节', content: ' \n ' },
      { id: 303, no: 3, title: '当前章', content: '当前章节原文不得入索引' },
      { id: 404, no: 4, title: '未来章', content: '未来剧情不得提前召回' },
    ],
  };
  const before = structuredClone(data);
  const documents = writingEmbeddingDocuments(data, 3);
  assert.deepEqual(documents.map((document) => document.id), ['knowledge-0', 'knowledge-2', 'chapter-101']);
  assert.deepEqual(documents.map((document) => document.source), ['knowledge', 'knowledge', 'chapter']);
  assert.deepEqual(documents[2], { id: 'chapter-101', source: 'chapter', type: '前文原文片段', title: '第 1 章 · 雨夜', body: '第一章原文', tags: ['前文', '第1章'] });
  assert.deepEqual(documents[0].tags, ['港口']);
  assert.ok(!JSON.stringify(documents).includes('不得'));
  assert.deepEqual(data, before);
});

test('The first chapter has no preceding chapter corpus', () => {
  assert.deepEqual(writingEmbeddingDocuments({ knowledge: [], chapters: [{ id: 1, no: 1, title: '开篇', content: '本章原文' }] }, 1), []);
  assert.deepEqual(writingEmbeddingDocuments({ knowledge: [], chapters: [] }, 1), []);
});

test('A semantic hit merges with the same source ID rather than creating duplicate cards', () => {
  const base = [item()];
  const before = structuredClone(base);
  const merged = mergeEmbeddingRecall(base, [hit(), hit({ chunkId: 'knowledge-0::1', body: '第二个命中片段', score: 0.7 })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'knowledge-0');
  assert.equal(merged[0].source, 'knowledge');
  assert.equal(merged[0].title, '雨港');
  assert.equal(merged[0].type, '地点');
  assert.equal(merged[0].score, 80);
  assert.equal(merged[0].recommended, true);
  assert.equal(merged[0].tags.filter((tag) => tag === 'Embedding').length, 1);
  assert.deepEqual(base, before);
});

test('Chapter semantic evidence keeps the forced continuity summary and original chapter metadata', () => {
  const summary = '时间：次日；地点：旧港。关键事件：主角得到信封。章末状态：仍在港口。';
  const base = [
    item({ id: 'chapter-101', source: 'chapter', type: '近期章节', title: '第 1 章 · 雨夜', body: summary, tags: ['强制召回', '前文'], reason: '前文连续性', score: 99 }),
    item({ id: 'knowledge-1', title: '其他资料', score: 95 }),
  ];
  const merged = mergeEmbeddingRecall(base, [hit({ documentId: 'chapter-101', chunkId: 'chapter-101::2', source: 'chapter', type: '前文原文片段', title: '不同的候选标题', body: '他把信封放进外套内袋。', tags: ['前文', '第1章'], score: 0.85 })]);
  const chapter = merged.find((candidate) => candidate.id === 'chapter-101');
  assert.equal(merged[0], chapter);
  assert.equal(chapter.title, '第 1 章 · 雨夜');
  assert.equal(chapter.type, '近期章节');
  assert.equal(chapter.score, 99);
  assert.ok(chapter.body.startsWith(summary));
  assert.match(chapter.body, /语义检索原文：他把信封放进外套内袋。/);
  assert.ok(chapter.tags.includes('强制召回'));
  assert.ok(chapter.tags.includes('Embedding'));
  assert.match(chapter.reason, /前文连续性.*语义命中/);
});

test('Forced items retain their order and other candidates follow score order', () => {
  const base = [
    item({ id: 'character-a', source: 'character', title: '甲', tags: ['强制召回'], score: 20 }),
    item({ id: 'knowledge-0', score: 40 }),
    item({ id: 'relation-a', source: 'relation', title: '关系', tags: ['强制召回'], score: 50 }),
    item({ id: 'knowledge-1', score: 60 }),
  ];
  const merged = mergeEmbeddingRecall(base, [hit({ documentId: 'knowledge-2', title: '新线索', score: 0.9 })]);
  assert.deepEqual(merged.map((candidate) => candidate.id), ['character-a', 'relation-a', 'knowledge-2', 'knowledge-1', 'knowledge-0']);
  assert.equal(merged[2].title, '新线索');
  assert.deepEqual(merged[2].tags, ['世界观', 'Embedding']);
});

test('Unexpected semantic source types cannot inject unrelated recall cards', () => {
  const base = [item()];
  const merged = mergeEmbeddingRecall(base, [hit({ documentId: 'outside', source: 'network', body: '外部内容' })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'knowledge-0');
  assert.ok(!JSON.stringify(merged).includes('外部内容'));
});

test('Recall context exposes source metadata and respects an explicit total character budget', () => {
  const small = writingRecallContext([item({ body: '完整设定' })], 200);
  assert.equal(small.context, '【地点｜关键词匹配】雨港：完整设定');
  assert.equal(small.chars, small.context.length);
  assert.equal(small.trimmed, false);
  const large = Array.from({ length: 18 }, (_, index) => item({ id: `knowledge-${index}`, title: `设定${index}`, body: '长正文。'.repeat(1500) }));
  for (const budget of [0, 30, 100, 512, 1000, 32000]) {
    const result = writingRecallContext(large, budget);
    assert.ok(result.context.length <= budget, `${result.context.length} exceeds ${budget}`);
    assert.equal(result.chars, result.context.length);
    assert.equal(result.trimmed, true);
    if (result.context) assert.match(result.context, /此条资料因长度限制已截取/);
  }
});

test('Default recall budget and per-item limit bound long material without mutating source text', () => {
  const body = '长设定'.repeat(20000);
  const single = item({ body });
  const result = writingRecallContext([single]);
  assert.ok(result.context.length < 4100);
  assert.equal(result.trimmed, true);
  assert.equal(single.body, body);
  const many = writingRecallContext(Array.from({ length: 18 }, (_, index) => item({ id: `knowledge-${index}`, body })));
  assert.ok(many.chars <= 32000);
  assert.deepEqual(writingRecallContext([]), { context: '', chars: 0, trimmed: false });
});
