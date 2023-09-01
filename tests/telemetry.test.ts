import {
  ConsoleExporter,
  PostgresExporter,
  POSTGRES_EXPORTER,
  TelemetryCollector,
  CONSOLE_EXPORTER,
} from "../src/telemetry/index.js";
import { TelemetrySignal } from "../src/telemetry/signals.js";
import { Operon, OperonConfig } from "../src/operon.js";
import { generateOperonTestConfig, setupOperonTestDb } from "./helpers.js";
import { Traced, OperonTransaction, OperonWorkflow } from "../src/decorators.js";
import { TransactionContext, WorkflowContext, WorkflowParams } from "../src/index.js";
import { WorkflowHandle } from "../src/workflow.js";

type TelemetrySignalDbFields = {
  workflow_uuid: string;
  function_id: number;
  function_name: string;
  run_as: string;
  timestamp: bigint;
  transaction_id: string;
  severity: string;
  log_message: string;
  trace_id: string;
  trace_span: JSON;
};

class TestClass {
  @Traced
  static create_user(
    name: string,
    age: number,
    isNice: boolean,
    udfParam: TelemetrySignalDbFields
  ): Promise<string> {
    console.log(name, age, isNice, udfParam);
    return Promise.resolve(name);
  }

  @OperonTransaction({ readOnly: false })
  static async test_function(
    txnCtxt: TransactionContext,
    name: string
  ): Promise<string> {
    const { rows } = await txnCtxt.pgClient.query(
      `select current_user from current_user where current_user=$1;`,
      [name]
    );
    const result = JSON.stringify(rows[0]);
    txnCtxt.log("INFO", `transaction result: ${result}`);
    return result;
  }

  @OperonWorkflow({ rolesThatCanRun: ["operonAppAdmin", "operonAppUser"] })
  static async test_workflow(
    workflowCtxt: WorkflowContext,
    name: string
  ): Promise<string> {
    const funcResult: string = await workflowCtxt.transaction(
      TestClass.test_function,
      name
    );
    workflowCtxt.log("INFO", `workflow result: ${funcResult}`);
    return funcResult;
  }
}

