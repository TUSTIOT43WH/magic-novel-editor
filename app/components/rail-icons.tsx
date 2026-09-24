'use client';

import type { ReactNode } from 'react';

export type RailIconName = 'books' | 'editor' | 'agents' | 'outline' | 'knowledge' | 'relations' | 'timeline' | 'skills' | 'settings';

// 左侧导航图标统一使用 24×24 线性网格：1.7 描边、圆角端点，颜色跟随 currentColor。
const SHAPES: Record<RailIconName, ReactNode> = {
  // 书库：书架上的三本书
  books: <>
    <path d="M3.2 5.6h4.6v14.6h-4.6z" />
    <path d="M9.7 8.4h4.6v11.8h-4.6z" />
    <path d="M16.2 6.8h4.6v13.4h-4.6z" />
    <path d="M2.4 20.4h19.2" />
  </>,
  // 写作台：正在书写的笔＋稿纸基线
  editor: <>
    <path d="M16.9 3.4a2.34 2.34 0 0 1 3.3 3.3L7.9 19l-4.3 1.1L4.7 15.8z" />
    <path d="m14.3 6 3.2 3.4" />
    <path d="M3.8 21.4h8.6" />
  </>,
  // 并行智能体：一个中枢节点连接三个并行节点
  agents: <>
    <path d="M12 11V8.4" />
    <path d="m9.5 15.4-2.3 1.3" />
    <path d="m14.5 15.4 2.3 1.3" />
    <circle cx="12" cy="13.9" r="2.9" />
    <circle cx="12" cy="6.3" r="2.1" />
    <circle cx="5.4" cy="17.7" r="2.1" />
    <circle cx="18.6" cy="17.7" r="2.1" />
  </>,
  // 大纲：分层树状结构
  outline: <>
    <path d="M12.6 6h8" />
    <path d="M12.6 12h8" />
    <path d="M12.6 18h8" />
    <path d="M3.4 6h3.2" />
    <path d="M3.4 6v4a2 2 0 0 0 2 2h3.2" />
    <path d="M3.4 12v4a2 2 0 0 0 2 2h3.2" />
  </>,
  // 知识库：设定归档用的数据仓（圆柱）
  knowledge: <>
    <ellipse cx="12" cy="5.8" rx="7.2" ry="2.6" />
    <path d="M4.8 5.8v12.4c0 1.44 3.22 2.6 7.2 2.6s7.2-1.16 7.2-2.6V5.8" />
    <path d="M4.8 12c0 1.44 3.22 2.6 7.2 2.6s7.2-1.16 7.2-2.6" />
  </>,
  // 人物关系：两个人物＋双向关系连线
  relations: <>
    <circle cx="6.6" cy="7.4" r="2.6" />
    <path d="M2.4 19.4a4.2 4.2 0 0 1 8.4 0" />
    <circle cx="17.4" cy="7.4" r="2.6" />
    <path d="M13.2 19.4a4.2 4.2 0 0 1 8.4 0" />
    <path d="M9.3 12.6h5.4" />
    <path d="m10.9 11.1-1.5 1.5 1.5 1.5" />
    <path d="m13.1 11.1 1.5 1.5-1.5 1.5" />
  </>,
  // 时间线：带刻度的时间轴＋前进箭头
  timeline: <>
    <path d="M2.8 12h14.8" />
    <path d="m14.6 8.9 3.1 3.1-3.1 3.1" />
    <path d="M7.2 8.6v6.8" />
    <path d="M12 8.6v6.8" />
  </>,
  // 写作技能：写作技法魔杖＋灵感火花
  skills: <>
    <path d="M4.8 20.8 16 9.6 14.4 8 3.2 19.2z" />
    <path d="M13 2.2 13.5 3.3 14.6 3.8 13.5 4.3 13 5.4 12.5 4.3 11.4 3.8 12.5 3.3z" />
    <path d="M18.4 2.4 19.3 4.7 21.6 5.6 19.3 6.5 18.4 8.8 17.5 6.5 15.2 5.6 17.5 4.7z" />
  </>,
  // 设置：齿轮
  settings: <>
    <path d="M18.6 9.7L21.3 9.9A9.5 9.5 0 0 1 21.3 14.1L18.6 14.3A7 7 0 0 1 18.3 15L20.1 17A9.5 9.5 0 0 1 17 20.1L15 18.3A7 7 0 0 1 14.3 18.6L14.1 21.3A9.5 9.5 0 0 1 9.9 21.3L9.7 18.6A7 7 0 0 1 9 18.3L7 20.1A9.5 9.5 0 0 1 3.9 17L5.7 15A7 7 0 0 1 5.4 14.3L2.7 14.1A9.5 9.5 0 0 1 2.7 9.9L5.4 9.7A7 7 0 0 1 5.7 9L3.9 7A9.5 9.5 0 0 1 7 3.9L9 5.7A7 7 0 0 1 9.7 5.4L9.9 2.7A9.5 9.5 0 0 1 14.1 2.7L14.3 5.4A7 7 0 0 1 15 5.7L17 3.9A9.5 9.5 0 0 1 20.1 7L18.3 9A7 7 0 0 1 18.6 9.7Z" />
    <circle cx="12" cy="12" r="3.3" />
  </>,
};

// 按名称渲染左侧导航图标：线宽与端点在此统一，尺寸和颜色由 .rail-icon 与 currentColor 决定。
export function RailIcon({ name }: { name: RailIconName }) {
  return <svg className="rail-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{SHAPES[name]}</svg>;
}
