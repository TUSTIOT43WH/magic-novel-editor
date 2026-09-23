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

export function StoryImageInput({ images, busy, loading, error, onSelect, onRemove }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="story-images">
    <div className="story-images-toolbar">
      <button type="button" className="story-image-upload" disabled={busy || loading || images.length >= MAX_STORY_IMAGES} onClick={() => input.current?.click()}>
        {loading ? '正在读取图片…' : '＋ 上传图片'}{images.length > 0 && '（' + images.length + '/' + MAX_STORY_IMAGES + '）'}
      </button>
      <input ref={input} type="file" aria-label="上传故事参考图片" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy || loading} onChange={(event) => {
        const files = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        if (files.length) onSelect(files);
      }} />
      <small>最多 4 张 · 每张 5 MB · PNG / JPEG / WebP</small>
    </div>
    {images.length > 0 && <div className="story-image-previews">{images.map((image, index) => <figure key={image.id}>
      {/* User-selected local data URLs are previewed without an image proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.dataUrl} alt={'参考图 ' + (index + 1) + '：' + image.name} />
      <figcaption title={image.name}>图 {index + 1} · {image.name}</figcaption>
      <button type="button" disabled={busy || loading} aria-label={'移除图片 ' + image.name} onClick={() => onRemove(image.id)}>×</button>
    </figure>)}</div>}
    <small className="story-image-hint">需使用支持图片输入的模型。可在描述中引用“图1、图2”；图片仅在本页暂存，点击生成时随文字发送。</small>
    {error && <p className="story-image-error" role="alert">{error}</p>}
  </div>;
}
