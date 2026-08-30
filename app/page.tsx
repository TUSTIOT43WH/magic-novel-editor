'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type View = 'books' | 'editor' | 'outline' | 'knowledge' | 'skills' | 'timeline' | 'relations' | 'settings';
type Chapter = { id: number; no: number; title: string; status: '已入库' | '草稿' | '尚未开始'; time: string; location: string; content: string; words: number; summary?: string; summaryVersion?: number; summaryLocked?: boolean };
type WorkspaceData = { book: { title: string; genre: string; systemPrompt: string; maxWords: number }; chapters: Chapter[]; outline: { title: string; summary: string; state: string }[]; knowledge: { type: string; title: string; body: string; tags: string[] }[]; skills: { title: string; description: string; enabled: boolean }[]; characters: { name: string; role: string; state: string; location: string; color?: string; marker?: string }[]; relations: { from: string; to: string; label: string; score: number }[]; timeline: { time: string; title: string; detail: string; chapter: number }[] };
type BookRecord = { id: string; data: WorkspaceData };
type LibraryPayload = { libraryVersion: 1; activeBookId: string; books: BookRecord[] };
type ModelConnection = { apiUrl: string; apiKey: string; model: string; enabled: boolean };
type RecallItem = { id: string; source: 'knowledge' | 'character' | 'relation' | 'timeline' | 'chapter'; type: string; title: string; body: string; tags: string[]; score: number; reason: string; recommended: boolean };
type DialogField = { key: string; label: string; value: string; placeholder?: string; multiline?: boolean };
type DialogConfig = { title: string; description?: string; confirmText?: string; fields: DialogField[]; onSubmit: (values: Record<string, string>) => void };

const MODEL_CONNECTION_STORAGE_KEY = 'mojing-local-model-connection-v1';

function isLocalModelHost() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

function normalizeModelApiUrl(value: string) {
  const url = new URL(value.trim());
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) url.pathname = '/v1/chat/completions';
  else if (path.endsWith('/v1')) url.pathname = `${path}/chat/completions`;
  return url.toString();
}

const seed: WorkspaceData = blankBook('未命名作品', '未分类');


function blankBook(title: string, genre: string): WorkspaceData {
  return {
    book: { title, genre, maxWords: 5000000, systemPrompt: '保持人物与世界设定一致，以清晰、有画面感的中文小说语言写作。' },
    chapters: [{ id: 1, no: 1, title: '第一章', status: '尚未开始', time: '2026-01-01 09:00', location: '待设定', content: '', words: 0 }],
    outline: [], knowledge: [], skills: [], characters: [], relations: [], timeline: [],
  };
}

const viewMeta: Record<View, [string, string]> = { books: ['我的书库', '创建、管理并随时切换不同作品'], editor: ['写作台', '章节正文与 Vibe 续写'], outline: ['全书大纲', '卷、主线与章节节拍'], knowledge: ['知识库', '世界观、地点、规则与伏笔'], skills: ['写作 Skills', '组合不同类型小说的写作方法'], timeline: ['故事时间线', '所有章节都可按时间点溯源'], relations: ['人物状态与关系', '入库后自动更新的故事状态'], settings: ['作品设置', '系统提示词与长篇上下文策略'] };

const synonymGroups = [
  ['抵达', '进入', '到达', '前往'], ['异空间', '异常空间', '陌生空间', '迷宫空间'],
  ['实体', '怪物', '异常生物', '敌人'], ['逛街', '购物', '商场', '购物中心'],
  ['逃跑', '逃离', '追逐', '脱险'], ['恋人', '情侣', '爱人', '爱情'],
  ['死敌', '仇敌', '敌对', '宿敌'], ['调查', '寻找', '追查', '查明'],
];

function vectorTerms(text: string) {
  const normalized = text.toLowerCase();
  const terms: string[] = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  const expanded: string[] = [];
  terms.forEach((term) => {
    expanded.push(term);
    if (/^[\u4e00-\u9fff]+$/.test(term)) {
      for (let size = 2; size <= Math.min(4, term.length); size += 1) {
        for (let i = 0; i <= term.length - size; i += 1) expanded.push(term.slice(i, i + size));
      }
    }
    synonymGroups.forEach((group) => { if (group.some((word) => term.includes(word))) expanded.push(...group); });
  });
  return expanded;
}

function termVector(text: string) {
  return vectorTerms(text).reduce((map, term) => map.set(term, (map.get(term) || 0) + 1), new Map<string, number>());
}

function cosineTextSimilarity(a: string, b: string) {
  const left = termVector(a); const right = termVector(b); let dot = 0; let leftNorm = 0; let rightNorm = 0;
  left.forEach((value, key) => { dot += value * (right.get(key) || 0); leftNorm += value * value; });
  right.forEach((value) => { rightNorm += value * value; });
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

function lexicalScore(query: string, title: string, body: string, tags: string[]) {
  const terms = [...new Set(vectorTerms(query))]; const lowerTitle = title.toLowerCase(); const lowerBody = body.toLowerCase(); const lowerTags = tags.join(' ').toLowerCase();
  return terms.reduce((score, term) => score + (lowerTitle.includes(term) ? 5 : 0) + (lowerTags.includes(term) ? 3 : 0) + (lowerBody.includes(term) ? 1 : 0), 0);
}

function summarizeChapterText(chapter: Chapter, characters: WorkspaceData['characters'] = [], relations: WorkspaceData['relations'] = [], knowledge: WorkspaceData['knowledge'] = []) {
  const normalized = chapter.content.replace(/\s+/g, ' ').trim();
  const sentences = (normalized.match(/[^。！？!?]+[。！？!?]?/g) || []).map((item) => item.trim()).filter(Boolean);
  if (!sentences.length) return '本章尚无可总结的正文。';

  const unique = (items: string[]) => [...new Set(items.filter(Boolean))];
  const explicitTimes = unique([...normalized.matchAll(/(?:\d{2,4}年)?\d{1,2}月\d{1,2}日(?:[^。！？]{0,12}(?:凌晨|清晨|上午|中午|下午|傍晚|晚上|\d{1,2}[时点](?:\d{1,2}分)?))?/g)].map((item) => item[0]));
  const timeCues = unique([...normalized.matchAll(/天光刚亮|天刚亮|清晨|早晨|晌午头|晌午后|晌午|当夜|半夜|第二天|次日|翌日|天不亮|黄昏|傍晚|夜里/g)].map((item) => item[0]));
  const time = explicitTimes.length
    ? explicitTimes.join('、')
    : timeCues.length > 1
      ? `未注明具体日期；情节从${timeCues[0]}推进至${timeCues[timeCues.length - 1]}`
      : timeCues.length === 1 ? `未注明具体日期；本章发生于${timeCues[0]}` : '未注明';

  const places = unique([chapter.location, ...knowledge.filter((item) => item.type.includes('地点') && normalized.includes(item.title)).map((item) => item.title)]).filter((item) => item && !/(?:待设定|待确认|未知)/.test(item)).slice(0, 5);
  const mentionedCharacters = characters.filter((item) => item.name && normalized.includes(item.name) && !/^本章(?:首次登场|同行)/.test(item.state)).slice(0, 6);
  const detectedNames = mentionedCharacters.map((item) => item.name);
  const roleText = mentionedCharacters.length ? mentionedCharacters.map((item) => `${item.name}（${item.role}）`).join('、') : '请作者在人物档案中补充本章角色';
  const relationTexts = relations.filter((item) => detectedNames.includes(item.from) && detectedNames.includes(item.to)).slice(0, 6).map((item) => `${item.from}与${item.to}：${item.label}`);

  const scoredEvents = sentences.map((sentence, index) => {
    let score = 0;
    if (/(?:出发|前往|赶路|投宿|到达|进入|离开|翻过去|回家|目的地|还有[零一二三四五六七八九十百\d]+里)/.test(sentence)) score += 5;
    if (/(?:发现|得知|听说|决定|异象|红光|异常|袭击|死亡|真相|突然|出现)/.test(sentence)) score += 3;
    if (detectedNames.some((name) => sentence.includes(name))) score += 1;
    return { sentence, index, score };
  }).filter((item) => item.score > 0);
  const events = scoredEvents.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 5).sort((a, b) => a.index - b.index).map((item) => item.sentence.slice(0, 80));
  const safeEvents = events.length ? events : [sentences[0], sentences[sentences.length - 1]].filter(Boolean).map((item) => item.slice(0, 80));
  const endStates = mentionedCharacters.map((item) => `${item.name}：${item.state}；位置：${item.location}`).slice(0, 6);
  const unresolved = sentences.filter((item) => /(尚未|仍未|秘密|隐瞒|失踪|异常|谜|等待|究竟|为何|为什么)/.test(item)).slice(-2).map((item) => item.slice(0, 70));

  return [`时间：${time}`, `地点：${places.length ? places.join(' → ') : '未注明'}`, `主要角色：${roleText}`, `人物关系：${unique(relationTexts).join('；') || '作者尚未建立本章人物关系'}`, `关键事件：\n${safeEvents.map((item, index) => `${index + 1}. ${item}`).join('\n')}`, `章末状态：\n${endStates.length ? endStates.map((item) => `- ${item}`).join('\n') : '- 请作者在人物档案中补充'}`, `未解决事项：\n${unresolved.length ? unresolved.map((item) => `- ${item}`).join('\n') : '- 无明确记录'}`].join('\n').slice(0, 900);
}

