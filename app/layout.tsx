import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

// 站点元信息：浏览器标题与搜索引擎描述。
export const metadata: Metadata = {
  title: '墨境 · AI 长篇小说编辑器',
  description: '支持 Vibe 驱动、设定召回、时间线溯源与人物状态更新的长篇小说编辑器。',
};

// 根布局：声明中文文档语言，把两种字体变量挂到 body 上供全局样式取用。
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
