import { logger } from "../../utils/logger"

/**
 * D1 migrations are applied by Wrangler (`wrangler d1 migrations apply`).
 * The Bun server path keeps this hook so local startup remains compatible,
 * but it no longer performs database DDL itself.
 */
export async function runMigrations(): Promise<void> {
  logger.info("D1 migrations are managed by Wrangler; skipping runtime migrations.")
}