function buildRecall(data: WorkspaceData, vibe: string, currentChapterNo: number): RecallItem[] {
  const knowledge = data.knowledge.map((item, index) => {
    const lexical = lexicalScore(vibe, item.title, item.body, item.tags);
    const vector = cosineTextSimilarity(vibe, `${item.title} ${item.tags.join(' ')} ${item.body}`);
    const score = Math.min(99, Math.round(vector * 65 + Math.min(34, lexical)));
    return { id: `knowledge-${index}`, source: 'knowledge' as const, type: item.type, title: item.title, body: item.body, tags: item.tags, score, reason: vector > 0.16 ? '文本＋向量' : score > 0 ? '关键词匹配' : '未自动命中', recommended: score >= 8 };
  }).sort((a, b) => b.score - a.score);
  let autoKnowledgeCount = 0;
  knowledge.forEach((item) => {
    item.recommended = item.score >= 8 && autoKnowledgeCount < 4;
    if (item.recommended) autoKnowledgeCount += 1;
  });
  const mentioned = data.characters.filter((item) => vibe.includes(item.name) || vibe.includes(item.role));
  const characters: RecallItem[] = mentioned.map((item, index) => ({ id: `character-${index}-${item.name}`, source: 'character', type: '人物状态', title: `${item.name} · ${item.role}`, body: `当前状态：${item.state}；当前位置：${item.location}；登场标记：${item.marker === 'retired' ? '不再登场' : '仍在故事中'}`, tags: ['强制召回'], score: 100, reason: '人物命中', recommended: true }));
  const names = new Set(mentioned.map((item) => item.name));
  const relations: RecallItem[] = data.relations.filter((item) => names.has(item.from) || names.has(item.to)).map((item, index) => ({ id: `relation-${index}-${item.from}-${item.to}`, source: 'relation', type: '人物关系', title: `${item.from} ↔ ${item.to}`, body: `关系：${item.label}；关系强度：${item.score}/100`, tags: ['强制召回'], score: 96, reason: '关系关联', recommended: true }));
  const chapters: RecallItem[] = data.chapters.filter((item) => item.no < currentChapterNo && item.status === '已入库' && item.content.trim()).sort((a, b) => b.no - a.no).slice(0, 3).map((item, index) => ({ id: `chapter-${item.id}`, source: 'chapter', type: index === 0 ? '上一章正文摘要' : '前文章节摘要', title: `第 ${item.no} 章 · ${item.title}`, body: `${item.summaryVersion === 2 && item.summary ? item.summary : summarizeChapterText(item, data.characters, data.relations, data.knowledge)}\n章节结尾原文：${item.content.replace(/\s+/g, ' ').slice(-600)}`, tags: ['强制召回', '正文摘要', '连续性'], score: index === 0 ? 99 : 95 - index, reason: index === 0 ? '上章连续性' : '前文连续性', recommended: true }));
  const timeline: RecallItem[] = [...data.timeline].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 2).map((item) => ({ id: `timeline-${item.chapter}-${item.time}`, source: 'timeline', type: '近期时间线', title: `第 ${item.chapter} 章 · ${item.title}`, body: `${item.time}：${item.detail}`, tags: ['强制召回'], score: 92, reason: '近期剧情', recommended: true }));
  return [...chapters, ...characters, ...relations, ...timeline, ...knowledge];
}

function recallContext(items: RecallItem[]) {
  return items.map((item) => `【${item.type}｜${item.reason}】${item.title}：${item.body}`).join('\n');
}

