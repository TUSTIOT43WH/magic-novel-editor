'use client';

import { useState, useSyncExternalStore } from 'react';
import { clearEmbeddingCache, normalizeEmbeddingApiUrl, requestEmbeddings, type EmbeddingConnection } from '../lib/embeddings';
import './embedding-settings.css';

export type EmbeddingSettingsValue = EmbeddingConnection & { enabled: boolean };
export const EMBEDDING_CONNECTION_STORAGE_KEY = 'mojing-local-embedding-connection-v1';
export const emptyEmbeddingConnection: EmbeddingSettingsValue = { apiUrl: '', apiKey: '', model: 'text-embedding-v4', enabled: false };

function isLocalHost() { return typeof window !== 'undefined' && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname); }
const subscribeToHost = () => () => {};
const serverHostSnapshot = () => false;

export function EmbeddingSettings({ value, onChange, bookId, setToast }: {
  value: EmbeddingSettingsValue; onChange: React.Dispatch<React.SetStateAction<EmbeddingSettingsValue>>; bookId: string; setToast: (message: string) => void;
}) {
  const local = useSyncExternalStore(subscribeToHost, isLocalHost, serverHostSnapshot);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState('');

  function enable() {
    try {
      if (!value.apiUrl.trim() || !value.apiKey.trim() || !value.model.trim()) throw new Error('请完整填写 Embedding API 地址、API Key 和模型名称');
      const connection = { apiUrl: normalizeEmbeddingApiUrl(value.apiUrl), apiKey: value.apiKey.trim(), model: value.model.trim(), enabled: true };
      onChange(connection);
      if (isLocalHost()) localStorage.setItem(EMBEDDING_CONNECTION_STORAGE_KEY, JSON.stringify(connection));
      setNotice('连接配置已启用，可在写作台开启 Embedding 检索。');
      setToast('Embedding 连接已启用');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Embedding 配置无效'); }
  }
  async function testConnection() {
    if (testing) return;
    setTesting(true); setNotice('正在测试 Embedding 连接…');
    try {
      const vectors = await requestEmbeddings(value, ['小说创作资料检索连接测试']);
      setNotice(`连接成功，返回 ${vectors[0].length} 维向量。此测试只发送了固定测试短句。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Embedding 连接测试失败'); }
    finally { setTesting(false); }
  }
  function clearConnection() {
    onChange({ ...emptyEmbeddingConnection });
    if (isLocalHost()) localStorage.removeItem(EMBEDDING_CONNECTION_STORAGE_KEY);
    setNotice('Embedding 连接配置已清除。');
  }
  async function clearCache() {
    setClearing(true);
    try { await clearEmbeddingCache(bookId); setNotice('本书的本地向量缓存已清除，下次检索时会重新建立。'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法清除本地缓存'); }
    finally { setClearing(false); }
  }
  const field = (key: 'apiUrl' | 'apiKey' | 'model', text: string) => onChange((old) => ({ ...old, [key]: text, enabled: false }));
  return <section className="model-settings embedding-settings" aria-label="Embedding 模型设置">
    <div className="model-heading"><div><h2>Embedding 模型连接</h2><p>配置支持文本向量化的模型，用于理解剧情意图、寻找意思相近的前文和设定。</p></div><span className={`connection-state ${value.enabled ? 'connected' : ''}`}>{value.enabled ? '已启用' : '未启用'}</span></div>
    <div className="model-form">
      <label>Embedding API 地址<input aria-label="Embedding API 地址" type="url" value={value.apiUrl} onChange={(e) => field('apiUrl', e.target.value)} placeholder="服务商提供的兼容接口根地址或完整 /embeddings 地址" /></label>
      <label>Embedding API Key<input aria-label="Embedding API Key" type="password" autoComplete="off" value={value.apiKey} onChange={(e) => field('apiKey', e.target.value)} placeholder="填写你自己的 Embedding API Key" /></label>
      <label>Embedding 模型名称<input aria-label="Embedding 模型名称" value={value.model} onChange={(e) => field('model', e.target.value)} placeholder="例如：text-embedding-v4" /></label>
    </div>
    <div className="model-actions"><button className="primary" onClick={enable}>启用 Embedding 连接</button><button className="secondary" disabled={testing || !value.apiUrl || !value.apiKey || !value.model} onClick={testConnection}>{testing ? '连接测试中…' : '测试 Embedding 连接'}</button><button className="secondary" disabled={clearing} onClick={clearCache}>{clearing ? '正在清除…' : '清除本书向量缓存'}</button><button className="danger" onClick={clearConnection}>清除 Embedding 配置</button></div>
    {notice && <p className="embedding-settings-notice" role="status">{notice}</p>}
    <small>向量缓存在当前浏览器的 IndexedDB 中，无需安装数据库或其他服务。开启检索后，点击检索或生成，会将本书知识设定、当前章节之前的正文及剧情意图发送到你配置的 Embedding 服务；首次建立索引需要等待，之后只处理变更内容，并产生相应的模型调用费用。{local ? '启用后的连接配置和 API Key 仅记住在本机浏览器，不写入书库。' : '连接配置和 API Key 仅保存在当前页面内存中。'}</small>
  </section>;
}
