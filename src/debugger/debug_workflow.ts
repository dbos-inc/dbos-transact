 import { DBOSExecutor, DBOSNull, OperationType, dbosNull } from "../dbos-executor";
import { transaction_outputs } from "../../schemas/user_db_schema";
import { Transaction, TransactionContextImpl } from "../transaction";
import { Communicator } from "../communicator";
import { DBOSDebuggerError, DBOSError } from "../error";
import { deserializeError } from "serialize-error";
import { SystemDatabase } from "../system_database";
import { UserDatabaseClient } from "../user_database";
import { Span } from "@opentelemetry/sdk-trace-base";
import { DBOSContextImpl } from "../context";
import { ConfiguredClass, getRegisteredOperations } from "../decorators";
import { WFInvokeFuncs, Workflow, WorkflowConfig, WorkflowContext, WorkflowHandle, WorkflowStatus } from "../workflow";
import { InvokeFuncsConf } from "../httpServer/handler";

interface RecordedResult<R> {
  output: R;
  txn_snapshot: string;
  txn_id: string;
}

/**
 * Context used for debugging a workflow
 */
export class WorkflowContextDebug extends DBOSContextImpl implements WorkflowContext {
  functionID: number = 0;
  readonly #dbosExec;
  readonly isTempWorkflow: boolean;

  constructor(dbosExec: DBOSExecutor, parentCtx: DBOSContextImpl | undefined, workflowUUID: string, readonly workflowConfig: WorkflowConfig,
    workflowName: string, readonly configuredClass: ConfiguredClass<unknown> | null)
  {
    const span = dbosExec.tracer.startSpan(
      workflowName,
      {
        operationUUID: workflowUUID,
        operationType: OperationType.WORKFLOW,
        authenticatedUser: parentCtx?.authenticatedUser ?? "",
        authenticatedRoles: parentCtx?.authenticatedRoles ?? [],
        assumedRole: parentCtx?.assumedRole ?? "",
      },
      parentCtx?.span,
    );
    super(workflowName, span, dbosExec.logger, parentCtx);
    this.workflowUUID = workflowUUID;
    this.#dbosExec = dbosExec;
    this.isTempWorkflow = DBOSExecutor.tempWorkflowName === workflowName;
    this.applicationConfig = dbosExec.config.application;
  }

  getClassConfig<T>(): T {
    if (!this.configuredClass) throw new DBOSError(`Configuration is required for ${this.operationName} but was not provided.  Was the method invoked with 'invoke' instead of 'invokeOnConfig'?`);
    return this.configuredClass.arg as T;
  }
  getConfiguredClass<C, T=unknown>() {
    if (!this.configuredClass) throw new DBOSError(`Configuration is required for ${this.operationName} but was not provided.  Was the method invoked with 'invoke' instead of 'invokeOnConfig'?`);
    return this.configuredClass as ConfiguredClass<C, T>;
  }

  functionIDGetIncrement(): number {
    return this.functionID++;
  }

  invoke<T extends object>(object: T): WFInvokeFuncs<T> {
    const ops = getRegisteredOperations(object);
    const proxy: Record<string, unknown> = {};

    for (const op of ops) {
      proxy[op.name] = op.txnConfig
        ?
        (...args: unknown[]) => this.transaction(op.registeredFunction as Transaction<unknown>, null, ...args)
        : op.commConfig
          ?
          (...args: unknown[]) => this.external(op.registeredFunction as Communicator<unknown>, null, ...args)
          : undefined;
    }
    return proxy as WFInvokeFuncs<T>;
  }

  async checkExecution<R>(client: UserDatabaseClient, funcID: number): Promise<RecordedResult<R> | Error> {
    // Note: we read the recorded snapshot and transaction ID!
    const query = "SELECT output, error, txn_snapshot, txn_id FROM dbos.transaction_outputs WHERE workflow_uuid=$1 AND function_id=$2";

    const rows = await this.#dbosExec.userDatabase.queryWithClient<transaction_outputs>(client, query, this.workflowUUID, funcID);

    if (rows.length === 0 || rows.length > 1) {
      this.logger.error("Unexpected! This should never happen during debug. Found incorrect rows for transaction output.  Returned rows: " + rows.toString() + `. WorkflowUUID ${this.workflowUUID}, function ID ${funcID}`);
      throw new DBOSDebuggerError(`This should never happen during debug. Found incorrect rows for transaction output. Returned ${rows.length} rows: ` + rows.toString());
    }

    if (JSON.parse(rows[0].error) != null) {
      return deserializeError(JSON.parse(rows[0].error));
    }

    const res: RecordedResult<R> = {
      output: JSON.parse(rows[0].output) as R,
      txn_snapshot: rows[0].txn_snapshot,
      txn_id: rows[0].txn_id,
    };

    if (this.#dbosExec.debugProxy) {
      // Send a signal to the debug proxy.
      await this.#dbosExec.userDatabase.queryWithClient(client, `--proxy:${res.txn_id ?? ''}:${res.txn_snapshot}`);
    }

    return res;
  }

