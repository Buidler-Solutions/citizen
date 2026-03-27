import { Injectable } from "@nestjs/common";
import { Pool } from "pg";

@Injectable()
export class DatabaseService {
  private pool: Pool | null = null;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (url) {
      this.pool = new Pool({ connectionString: url });
    }
  }

  async checkConnection() {
    if (!this.pool) {
      return { enabled: false, status: "skipped" };
    }

    try {
      const result = await this.pool.query("SELECT NOW() as now");
      return { enabled: true, status: "ok", now: result.rows[0].now };
    } catch (error) {
      return { enabled: true, status: "error", error: (error as Error).message };
    }
  }
}
