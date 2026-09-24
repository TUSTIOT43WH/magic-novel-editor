// D1 建表语句，由 workspace 接口在每次读写前执行。
export const schemaStatements = [
  // 整部作品序列化后放在单行单列的 payload 里：前端本地状态就是一整份 JSON，
  // 整体覆盖写比拆成关系表更简单，也避免频繁改表；revision 在每次覆盖更新时加一。
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`,
  // 按最后更新时间建立索引，便于排查与后续按时间取用。
  `CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at ON workspaces(updated_at)`,
] as const;
