import { WorkflowContext, TransactionContext, Transaction, Workflow, DBOSInitializer, InitContext, CommunicatorContext, Communicator } from "../../src/";
import { generateDBOSTestConfig, setUpDBOSTestDb, TestKvTable } from "../helpers";
import { v1 as uuidv1 } from "uuid";
import { DBOSConfig } from "../../src/dbos-executor";
import { PoolClient } from "pg";
import { TestingRuntime, createInternalTestRuntime } from "../../src/testing/testing_runtime";

type TestTransactionContext = TransactionContext<PoolClient>;
const testTableName = "debugger_test_kv";

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
    static cnt: number = 0;

    @DBOSInitializer()
    static async init(ctx: InitContext) {
      await ctx.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
      await ctx.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
    }

    @Transaction()
    static async testFunction(txnCtxt: TestTransactionContext, name: string) {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`, [name]);
      return Number(rows[0].id);
    }

    @Workflow()
    static async testWorkflow(ctxt: WorkflowContext, name: string) {
      const funcResult = await ctxt.invoke(DebuggerTest).testFunction(name);
      return funcResult;
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    @Communicator()
    static async testCommunicator(_ctxt: CommunicatorContext) {
      return ++DebuggerTest.cnt;
    }
  }

  test("debug-workflow", async () => {
    // TODO: connect to the real proxy.
    const debugConfig = generateDBOSTestConfig(undefined, "http://127.0.0.1:5432");
    const debugRuntime = await createInternalTestRuntime([DebuggerTest], debugConfig);

    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    testRuntime = await createInternalTestRuntime([DebuggerTest], config);
    const res = await testRuntime
      .invoke(DebuggerTest, wfUUID)
      .testWorkflow(username)
      .then((x) => x.getResult());
    expect(res).toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    const debugRes = await debugRuntime
      .invoke(DebuggerTest, wfUUID)
      .testWorkflow(username)
      .then((x) => x.getResult());
    expect(debugRes).toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    const nonExist = await debugRuntime.invoke(DebuggerTest, wfUUID2).testWorkflow(username);
    await expect(nonExist.getResult()).rejects.toThrow("Workflow status not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testWorkflow(username)).rejects.toThrow("Workflow UUID not found!");

    await debugRuntime.destroy();
  });

  test("debug-transaction", async () => {
    // TODO: connect to the real proxy.
    const debugConfig = generateDBOSTestConfig(undefined, "http://127.0.0.1:5432");
    const debugRuntime = await createInternalTestRuntime([DebuggerTest], debugConfig);

    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    testRuntime = await createInternalTestRuntime([DebuggerTest], config);
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testFunction(username)).resolves.toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testFunction(username)).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testFunction(username)).rejects.toThrow("This should never happen during debug.");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testFunction(username)).rejects.toThrow("Workflow UUID not found!");

    await debugRuntime.destroy();
  });

  test("debug-communicator", async () => {
    // TODO: connect to the real proxy.
    const debugConfig = generateDBOSTestConfig(undefined, "http://127.0.0.1:5432");
    const debugRuntime = await createInternalTestRuntime([DebuggerTest], debugConfig);

    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    testRuntime = await createInternalTestRuntime([DebuggerTest], config);
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testCommunicator()).resolves.toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testCommunicator()).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testCommunicator()).rejects.toThrow("Cannot find recorded communicator");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testCommunicator()).rejects.toThrow("Workflow UUID not found!");

    await debugRuntime.destroy();
  });
});
