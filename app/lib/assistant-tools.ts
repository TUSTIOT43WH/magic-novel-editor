// 所有查书工具只接收当前书的快照，不读文件、不联网、不修改作品。
export type AssistantBook = {
  book: { title: string }; chapters: { no: number; title: string; content: string; summary?: string }[];
  characters: { name: string; role: string; state: string; location: string; marker?: string }[];
  relations: { from: string; to: string; label: string }[];
  knowledge: { title: string; body: string; tags: string[] }[];
  timeline: { time: string; title: string; detail: string; chapter: number }[];
  outline: { title: string; summary: string; state: string }[];
};
export const TOOL_LABELS: Record<string, string> = { search_chapters: '检索章节', read_chapter: '阅读章节', get_character: '查询人物', get_relations: '查询关系', get_timeline: '查询时间线', search_knowledge: '检索设定', get_outline: '阅读大纲' };
const string = { type: 'string' };
const limit = (max: number) => ({ type: 'integer', minimum: 1, maximum: max });
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
export const ASSISTANT_TOOLS = [
  definition('search_chapters', '检索本书章节正文及总结，返回章节号与命中片段。人物经历、情节事件先查本工具。query 使用简短人名或关键词，可用空格分隔。', { query: string, limit: limit(20) }, ['query']),
  definition('read_chapter', '读取章节总结与首尾片段；需要核查原文时按 offset/maxChars 分页。每次最多4000字符。', { no: limit(100000), offset: { type: 'integer', minimum: 0 }, maxChars: limit(4000) }, ['no']),
  definition('get_character', '查询作者维护的人物身份、状态、位置、登场标记。', { name: string }, ['name']),
  definition('get_relations', '查询人物关系。name 可选，未填返回关系概览。', { name: string }),
  definition('get_timeline', '按章节号 chapter 或时间文本 from/to 查询时间线；非标准纪年只支持文本匹配，不推断日期先后。', { chapter: limit(100000), from: string, to: string, limit: limit(30) }),
  definition('search_knowledge', '按关键词查询本书世界观、地点、道具、伏笔等设定。', { query: string, limit: limit(20) }, ['query']),
  definition('get_outline', '获取全书大纲及当前进度，长大纲可按 offset 分页。', { offset: { type: 'integer', minimum: 0 } }),
];
const clip = (value: string, max: number) => value.length > max ? value.slice(0, Math.max(0, max - 6)) + '（已截断）' : value;
const terms = (value: string) => [...new Set(value.toLowerCase().split(/[\s，、,；;。？！?!]+/).filter(Boolean))].slice(0, 12);
const score = (value: string, query: string[]) => query.reduce((n, term) => n + (value.toLowerCase().includes(term) ? 1 : 0), 0);
function snippet(value: string, query: string[], max = 320) {
  const positions = query.map((term) => value.toLowerCase().indexOf(term)).filter((index) => index >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 80);
  return (start ? '…' : '') + clip(value.slice(start), max);
}
function numberArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}～${max} 的整数`);
  return value;
}
function textArg(args: Record<string, unknown>, key: string, required = false) {
  const value = args[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > 200 || (required && !value.trim())) throw new Error(`${key} 必须是非空的短文本（最多200字符）`);
  return value.trim();
}
export function detectStoryIntent(question: string, data: AssistantBook) {
  // “主角”“关系”等是提示而非事实；不会将角色称谓当成一个人名。
  const labels = [...data.characters.flatMap((x) => [x.name, x.role]), ...data.knowledge.flatMap((x) => [x.title, ...x.tags]), ...data.chapters.map((x) => x.title), ...data.timeline.map((x) => x.title)];
  const matches = [...new Set(labels.filter((x) => x.trim().length >= 2 && question.includes(x)))];
  return { isStory: matches.length > 0 || /第\s*[0-9一二三四五六七八九十百千零两]+\s*章|本书|本章|主角|此前|之前|上次|伏笔|设定|世界观|大纲|时间线|关系/.test(question), matches };
}
type ToolResult = { text: string; sources: string[] };
export function executeAssistantTool(data: AssistantBook, name: string, raw: string, budget = 4000): ToolResult {
  try {
    if (!Object.hasOwn(TOOL_LABELS, name)) throw new Error('不允许调用该工具；仅可查阅当前作品');
    const args = JSON.parse(raw || '{}') as Record<string, unknown>;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象');
    let rows: unknown[] = []; let sources: string[] = []; let detail: unknown;
    const query = ['search_chapters', 'search_knowledge'].includes(name) ? terms(textArg(args, 'query', true)) : [];
    if (name === 'search_chapters') {
      const matches = data.chapters.map((c) => ({ c, score: score(c.title + '\n' + (c.summary || '') + '\n' + c.content, query) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.c.no - b.c.no).slice(0, numberArg(args, 'limit', 5, 1, 20));
      rows = matches.map(({ c }) => ({ chapter: c.no, title: c.title, summary: snippet(c.summary || '', query, 180), excerpt: snippet(c.content, query) }));
      sources = matches.map(({ c }) => `第 ${c.no} 章《${c.title}》`);
    } else if (name === 'read_chapter') {
      const no = numberArg(args, 'no', 0, 1, 100000); const c = data.chapters.find((x) => x.no === no);
      if (c) {
        const offset = numberArg(args, 'offset', 0, 0, 10000000); const max = numberArg(args, 'maxChars', 2200, 1, 4000);
        const excerpt = c.content.slice(offset, offset + Math.min(max, Math.max(0, Math.min(4000, budget) - 1800)));
        detail = { chapter: no, title: c.title, summary: clip(c.summary || '本章暂无作者确认的总结，请以原文为准。', 500), totalChars: c.content.length, offset, nextOffset: Math.min(c.content.length, offset + excerpt.length), excerpt, ...(args.offset === undefined ? { ending: c.content.slice(-400) } : {}) };
        sources = [`第 ${no} 章《${c.title}》`];
      }
    } else if (name === 'get_character') {
      const value = textArg(args, 'name', true); rows = data.characters.filter((x) => x.name.includes(value)).slice(0, 20); sources = (rows as AssistantBook['characters']).map((x) => `人物：${x.name}`);
    } else if (name === 'get_relations') {
      const value = textArg(args, 'name'); rows = data.relations.filter((x) => !value || x.from.includes(value) || x.to.includes(value)).slice(0, 40); sources = (rows as AssistantBook['relations']).map((x) => `${x.from}—${x.label}—${x.to}`);
    } else if (name === 'search_knowledge') {
      const matches = data.knowledge.map((x) => ({ x, score: score(x.title + ' ' + x.tags.join(' ') + ' ' + x.body, query) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, numberArg(args, 'limit', 5, 1, 20));
      rows = matches.map(({ x }) => ({ title: x.title, excerpt: snippet(x.body, query, 600) })); sources = matches.map(({ x }) => `设定：${x.title}`);
    } else if (name === 'get_timeline') {
      const from = textArg(args, 'from'); const to = textArg(args, 'to'); const chapter = numberArg(args, 'chapter', 0, 1, 100000);
      const isoRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
      const matches = data.timeline.filter((x) => (!chapter || x.chapter === chapter) && (isoRange ? x.time >= from && x.time.slice(0, 10) <= to : (!from && !to) || Boolean(from && x.time.includes(from)) || Boolean(to && x.time.includes(to)))).sort((a, b) => a.chapter - b.chapter).slice(0, numberArg(args, 'limit', 10, 1, 30));
      rows = matches.map((x) => ({ ...x, detail: clip(x.detail, 450) })); sources = matches.map((x) => `时间线：第 ${x.chapter} 章 ${x.title}`);
    } else if (name === 'get_outline') {
      const offset = numberArg(args, 'offset', 0, 0, 100000);
      rows = data.outline.slice(offset, offset + 8).map((x) => ({ ...x, summary: clip(x.summary, 650) }));
      sources = rows.length ? ['全书大纲'] : []; detail = { items: rows, chapterCount: data.chapters.length, nextOffset: offset + rows.length, total: data.outline.length };
    }
    const found = sources.length > 0;
    const payload = { found, data: detail ?? rows, note: found ? '仅为当前作者资料；片段不代表全文。请引用来源。' : '本次检索未找到匹配项，不代表全书不存在；可换关键词继续查证。' };
    const available = Math.max(0, Math.min(4000, budget));
    const full = JSON.stringify(payload);
    // 保留有效 JSON，超预算封装为明确标记的片段；来源只对应实际输出的结果。
    const overhead = JSON.stringify({ truncated: true, excerpt: '' }).length;
    let text = full;
    if (text.length > available) {
      let excerpt = full.slice(0, Math.max(0, available - overhead - 100));
      while (JSON.stringify({ truncated: true, excerpt }).length > available && excerpt.length) excerpt = excerpt.slice(0, Math.floor(excerpt.length * .8));
      text = available >= overhead ? JSON.stringify({ truncated: true, excerpt }) : '';
      sources = sources.filter((source) => { const title = source.replace(/^.*?《|》$/g, '').replace(/^设定：|^人物：/, ''); return excerpt.includes(title); });
    }
    return { text, sources: text ? sources.length ? sources : [`${TOOL_LABELS[name]}：${found ? '结果已截断' : '本次未命中'}`] : [] };
  } catch (error) { return { text: clip(JSON.stringify({ error: error instanceof Error ? error.message : '查书失败，请换一种查询方式' }), Math.max(0, budget)), sources: [] }; }
}
