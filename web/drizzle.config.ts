/**
 * drizzle.config.ts — saddle v7 drizzle kit configuration (worklog task
 * v7-BACK).
 *
 * a plain typed object with the three fields drizzle-kit expects for a
 * raw-sql sqlite project: the sqlite dialect, the schema file (the same
 * web/init.sql shared with node:sqlite and prisma) and the
 * output directory for generated artifacts. the file intentionally
 * imports nothing so typecheck and boot never depend on drizzle-kit
 * being installed; drizzle-kit reads the default export as-is.
 */

/** the drizzle-kit configuration shape for dialect sqlite. */
export interface drizzleconfig {
  dialect: 'sqlite';
  schema: string;
  out: string;
}

/** the configuration consumed by `drizzle-kit generate` and friends. */
const config: drizzleconfig = {
  dialect: 'sqlite',
  schema: './init.sql',
  out: './drizzleout',
};

export default config;
