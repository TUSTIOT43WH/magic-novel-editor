// 整库持久化接口（D1）：所有作品数据只占 workspaces 表的一行，payload 存整个 JSON 文档，
// revision 每次写入自增。
import { env } from 'cloudflare:workers';
import { schemaStatements } from '../../../db/schema';

// 单用户演示场景固定使用这一行主键。
const DEFAULT_ID = 'demo-workspace';

// 读写前先执行建表语句，保证首次部署或库被重建后仍能拿到表结构。
async function ensureSchema() {
  await env.DB.batch(schemaStatements.map((sql) => env.DB.prepare(sql)));
}

// 读取整库数据：命中则解析 payload 后连同 revision 返回，未命中返回空数据。
export async function GET() {
  await ensureSchema();
  const row = await env.DB.prepare('SELECT payload, revision, updated_at FROM workspaces WHERE id = ?')
    .bind(DEFAULT_ID).first<{ payload: string; revision: number; updated_at: string }>();
  return Response.json(row ? { ...row, payload: JSON.parse(row.payload) } : { payload: null, revision: 0 });
}

// 覆盖写入整库数据：首次插入 revision 为 1，已存在则整体替换 payload 并把 revision 加一，
// 同时刷新 updated_at。
export async function PUT(request: Request) {
  await ensureSchema();
  const payload = await request.json();
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO workspaces (id, payload, revision, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, revision = revision + 1, updated_at = excluded.updated_at`)
    .bind(DEFAULT_ID, JSON.stringify(payload), updatedAt).run();
  return Response.json({ ok: true, updatedAt });
}
