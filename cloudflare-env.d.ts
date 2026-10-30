// 与现有 hosting 配置中的 DB 绑定保持一致，仅补充类型，不创建或更改数据库。
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
