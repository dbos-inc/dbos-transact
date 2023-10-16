import { JaegerExporter } from "../src/telemetry/exporters";
import { TRACE_PARENT_HEADER, TRACE_STATE_HEADER } from "@opentelemetry/core";
import { Operon, OperonConfig } from "../src/operon";
import { generateOperonTestConfig, setupOperonTestDb } from "./helpers";
import { OperonTransaction, OperonWorkflow, RequiredRole } from "../src/decorators";
import request from "supertest";
import { GetApi, HandlerContext, OperonTestingRuntime, TransactionContext, WorkflowContext } from "../src";
import { PoolClient } from "pg";
import { createInternalTestRuntime } from "../src/testing/testing_runtime";

/*
type TelemetrySignalDbFields = {
  workflow_uuid: string;
  function_name: string;
  run_as: string;
  timestamp: bigint;
  transaction_id: string;
  severity: string;
  log_message: string;
  trace_id: string;
  trace_span: JSON;
};
*/

type TestTransactionContext = TransactionContext<PoolClient>;

class TestClass {
  @OperonTransaction({ readOnly: false })
  static async test_function(txnCtxt: TestTransactionContext, name: string): Promise<string> {
    const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
    const result = JSON.stringify(rows[0]);
    txnCtxt.logger.info(`transaction result: ${result}`);
    return result;
  }

  @OperonWorkflow()
  @RequiredRole(["operonAppAdmin", "operonAppUser"])
  static async test_workflow(workflowCtxt: WorkflowContext, name: string): Promise<string> {
    const funcResult = await workflowCtxt.invoke(TestClass).test_function(name);
    return funcResult;
  }

  @GetApi("/hello")
  static async hello(_ctx: HandlerContext) {
    return Promise.resolve({ message: "hello!" });
  }
}

