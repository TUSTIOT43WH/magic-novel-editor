# 魔境小说编辑器

一个面向中文长篇小说创作的本地优先编辑器，支持多书籍、章节写作、Vibe 续写、知识库召回、人物档案、人物关系、时间线、写作 Skills 和可配置的大模型接口。用户可以在设置页面编写提示词。在知识库里编写相关设定，在写作台中决定是否引用这些设定一并发给大模型，也可以编写自己的作家skills。

## 环境要求

- Node.js 22.13.0 或更高版本
- npm

## 本地启动

```bash
npm install
npm run dev
```

根据终端提示打开本地地址，通常为 `http://localhost:3000`。

## 模型配置

在编辑器的“设置 → 模型连接”中填写兼容 OpenAI Chat Completions 或 Responses API 的地址、API Key 和模型名称。也可以复制 `.env.example` 为 `.env`，然后填写服务端环境变量。

不要把 `.env`、API Key、本地数据库、构建产物或浏览器数据提交到 Git 仓库。

## 常用命令

```bash
npm run dev
npm run build
npm run start
npm run lint
```

首次启动时书库为空，仅包含一章空白章节；所有小说正文、人物、关系、知识库和时间线均由使用者自行创建。

## 更新记录

本次新增的连贯性审校、悬浮作者助手、召回优化和人物关系功能请查看 [CHANGELOG.md](CHANGELOG.md)。
