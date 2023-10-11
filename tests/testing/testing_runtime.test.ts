import { PoolClient } from "pg";
import { TransactionContext } from "../../src/transaction";
import { OperonTestingRuntime, OperonTransaction, OperonWorkflow, WorkflowContext, createTestingRuntime } from "../../src";
import { setupOperonTestDb } from "../helpers";
import { parseConfigFile } from "../../src/operon-runtime/config";

type TestTransactionContext = TransactionContext<PoolClient>;

describe("testruntime-test", () => {
  const username = "postgres";
  const configFilePath = "operon-test-config.yaml";
  let testRuntime: OperonTestingRuntime;

  beforeAll(async () => {
    const [operonConfig] = parseConfigFile({configfile: configFilePath});
    await setupOperonTestDb(operonConfig);

    testRuntime = await createTestingRuntime([TestClass], configFilePath, "info");
  });

  afterAll(async () => {
    await testRuntime.destroy();
  });

  test("simple-workflow", async () => {
    const res = await testRuntime.invoke(TestClass).testWorkflow(username).then(x => x.getResult());
    expect(JSON.parse(res)).toEqual({ current_user: username });
  });

});

class TestClass {
  @OperonTransaction()
  static async testFunction(txnCtxt: TestTransactionContext, name: string) {
    const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
    return JSON.stringify(rows[0]);
  }

  @OperonWorkflow()
  static async testWorkflow(ctxt: WorkflowContext, name: string) {
    const funcResult = await ctxt.invoke(TestClass).testFunction(name);
    return funcResult;
  }
}