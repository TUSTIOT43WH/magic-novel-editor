'use client';

import { useRef } from 'react';
import { MAX_STORY_IMAGES, type StoryImage } from '../lib/story-images';

type Props = {
  images: StoryImage[];
  busy: boolean;
  loading: boolean;
  error: string;
  onSelect: (files: File[]) => void;
  onRemove: (id: string) => void;
};

// 写作台的参考图输入：上传按钮代为触发隐藏的 文件选择框，负责预览已选图片、逐张移除
// 与展示校验错误；数量上限取自 story-images 中的共享常量。
export function StoryImageInput({ images, busy, loading, error, onSelect, onRemove }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="story-images">
    <div className="story-images-toolbar">
      <button type="button" className="story-image-upload" disabled={busy || loading || images.length >= MAX_STORY_IMAGES} onClick={() => input.current?.click()}>
        {loading ? '正在读取图片…' : '＋ 上传图片'}{images.length > 0 && '（' + images.length + '/' + MAX_STORY_IMAGES + '）'}
      </button>
      {/* 隐藏的原生文件选择框，由上方按钮代理点击；选完立即清空 value 以便重复选择同一文件。 */}
      <input ref={input} type="file" aria-label="上传故事参考图片" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy || loading} onChange={(event) => {
        const files = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        if (files.length) onSelect(files);
      }} />
      <small>最多 4 张 · 每张 5 MB · PNG / JPEG / WebP</small>
    </div>
    {/* 缩略图列表：每张图带序号、文件名与移除按钮。 */}
    {images.length > 0 && <div className="story-image-previews">{images.map((image, index) => <figure key={image.id}>
      {/* 预览作者选择的本地 内嵌数据地址，不经过图片代理 */}
      {/* eslint-disable-next-line @next/next/no-img-element -- 本地图片预览不经过图片代理 */}
      <img src={image.dataUrl} alt={'参考图 ' + (index + 1) + '：' + image.name} />
      <figcaption title={image.name}>图 {index + 1} · {image.name}</figcaption>
      <button type="button" disabled={busy || loading} aria-label={'移除图片 ' + image.name} onClick={() => onRemove(image.id)}>×</button>
    </figure>)}</div>}
    <small className="story-image-hint">需使用支持图片输入的模型。可在描述中引用“图1、图2”；图片仅在本页暂存，点击生成时随文字发送。</small>
    {/* 校验失败时的提示文案，交给读屏软件播报。 */}
    {error && <p className="story-image-error" role="alert">{error}</p>}
  </div>;
}