  /**
   * Execute a transactional function in debug mode.
   * If a debug proxy is provided, it connects to a debug proxy and everything should be read-only.
   */
  async transaction<R>(txn: Transaction<R>, cfcls: ConfiguredClass<unknown> | null,  ...args: unknown[]): Promise<R> {
    const txnInfo = this.#dbosExec.getTransactionInfo(txn as Transaction<unknown>);
    if (txnInfo === undefined) {
      throw new DBOSDebuggerError(`Transaction ${txn.name} not registered!`);
    }
    // const readOnly = true; // TODO: eventually, this transaction must be read-only.
    const funcID = this.functionIDGetIncrement();
    const span: Span = this.#dbosExec.tracer.startSpan(
      txn.name,
      {
        operationUUID: this.workflowUUID,
        operationType: OperationType.TRANSACTION,
        authenticatedUser: this.authenticatedUser,
        authenticatedRoles: this.authenticatedRoles,
        assumedRole: this.assumedRole,
        readOnly: txnInfo.config.readOnly ?? false, // For now doing as in src/workflow.ts:272
        isolationLevel: txnInfo.config.isolationLevel,
      },
      this.span
    );

    let check: RecordedResult<R> | Error;
    const wrappedTransaction = async (client: UserDatabaseClient): Promise<R> => {
      // Original result must exist during replay.
      const tCtxt = new TransactionContextImpl(this.#dbosExec.userDatabase.getName(), client, this, span, this.#dbosExec.logger, funcID, txn.name, cfcls);
      check = await this.checkExecution<R>(client, funcID);

      if (check instanceof Error) {
        if (this.#dbosExec.debugProxy) {
          this.logger.warn(`original transaction ${txn.name} failed with error: ${check.message}`);
        } else {
          throw check; // In direct mode, directly throw the error.
        }
      }

      if (!this.#dbosExec.debugProxy) {
        // Direct mode skips execution and return the recorded result.
        return (check as RecordedResult<R>).output;
      }
      // If we have a proxy, then execute the user's transaction.
      const result = await txn(tCtxt, ...args);
      return result;
    };

    let result: Awaited<R> | Error;
    try {
      result = await this.#dbosExec.userDatabase.transaction(wrappedTransaction, txnInfo.config);
    } catch (e) {
      result = e as Error;
    }

    check = check!;
    result = result!;

    if (check instanceof Error) {
      throw check;
    }

    // If returned nothing and the recorded value is also null/undefined, we just return it
    if (result === undefined && !check.output) {
      return result;
    }

    if (JSON.stringify(check.output) !== JSON.stringify(result)) {
      this.logger.error(`Detected different transaction output than the original one!\n Result: ${JSON.stringify(result)}\n Original: ${JSON.stringify(check.output)}`);
    }
    return check.output; // Always return the recorded result.
  }

  async external<R>(commFn: Communicator<R>, _clscfg: ConfiguredClass<unknown> | null, ..._args: unknown[]): Promise<R> {
    const commConfig = this.#dbosExec.getCommunicatorInfo(commFn as Communicator<unknown>);
    if (commConfig === undefined) {
      throw new DBOSDebuggerError(`Communicator ${commFn.name} not registered!`);
    }
    const funcID = this.functionIDGetIncrement();

    // FIXME: we do not create a span for the replay communicator. Do we want to?

    // Original result must exist during replay.
    const check: R | DBOSNull = await this.#dbosExec.systemDatabase.checkOperationOutput<R>(this.workflowUUID, funcID);
    if (check === dbosNull) {
      throw new DBOSDebuggerError(`Cannot find recorded communicator output for ${commFn.name}. Shouldn't happen in debug mode!`);
    }
    this.logger.debug("Use recorded communicator output.");
    return check as R;
  }

  // Invoke the debugWorkflow() function instead.
  async startChildWorkflow<R>(wf: Workflow<R>, ...args: unknown[]): Promise<WorkflowHandle<R>> {
    const funcId = this.functionIDGetIncrement();
    const childUUID: string = this.workflowUUID + "-" + funcId;
    return this.#dbosExec.debugWorkflow(wf, { parentCtx: this, workflowUUID: childUUID, classConfig: null }, this.workflowUUID, funcId, ...args);
  }

  async invokeChildWorkflow<R>(wf: Workflow<R>, ...args: unknown[]): Promise<R> {
    return this.startChildWorkflow(wf, ...args).then((handle) => handle.getResult());
  }

  // Deprecated
  async childWorkflow<R>(wf: Workflow<R>, ...args: unknown[]): Promise<WorkflowHandle<R>> {
    return this.startChildWorkflow(wf, ...args);
  }

  invokeOnConfig<T extends object>(targetCfg: ConfiguredClass<T>): InvokeFuncsConf<T> {
    const ops = getRegisteredOperations(targetCfg.ctor);

    const proxy: Record<string, unknown> = {};
    for (const op of ops) {
      proxy[op.name] = op.txnConfig
        ?
        (...args: unknown[]) => this.transaction(op.registeredFunction as Transaction<unknown>, targetCfg, ...args)
        : op.commConfig
          ?
          (...args: unknown[]) => this.external(op.registeredFunction as Communicator<unknown>, targetCfg, ...args)
          : undefined;
    }
    return proxy as InvokeFuncsConf<T>;
  }

