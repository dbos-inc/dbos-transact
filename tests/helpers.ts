import { OperonConfig } from "src";
import { Client } from "pg";

/* DB management helpers */
export function generateOperonTestConfig(exporters?: string[]): OperonConfig {
  const dbPassword: string | undefined =
    process.env.DB_PASSWORD || process.env.PGPASSWORD;
  if (!dbPassword) {
    throw new Error("DB_PASSWORD or PGPASSWORD environment variable not set");
  }

  const operonTestConfig: OperonConfig = {
    poolConfig: {
      host: "localhost",
      port: 5432,
      user: "postgres",
      password: process.env.PGPASSWORD,
      // We can use another way of randomizing the DB name if needed
      database: "operontest",
    },
    application: {
      counter: 3
    },
    telemetryExporters: exporters || [],
    system_database: "operontest_systemdb",
    observability_database: "operontest_observabilitydb",
    httpServer: {
      port: 3000
    }
  };

  return operonTestConfig;
}

export async function setupOperonTestDb(config: OperonConfig) {
  const pgSystemClient = new Client({
    user: config.poolConfig.user,
    port: config.poolConfig.port,
    host: config.poolConfig.host,
    password: config.poolConfig.password,
    database: "postgres",
  });
  await pgSystemClient.connect();
  await pgSystemClient.query(
    `DROP DATABASE IF EXISTS ${config.poolConfig.database};`
  );
  await pgSystemClient.query(`CREATE DATABASE ${config.poolConfig.database};`);
  await pgSystemClient.query(
    `DROP DATABASE IF EXISTS ${config.system_database};`
  );
  await pgSystemClient.query(
    `DROP DATABASE IF EXISTS ${config.observability_database};`
  );
  await pgSystemClient.end();
}

/* Common test types */
export interface TestKvTable {
  id?: number;
  value?: string;
}