export default function Home() {
  const [data, setData] = useState(seed); const [books, setBooks] = useState<BookRecord[]>([{ id: 'book-demo', data: seed }]); const [activeBookId, setActiveBookId] = useState('book-demo'); const [view, setView] = useState<View>('books'); const [chapterId, setChapterId] = useState(2); const [ai, setAi] = useState(true); const [vibe, setVibe] = useState(''); const [positive, setPositive] = useState(''); const [negative, setNegative] = useState(''); const [showPrompts, setShowPrompts] = useState(false); const [generating, setGenerating] = useState(false); const [pending, setPending] = useState(false); const [provider, setProvider] = useState(''); const [saved, setSaved] = useState('已保存'); const [toast, setToast] = useState(''); const hydrated = useRef(false);
  const [modelConnection, setModelConnection] = useState<ModelConnection>({ apiUrl: '', apiKey: '', model: '', enabled: false });
  const [recallOverrides, setRecallOverrides] = useState<Record<string, boolean>>({});
  const [homeDialog, setHomeDialog] = useState<DialogConfig | null>(null);
  const manuscriptRef = useRef<HTMLTextAreaElement | null>(null);
  const chapter = data.chapters.find((item) => item.id === chapterId) || data.chapters[0];
  useEffect(() => { fetch('/api/workspace').then((r) => r.json()).then((result) => {
    const payload = result.payload as LibraryPayload | WorkspaceData | null;
    if (payload && 'libraryVersion' in payload && payload.books.length) {
      const active = payload.books.find((item) => item.id === payload.activeBookId) || payload.books[0];
      setBooks(payload.books); setActiveBookId(active.id); setData(active.data); setChapterId(active.data.chapters[0]?.id || 0);
    } else if (payload && 'book' in payload && Array.isArray(payload.chapters)) {
      setData(payload); setBooks([{ id: 'book-demo', data: payload }]); setActiveBookId('book-demo'); setChapterId(payload.chapters[0]?.id || 0);
    }
    hydrated.current = true;
  }).catch(() => { hydrated.current = true; }); }, []);
  useEffect(() => {
    if (!isLocalModelHost()) return;
    try {
      const stored = window.localStorage.getItem(MODEL_CONNECTION_STORAGE_KEY);
      if (!stored) return;
      const connection = JSON.parse(stored) as Partial<ModelConnection>;
      if (connection.apiUrl && connection.apiKey && connection.model) {
        setModelConnection({ apiUrl: connection.apiUrl, apiKey: connection.apiKey, model: connection.model, enabled: true });
      }
    } catch {
      window.localStorage.removeItem(MODEL_CONNECTION_STORAGE_KEY);
    }
  }, []);
  useEffect(() => { if (!hydrated.current) return; setSaved('保存中…'); const timer = window.setTimeout(() => {
    const payload: LibraryPayload = { libraryVersion: 1, activeBookId, books: books.map((item) => item.id === activeBookId ? { ...item, data } : item) };
    fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(() => setSaved('已保存')).catch(() => setSaved('离线草稿'));
  }, 650); return () => window.clearTimeout(timer); }, [data, books, activeBookId]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 2400); return () => clearTimeout(timer); }, [toast]);
  const recallCandidates = useMemo(() => buildRecall(data, vibe, chapter.no), [data, vibe, chapter.no]);
  const retrieved = useMemo(() => recallCandidates.filter((item) => recallOverrides[item.id] ?? item.recommended).slice(0, 12), [recallCandidates, recallOverrides]);
  useEffect(() => { setRecallOverrides({}); }, [chapterId, activeBookId]);
  function toggleRecall(item: RecallItem) {
    const selected = recallOverrides[item.id] ?? item.recommended;
    if (!selected && retrieved.length >= 12) { setToast('单次最多选择 12 条上下文'); return; }
    setRecallOverrides((old) => ({ ...old, [item.id]: !selected }));
  }
  const updateChapter = (patch: Partial<Chapter>) => setData((old) => ({ ...old, chapters: old.chapters.map((item) => item.id === chapter.id ? { ...item, ...patch } : item) }));
  async function generate() {
    if (!ai) { setToast('AI 已关闭，可以直接手写本章'); return; }
    setGenerating(true); setPending(false);
    try {
      const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vibe, positive, negative, systemPrompt: data.book.systemPrompt, context: recallContext(retrieved), connection: modelConnection.enabled ? modelConnection : undefined }) });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        const result = contentType.includes('application/json') ? await response.json() : { error: await response.text() };
        const detail = typeof result.detail === 'string' && result.detail ? `：${result.detail}` : '';
        throw new Error(`${result.error || '生成失败'}${detail}`);
      }
      const original = chapter.content.trim();
      const prefix = original ? `${original}\n\n` : '';
      let generated = '';
      const writeCharacters = async (fragment: string) => {
        for (const character of Array.from(fragment)) {
          generated += character;
          const next = prefix + generated;
          updateChapter({ content: next, words: next.replace(/\s/g, '').length, status: '草稿' });
          await new Promise<void>((resolve) => window.setTimeout(resolve, 8));
          if (manuscriptRef.current) manuscriptRef.current.scrollTop = manuscriptRef.current.scrollHeight;
        }
      };
      if (contentType.includes('application/json')) {
        const result = await response.json();
        if (!result.content) throw new Error('模型没有返回正文');
        await writeCharacters(result.content);
        setProvider(result.provider === 'demo' ? '演示引擎' : result.provider);
      } else {
        if (!response.body) throw new Error('浏览器无法读取模型的流式响应');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeCharacters(decoder.decode(value, { stream: true }));
        }
        await writeCharacters(decoder.decode());
        if (!generated) throw new Error('模型完成了请求，但没有返回正文');
        setProvider(response.headers.get('x-model-provider') || modelConnection.model || '模型服务');
      }
      setPending(true);
    } catch (error) {
      setToast(error instanceof Error ? error.message : '生成失败，请检查模型服务配置');
    } finally {
      setGenerating(false);
    }
  }
  function ingest() { setData((old) => { const storedChapter = old.chapters.find((item) => item.id === chapter.id) || chapter; const generatedSummary = summarizeChapterText(storedChapter, old.characters, old.relations, old.knowledge); const summary = storedChapter.summaryLocked && storedChapter.summary ? storedChapter.summary : generatedSummary; const timelineEvent = { time: chapter.time, title: chapter.title, detail: summary, chapter: chapter.no }; return { ...old, chapters: old.chapters.map((item) => item.id === chapter.id ? { ...item, status: '已入库', words: item.content.replace(/\s/g, '').length, summary, summaryVersion: 2 } : item), timeline: old.timeline.some((item) => item.chapter === chapter.no) ? old.timeline.map((item) => item.chapter === chapter.no ? timelineEvent : item) : [...old.timeline, timelineEvent] }; }); setPending(false); setToast(chapter.summaryLocked ? '已入库：保留作者锁定的召回总结' : '已入库：已生成白名单召回总结，可在右侧编辑并锁定'); }
  function addChapter() { const no = data.chapters.length + 1; const next: Chapter = { id: Date.now(), no, title: `第 ${no} 章`, status: '尚未开始', time: chapter.time, location: chapter.location, content: '', words: 0 }; setData((old) => ({ ...old, chapters: [...old.chapters, next] })); setChapterId(next.id); setVibe(''); setPositive(''); setNegative(''); setShowPrompts(false); setView('editor'); setPending(false); }
  function deleteChapter(id: number) {
    if (data.chapters.length === 1) { setToast('一本书至少需要保留一个章节'); return; }
    const target = data.chapters.find((item) => item.id === id);
    if (!target || !window.confirm(`确定删除第 ${target.no} 章《${target.title}》吗？删除后无法恢复。`)) return;
    const index = data.chapters.findIndex((item) => item.id === id);
    const remaining = data.chapters.filter((item) => item.id !== id).map((item, i) => ({ ...item, no: i + 1 }));
    if (chapterId === id) setChapterId(remaining[Math.min(index, remaining.length - 1)].id);
    setData((old) => ({ ...old, chapters: remaining, timeline: old.timeline.filter((item) => item.chapter !== target.no).map((item) => ({ ...item, chapter: item.chapter > target.no ? item.chapter - 1 : item.chapter })) }));
    setPending(false); setToast(`已删除《${target.title}》`);
  }

  function syncedBooks() { return books.map((item) => item.id === activeBookId ? { ...item, data } : item); }
  function switchBook(id: string) {
    if (id === activeBookId) { setView('editor'); return; }
    const current = syncedBooks(); const target = current.find((item) => item.id === id); if (!target) return;
    setBooks(current); setActiveBookId(id); setData(target.data); setChapterId(target.data.chapters[0]?.id || 0); setVibe(''); setPositive(''); setNegative(''); setShowPrompts(false); setPending(false); setView('editor'); setToast('已切换到《' + target.data.book.title + '》');
  }
  function createBook() {
    setHomeDialog({ title: '创建新书', description: '为新作品填写名称和类型。', confirmText: '创建并开始写作', fields: [{ key: 'title', label: '书名', value: '', placeholder: '例如：我的第一本小说' }, { key: 'genre', label: '小说类型', value: '未分类', placeholder: '例如：悬疑、玄幻、言情' }], onSubmit: (values) => {
      const title = values.title.trim(); if (!title) { setToast('请填写书名'); return; }
      const next = blankBook(title, values.genre.trim() || '未分类'); const id = 'book-' + Date.now();
      setBooks([...syncedBooks(), { id, data: next }]); setActiveBookId(id); setData(next); setChapterId(next.chapters[0].id); setVibe(''); setPositive(''); setNegative(''); setShowPrompts(false); setView('editor'); setHomeDialog(null); setToast('《' + title + '》已创建');
    } });
  }
  function deleteBook(id: string) {
    if (books.length === 1) { setToast('书库中至少需要保留一本书'); return; }
    const current = syncedBooks(); const target = current.find((item) => item.id === id); if (!target || !window.confirm('确定删除《' + target.data.book.title + '》及其全部内容吗？')) return;
    const remaining = current.filter((item) => item.id !== id); setBooks(remaining);
    if (id === activeBookId) { const next = remaining[0]; setActiveBookId(next.id); setData(next.data); setChapterId(next.data.chapters[0]?.id || 0); }
    setToast('书籍已删除');
  }
  return <main className="studio-shell">{toast && <div className="toast">✓ {toast}</div>}<aside className="rail"><button className="brand-mark brand-button" title="我的书库" onClick={() => setView('books')}>墨</button><NavIcon label="书库" icon="书" active={view === 'books'} onClick={() => setView('books')} /><NavIcon label="写作台" icon="✦" active={view === 'editor'} onClick={() => setView('editor')} /><NavIcon label="大纲" icon="⌘" active={view === 'outline'} onClick={() => setView('outline')} /><NavIcon label="知识库" icon="◇" active={view === 'knowledge'} onClick={() => setView('knowledge')} /><NavIcon label="人物关系" icon="◎" active={view === 'relations'} onClick={() => setView('relations')} /><NavIcon label="时间线" icon="◷" active={view === 'timeline'} onClick={() => setView('timeline')} /><NavIcon label="Skills" icon="S" active={view === 'skills'} onClick={() => setView('skills')} /><div className="rail-spacer" /><NavIcon label="设置" icon="⚙" active={view === 'settings'} onClick={() => setView('settings')} /></aside>
    <aside className="chapter-pane"><div className="book-row book-switcher"><div><span className="eyebrow">当前作品</span><strong>{data.book.title}</strong></div><select aria-label="切换书籍" value={activeBookId} onChange={(e) => switchBook(e.target.value)}>{books.map((item) => <option key={item.id} value={item.id}>{item.data.book.title}</option>)}</select></div><button className="new-chapter" onClick={addChapter}>＋ 新建章节</button><div className="pane-label"><span>全部章节</span><span>{data.chapters.length}</span></div><nav className="chapter-list">{data.chapters.map((item) => <div key={item.id} className={`chapter-item ${chapterId === item.id ? 'active' : ''} ${item.status === '已入库' ? 'done' : ''}`}><button className="chapter-select" onClick={() => { setChapterId(item.id); setView('editor'); setPending(false); }}><span className="chapter-no">{String(item.no).padStart(2, '0')}</span><span><b>{item.title}</b><small>{item.words ? `${item.words.toLocaleString()} 字 · ` : ''}{item.status}</small></span></button><button className="delete-chapter" title="删除章节" aria-label={`删除《${item.title}》`} onClick={() => deleteChapter(item.id)}>×</button></div>)}</nav><div className="context-meter"><div className="meter-head"><span>长篇上下文</span><b>{data.chapters.reduce((a, c) => a + c.words, 0).toLocaleString()} / 500 万字</b></div><div className="meter"><i style={{ width: `${Math.max(2, data.chapters.reduce((a, c) => a + c.words, 0) / 50000)}%` }} /></div><small>摘要、实体与时间线持续索引中</small></div></aside>
    <section className="workspace"><header className="topbar"><div><span className="page-title">{viewMeta[view][0]}</span><span className="page-subtitle">{viewMeta[view][1]}</span></div><div className="top-actions"><span className="saved">● {saved}</span>{view === 'editor' && <><button className="secondary" onClick={() => setView('timeline')}>时间线</button><button className="primary" onClick={ingest}>入库并更新</button></>}</div></header>{view === 'editor' ? <><div className="editor-wrap"><article className="manuscript"><div className="chapter-kicker">CHAPTER {String(chapter.no).padStart(2, '0')} · {chapter.time} · {chapter.location}</div><input className="title-input" value={chapter.title} onChange={(e) => updateChapter({ title: e.target.value })} /><textarea ref={manuscriptRef} className="manuscript-input" value={chapter.content} placeholder="从这里开始写作……" onChange={(e) => updateChapter({ content: e.target.value, words: e.target.value.replace(/\s/g, '').length, status: '草稿' })} /></article></div>{pending && <div className="review-strip"><div><b>AI 草稿已生成</b><span>由 {provider} 生成 · 已写入编辑区，可继续修改</span></div><button className="secondary" onClick={() => setPending(false)}>继续修改</button><button className="primary" onClick={ingest}>直接入库</button></div>}<section className="vibe-dock"><div className="dock-head"><div><span className="spark">✦</span><strong>Vibe 续写</strong><small>{generating ? '模型正在逐字写入正文' : `已选择 ${retrieved.length} 条上下文`}</small></div><label className="ai-toggle"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /><span /> AI 助写</label></div><textarea aria-label="剧情意图" value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="输入本章希望发生的剧情……" />{showPrompts && <div className="prompt-grid"><label>正向提示<input value={positive} onChange={(e) => setPositive(e.target.value)} /></label><label>反向提示<input value={negative} onChange={(e) => setNegative(e.target.value)} /></label></div>}<div className="chips"><button onClick={() => setShowPrompts(!showPrompts)}>{showPrompts ? '收起提示词' : '＋ 正反提示词'}</button><span title={retrieved.map((x) => `${x.title}（${x.reason}）`).join('、')}>召回：{retrieved.slice(0, 4).map((x) => x.title).join('、') || '尚未选择'}{retrieved.length > 4 ? ` 等 ${retrieved.length} 条` : ''}</span><button className="generate" disabled={generating} onClick={generate}>{generating ? '正在逐字生成…' : ai ? '生成草稿' : '关闭 AI，手动写作'} <kbd>⌘ ↵</kbd></button></div></section></> : view === 'books' ? <BooksHome books={books.map((item) => item.id === activeBookId ? { ...item, data } : item)} activeBookId={activeBookId} onOpen={switchBook} onCreate={createBook} onDelete={deleteBook} /> : <Panel view={view} data={data} setData={setData} setToast={setToast} modelConnection={modelConnection} setModelConnection={setModelConnection} />}</section>{view === 'editor' && <Inspector chapter={chapter} candidates={recallCandidates} selectedIds={new Set(retrieved.map((item) => item.id))} onToggleRecall={toggleRecall} data={data} setData={setData} setToast={setToast} />}{homeDialog && <EditDialog config={homeDialog} onClose={() => setHomeDialog(null)} />}</main>;
}


