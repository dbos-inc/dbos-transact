import { WorkflowContext, TransactionContext, Transaction, Workflow, DBOSInitializer, InitContext, CommunicatorContext, Communicator } from "../../src/";
import { generateDBOSTestConfig, setUpDBOSTestDb, TestKvTable } from "../helpers";
import { v1 as uuidv1 } from "uuid";
import { DBOSConfig } from "../../src/dbos-executor";
import { PoolClient } from "pg";
import { TestingRuntime, TestingRuntimeImpl, createInternalTestRuntime } from "../../src/testing/testing_runtime";

type TestTransactionContext = TransactionContext<PoolClient>;
const testTableName = "debugger_test_kv";

describe("debugger-test", () => {
  let username: string;
  let config: DBOSConfig;
  let debugConfig: DBOSConfig;
  let testRuntime: TestingRuntime;
  let debugRuntime: TestingRuntime;

  beforeAll(async () => {
    config = generateDBOSTestConfig();
    debugConfig = generateDBOSTestConfig(undefined, "http://127.0.0.1:5432");
    username = config.poolConfig.user || "postgres";
    await setUpDBOSTestDb(config);
  });

  beforeEach(async () => {
    // TODO: connect to the real proxy.
    debugRuntime = await createInternalTestRuntime([DebuggerTest], debugConfig);
    testRuntime = await createInternalTestRuntime([DebuggerTest], config);
  });

  afterEach(async () => {
    await debugRuntime.destroy();
    await testRuntime.destroy();
  });

  class DebuggerTest {
    static cnt: number = 0;

    @DBOSInitializer()
    static async init(ctx: InitContext) {
      await ctx.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
      await ctx.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
    }

    @Transaction({readOnly: true})
    static async testReadOnlyFunction(txnCtxt: TestTransactionContext, number: number) {
      const { rows } = await txnCtxt.client.query<{one: number}>(`SELECT 1 AS one`);
      return Number(rows[0].one) + number;
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

    @Workflow()
    static async receiveWorkflow(ctxt: WorkflowContext, debug?: boolean) {
      const message1 = await ctxt.recv<string>();
      const message2 = await ctxt.recv<string>();
      const fail = await ctxt.recv("message3", 0);
      if (debug) {
        await ctxt.recv("shouldn't happen", 0);
      }
      return message1 === "message1" && message2 === "message2" && fail === null;
    }

    @Workflow()
    static async sendWorkflow(ctxt: WorkflowContext, destinationUUID: string, debug?: boolean) {
      await ctxt.send(destinationUUID, "message1");
      await ctxt.send(destinationUUID, "message2");
      if (debug) {
        await ctxt.send(destinationUUID, "message3");
      }
    }

    @Workflow()
    static async setEventWorkflow(ctxt: WorkflowContext, debug?: boolean) {
      await ctxt.setEvent("key1", "value1");
      await ctxt.setEvent("key2", "value2");
      if (debug) {
        await ctxt.setEvent("key3", "value3");
      }
      return 0;
    }

    @Workflow()
    static async getEventWorkflow(ctxt: WorkflowContext, targetUUID: string, debug?: boolean) {
      const val1 = await ctxt.getEvent<string>(targetUUID, "key1");
      const val2 = await ctxt.getEvent<string>(targetUUID, "key2");
      if (debug) {
        await ctxt.getEvent(targetUUID, "key3");
      }
      return val1 + "-" + val2;
    }
  }

  test("debug-workflow", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
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

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    const nonExist = await debugRuntime.invoke(DebuggerTest, wfUUID2).testWorkflow(username);
    await expect(nonExist.getResult()).rejects.toThrow("Workflow status not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testWorkflow(username)).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-transaction", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testFunction(username)).resolves.toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testFunction(username)).resolves.toBe(1);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testFunction(username)).rejects.toThrow("This should never happen during debug.");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testFunction(username)).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-read-only-transaction", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testReadOnlyFunction(1)).resolves.toBe(2);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testReadOnlyFunction(1)).resolves.toBe(2);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(2);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testReadOnlyFunction(1)).rejects.toThrow("This should never happen during debug.");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testReadOnlyFunction(1)).rejects.toThrow("Workflow UUID not found!");
  });


  test("debug-communicator", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testCommunicator()).resolves.toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testCommunicator()).resolves.toBe(1);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testCommunicator()).rejects.toThrow("Cannot find recorded communicator");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testCommunicator()).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-workflow-notifications", async() => {
    const recvUUID = uuidv1();
    const sendUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    const handle = await testRuntime.invoke(DebuggerTest, recvUUID).receiveWorkflow(false);
    await expect(testRuntime.invoke(DebuggerTest, sendUUID).sendWorkflow(recvUUID, false).then((x) => x.getResult())).resolves.toBeFalsy(); // return void.
    expect(await handle.getResult()).toBe(true);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, recvUUID).receiveWorkflow(false).then((x) => x.getResult())).resolves.toBe(true);
    await expect(debugRuntime.invoke(DebuggerTest, sendUUID).sendWorkflow(recvUUID, false).then((x) => x.getResult())).resolves.toBeFalsy();

    // Execute a non-exist function ID should fail.
    await expect(debugRuntime.invoke(DebuggerTest, sendUUID).sendWorkflow(recvUUID, true).then((x) => x.getResult())).rejects.toThrow("Cannot find recorded send");
    await expect(debugRuntime.invoke(DebuggerTest, recvUUID).receiveWorkflow(true).then((x) => x.getResult())).rejects.toThrow("Cannot find recorded recv");
  });

  test("debug-workflow-events", async() => {
    const getUUID = uuidv1();
    const setUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, setUUID).setEventWorkflow(false).then((x) => x.getResult())).resolves.toBe(0);
    await expect(testRuntime.invoke(DebuggerTest, getUUID).getEventWorkflow(setUUID, false).then((x) => x.getResult())).resolves.toBe("value1-value2");
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, setUUID).setEventWorkflow(false).then((x) => x.getResult())).resolves.toBe(0);
    await expect(debugRuntime.invoke(DebuggerTest, getUUID).getEventWorkflow(setUUID, false).then((x) => x.getResult())).resolves.toBe("value1-value2");

    // Execute a non-exist function ID should fail.
    await expect(debugRuntime.invoke(DebuggerTest, setUUID).setEventWorkflow(true).then((x) => x.getResult())).rejects.toThrow("Cannot find recorded setEvent");
    await expect(debugRuntime.invoke(DebuggerTest, getUUID).getEventWorkflow(setUUID, true).then((x) => x.getResult())).rejects.toThrow("Cannot find recorded getEvent");
  });
});