  async startChildWorkflowOnConfig<R>(targetCfg: ConfiguredClass<unknown>, wf: Workflow<R>, ...args: unknown[]): Promise<WorkflowHandle<R>> {
    const funcId = this.functionIDGetIncrement();
    const childUUID: string = this.workflowUUID + "-" + funcId;
    return this.#dbosExec.debugWorkflow(wf, { parentCtx: this, workflowUUID: childUUID, classConfig: targetCfg }, this.workflowUUID, funcId, ...args);
  }

  async invokeChildWorkflowOnConfig<R>(targetCfg: ConfiguredClass<unknown>, wf: Workflow<R>, ...args: unknown[]): Promise<R> {
    return this.startChildWorkflowOnConfig(targetCfg, wf, ...args).then((handle) => handle.getResult());
  }

  async send(_destinationUUID: string, _message: NonNullable<unknown>, _topic?: string | undefined): Promise<void> {
    const functionID: number = this.functionIDGetIncrement();

    // Original result must exist during replay.
    const check: undefined | DBOSNull = await this.#dbosExec.systemDatabase.checkOperationOutput<undefined>(this.workflowUUID, functionID);
    if (check === dbosNull) {
      throw new DBOSDebuggerError(`Cannot find recorded send. Shouldn't happen in debug mode!`);
    }
    this.logger.debug("Use recorded send output.");
    return;
  }

  async recv<T extends NonNullable<unknown>>(_topic?: string | undefined, _timeoutSeconds?: number | undefined): Promise<T | null> {
    const functionID: number = this.functionIDGetIncrement();

    // Original result must exist during replay.
    const check: T | null | DBOSNull = await this.#dbosExec.systemDatabase.checkOperationOutput<T | null>(this.workflowUUID, functionID);
    if (check === dbosNull) {
      throw new DBOSDebuggerError(`Cannot find recorded recv. Shouldn't happen in debug mode!`);
    }
    this.logger.debug("Use recorded recv output.");
    return check as T | null;
  }

  async setEvent(_key: string, _value: NonNullable<unknown>): Promise<void> {
    const functionID: number = this.functionIDGetIncrement();
    // Original result must exist during replay.
    const check: undefined | DBOSNull = await this.#dbosExec.systemDatabase.checkOperationOutput<undefined>(this.workflowUUID, functionID);
    if (check === dbosNull) {
      throw new DBOSDebuggerError(`Cannot find recorded setEvent. Shouldn't happen in debug mode!`);
    }
    this.logger.debug("Use recorded setEvent output.");
  }

  async getEvent<T extends NonNullable<unknown>>(_workflowUUID: string, _key: string, _timeoutSeconds?: number | undefined): Promise<T | null> {
    const functionID: number = this.functionIDGetIncrement();

    // Original result must exist during replay.
    const check: T | null | DBOSNull = await this.#dbosExec.systemDatabase.checkOperationOutput<T | null>(this.workflowUUID, functionID);
    if (check === dbosNull) {
      throw new DBOSDebuggerError(`Cannot find recorded getEvent. Shouldn't happen in debug mode!`);
    }
    this.logger.debug("Use recorded getEvent output.");
    return check as T | null;
  }

  retrieveWorkflow<R>(targetUUID: string): WorkflowHandle<R> {
    // TODO: write a proper test for this.
    const functionID: number = this.functionIDGetIncrement();
    return new RetrievedHandleDebug(this.#dbosExec.systemDatabase, targetUUID, this.workflowUUID, functionID);
  }

  async sleepms(_: number): Promise<void> {
    // Need to increment function ID for faithful replay.
    this.functionIDGetIncrement();
    return Promise.resolve();
  }
  async sleep(s: number): Promise<void> {
    return this.sleepms(s*1000);
  }
}

/**
 * The handle returned when retrieving a workflow with Debug workflow's retrieve
 */
class RetrievedHandleDebug<R> implements WorkflowHandle<R> {
  constructor(readonly systemDatabase: SystemDatabase, readonly workflowUUID: string, readonly callerUUID: string, readonly callerFunctionID: number) { }

  getWorkflowUUID(): string {
    return this.workflowUUID;
  }

  async getStatus(): Promise<WorkflowStatus | null> {
    // Must use original result.
    const check: WorkflowStatus | null | DBOSNull = await this.systemDatabase.checkOperationOutput<WorkflowStatus | null>(this.callerUUID, this.callerFunctionID);
    if (check === dbosNull) {
      throw new DBOSDebuggerError(`Cannot find recorded workflow status. Shouldn't happen in debug mode!`);
    }
    return check as WorkflowStatus | null;
  }

  async getResult(): Promise<R> {
    return await this.systemDatabase.getWorkflowResult<R>(this.workflowUUID);
  }
}