function BooksHome({ books, activeBookId, onOpen, onCreate, onDelete }: { books: BookRecord[]; activeBookId: string; onOpen: (id: string) => void; onCreate: () => void; onDelete: (id: string) => void }) {
  return <div className="content-page books-home">
    <div className="library-hero"><div><span>MOJING LIBRARY</span><h1>我的书库</h1><p>每本书都拥有独立的章节、世界观、人物关系、Skills 与写作风格。</p></div><button className="primary" onClick={onCreate}>＋ 创建新书</button></div>
    <div className="book-grid">{books.map((item) => <article className={item.id === activeBookId ? 'active' : ''} key={item.id}>
      <button className="book-cover" onClick={() => onOpen(item.id)}><span>{item.data.book.genre}</span><b>{item.data.book.title}</b><small>{item.data.chapters.length} 章 · {item.data.chapters.reduce((sum, chapter) => sum + chapter.words, 0).toLocaleString()} 字</small></button>
      <footer><button onClick={() => onOpen(item.id)}>{item.id === activeBookId ? '继续写作' : '打开作品'}</button><button className="danger" onClick={() => onDelete(item.id)}>删除</button></footer>
    </article>)}</div>
  </div>;
}

function NavIcon({ label, icon, active, onClick }: { label: string; icon: string; active: boolean; onClick: () => void }) { return <button title={label} aria-label={label} className={`rail-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}</button>; }
function Inspector({ chapter, candidates, selectedIds, onToggleRecall, data, setData, setToast }: { chapter: Chapter; candidates: RecallItem[]; selectedIds: Set<string>; onToggleRecall: (item: RecallItem) => void; data: WorkspaceData; setData: React.Dispatch<React.SetStateAction<WorkspaceData>>; setToast: (s: string) => void }) {
  const [tab, setTab] = useState<'context' | 'characters' | 'knowledge'>('context');
  const [dialog, setDialog] = useState<DialogConfig | null>(null);
  const primaryRelation = data.relations[0];
  function editTime() {
    setDialog({ title: '编辑章节时间锚点', description: '修改后，本章入库事件将使用新的时间和地点。', confirmText: '保存修改', fields: [{ key: 'time', label: '章节时间', value: chapter.time, placeholder: 'YYYY-MM-DD HH:mm' }, { key: 'location', label: '章节地点', value: chapter.location }], onSubmit: (values) => {
      if (!values.time.trim()) { setToast('请填写章节时间'); return; }
      setData((old) => ({ ...old, chapters: old.chapters.map((item) => item.id === chapter.id ? { ...item, time: values.time.trim(), location: values.location.trim() } : item) }));
      setDialog(null); setToast('时间锚点已更新');
    } });
  }
  const visibleSummary = chapter.content.trim() ? (chapter.summaryVersion === 2 && chapter.summary ? chapter.summary : summarizeChapterText(chapter, data.characters, data.relations, data.knowledge)) : '正文尚未生成，入库后会建立召回总结。';
  function editSummary() {
    setDialog({ title: `编辑第 ${chapter.no} 章召回总结`, description: '作者修改后的版本会直接用于后续章节召回，并自动锁定以防入库覆盖。', confirmText: '保存并锁定', fields: [{ key: 'summary', label: '章节召回总结', value: visibleSummary, multiline: true }], onSubmit: (values) => {
      if (!values.summary.trim()) { setToast('召回总结不能为空'); return; }
      setData((old) => ({ ...old, chapters: old.chapters.map((item) => item.id === chapter.id ? { ...item, summary: values.summary.trim().slice(0, 1600), summaryVersion: 2, summaryLocked: true } : item) }));
      setDialog(null); setToast('召回总结已保存并锁定');
    } });
  }
  function rebuildSummary() {
    const summary = summarizeChapterText(chapter, data.characters, data.relations, data.knowledge);
    setData((old) => ({ ...old, chapters: old.chapters.map((item) => item.id === chapter.id ? { ...item, summary, summaryVersion: 2, summaryLocked: false } : item) }));
    setToast('已按当前人物档案和关系重新生成总结');
  }
  return <aside className="inspector">
    <div className="inspector-tabs">
      <button className={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}>上下文</button>
      <button className={tab === 'characters' ? 'active' : ''} onClick={() => setTab('characters')}>人物</button>
      <button className={tab === 'knowledge' ? 'active' : ''} onClick={() => setTab('knowledge')}>设定</button>
    </div>
    {tab === 'context' && <>
      <section className="inspector-section"><div className="section-title"><span>本章时间锚点</span><button onClick={editTime}>编辑</button></div><div className="time-card"><b>{chapter.time.slice(0, 10).replaceAll('-', ' · ')}</b><span>{chapter.time.slice(11)} · {chapter.location}</span><small>所有事件将以此时间点入库</small></div></section>
      <section className="inspector-section chapter-summary"><div className="section-title"><span>本章召回总结 · {chapter.summaryLocked ? '已锁定' : '可更新'}</span><button onClick={editSummary}>编辑</button></div><pre>{visibleSummary}</pre><div className="summary-actions"><button onClick={rebuildSummary}>按档案重建</button><button onClick={() => { setData((old) => ({ ...old, chapters: old.chapters.map((item) => item.id === chapter.id ? { ...item, summaryLocked: !item.summaryLocked, summary: item.summary || visibleSummary, summaryVersion: 2 } : item) })); setToast(chapter.summaryLocked ? '总结已解锁，下次入库可以更新' : '总结已锁定，入库不会覆盖'); }}>{chapter.summaryLocked ? '解除锁定' : '锁定当前版本'}</button></div></section>
      <section className="inspector-section"><div className="section-title"><span>召回候选 · 已选 {selectedIds.size}</span><button onClick={() => setToast('可按匹配度手动加入或移除')}>使用说明</button></div><div className="recall-options">{candidates.map((item) => { const selected = selectedIds.has(item.id); return <article className={`recall-option ${selected ? 'selected' : ''}`} key={item.id}><header><span>{item.type} · {item.reason}</span><strong>{item.score}%</strong></header><b>{item.title}</b><p>{item.body}</p><button onClick={() => onToggleRecall(item)}>{selected ? '移除本次召回' : '＋ 加入本次召回'}</button></article>; })}</div></section>
      <section className="inspector-section relation"><div className="section-title"><span>当前人物关系</span><button onClick={() => setToast(primaryRelation ? '已读取作者维护的人物关系' : '新书尚未建立人物关系')}>刷新</button></div>{primaryRelation ? <><div><span className="avatar">{primaryRelation.from.slice(0, 1)}</span><i>关系 {primaryRelation.score}</i><span className="avatar coral">{primaryRelation.to.slice(0, 1)}</span></div><p>{primaryRelation.from} · {primaryRelation.label} · {primaryRelation.to}</p></> : <div className="empty-recall">尚未建立人物关系。请前往人物关系页面手动添加人物和关系。</div>}</section>
    </>}
    {tab === 'characters' && <section className="inspector-section inspector-list"><div className="section-title"><span>人物档案</span><button onClick={() => setToast('人物状态由作者手动维护，入库不会自动改写')}>状态来源</button></div>{data.characters.map((item, index) => <button className="inspector-person" key={item.name} onClick={() => setDialog({ title: `修改 ${item.name} 的状态`, description: '该状态由作者维护，并会参与后续章节召回。', confirmText: '保存状态', fields: [{ key: 'state', label: '人物状态', value: item.state, multiline: true }, { key: 'location', label: '当前位置', value: item.location }], onSubmit: (values) => { setData((old) => ({ ...old, characters: old.characters.map((c, i) => i === index ? { ...c, state: values.state.trim(), location: values.location.trim() } : c) })); setDialog(null); setToast('人物状态已更新'); } })}><span className="avatar">{item.name[0]}</span><span><b>{item.name} · {item.role}</b><small>{item.state}</small><em>{item.location}</em></span></button>)}</section>}
    {tab === 'knowledge' && <section className="inspector-section"><div className="section-title"><span>全部设定</span><button onClick={() => setToast(`共 ${data.knowledge.length} 条设定`)}>{data.knowledge.length} 条</button></div>{data.knowledge.map((item, index) => <div className="setting-item" key={item.title + index}><button className="setting-row" onClick={() => window.alert(`${item.title}\n\n${item.body}`)}><span>{item.type}</span><b>{item.title}</b><small>{item.tags.join(' · ')}</small></button><button className="setting-delete" title="删除设定" aria-label={`删除${item.title}`} onClick={() => { if (window.confirm(`确定删除设定“${item.title}”吗？`)) { setData((old) => ({ ...old, knowledge: old.knowledge.filter((_, i) => i !== index) })); setToast('设定已删除'); } }}>×</button></div>)}</section>}
    {dialog && <EditDialog config={dialog} onClose={() => setDialog(null)} />}
  </aside>;
}

const defaultCharacterColor = '#4b6671';
function RelationGraph({ characters, relations, selectedName, onSelect }: { characters: WorkspaceData['characters']; relations: WorkspaceData['relations']; selectedName: string | null; onSelect: (name: string) => void }) {
  const selected = characters.find((item) => item.name === selectedName);
  if (!selected) return <section className="relation-graph"><div className="empty-state">选择人物后查看关系网络</div></section>;
  const connected = relations.filter((item) => item.from === selected.name || item.to === selected.name).map((relation) => { const otherName = relation.from === selected.name ? relation.to : relation.from; return { relation, character: characters.find((item) => item.name === otherName) }; }).filter((item): item is { relation: WorkspaceData['relations'][number]; character: WorkspaceData['characters'][number] } => Boolean(item.character)).slice(0, 12);
  return <section className="relation-graph"><header><div><span>RELATIONSHIP NETWORK</span><h2>{selected.name}的人际关系</h2></div><small>以当前人物为中心 · 点击关系人物可切换</small></header><div className="relation-network">
    <div className={`network-focus ${selected.marker === 'retired' ? 'retired' : ''}`} style={{ borderColor: selected.color || defaultCharacterColor }}><i style={{ background: selected.color || defaultCharacterColor }}>{selected.name[0]}</i><div><b>{selected.name}</b><small>{selected.role}</small><p>{selected.state}</p></div></div>
    {connected.length > 0 ? <div className="network-branches">{connected.map(({ relation, character }) => <article className="network-branch" key={`${relation.from}-${relation.to}`}><div className="network-link"><span>{relation.label}</span><i style={{ width: `${Math.max(12, relation.score)}%` }} /><small>关系强度 {relation.score}</small></div><button className={character.marker === 'retired' ? 'retired' : ''} onClick={() => onSelect(character.name)}><span style={{ background: character.color || defaultCharacterColor }}>{character.name[0]}</span><div><b>{character.name}</b><small>{character.role}</small><p>{character.state}</p></div><em>查看 →</em></button></article>)}</div> : <div className="network-empty">尚未建立与 {selected.name} 直接相关的关系</div>}
  </div><footer className="graph-profile"><span style={{ background: selected.color || defaultCharacterColor }}>{selected.name[0]}</span><div><b>{selected.name} · {selected.role}</b><p>{selected.state}</p><small>当前位置：{selected.location} · 标记：{selected.marker === 'retired' ? '不再登场' : '仍在故事中'}</small></div></footer></section>;
}
function Panel({ view, data, setData, setToast, modelConnection, setModelConnection }: { view: Exclude<View, 'editor'>; data: WorkspaceData; setData: React.Dispatch<React.SetStateAction<WorkspaceData>>; setToast: (s: string) => void; modelConnection: ModelConnection; setModelConnection: React.Dispatch<React.SetStateAction<ModelConnection>> }) {
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [batchCharacters, setBatchCharacters] = useState<string[]>([]);
  const [batchRelations, setBatchRelations] = useState<number[]>([]);
  const [dialog, setDialog] = useState<DialogConfig | null>(null);
  const characterMarks = [
    { id: 'active', label: '活跃', color: '#4b6671' },
    { id: 'important', label: '重要', color: '#bd5b3e' },
    { id: 'danger', label: '危险', color: '#9f3f4d' },
    { id: 'hidden', label: '隐藏', color: '#806b9b' },
    { id: 'retired', label: '不再登场', color: '#9b9b98' },
  ];
  const updateCharacterMark = (index: number, marker: string) => {
    const option = characterMarks.find((item) => item.id === marker) || characterMarks[0];
    setData((old) => ({ ...old, characters: old.characters.map((item, i) => i === index ? { ...item, marker: option.id, color: option.color } : item) }));
  };
  const remove = (kind: 'outline' | 'knowledge' | 'skills', index: number, title: string) => {
    if (!window.confirm(`确定删除“${title}”吗？`)) return;
    setData((old) => ({ ...old, [kind]: old[kind].filter((_, i) => i !== index) }));
    setToast('已删除');
  };
  const addOutline = () => {
    setDialog({ title: '新建卷', description: '填写这一卷的名称、剧情摘要和当前规划状态。', confirmText: '添加新卷', fields: [{ key: 'title', label: '卷名', value: '' }, { key: 'summary', label: '剧情摘要', value: '', multiline: true }, { key: 'state', label: '状态', value: '构思中', placeholder: '构思中 / 规划中 / 进行中 / 已完成' }], onSubmit: (values) => {
      if (!values.title.trim()) { setToast('请填写卷名'); return; }
      setData((old) => ({ ...old, outline: [...old.outline, { title: values.title.trim(), summary: values.summary.trim(), state: values.state.trim() || '构思中' }] })); setDialog(null); setToast('新卷已添加');
    } });
  };
  const editOutline = (item: WorkspaceData['outline'][number], index: number) => {
    setDialog({ title: '编辑卷', description: '修改卷名、剧情摘要和规划状态。', confirmText: '保存修改', fields: [{ key: 'title', label: '卷名', value: item.title }, { key: 'summary', label: '剧情摘要', value: item.summary, multiline: true }, { key: 'state', label: '状态', value: item.state }], onSubmit: (values) => {
      if (!values.title.trim()) { setToast('请填写卷名'); return; }
      setData((old) => ({ ...old, outline: old.outline.map((x, i) => i === index ? { title: values.title.trim(), summary: values.summary.trim(), state: values.state.trim() || item.state } : x) })); setDialog(null); setToast('卷信息已更新');
    } });
  };
  const addKnowledge = () => {
    setDialog({ title: '添加知识设定', description: '内容越具体，后续召回越准确。', confirmText: '添加到知识库', fields: [{ key: 'title', label: '设定名称', value: '' }, { key: 'type', label: '类型', value: '设定', placeholder: '人物、地点、规则、伏笔' }, { key: 'body', label: '详细内容', value: '', multiline: true }, { key: 'tags', label: '标签', value: '', placeholder: '用逗号分隔' }], onSubmit: (values) => {
      if (!values.title.trim()) { setToast('请填写设定名称'); return; }
      const tags = values.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      setData((old) => ({ ...old, knowledge: [...old.knowledge, { type: values.type.trim() || '设定', title: values.title.trim(), body: values.body.trim(), tags }] })); setDialog(null); setToast('知识已添加');
    } });
  };
  const editKnowledge = (item: WorkspaceData['knowledge'][number], index: number) => {
    setDialog({ title: '编辑知识设定', description: '修改后会立即参与当前 Vibe 的召回评分。', confirmText: '保存修改', fields: [{ key: 'title', label: '设定名称', value: item.title }, { key: 'type', label: '类型', value: item.type }, { key: 'body', label: '详细内容', value: item.body, multiline: true }, { key: 'tags', label: '标签', value: item.tags.join('，'), placeholder: '用逗号分隔' }], onSubmit: (values) => {
      if (!values.title.trim()) { setToast('请填写设定名称'); return; }
      const tags = values.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      setData((old) => ({ ...old, knowledge: old.knowledge.map((x, i) => i === index ? { type: values.type.trim() || item.type, title: values.title.trim(), body: values.body.trim(), tags } : x) })); setDialog(null); setToast('设定已更新');
    } });
  };
  const addSkill = () => {
    setDialog({ title: '创建写作 Skill', description: '写下这项 Skill 应遵循的写作规则。', confirmText: '创建 Skill', fields: [{ key: 'title', label: 'Skill 名称', value: '' }, { key: 'description', label: '详细写作规则', value: '', multiline: true }], onSubmit: (values) => {
      if (!values.title.trim()) { setToast('请填写 Skill 名称'); return; }
      setData((old) => ({ ...old, skills: [...old.skills, { title: values.title.trim(), description: values.description.trim(), enabled: true }] })); setDialog(null); setToast('Skill 已添加');
    } });
  };
  const editSkill = (item: WorkspaceData['skills'][number], index: number) => {
    setDialog({ title: '编辑写作 Skill', description: '调整名称或详细执行规则。', confirmText: '保存修改', fields: [{ key: 'title', label: 'Skill 名称', value: item.title }, { key: 'description', label: '写作规则', value: item.description, multiline: true }], onSubmit: (values) => {
      if (!values.title.trim()) { setToast('请填写 Skill 名称'); return; }
      setData((old) => ({ ...old, skills: old.skills.map((x, i) => i === index ? { ...x, title: values.title.trim(), description: values.description.trim() } : x) })); setDialog(null); setToast('Skill 已更新');
    } });
  };
  const addCharacter = () => {
    setDialog({ title: '添加人物', description: '人物建立后即可参与关系网络和后续章节召回。', confirmText: '添加人物', fields: [{ key: 'name', label: '姓名', value: '' }, { key: 'role', label: '角色定位', value: '配角', placeholder: '男主、女主、配角、反派' }, { key: 'state', label: '当前状态', value: '状态待补充', multiline: true }, { key: 'location', label: '当前位置', value: '地点待确认' }], onSubmit: (values) => {
      const name = values.name.trim();
      if (!name) { setToast('请填写人物姓名'); return; }
      if (data.characters.some((item) => item.name === name)) { setToast('该人物已经存在'); return; }
      setData((old) => ({ ...old, characters: [...old.characters, { name, role: values.role.trim() || '配角', state: values.state.trim() || '状态待补充', location: values.location.trim() || '地点待确认', color: '#4b6671', marker: 'active' }] }));
      setSelectedCharacter(name); setDialog(null); setToast('人物已添加');
    } });
  };
  const editCharacter = (item: WorkspaceData['characters'][number], index: number) => {
    setDialog({ title: `编辑人物 · ${item.name}`, description: '人物身份、状态和位置均由作者维护，保存后会参与后续章节召回。', confirmText: '保存人物', fields: [{ key: 'name', label: '姓名', value: item.name }, { key: 'role', label: '角色定位', value: item.role }, { key: 'state', label: '当前状态', value: item.state, multiline: true }, { key: 'location', label: '当前位置', value: item.location }], onSubmit: (values) => {
      const name = values.name.trim();
      if (!name) { setToast('请填写人物姓名'); return; }
      if (data.characters.some((character, characterIndex) => characterIndex !== index && character.name === name)) { setToast('该人物姓名已经存在'); return; }
      const previousName = item.name;
      setData((old) => ({ ...old, characters: old.characters.map((character, characterIndex) => characterIndex === index ? { ...character, name, role: values.role.trim() || '配角', state: values.state.trim() || '状态待补充', location: values.location.trim() || '地点待确认' } : character), relations: old.relations.map((relation) => ({ ...relation, from: relation.from === previousName ? name : relation.from, to: relation.to === previousName ? name : relation.to })) }));
      setBatchCharacters((old) => old.map((selectedName) => selectedName === previousName ? name : selectedName));
      setSelectedCharacter(name); setDialog(null); setToast('人物档案已更新');
    } });
  };
  const deleteCharacter = (item: WorkspaceData['characters'][number], index: number) => {
    if (!window.confirm(`确定删除人物“${item.name}”吗？相关人物关系也会一并删除。`)) return;
    setData((old) => ({ ...old, characters: old.characters.filter((_, characterIndex) => characterIndex !== index), relations: old.relations.filter((relation) => relation.from !== item.name && relation.to !== item.name) }));
    setBatchCharacters((old) => old.filter((name) => name !== item.name)); setBatchRelations([]);
    if (selectedCharacter === item.name) setSelectedCharacter(null);
    setToast('人物及相关关系已删除');
  };
  const deleteSelectedCharacters = () => {
    if (!batchCharacters.length) { setToast('请先勾选要删除的人物'); return; }
    if (!window.confirm(`确定删除选中的 ${batchCharacters.length} 个人物吗？相关人物关系也会一并删除。`)) return;
    const names = new Set(batchCharacters);
    setData((old) => ({ ...old, characters: old.characters.filter((character) => !names.has(character.name)), relations: old.relations.filter((relation) => !names.has(relation.from) && !names.has(relation.to)) }));
    if (selectedCharacter && names.has(selectedCharacter)) setSelectedCharacter(null);
    setBatchCharacters([]); setBatchRelations([]); setToast(`已删除 ${names.size} 个人物及其相关关系`);
  };
  const relationDialog = (item?: WorkspaceData['relations'][number], index?: number) => {
    setDialog({ title: item ? '编辑人物关系' : '添加人物关系', description: '两端姓名必须已经存在于人物档案中。', confirmText: item ? '保存关系' : '添加关系', fields: [{ key: 'from', label: '人物 A', value: item?.from || '', placeholder: data.characters[0]?.name || '人物姓名' }, { key: 'to', label: '人物 B', value: item?.to || '', placeholder: data.characters[1]?.name || '人物姓名' }, { key: 'label', label: '关系名称', value: item?.label || '同伴', placeholder: '例如：恋人、死敌、师徒' }, { key: 'score', label: '关系强度（0-100）', value: String(item?.score ?? 40) }], onSubmit: (values) => {
      const from = values.from.trim(); const to = values.to.trim();
      if (!from || !to || from === to) { setToast('请选择两个不同的人物'); return; }
      if (!data.characters.some((character) => character.name === from) || !data.characters.some((character) => character.name === to)) { setToast('请先添加这两个人物档案'); return; }
      const duplicate = data.relations.some((relation, relationIndex) => relationIndex !== index && ((relation.from === from && relation.to === to) || (relation.from === to && relation.to === from)));
      if (duplicate) { setToast('这两个人物之间已经存在关系，可直接编辑现有记录'); return; }
      const next = { from, to, label: values.label.trim() || '共同经历', score: Math.max(0, Math.min(100, Number(values.score) || 0)) };
      setData((old) => ({ ...old, relations: item ? old.relations.map((relation, relationIndex) => relationIndex === index ? next : relation) : [...old.relations, next] }));
      setSelectedCharacter(from); setDialog(null); setToast(item ? '人物关系已更新' : '人物关系已添加');
    } });
  };
  const deleteRelation = (index: number, item: WorkspaceData['relations'][number]) => {
    if (!window.confirm(`确定删除 ${item.from} 与 ${item.to} 的关系吗？`)) return;
    setData((old) => ({ ...old, relations: old.relations.filter((_, relationIndex) => relationIndex !== index) }));
    setBatchRelations([]);
    setToast('人物关系已删除');
  };
  const deleteSelectedRelations = () => {
    if (!batchRelations.length) { setToast('请先勾选要删除的关系'); return; }
    if (!window.confirm(`确定删除选中的 ${batchRelations.length} 条人物关系吗？`)) return;
    const indexes = new Set(batchRelations);
    setData((old) => ({ ...old, relations: old.relations.filter((_, index) => !indexes.has(index)) }));
    setBatchRelations([]); setToast(`已删除 ${indexes.size} 条人物关系`);
  };
  const withDialog = (content: React.ReactNode) => <>{content}{dialog && <EditDialog config={dialog} onClose={() => setDialog(null)} />}</>;

  if (view === 'outline') return withDialog(<div className="content-page"><div className="content-toolbar"><p>{data.outline.length} 卷 · 可新增、编辑和删除</p><button className="primary" onClick={addOutline}>＋ 新建卷</button></div><div className="outline-grid">{data.outline.map((item, i) => <article className="outline-card" key={i}><span>0{i + 1}</span><em>{item.state}</em><h2>{item.title}</h2><p>{item.summary}</p><footer className="card-actions"><button onClick={() => editOutline(item, i)}>编辑</button><button className="danger" onClick={() => remove('outline', i, item.title)}>删除</button></footer></article>)}</div></div>);
  if (view === 'knowledge') return withDialog(<div className="content-page"><div className="content-toolbar"><p>{data.knowledge.length} 条设定 · 可新增、编辑和删除</p><button className="primary" onClick={addKnowledge}>＋ 添加知识</button></div><div className="knowledge-grid">{data.knowledge.map((item, i) => <article className="knowledge-card" key={i}><div><span>{item.type}</span><button onClick={() => editKnowledge(item, i)}>编辑</button></div><h3>{item.title}</h3><p>{item.body}</p><footer>{item.tags.map((tag) => <i key={tag}>#{tag}</i>)}</footer><div className="card-actions"><button onClick={() => editKnowledge(item, i)}>编辑</button><button className="danger" onClick={() => remove('knowledge', i, item.title)}>删除</button></div></article>)}</div></div>);
  if (view === 'skills') return withDialog(<div className="content-page"><div className="content-toolbar"><p>{data.skills.length} 个 Skills · 可配置内容</p><button className="primary" onClick={addSkill}>＋ 创建 Skill</button></div><div className="skills-list">{data.skills.map((item, index) => <article key={index}><div className="skill-icon">{item.title.slice(0, 1)}</div><button className="skill-edit" onClick={() => editSkill(item, index)}><h3>{item.title}</h3><p>{item.description}</p></button><label className="ai-toggle"><input type="checkbox" checked={item.enabled} onChange={(e) => setData((d) => ({ ...d, skills: d.skills.map((s, i) => i === index ? { ...s, enabled: e.target.checked } : s) }))} /><span /></label><button className="danger compact" onClick={() => remove('skills', index, item.title)}>删除</button></article>)}</div></div>);
  if (view === 'timeline') return withDialog(<div className="content-page timeline-page"><div className="timeline-summary"><b>故事时间：2019年7月17日</b><span>{data.timeline.length} 个事件锚点</span></div><div className="timeline-list">{[...data.timeline].sort((a, b) => a.time.localeCompare(b.time)).map((item) => <article key={`${item.time}-${item.title}`}><time>{item.time.slice(11)}<small>{item.time.slice(0, 10)}</small></time><i /><div><span>第 {item.chapter} 章</span><h3>{item.title}</h3><p>{item.detail}</p></div></article>)}</div></div>);
  if (view === 'relations') {
    const selected = selectedCharacter && data.characters.some((item) => item.name === selectedCharacter) ? selectedCharacter : data.characters[0]?.name || null;
    return withDialog(<div className="content-page relations-page"><div className="content-toolbar relation-toolbar"><p>{data.characters.length} 个人物 · {data.relations.length} 条关系 · 档案和关系均由作者维护</p><div><button className="secondary" onClick={addCharacter}>＋ 添加人物</button><button className="primary" onClick={() => relationDialog()}>＋ 添加关系</button></div></div><div className="relation-workbench">
      <section className="character-catalog"><div className="catalog-head"><div><h2>人物档案</h2><p>点击人物查看关系，使用下方按钮修改档案</p></div><div className="mark-legend"><i style={{ background: '#9b9b98' }} />灰色代表不再登场</div></div><div className="batch-toolbar"><button onClick={() => setBatchCharacters(batchCharacters.length === data.characters.length ? [] : data.characters.map((item) => item.name))}>{batchCharacters.length === data.characters.length && data.characters.length ? '取消全选' : '全选人物'}</button><span>已选 {batchCharacters.length}</span><button className="danger" disabled={!batchCharacters.length} onClick={deleteSelectedCharacters}>删除所选</button></div>
        {data.characters.length === 0 && <div className="empty-state"><span>尚未添加人物<br /><button className="secondary" onClick={addCharacter}>先添加第一个人物</button></span></div>}
        {data.characters.map((item, index) => { const color = item.color || characterMarks[0].color; const marker = item.marker || 'active'; return <article className={`character-profile ${marker === 'retired' ? 'is-retired' : ''} ${selected === item.name ? 'selected' : ''}`} key={item.name}>
          <button className="character-open" onClick={() => setSelectedCharacter(item.name)}><span className="large-avatar" style={{ background: color }}>{item.name[0]}</span><span><b>{item.name}<small>{item.role}</small></b><p>{item.state}</p><em>{item.location}</em></span></button>
          <div className="character-mark"><label className="batch-check"><input type="checkbox" checked={batchCharacters.includes(item.name)} onChange={(event) => setBatchCharacters((old) => event.target.checked ? [...old, item.name] : old.filter((name) => name !== item.name))} /><span>选择</span></label><span className="color-dot" style={{ background: color }} /><select aria-label={`${item.name}的颜色标记`} value={marker} onChange={(e) => updateCharacterMark(index, e.target.value)}>{characterMarks.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><input aria-label={`${item.name}自定义颜色`} type="color" value={color} onChange={(e) => setData((old) => ({ ...old, characters: old.characters.map((character, i) => i === index ? { ...character, color: e.target.value, marker: 'custom' } : character) }))} /><button onClick={() => editCharacter(item, index)}>编辑</button><button className="danger" onClick={() => deleteCharacter(item, index)}>删除</button></div>
        </article>; })}
      </section>
      <RelationGraph characters={data.characters} relations={data.relations} selectedName={selected} onSelect={setSelectedCharacter} />
    </div><section className="relation-records"><header><div><h2>全部关系</h2><p>关系名称和强度由作者添加与维护。</p></div><div className="batch-actions"><button onClick={() => setBatchRelations(batchRelations.length === data.relations.length ? [] : data.relations.map((_, index) => index))}>{batchRelations.length === data.relations.length && data.relations.length ? '取消全选' : '全选关系'}</button><span>已选 {batchRelations.length}</span><button className="danger" disabled={!batchRelations.length} onClick={deleteSelectedRelations}>删除所选</button><button className="primary" onClick={() => relationDialog()}>＋ 添加关系</button></div></header>{data.relations.length === 0 ? <div className="empty-state">尚无关系记录。请先添加至少两个人物，再建立第一条关系。</div> : <div>{data.relations.map((item, index) => <article className="relation-record" key={`${item.from}-${item.to}-${index}`}><input aria-label={`选择${item.from}与${item.to}的关系`} type="checkbox" checked={batchRelations.includes(index)} onChange={(event) => setBatchRelations((old) => event.target.checked ? [...old, index] : old.filter((relationIndex) => relationIndex !== index))} /><span className="avatar">{item.from[0]}</span><div><b>{item.from} ↔ {item.to}</b><p>{item.label}</p></div><strong>{item.score}</strong><button onClick={() => relationDialog(item, index)}>编辑</button><button className="danger" onClick={() => deleteRelation(index, item)}>删除</button></article>)}</div>}</section></div>);
  }
  return withDialog(<div className="content-page settings-page"><section><h2>本书系统提示词</h2><p>每本书可拥有独立的叙事声音与约束。</p><textarea value={data.book.systemPrompt} onChange={(e) => setData((d) => ({ ...d, book: { ...d.book, systemPrompt: e.target.value } }))} /><div className="preset-row"><button onClick={() => setData((d) => ({ ...d, book: { ...d.book, systemPrompt: '用冷静、克制的第三人称限知写作。减少解释，以感官细节和留白制造悬疑。' } }))}>克制悬疑</button><button onClick={() => setData((d) => ({ ...d, book: { ...d.book, systemPrompt: '使用轻快、自然的对白推动情节，保持人物之间的化学反应与幽默感。' } }))}>轻喜剧</button><button onClick={() => setData((d) => ({ ...d, book: { ...d.book, systemPrompt: '采用节奏明快的类型文学写法，每章结尾设置强钩子。' } }))}>类型爽文</button></div></section><section><h2>500 万字上下文策略</h2><div className="strategy"><b>① 近期正文</b><span>保留最近章节原文</span></div><div className="strategy"><b>② 分层摘要</b><span>章节 → 卷 → 全书摘要</span></div><div className="strategy"><b>③ 混合召回</b><span>关键词权重＋本地向量相似度</span></div><div className="strategy"><b>④ 强制上下文</b><span>命中人物、人物关系与最近时间线</span></div></section><ModelSettings value={modelConnection} onChange={setModelConnection} setToast={setToast} /><PromptGuide /></div>);
}

function ModelSettings({ value, onChange, setToast }: { value: ModelConnection; onChange: React.Dispatch<React.SetStateAction<ModelConnection>>; setToast: (message: string) => void }) {
  const [localMode, setLocalMode] = useState(false);
  useEffect(() => { setLocalMode(isLocalModelHost()); }, []);
  function enable() {
    if (!value.apiUrl.trim() || !value.apiKey.trim() || !value.model.trim()) { setToast('请完整填写 API 地址、API Key 和模型名称'); return; }
    let apiUrl = '';
    try { apiUrl = normalizeModelApiUrl(value.apiUrl); const url = new URL(apiUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { setToast('API 地址必须是有效的 http 或 https 地址'); return; }
    const connection = { apiUrl, apiKey: value.apiKey.trim(), model: value.model.trim(), enabled: true };
    onChange(connection);
    if (isLocalModelHost()) window.localStorage.setItem(MODEL_CONNECTION_STORAGE_KEY, JSON.stringify({ apiUrl: connection.apiUrl, apiKey: connection.apiKey, model: connection.model }));
    setToast(isLocalModelHost() ? '模型连接已启用，并已记住在这台本机浏览器中' : '模型连接已启用，生成草稿时将立即使用');
  }
  function clear() { onChange({ apiUrl: '', apiKey: '', model: '', enabled: false }); if (isLocalModelHost()) window.localStorage.removeItem(MODEL_CONNECTION_STORAGE_KEY); setToast('模型连接及本机保存的配置已清除'); }
  return <section className="model-settings"><div className="model-heading"><div><h2>模型连接</h2><p>支持 Chat Completions 与 Responses 接口；只填域名或以 /v1 结尾时会自动补全接口路径。</p></div><span className={`connection-state ${value.enabled ? 'connected' : ''}`}>{value.enabled ? (localMode ? '本机已记住' : '本次会话已启用') : '未启用'}</span></div><div className="model-form"><label>API 地址<input type="url" value={value.apiUrl} onChange={(e) => onChange((current) => ({ ...current, apiUrl: e.target.value, enabled: false }))} placeholder="https://api.openai.com/v1/chat/completions" /></label><label>API Key<input type="password" value={value.apiKey} onChange={(e) => onChange((current) => ({ ...current, apiKey: e.target.value, enabled: false }))} placeholder="sk-..." autoComplete="off" /></label><label>模型名称<input value={value.model} onChange={(e) => onChange((current) => ({ ...current, model: e.target.value, enabled: false }))} placeholder="例如：gpt-5-mini" /></label></div><div className="model-actions"><button className="primary" onClick={enable}>启用连接</button>{(value.apiUrl || value.apiKey || value.model) && <button className="danger" onClick={clear}>清除</button>}</div><small>{localMode ? '本地访问时，启用后的地址、模型名和 API Key 会保存在这台设备的浏览器本地存储中，重新打开会自动恢复。能使用该浏览器账户的人也可能读取该密钥；点击“清除”可立即移除。' : '在线访问时配置仅保存在当前页面内存中，不会写入浏览器存储。'} API Key 只在生成时发送到本站服务端，再由服务端请求你填写的 API 地址。</small></section>;
}

function EditDialog({ config, onClose }: { config: DialogConfig; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(config.fields.map((field) => [field.key, field.value])));
  useEffect(() => { setValues(Object.fromEntries(config.fields.map((field) => [field.key, field.value]))); }, [config]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape); return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="edit-dialog" role="dialog" aria-modal="true" aria-label={config.title} onSubmit={(event) => { event.preventDefault(); config.onSubmit(values); }}><header><div><span>MOJING EDITOR</span><h2>{config.title}</h2>{config.description && <p>{config.description}</p>}</div><button type="button" aria-label="关闭弹窗" onClick={onClose}>×</button></header><div className="dialog-fields">{config.fields.map((field, index) => <label key={field.key}>{field.label}{field.multiline ? <textarea autoFocus={index === 0} value={values[field.key] || ''} placeholder={field.placeholder} onChange={(event) => setValues((old) => ({ ...old, [field.key]: event.target.value }))} /> : <input autoFocus={index === 0} value={values[field.key] || ''} placeholder={field.placeholder} onChange={(event) => setValues((old) => ({ ...old, [field.key]: event.target.value }))} />}</label>)}</div><footer><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary">{config.confirmText || '保存'}</button></footer></form></div>;
}

function PromptGuide() {
  return <section className="prompt-guide"><h2>大模型会收到什么</h2><p>点击“生成草稿”后，会按下面的结构组织提问：</p><pre>{`【系统提示词】
本书的叙事风格、视角与写作约束

【用户提问】
相关上下文：文本＋本地向量筛选的知识库内容
前文连续性：最近 3 个已入库章节的正文摘要，含上一章结尾片段
强制上下文：Vibe 命中的人物状态和关系、最近 2 条时间线
剧情意图：写作台填写的 Vibe
正向要求：希望加强的风格、节奏与表现
避免：不希望出现的内容与写法

只输出小说正文。`}</pre><h3>获得更好反馈前，建议先写好</h3><ul><li><b>系统提示词：</b>人称、视角、文风、节奏、目标篇幅和禁忌。</li><li><b>知识库：</b>人物性格与当前状态、世界规则、地点、重要道具和已发生事实。</li><li><b>Vibe：</b>本章起点、主要事件、冲突、转折、结尾落点，以及哪些角色必须出场。</li><li><b>正向提示：</b>需要强化的情绪、感官、对白或悬念。</li><li><b>反向提示：</b>不能改动的设定、不能提前揭露的信息，以及要避免的套路。</li></ul><p className="guide-note">召回在本地完成，不会为了检索把整套知识库发送给第三方向量服务。生成时会发送最终选中的知识设定，以及最近已入库章节的本地摘要；上一章会额外附带末尾 600 字用于衔接，不会发送整本正文或大纲。</p></section>;
}
