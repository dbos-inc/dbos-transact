import { CommunicatorContext, OperonCommunicator, OperonTestingRuntime, OperonTransaction, OperonWorkflow, TransactionContext, WorkflowContext } from "../src";
import { v1 as uuidv1 } from "uuid";
import { sleep } from "../src/utils";
import { generateOperonTestConfig, setupOperonTestDb } from "./helpers";
import { OperonConfig } from "../src/operon";
import { PoolClient } from "pg";
import { createInternalTestRuntime } from "../src/testing/testing_runtime";

type TestTransactionContext = TransactionContext<PoolClient>;

describe("concurrency-tests", () => {
  const testTableName = "operon_concurrency_test_kv";

  let config: OperonConfig;
  let testRuntime: OperonTestingRuntime;

  beforeAll(async () => {
    config = generateOperonTestConfig();
    await setupOperonTestDb(config);
  });

  beforeEach(async () => {
    testRuntime = await createInternalTestRuntime([ConcurrTestClass], config);
    await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
    await testRuntime.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id INTEGER PRIMARY KEY, value TEXT);`);
    ConcurrTestClass.cnt = 0;
    ConcurrTestClass.wfCnt = 0;
  });

  afterEach(async () => {
    await testRuntime.destroy();
  });

  test("duplicate-transaction", async () => {
    // Run two transactions concurrently with the same UUID.
    // Both should return the correct result but only one should execute.
    const workflowUUID = uuidv1();
    let results = await Promise.allSettled([
      testRuntime.invoke(ConcurrTestClass, workflowUUID).testReadWriteFunction(10),
      testRuntime.invoke(ConcurrTestClass, workflowUUID).testReadWriteFunction(10),
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(10);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(10);
    expect(ConcurrTestClass.cnt).toBe(1);

    // Read-only transactions would execute twice.
    ConcurrTestClass.cnt = 0;

    const readUUID = uuidv1();
    results = await Promise.allSettled([
      testRuntime.invoke(ConcurrTestClass, readUUID).testReadOnlyFunction(12),
      testRuntime.invoke(ConcurrTestClass, readUUID).testReadOnlyFunction(12),
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(12);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(12);
    expect(ConcurrTestClass.cnt).toBe(2);
  });

  test("concurrent-workflow", async () => {
    // Invoke testWorkflow twice with the same UUID and flush workflow output buffer right before the second transaction starts.
    // The second transaction should get the correct recorded execution without being executed.
    const uuid = uuidv1();
    await testRuntime
      .invoke(ConcurrTestClass, uuid)
      .testWorkflow()
      .then((x) => x.getResult());
    const handle = await testRuntime.invoke(ConcurrTestClass, uuid).testWorkflow();
    await ConcurrTestClass.promise2;

    const operon = testRuntime.getOperon();
    await operon.flushWorkflowStatusBuffer();
    ConcurrTestClass.resolve();
    await handle.getResult();

    expect(ConcurrTestClass.cnt).toBe(1);
    expect(ConcurrTestClass.wfCnt).toBe(2);
  });

  test("duplicate-communicator", async () => {
    // Run two communicators concurrently with the same UUID; both should succeed.
    // Since we only record the output after the function, it may cause more than once executions.
    const workflowUUID = uuidv1();
    const results = await Promise.allSettled([
      testRuntime.invoke(ConcurrTestClass, workflowUUID).testCommunicator(11),
      testRuntime.invoke(ConcurrTestClass, workflowUUID).testCommunicator(11),
    ]);
    expect((results[0] as PromiseFulfilledResult<number>).value).toBe(11);
    expect((results[1] as PromiseFulfilledResult<number>).value).toBe(11);

    expect(ConcurrTestClass.cnt).toBeGreaterThanOrEqual(1);
  });

  test("duplicate-notifications", async () => {
    // Run two send/recv concurrently with the same UUID, both should succeed.
    // It's a bit hard to trigger conflicting send because the transaction runs quickly.
    const recvUUID = uuidv1();
    const recvResPromise = Promise.allSettled([
      testRuntime.invoke(ConcurrTestClass, recvUUID).receiveWorkflow( "testTopic", 2).then((x) => x.getResult()),
      testRuntime.invoke(ConcurrTestClass, recvUUID).receiveWorkflow( "testTopic", 2).then((x) => x.getResult()),
    ]);

    // Send would trigger both to receive, but only one can succeed.
    await sleep(10); // Both would be listening to the notification.

    await expect(testRuntime.send(recvUUID, "testmsg", "testTopic")).resolves.toBeFalsy();

    const recvRes = await recvResPromise;
    expect((recvRes[0] as PromiseFulfilledResult<string | null>).value).toBe("testmsg");
    expect((recvRes[1] as PromiseFulfilledResult<string | null>).value).toBe("testmsg");

    const recvHandle = testRuntime.retrieveWorkflow(recvUUID);
    await expect(recvHandle.getResult()).resolves.toBe("testmsg");
  });
});

class ConcurrTestClass {
  static cnt = 0;
  static wfCnt = 0;
  static resolve: () => void;
  static promise = new Promise<void>((r) => {
    ConcurrTestClass.resolve = r;
  });

  static resolve2: () => void;
  static promise2 = new Promise<void>((r) => {
    ConcurrTestClass.resolve2 = r;
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  @OperonTransaction()
  static async testReadWriteFunction(_txnCtxt: TestTransactionContext, id: number) {
    ConcurrTestClass.cnt++;
    return id;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  @OperonTransaction({ readOnly: true })
  static async testReadOnlyFunction(_txnCtxt: TestTransactionContext, id: number) {
    ConcurrTestClass.cnt += 1;
    return id;
  }

  @OperonWorkflow()
  static async testWorkflow(ctxt: WorkflowContext) {
    if (ConcurrTestClass.wfCnt++ === 1) {
      ConcurrTestClass.resolve2();
      await ConcurrTestClass.promise;
    }
    await ctxt.invoke(ConcurrTestClass).testReadWriteFunction(1);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  @OperonCommunicator()
  static async testCommunicator(_ctxt: CommunicatorContext, id: number) {
    ConcurrTestClass.cnt++;
    return id;
  }

  @OperonWorkflow()
  static async receiveWorkflow(ctxt: WorkflowContext, topic: string, timeout: number) {
    return ctxt.recv<string>(topic, timeout);
  }
}
