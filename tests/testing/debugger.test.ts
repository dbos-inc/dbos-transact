import { WorkflowContext, TransactionContext, CommunicatorContext, WorkflowHandle, Transaction, Workflow, Communicator, DBOSInitializer, InitContext } from "../../src/";
import { generateDBOSTestConfig, setUpDBOSTestDb, TestKvTable } from "../helpers";
import { v1 as uuidv1 } from "uuid";
import { StatusString } from "../../src/workflow";
import { DBOSConfig } from "../../src/dbos-executor";
import { PoolClient } from "pg";
import { TestingRuntime, TestingRuntimeImpl, createInternalTestRuntime } from "../../src/testing/testing_runtime";
import { DBOSDebuggerError } from "../../src/error";

type TestTransactionContext = TransactionContext<PoolClient>;

describe("debugger-test", () => {
  let username: string;
  let config: DBOSConfig;
  let testRuntime: TestingRuntime;

  beforeAll(async () => {
    config = generateDBOSTestConfig();
    username = config.poolConfig.user || "postgres";
    await setUpDBOSTestDb(config);
  });

  class DebuggerTest {
    @Transaction()
    static async testFunction(txnCtxt: TestTransactionContext, name: string) {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      txnCtxt.logger.debug("Name: " + name);
      return JSON.stringify(rows[0]);
    }

    @Workflow()
    static async testWorkflow(ctxt: WorkflowContext, name: string) {
      const funcResult = await ctxt.invoke(DebuggerTest).testFunction(name);
      return funcResult;
    }
  }

  test("debug-workflow", async () => {
    process.env["SILENCE_LOGS"] = "false";
    const debugConfig = generateDBOSTestConfig(undefined, "127.0.0.1:5432");
    const debugRuntime = await createInternalTestRuntime([DebuggerTest], debugConfig);

    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    testRuntime = await createInternalTestRuntime([DebuggerTest], config);
    const res = await testRuntime
      .invoke(DebuggerTest, wfUUID)
      .testWorkflow(username)
      .then((x) => x.getResult());
    expect(JSON.parse(res)).toEqual({ current_user: username });
    await testRuntime.destroy();

    // Execute again in debug mode.
    // TODO: test with a real proxy.
    const debugRes = await debugRuntime
      .invoke(DebuggerTest, wfUUID)
      .testWorkflow(username)
      .then((x) => x.getResult());
    expect(JSON.parse(debugRes)).toEqual({ current_user: username });

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    const nonExist = await debugRuntime
    .invoke(DebuggerTest, wfUUID2)
    .testWorkflow(username);
    await expect(nonExist.getResult()).rejects.toThrow("Workflow status not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime
      .invoke(DebuggerTest)
      .testWorkflow(username)).rejects.toThrow("Workflow UUID not found!");

    await debugRuntime.destroy();
  });
});