describe("operon-telemetry", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Operon init works with all exporters", async () => {
    const operonConfig = generateOperonTestConfig();
    await setupOperonTestDb(operonConfig);
    const operon = new Operon(operonConfig);
    await operon.init();
    await operon.destroy();
  });

  test("collector handles errors gracefully", async () => {
    const operonConfig = generateOperonTestConfig();
    if (operonConfig.telemetry?.traces) {
      operonConfig.telemetry.traces.enabled = true;
    }
    await setupOperonTestDb(operonConfig);
    const operon = new Operon(operonConfig);
    await operon.init(TestClass);

    const collector = operon.telemetryCollector.exporters[0] as JaegerExporter;
    jest.spyOn(collector, "export").mockImplementation(() => {
      throw new Error("exporter crashed");
    });
    // "mute" console.error
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(operon.telemetryCollector.processAndExportSignals()).resolves.not.toThrow();

    await operon.destroy();
  });

  /*
  describe("Postgres exporter", () => {
    let operon: Operon;
    let operonConfig: OperonConfig;
    let testRuntime: OperonTestingRuntime;

    beforeAll(async () => {
      operonConfig = generateOperonTestConfig()
      // This attempts to clear all our DBs, including the observability one
      await setupOperonTestDb(operonConfig);
      testRuntime = await createInternalTestRuntime([TestClass], operonConfig);
      operon = (testRuntime as OperonTestingRuntimeImpl).getOperon();
      expect(operon.telemetryCollector.exporters.length).toBe(1);
      expect(operon.telemetryCollector.exporters[1]).toBeInstanceOf(PostgresExporter);
    });

    afterAll(async () => {
      await testRuntime.destroy();
    });

    test("signal tables are correctly created", async () => {
      const pgExporter = operon.telemetryCollector.exporters[0] as PostgresExporter;
      const pgExporterPgClient = pgExporter.pgClient;
      const stfQueryResult = await pgExporterPgClient.query(`SELECT column_name, data_type FROM information_schema.columns where table_name='signal_test_function';`);
      const expectedStfColumns = [
        {
          column_name: "timestamp",
          data_type: "bigint",
        },
        {
          column_name: "trace_span",
          data_type: "jsonb",
        },
        {
          column_name: "transaction_id",
          data_type: "text",
        },
        {
          column_name: "trace_id",
          data_type: "text",
        },
        {
          column_name: "workflow_uuid",
          data_type: "text",
        },
        {
          column_name: "name",
          data_type: "text",
        },
        {
          column_name: "function_name",
          data_type: "text",
        },
        {
          column_name: "run_as",
          data_type: "text",
        },
      ];
      expect(stfQueryResult.rows).toEqual(expect.arrayContaining(expectedStfColumns));

      const stwQueryResult = await pgExporterPgClient.query(`SELECT column_name, data_type FROM information_schema.columns where table_name='signal_test_workflow';`);
      const expectedStwColumns = [
        {
          column_name: "trace_span",
          data_type: "jsonb",
        },
        {
          column_name: "transaction_id",
          data_type: "text",
        },
        {
          column_name: "timestamp",
          data_type: "bigint",
        },
        {
          column_name: "trace_id",
          data_type: "text",
        },
        {
          column_name: "workflow_uuid",
          data_type: "text",
        },
        {
          column_name: "name",
          data_type: "text",
        },
        {
          column_name: "function_name",
          data_type: "text",
        },
        {
          column_name: "run_as",
          data_type: "text",
        },
      ];
      expect(stwQueryResult.rows).toEqual(expect.arrayContaining(expectedStwColumns));
    });

    test("correctly exports log entries with single workflow single operation", async () => {
      jest.spyOn(console, "log").mockImplementation(); // "mute" console.log
      const username = operonConfig.poolConfig.user as string;
      const workflowHandle: WorkflowHandle<string> = await testRuntime.invoke(TestClass, undefined, {authenticatedRoles: ["operonAppAdmin"], authenticatedUser: "operonAppAdmin"}).test_workflow(username);
      const result: string = await workflowHandle.getResult();

      // Workflow should have executed correctly
      expect(JSON.parse(result)).toEqual({ current_user: username });

      // Exporter should export the log entries
      await operon.telemetryCollector.processAndExportSignals();

      const pgExporter = operon.telemetryCollector.exporters[0] as PostgresExporter;
      const pgExporterPgClient = pgExporter.pgClient;

      // Exporter should export traces
      const txnTraceQueryResult = await pgExporterPgClient.query<TelemetrySignalDbFields>(`SELECT * FROM signal_test_function WHERE trace_id IS NOT NULL`);
      expect(txnTraceQueryResult.rows).toHaveLength(1);
      const txnTraceEntry = txnTraceQueryResult.rows[0];
      expect(txnTraceEntry.trace_id.length).toBe(32);
      expect(txnTraceEntry.trace_span).not.toBe(null);

      const wfTraceQueryResult = await pgExporterPgClient.query<TelemetrySignalDbFields>(`SELECT * FROM signal_test_workflow WHERE trace_id IS NOT NULL`);
      expect(wfTraceQueryResult.rows).toHaveLength(1);
      const wfTraceEntry = wfTraceQueryResult.rows[0];
      expect(wfTraceEntry.trace_id.length).toBe(32);
      expect(wfTraceEntry.trace_span).not.toBe(null);
    });
  });
 */

  describe("http Tracer", () => {
    let config: OperonConfig;
    let testRuntime: OperonTestingRuntime;

    beforeAll(async () => {
      config = generateOperonTestConfig();
      await setupOperonTestDb(config);
    });

    beforeEach(async () => {
      testRuntime = await createInternalTestRuntime([TestClass], config);
    });

    afterEach(async () => {
      await testRuntime.destroy();
    });

    test("Trace context is propagated in and out Operon", async () => {
      const headers = {
        [TRACE_PARENT_HEADER]: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        [TRACE_STATE_HEADER]: "some_state=some_value",
      };

      const response = await request(testRuntime.getHandlersCallback()).get("/hello").set(headers);
      expect(response.statusCode).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.body.message).toBe("hello!");
      // traceId should be the same, spanId should be different (ID of the last operation's span)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.headers.traceparent).toContain("00-4bf92f3577b34da6a3ce929d0e0e4736");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.headers.tracestate).toBe(headers[TRACE_STATE_HEADER]);
    });

    test("New trace context is propagated out of Operon", async () => {
      const response = await request(testRuntime.getHandlersCallback()).get("/hello");
      expect(response.statusCode).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.body.message).toBe("hello!");
      // traceId should be the same, spanId should be different (ID of the last operation's span)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(response.headers.traceparent).not.toBe(null);
    });
  });
});