describe("operon-telemetry", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Operon init works with all exporters", async () => {
    const operonConfig = generateOperonTestConfig([
      CONSOLE_EXPORTER,
      POSTGRES_EXPORTER,
    ]);
    const operon = new Operon(operonConfig);
    operon.useNodePostgres();
    await operon.init();
    await operon.destroy();
  });

  test("collector handles errors gracefully", async () => {
    const operonConfig = generateOperonTestConfig([POSTGRES_EXPORTER]);
    const operon = new Operon(operonConfig);
    operon.registerDecoratedWT();
    operon.useNodePostgres();
    await operon.init();

    const collector = operon.telemetryCollector
      .exporters[0] as PostgresExporter;
    jest.spyOn(collector, "process").mockImplementation(() => {
      throw new Error("exporter crashed");
    });
    // "mute" console.error
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      operon.telemetryCollector.processAndExportSignals()
    ).resolves.not.toThrow();

    await operon.destroy();
  });

  describe("Console exporter", () => {
    let operon: Operon;
    const operonConfig = generateOperonTestConfig([CONSOLE_EXPORTER]);
    let collector: TelemetryCollector;

    beforeEach(() => {
      operon = new Operon(operonConfig);
      operon.registerDecoratedWT();
      operon.useNodePostgres();
    });

    afterEach(async () => {
      await collector.destroy();
      await operon.destroy();
    });

    test("console.log is called with the correct messages", async () => {
      collector = operon.telemetryCollector;
      expect(collector.exporters.length).toBe(1);
      expect(collector.exporters[0]).toBeInstanceOf(ConsoleExporter);

      await collector.init();
      const logSpy = jest.spyOn(global.console, "log").mockImplementation(); // "mute" console.log

      const signal1: TelemetrySignal = {
        workflowUUID: "test",
        operationName: "create_user",
        functionID: 0,
        runAs: "test",
        timestamp: Date.now(),
        severity: "INFO",
        logMessage: "test",
      };
      const signal2 = { ...signal1 };
      signal2.logMessage = "test2";
      collector.push(signal1);
      collector.push(signal2);
      await collector.processAndExportSignals();
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(logSpy).toHaveBeenNthCalledWith(
        1,
        `[${signal1.severity}] ${signal1.logMessage}`
      );
      expect(logSpy).toHaveBeenNthCalledWith(
        2,
        `[${signal1.severity}] ${signal2.logMessage}`
      );
    });
  });

  describe("Postgres exporter", () => {
    let operon: Operon;
    let operonConfig: OperonConfig;
    beforeAll(async () => {
      operonConfig = generateOperonTestConfig([POSTGRES_EXPORTER]);
      operon = new Operon(operonConfig);
      operon.registerDecoratedWT();
      operon.useNodePostgres();
      await operon.init();
      expect(operon.telemetryCollector.exporters.length).toBe(1);
      expect(operon.telemetryCollector.exporters[0]).toBeInstanceOf(
        PostgresExporter
      );
    });

    afterAll(async () => {
      await operon.destroy();
      // This attempts to clear all our DBs, including the observability one
      await setupOperonTestDb(operonConfig);
    });

    test("signal tables are correctly created", async () => {
      const pgExporter = operon.telemetryCollector
        .exporters[0] as PostgresExporter;
      const pgExporterPgClient = pgExporter.pgClient;
      const stfQueryResult = await pgExporterPgClient.query(
        `SELECT column_name, data_type FROM information_schema.columns where table_name='signal_test_function';`
      );
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
          column_name: "function_id",
          data_type: "integer",
        },
        {
          column_name: "transaction_id",
          data_type: "text"
        },
        {
          column_name: "severity",
          data_type: "text",
        },
        {
          column_name: "log_message",
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

      const stwQueryResult = await pgExporterPgClient.query(
        `SELECT column_name, data_type FROM information_schema.columns where table_name='signal_test_workflow';`
      );
      const expectedStwColumns = [
        {
          column_name: "function_id",
          data_type: "integer",
        },
        {
          column_name: "trace_span",
          data_type: "jsonb",
        },
        {
          column_name: "transaction_id",
          data_type: "text"
        },
        {
          column_name: "timestamp",
          data_type: "bigint",
        },
        {
          column_name: "severity",
          data_type: "text",
        },
        {
          column_name: "log_message",
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
      expect(stwQueryResult.rows).toEqual(expect.arrayContaining(expectedStwColumns));
      const scuQueryResult = await pgExporterPgClient.query(
        `SELECT column_name, data_type FROM information_schema.columns where table_name='signal_create_user';`
      );
      const expectedScuColumns = [
        {
          column_name: "function_id",
          data_type: "integer",
        },
        {
          column_name: "trace_span",
          data_type: "jsonb",
        },
        {
          column_name: "timestamp",
          data_type: "bigint",
        },
        {
          column_name: "transaction_id",
          data_type: "text"
        },
        {
          column_name: "age",
          data_type: "double precision",
        },
        {
          column_name: "isnice",
          data_type: "boolean",
        },
        {
          column_name: "udfparam",
          data_type: "json",
        },
        {
          column_name: "name",
          data_type: "text",
        },
        {
          column_name: "log_message",
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
        {
          column_name: "severity",
          data_type: "text",
        },
        {
          column_name: "workflow_uuid",
          data_type: "text",
        },
        {
          column_name: "trace_id",
          data_type: "text",
        },
      ];
      expect(scuQueryResult.rows).toEqual(expect.arrayContaining(expectedScuColumns));
    });

    test("correctly exports log entries with single workflow single operation", async () => {
      jest.spyOn(console, "log").mockImplementation(); // "mute" console.log
      const params: WorkflowParams = {
        runAs: "operonAppAdmin",
      };
      const username = operonConfig.poolConfig.user as string;
      const workflowHandle: WorkflowHandle<string> = operon.workflow(
        TestClass.test_workflow,
        params,
        username
      );
      const workflowUUID = workflowHandle.getWorkflowUUID();
      const result: string = await workflowHandle.getResult();

      // Workflow should have executed correctly
      expect(JSON.parse(result)).toEqual({ current_user: username });

      // Exporter should export the log entries
      await operon.telemetryCollector.processAndExportSignals();

      const pgExporter = operon.telemetryCollector
        .exporters[0] as PostgresExporter;
      const pgExporterPgClient = pgExporter.pgClient;

      const txnLogQueryResult =
        await pgExporterPgClient.query<TelemetrySignalDbFields>(
          `SELECT * FROM signal_test_function WHERE log_message IS NOT NULL`
        );
      expect(txnLogQueryResult.rows).toHaveLength(1);
      const txnLogEntry = txnLogQueryResult.rows[0];
      expect(txnLogEntry.workflow_uuid).toBe(workflowUUID);
      expect(txnLogEntry.function_id).toBe(1);
      expect(txnLogEntry.function_name).toBe("test_function");
      expect(txnLogEntry.run_as).toBe(params.runAs);
      expect(txnLogEntry.severity).toBe("INFO");
      expect(txnLogEntry.log_message).toBe(`transaction result: ${result}`);
      expect(txnLogEntry.trace_id).toBe(null);
      expect(txnLogEntry.trace_span).toBe(null);

      const wfLogQueryResult =
        await pgExporterPgClient.query<TelemetrySignalDbFields>(
          `SELECT * FROM signal_test_workflow WHERE log_message IS NOT NULL`
        );
      expect(wfLogQueryResult.rows).toHaveLength(1);
      const wfLogEntry = wfLogQueryResult.rows[0];
      expect(wfLogEntry.workflow_uuid).toBe(workflowUUID);
      expect(wfLogEntry.function_id).toBe(2);
      expect(wfLogEntry.function_name).toBe("test_workflow");
      expect(wfLogEntry.run_as).toBe(params.runAs);
      expect(wfLogEntry.severity).toBe("INFO");
      expect(wfLogEntry.log_message).toBe(`workflow result: ${result}`);
      expect(wfLogEntry.trace_id).toBe(null);
      expect(wfLogEntry.trace_span).toBe(null);

      // Exporter should export traces
      const txnTraceQueryResult =
        await pgExporterPgClient.query<TelemetrySignalDbFields>(
          `SELECT * FROM signal_test_function WHERE trace_id IS NOT NULL`
        );
      expect(txnTraceQueryResult.rows).toHaveLength(1);
      const txnTraceEntry = txnTraceQueryResult.rows[0];
      expect(txnTraceEntry.trace_id.length).toBe(32);
      expect(txnTraceEntry.log_message).toBe(null);
      expect(txnTraceEntry.severity).toBe(null);
      expect(txnTraceEntry.trace_span).not.toBe(null);

      const wfTraceQueryResult =
        await pgExporterPgClient.query<TelemetrySignalDbFields>(
          `SELECT * FROM signal_test_workflow WHERE trace_id IS NOT NULL`
        );
      expect(wfTraceQueryResult.rows).toHaveLength(1);
      const wfTraceEntry = wfTraceQueryResult.rows[0];
      expect(wfTraceEntry.trace_id.length).toBe(32);
      expect(wfTraceEntry.log_message).toBe(null);
      expect(wfTraceEntry.severity).toBe(null);
      expect(wfTraceEntry.trace_span).not.toBe(null);
    });
  });
});
