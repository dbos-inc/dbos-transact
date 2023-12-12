import { DBOSConfig, DBOSExecutor } from "../dbos-executor";
import { DBOSRuntime, DBOSRuntimeConfig,  } from "./runtime";

export async function debugWorkflow(dbosConfig: DBOSConfig, runtimeConfig: DBOSRuntimeConfig, proxy: string, workflowUUID: string) {
  dbosConfig = {...dbosConfig, debugProxy: proxy, system_database: "dbos_systemdb"};
  dbosConfig.poolConfig.database = `${dbosConfig.poolConfig.database}_prov`;

  // Point to the correct system DB schema.
  DBOSExecutor.systemDBSchemaName = "dbos_system";

  // Load classes
  const classes = await DBOSRuntime.loadClasses(runtimeConfig.entrypoint);
  const dbosExec = new DBOSExecutor(dbosConfig);
  await dbosExec.init(...classes);

  // Invoke the workflow in debug mode.
  const handle = await dbosExec.executeWorkflowUUID(workflowUUID);
  await handle.getResult();

  // Destroy testing runtime.
  await dbosExec.destroy();
}
