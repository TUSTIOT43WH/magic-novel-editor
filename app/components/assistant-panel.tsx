'use client';
import { useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { assistantTitle, runWritingAssistant } from '../lib/assistant-client';
import { detectStoryIntent, type AssistantBook } from '../lib/assistant-tools';
import type { AssistantConnection, AssistantMessage, AssistantSession, AssistantStore } from '../lib/assistant-types';

type StoredBook = AssistantBook & { assistant?: AssistantStore };
type Runtime = { bookId: string; question: string; editingId?: string; running: boolean; progress: string };
const idle = (bookId: string): Runtime => ({ bookId, question: '', running: false, progress: '' });
const EMPTY_MESSAGES: AssistantMessage[] = [];
export function useWritingAssistant<T extends StoredBook>({ bookId, data, setData, connection, prefetch }: {
  bookId: string; data: T; setData: Dispatch<SetStateAction<T>>; connection?: AssistantConnection; prefetch: (question: string) => string;
}) {
  const [runtime, setRuntime] = useState<Runtime>(() => idle(bookId));
  const state = runtime.bookId === bookId ? runtime : idle(bookId);
  const flight = useRef<{ controller: AbortController; finish: () => void } | null>(null);
  // 切换作品/卸载即中止；异步回调只能更新同一请求的会话。
  useEffect(() => () => { const current = flight.current; flight.current = null; current?.controller.abort(); }, [bookId]);
  const store: AssistantStore = data.assistant || { sessions: [], allowBook: true };
  const session = store.sessions.find((x) => x.id === store.activeId) || store.sessions[0];
  function updateStore(change: (old: AssistantStore) => AssistantStore) {
    setData((old) => ({ ...old, assistant: change(old.assistant || { sessions: [], allowBook: true }) }));
  }
  function stop() {
    const current = flight.current;
    if (!current) return;
    current.finish(); flight.current = null; current.controller.abort();
    setRuntime((old) => ({ ...old, running: false, progress: '' }));
  }
  function choose(id?: string) {
    stop();
    updateStore((old) => ({ ...old, activeId: id || 'new' }));
    setRuntime(idle(bookId));
  }
  // activeId='new' 表示尚未发送的空会话，不会把空卡片塞入历史。
  const active = store.activeId === 'new' ? undefined : session;
  function edit(id: string) {
    const message = active?.messages.find((x) => x.id === id && x.role === 'author');
    if (!message || state.running) return;
    setRuntime({ ...state, question: message.content, editingId: id });
  }
  function deleteQuestion(id: string) {
    if (!active || state.running) return;
    const index = active.messages.findIndex((m) => m.id === id);
    if (index < 0) return;
    updateStore((old) => ({ ...old, sessions: old.sessions.map((x) => x.id === active.id ? { ...x, messages: x.messages.slice(0, index), ...(!x.manualTitle && index === 0 ? { title: '新会话' } : {}) } : x) }));
    setRuntime(idle(bookId));
  }
  function deleteSession(id: string) {
    if (!store.sessions.some((x) => x.id === id)) return;
    if (active?.id === id) stop();
    updateStore((old) => ({ ...old, sessions: old.sessions.filter((x) => x.id !== id), activeId: old.activeId === id || active?.id === id ? 'new' : old.activeId }));
    if (active?.id === id) setRuntime(idle(bookId));
  }
  async function ask(confirmed = false) {
    const question = state.question.trim();
    if (!question || flight.current) return;
    if (question.length > 12000) { setRuntime({ ...state, progress: '问题过长，请控制在12000字符以内' }); return; }
    const index = state.editingId ? active?.messages.findIndex((x) => x.id === state.editingId) ?? -1 : -1;
    if (state.editingId && index < 0) return;
    if (index >= 0 && active && active.messages.length > index + 2 && !confirmed) return;
    const history = active ? index >= 0 ? active.messages.slice(0, index) : active.messages : [];
    const sessionId = active?.id || crypto.randomUUID();
    const questionId = state.editingId || crypto.randomUUID(); const answerId = crypto.randomUUID();
    const now = Date.now();
    const next: AssistantSession = { id: sessionId, title: active?.manualTitle ? active.title : assistantTitle(history.find((m) => m.role === 'author')?.content || question), manualTitle: active?.manualTitle, createdAt: active?.createdAt || now, messages: [...history, { id: questionId, role: 'author', content: question }, { id: answerId, role: 'assistant', content: '', status: 'running' }] };
    updateStore((old) => ({ ...old, activeId: sessionId, sessions: old.sessions.some((x) => x.id === sessionId) ? old.sessions.map((x) => x.id === sessionId ? next : x) : [next, ...old.sessions] }));
    setRuntime({ bookId, question: '', running: true, progress: '准备提问…' });
    const patch = (change: Partial<AssistantMessage>) => updateStore((old) => ({ ...old, sessions: old.sessions.map((x) => x.id === sessionId ? { ...x, messages: x.messages.map((m) => m.id === answerId ? { ...m, ...change } : m) } : x) }));
    const controller = new AbortController();
    const token = { controller, finish: () => patch({ status: 'stopped' }) }; flight.current = token;
    const live = () => flight.current === token && !controller.signal.aborted;
    try {
      const allowBook = store.allowBook !== false;
      await runWritingAssistant({
        question, history, data, allowBook, connection, signal: controller.signal,
        prefetch: allowBook && detectStoryIntent(question, data).isStory ? prefetch(question) : '',
        onText: (content) => { if (live()) patch({ content }); },
        onSources: (sources) => { if (live()) patch({ sources }); },
        onNotice: (notice) => { if (live()) patch({ notice }); },
        onBookContext: () => { if (live()) patch({ bookContext: true }); },
        onProgress: (progress) => { if (live()) setRuntime((old) => ({ ...old, progress })); },
      });
      if (live()) patch({ status: 'complete' });
    } catch (error) {
      if (live()) patch({ status: 'error', notice: '回答中断：' + (error instanceof Error ? error.message : '模型请求失败') });
    } finally {
      if (flight.current === token) { flight.current = null; setRuntime((old) => ({ ...old, running: false, progress: '' })); }
    }
  }
  return {
    ...state, sessions: store.sessions, session: active, allowBook: store.allowBook !== false,
    setQuestion: (question: string) => setRuntime({ ...state, question }),
    setAllowBook: (allowBook: boolean) => updateStore((old) => ({ ...old, allowBook })),
    cancelEdit: () => setRuntime({ ...state, question: '', editingId: undefined }),
    choose, edit, ask, stop, deleteQuestion, deleteSession,
    rename: (id: string, title: string) => { if (title.trim()) updateStore((old) => ({ ...old, sessions: old.sessions.map((x) => x.id === id ? { ...x, title: title.trim().slice(0, 60), manualTitle: true } : x) })); },
  };
}
export type AssistantController = ReturnType<typeof useWritingAssistant>;

type AssistantDialog = { kind: 'history' } | { kind: 'rename'; session: AssistantSession } | { kind: 'delete-session'; session: AssistantSession } | { kind: 'delete-question'; message: AssistantMessage; count: number } | { kind: 'rewrite' };

function AssistantIcon({ name }: { name: 'history' | 'search' | 'plus' | 'edit' | 'trash' | 'close' | 'chevron' }) {
  const paths = { history: 'M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', plus: 'M12 5v14M5 12h14', edit: 'm15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', close: 'm6 6 12 12M18 6 6 18', chevron: 'm9 5 7 7-7 7' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

// 原生 dialog 的 顶层显示机制 不受悬浮窗 溢出裁剪或层叠顺序 裁剪，并提供焦点约束。
function AssistantModal({ title, description, danger = false, wide = false, onClose, children }: { title: string; description: string; danger?: boolean; wide?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId(); const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal(); dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => { dialog?.close(); };
  }, []);
  return createPortal(<dialog ref={ref} className={'assistant-modal' + (wide ? ' history-modal' : '')} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header className="assistant-modal-heading"><div className={'assistant-modal-emblem' + (danger ? ' danger' : '')}><AssistantIcon name={danger ? 'trash' : wide ? 'history' : 'edit'} /></div><div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div><button type="button" className="assistant-icon-action" aria-label="关闭弹窗" onClick={onClose}><AssistantIcon name="close" /></button></header>
    {children}
  </dialog>, document.body);
}

export function AssistantPanel({ assistant, compact = false }: { assistant: AssistantController; compact?: boolean }) {
  const [dialog, setDialog] = useState<AssistantDialog>(); const [title, setTitle] = useState(''); const [search, setSearch] = useState('');
  const chatRef = useRef<HTMLDivElement>(null); const followBottom = useRef(true);
  const messages = assistant.session?.messages || EMPTY_MESSAGES;
  useEffect(() => { if (followBottom.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [messages, assistant.progress]);
  const a = assistant;
  const keyword = search.trim().toLocaleLowerCase();
  const sessions = dialog?.kind === 'history' ? a.sessions.filter((s) => !keyword || s.title.toLocaleLowerCase().includes(keyword) || s.messages.some((m) => m.content.toLocaleLowerCase().includes(keyword))).slice().sort((x, y) => y.createdAt - x.createdAt) : [];
  const ask = () => {
    followBottom.current = true;
    const index = a.editingId ? messages.findIndex((m) => m.id === a.editingId) : -1;
    if (index >= 0 && messages.length > index + 2) setDialog({ kind: 'rewrite' });
    else void a.ask();
  };
  const startHistory = () => { setSearch(''); setDialog({ kind: 'history' }); };
  return <div className={'assistant-panel' + (compact ? ' compact' : '')}>
    <div className="assistant-history">
      <button type="button" className="assistant-history-trigger" aria-label="查看历史会话" onClick={startHistory}><span className="assistant-history-symbol"><AssistantIcon name="history" /></span><span className="assistant-history-caption"><small>本书会话 · {a.sessions.length}</small><strong>{a.session?.title || '开始新的对话'}</strong></span><AssistantIcon name="chevron" /></button>
      <button type="button" className="assistant-new-session" aria-label="新建会话" onClick={() => { a.choose(); followBottom.current = true; }}><AssistantIcon name="plus" /><span>新建</span></button>
    </div>
    <div className={compact ? 'float-chat' : 'assistant-chat'} ref={chatRef} onScroll={() => { const el = chatRef.current; if (el) followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>
      {messages.length ? messages.map((m) => <article className={m.role} key={m.id}>
        <span>{m.role === 'author' ? '作者' : '助手'}</span><p>{m.content || (m.status === 'running' && a.running ? '正在处理…' : '尚无回答内容')}</p>
        {m.sources?.length ? <small>已查阅：{m.sources.join(' · ')}</small> : null}
        {m.notice && <small className="assistant-notice">{m.notice}</small>}
        {(m.status === 'stopped' || m.status === 'running' && !a.running) && <small>已停止，保留已收到的内容</small>}
        {m.role === 'author' && <div className="assistant-message-actions"><button disabled={a.running} onClick={() => { a.edit(m.id); followBottom.current = true; }}>修改重问</button><button disabled={a.running} onClick={() => setDialog({ kind: 'delete-question', message: m, count: messages.slice(messages.findIndex((item) => item.id === m.id)).filter((item) => item.role === 'author').length })}>删除问答</button></div>}
      </article>) : <div className="float-chat-empty"><b>本书专属提问助手</b><span>通识问题直接回答，书内问题按需查证。历史会话只属于当前书籍。</span></div>}
      {a.progress && <div role="status" className="assistant-thinking">{a.progress}</div>}
    </div>
    <form className={compact ? 'float-compose' : 'assistant-compose'} onSubmit={(e) => { e.preventDefault(); ask(); }}>
      {a.editingId && <div className="assistant-edit-hint"><span>重问将覆盖旧回答；后续对话将移除</span><button type="button" onClick={a.cancelEdit}>取消修改</button></div>}
      <textarea aria-label="助手问题" value={a.question} maxLength={12000} onChange={(e) => a.setQuestion(e.target.value)} placeholder="咨询创作、历史资料或本书情节……" />
      <div><label className="rag-switch"><input type="checkbox" checked={a.allowBook} disabled={a.running} onChange={(e) => a.setAllowBook(e.target.checked)} /><i /><b>允许查阅本书</b></label>{a.running ? <button type="button" className="primary" onClick={a.stop}>停止生成</button> : <button className="primary" type="submit" disabled={!a.question.trim()}>{a.editingId ? '重新提问' : '发送问题'}</button>}</div>
      <small className="assistant-privacy">{a.allowBook ? '仅在提问时按需发送本书片段；不联网搜索。' : '仅携带通用对话历史，不发送查书资料。'} 标题由首问在本地自动提炼。</small>
    </form>
    {dialog?.kind === 'history' && <AssistantModal key="history" title="历史会话" description="找回灵感，也找回上一次讨论的线索。" wide onClose={() => setDialog(undefined)}>
      <div className="assistant-history-search"><AssistantIcon name="search" /><input aria-label="搜索历史会话" value={search} data-autofocus onChange={(e) => setSearch(e.target.value)} placeholder="搜索会话标题或问答内容…" />{search && <button className="assistant-icon-action" aria-label="清空搜索" onClick={() => setSearch('')}><AssistantIcon name="close" /></button>}</div>
      <div className="assistant-history-meta"><span>{keyword ? '搜索结果' : '全部会话'}</span><span>{sessions.length} 个会话 · 按创建时间排序</span></div>
      <div className="assistant-history-results" aria-label="历史会话列表">
        {sessions.length ? sessions.map((s) => {
          const preview = (keyword ? s.messages.find((m) => m.content.toLocaleLowerCase().includes(keyword)) : s.messages.find((m) => m.role === 'author'))?.content || '暂无提问，继续这段对话吧';
          return <article key={s.id} className={'assistant-history-item' + (a.session?.id === s.id ? ' selected' : '')}>
            <button type="button" className="assistant-history-select" aria-label={'打开会话：' + s.title} onClick={() => { a.choose(s.id); followBottom.current = true; setDialog(undefined); }}><div><strong>{s.title}</strong>{a.session?.id === s.id && <em>当前</em>}</div><p>{preview}</p><small><time>{new Date(s.createdAt).toLocaleDateString('zh-CN')}</time><span>·</span><span>{s.messages.filter((m) => m.role === 'author').length} 次提问</span></small></button>
            <div className="assistant-history-item-actions"><button type="button" className="assistant-icon-action" aria-label={'重命名会话：' + s.title} title="重命名" onClick={() => { setTitle(s.title); setDialog({ kind: 'rename', session: s }); }}><AssistantIcon name="edit" /></button><button type="button" className="assistant-icon-action danger" aria-label={'删除会话：' + s.title} title="删除会话" onClick={() => setDialog({ kind: 'delete-session', session: s })}><AssistantIcon name="trash" /></button></div>
          </article>;
        }) : <div className="assistant-history-empty"><AssistantIcon name={keyword ? 'search' : 'history'} /><strong>{keyword ? '没有找到相关会话' : '还没有历史会话'}</strong><p>{keyword ? '试试其他关键词，也可以搜索回答中的文字。' : '发送第一个问题后，对话会自动保存在这里。'}</p></div>}
      </div>
      <footer className="assistant-history-footer"><span>只显示当前书籍的会话</span><button type="button" className="secondary" onClick={() => { a.choose(); setDialog(undefined); }}>＋ 新建会话</button></footer>
    </AssistantModal>}
    {dialog?.kind === 'rename' && <AssistantModal key="rename" title="重命名会话" description="用一个容易记住的名字，留住这段讨论。" onClose={() => setDialog(undefined)}>
      <form className="assistant-rename-form" onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; a.rename(dialog.session.id, title); setDialog({ kind: 'history' }); }}><div className="assistant-modal-content"><label>会话名称<input aria-label="会话标题" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus /></label><small>{title.length} / 60 · 手动命名后不会被自动标题覆盖</small></div><footer className="assistant-modal-footer"><button type="button" className="secondary" onClick={() => setDialog({ kind: 'history' })}>取消</button><button type="submit" className="primary" disabled={!title.trim()}>保存名称</button></footer></form>
    </AssistantModal>}
    {(dialog?.kind === 'delete-session' || dialog?.kind === 'delete-question') && <AssistantModal key={dialog.kind} title={dialog.kind === 'delete-session' ? '删除这段会话？' : '删除这些问答？'} description="请确认删除范围，此操作无法撤销。" danger onClose={() => setDialog(undefined)}>
      <div className="assistant-modal-content"><div className="assistant-delete-preview"><small>{dialog.kind === 'delete-session' ? '将删除的会话' : '从这条问题开始'}</small><strong>{dialog.kind === 'delete-session' ? dialog.session.title : dialog.message.content}</strong></div><p className="assistant-delete-description">{dialog.kind === 'delete-session' ? '该会话中的全部问题和回答将被删除。其他会话、小说正文和本书设定不受影响。' : '将删除当前问题、对应回答及后续问答，共 ' + dialog.count + ' 次提问。此前的对话将保留。'}</p>{dialog.kind === 'delete-session' && a.running && a.session?.id === dialog.session.id && <p className="assistant-delete-description">正在生成的回答也会停止。</p>}</div>
      <footer className="assistant-modal-footer"><button type="button" className="secondary" data-autofocus onClick={() => setDialog(dialog.kind === 'delete-session' ? { kind: 'history' } : undefined)}>取消</button><button type="button" className="assistant-danger-button" onClick={() => { if (dialog.kind === 'delete-session') { a.deleteSession(dialog.session.id); setDialog({ kind: 'history' }); } else { a.deleteQuestion(dialog.message.id); setDialog(undefined); } }}>确认删除</button></footer>
    </AssistantModal>}
    {dialog?.kind === 'rewrite' && <AssistantModal key="rewrite" title="替换回答并重新提问？" description="后续对话依赖旧回答，需要一起移除。" onClose={() => setDialog(undefined)}><div className="assistant-modal-content"><p className="assistant-delete-description">修改后的问题将覆盖原问题，助手会生成新的回答。此问题之前的对话不受影响。</p></div><footer className="assistant-modal-footer"><button type="button" className="secondary" data-autofocus onClick={() => setDialog(undefined)}>继续编辑</button><button type="button" className="primary" onClick={() => { setDialog(undefined); void a.ask(true); }}>确认重问</button></footer></AssistantModal>}
  </div>;
}
