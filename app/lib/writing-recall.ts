import type { EmbeddingDocument, EmbeddingHit } from './embeddings';

export type RecallItem = { id: string; source: 'knowledge' | 'character' | 'relation' | 'timeline' | 'chapter'; type: string; title: string; body: string; tags: string[]; score: number; reason: string; recommended: boolean };

type RecallSource = {
  knowledge: { type: string; title: string; body: string; tags: string[] }[];
  chapters: { id: number; no: number; title: string; content: string }[];
};

// 只索引当前书的知识和当前章之前的正文，避免把后文提前带入续写。
export function writingEmbeddingDocuments(data: RecallSource, currentChapterNo: number): EmbeddingDocument[] {
  return [
    ...data.knowledge.map((item, index) => ({ id: `knowledge-${index}`, source: 'knowledge', type: item.type, title: item.title, body: item.body, tags: item.tags })).filter((item) => item.body.trim()),
    ...data.chapters.filter((item) => item.no < currentChapterNo && item.content.trim()).map((item) => {
      const prefix = `第 ${item.no} 章`;
      const title = !item.title.trim() || item.title.replace(/\s+/g, '') === `第${item.no}章` ? prefix : `${prefix} · ${item.title}`;
      return { id: `chapter-${item.id}`, source: 'chapter', type: '前文原文片段', title, body: item.content, tags: ['前文', `第${item.no}章`] };
    }),
  ];
}

// 同一来源只显示一张卡片；近期章节的连续性摘要仍保留。
export function mergeEmbeddingRecall(base: RecallItem[], hits: EmbeddingHit[]): RecallItem[] {
  const items = new Map(base.map((item) => [item.id, { ...item }]));
  for (const hit of hits) {
    if (!['chapter', 'knowledge'].includes(hit.source)) continue;
    const original = items.get(hit.documentId);
    const score = Math.max(original?.score || 0, Math.min(99, Math.round(hit.score * 100)));
    items.set(hit.documentId, {
      id: hit.documentId, source: hit.source as RecallItem['source'], type: original?.type || hit.type || '语义检索',
      title: original?.title || hit.title,
      body: original?.source === 'chapter' ? `${original.body}\n语义检索原文：${hit.body}` : hit.body,
      tags: [...new Set([...(original?.tags || []), ...hit.tags, 'Embedding'])], score,
      reason: original?.source === 'chapter' ? `${original.reason}＋语义命中` : 'Embedding 语义命中',
      recommended: true,
    });
  }
  const all = [...items.values()];
  return [...all.filter((item) => item.tags.includes('强制召回')), ...all.filter((item) => !item.tags.includes('强制召回')).sort((a, b) => b.score - a.score)];
}

// 字符预算是上下文长度保护，不等于模型供应商的计费 Token。
export function writingRecallContext(items: RecallItem[], maxChars = 32000) {
  const blocks: string[] = [];
  let chars = 0;
  let trimmed = false;
  for (const item of items) {
    const header = `【${item.type}｜${item.reason}】${item.title}：`;
    const remaining = maxChars - chars - header.length - 30;
    if (remaining < 40) { trimmed = true; break; }
    const limit = Math.min(4000, remaining);
    const body = item.body.slice(0, limit);
    const shortened = body.length < item.body.length;
    const block = header + body + (shortened ? '\n（此条资料因长度限制已截取）' : '');
    trimmed ||= shortened;
    blocks.push(block); chars += block.length + 2;
  }
  const context = blocks.join('\n\n');
  return { context, chars: context.length, trimmed };
}
