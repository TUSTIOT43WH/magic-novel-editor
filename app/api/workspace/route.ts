import { env } from 'cloudflare:workers';
import { schemaStatements } from '../../../db/schema';

const DEFAULT_ID = 'demo-workspace';

async function ensureSchema() {
  await env.DB.batch(schemaStatements.map((sql) => env.DB.prepare(sql)));
}

export async function GET() {
  await ensureSchema();
  const row = await env.DB.prepare('SELECT payload, revision, updated_at FROM workspaces WHERE id = ?')
    .bind(DEFAULT_ID).first<{ payload: string; revision: number; updated_at: string }>();
  return Response.json(row ? { ...row, payload: JSON.parse(row.payload) } : { payload: null, revision: 0 });
}

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
