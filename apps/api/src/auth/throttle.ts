import { createHash } from "node:crypto";
import { QueryTypes, type Sequelize } from "sequelize";
import { ApiError } from "../errors.js";

// Per normalized login address, including unknown accounts. Persistent across
// instances/restarts; callers cannot bypass it by spoofing forwarded IP headers.
export async function checkLoginLimit(db: Sequelize, email: string) {
  const key = createHash("sha256").update(email).digest("hex");
  const [bucket] = await db.query<{ attempt_count: number }>(`
    INSERT INTO login_attempts (key_hash, attempt_count, window_started_at)
    VALUES ($1, 1, CURRENT_TIMESTAMP)
    ON CONFLICT (key_hash) DO UPDATE SET
      attempt_count = CASE WHEN login_attempts.window_started_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        THEN 1 ELSE LEAST(login_attempts.attempt_count + 1, 1000000) END,
      window_started_at = CASE WHEN login_attempts.window_started_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        THEN CURRENT_TIMESTAMP ELSE login_attempts.window_started_at END
    RETURNING attempt_count
  `, { bind: [key], type: QueryTypes.SELECT });
  if (!bucket || bucket.attempt_count > 10) throw new ApiError(429, "LOGIN_LIMIT", "Too many sign-in attempts. Please try again in 15 minutes.");
  await db.query("DELETE FROM login_attempts WHERE window_started_at < CURRENT_TIMESTAMP - INTERVAL '1 day'");
}
