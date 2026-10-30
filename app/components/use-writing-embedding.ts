'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { searchEmbeddings, type EmbeddingDocument, type EmbeddingHit } from '../lib/embeddings';
import type { EmbeddingSettingsValue } from './embedding-settings';

type Scope = { bookId: string; chapterId: number; query: string; documents: EmbeddingDocument[]; connection: EmbeddingSettingsValue; enabled: boolean };
const EMPTY_HITS: EmbeddingHit[] = [];
function sameScope(a: Scope, b: Scope) {
  return a.bookId === b.bookId && a.chapterId === b.chapterId && a.query.trim() === b.query.trim() && a.enabled === b.enabled
    && a.connection.enabled === b.connection.enabled && a.connection.apiUrl === b.connection.apiUrl && a.connection.model === b.connection.model && a.connection.apiKey === b.connection.apiKey
    && a.documents.length === b.documents.length && a.documents.every((item, index) => {
      const other = b.documents[index];
      return item.id === other.id && item.title === other.title && item.body === other.body && item.type === other.type && item.tags?.join('\n') === other.tags?.join('\n');
    });
}

// 检索只由按钮或生成动作调用；输入变化仅让旧结果失效，不发起模型请求。
export function useWritingEmbedding(scope: Scope) {
  const latest = useRef(scope);
  const active = useRef<{ controller: AbortController; scope: Scope } | null>(null);
  const [snapshot, setSnapshot] = useState<{ scope: Scope; hits: EmbeddingHit[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState<{ scope: Scope; message: string } | null>(null);
  const error = failure && sameScope(failure.scope, scope) ? failure.message : '';
  const valid = snapshot && sameScope(snapshot.scope, scope);
  useEffect(() => {
    latest.current = scope;
    if (active.current && !sameScope(active.current.scope, scope)) {
      active.current.controller.abort();
    }
  }, [scope]);
  useEffect(() => () => { active.current?.controller.abort(); }, []);

  const cancel = useCallback(() => {
    active.current?.controller.abort(); active.current = null; setBusy(false); setStatus('检索已停止。');
  }, []);
  async function search() {
    const captured = latest.current;
    if (!captured.connection.enabled) throw new Error('请先在作品设置中启用 Embedding 模型连接');
    if (!captured.query.trim()) throw new Error('请先填写剧情意图，再进行 Embedding 检索');
    if (!captured.documents.length) {
      setSnapshot({ scope: captured, hits: [] }); setStatus('本书暂无可检索的知识设定或前文章节。'); setFailure(null); return [];
    }
    active.current?.controller.abort();
    const operation = { controller: new AbortController(), scope: captured };
    active.current = operation; setBusy(true); setFailure(null); setStatus('正在准备本书向量索引…');
    try {
      const result = await searchEmbeddings({ bookId: captured.bookId, documents: captured.documents, query: captured.query.trim(), connection: captured.connection, signal: operation.controller.signal, limit: 6,
        onProgress: (progress) => {
          if (active.current !== operation) return;
          setStatus(progress.stage === 'indexing' ? `建立向量索引 ${progress.completed}/${progress.total}，复用 ${progress.cached} 段缓存` : '正在匹配剧情意图…');
        },
      });
      if (operation.controller.signal.aborted || !sameScope(captured, latest.current)) throw new DOMException('检索已取消', 'AbortError');
      setSnapshot({ scope: captured, hits: result.hits });
      setStatus(`命中 ${result.hits.length} 条资料 · ${result.dimensions} 维 · 复用 ${result.cached} 段，新建 ${result.indexed} 段`);
      return result.hits;
    } catch (failure) {
      if (active.current === operation && !(failure instanceof DOMException && failure.name === 'AbortError')) {
        setSnapshot(null); setFailure({ scope: captured, message: failure instanceof Error ? failure.message : 'Embedding 检索失败' }); setStatus('');
      }
      throw failure;
    } finally { if (active.current === operation) { active.current = null; setBusy(false); } }
  }
  return { hits: valid ? snapshot.hits : EMPTY_HITS, busy, status: valid || busy || error ? status : '', error, search, cancel };
}
