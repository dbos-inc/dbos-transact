/* eslint-disable @typescript-eslint/no-explicit-any */

import { deserializeError, serializeError } from "serialize-error";
import { Operon, OperonNull, operonNull } from "../operon";
import { SystemDatabase } from "../system_database";
import { StatusString, WorkflowStatus } from "../workflow";
import * as fdb from "foundationdb";
import { OperonDuplicateWorkflowEventError, OperonWorkflowConflictUUIDError } from "../error";
import { NativeValue } from "foundationdb/dist/lib/native";
import { HTTPRequest } from "../context";

interface WorkflowOutput<R> {
  status: string;
  error: string;
  output: R;
  name: string;
  authenticatedUser: string;
  authenticatedRoles: Array<string>;
  assumedRole: string;
  request: HTTPRequest;
}

interface OperationOutput<R> {
  output: R;
  error: string;
}

const Tables = {
  WorkflowStatus: "operon_workflow_status",
  OperationOutputs: "operon_operation_outputs",
  Notifications: "operon_notifications",
  WorkflowEvents: "workflow_events",
  WorkflowInpus: "workflow_inputs"
} as const;

export class FoundationDBSystemDatabase implements SystemDatabase {
  dbRoot: fdb.Database<NativeValue, Buffer, NativeValue, Buffer>;
  workflowStatusDB: fdb.Database<string, string, unknown, unknown>;
  operationOutputsDB: fdb.Database<fdb.TupleItem, fdb.TupleItem, unknown, unknown>;
  notificationsDB: fdb.Database<fdb.TupleItem, fdb.TupleItem, unknown, unknown>;
  workflowEventsDB: fdb.Database<fdb.TupleItem, fdb.TupleItem, unknown, unknown>;
  workflowInputsDB: fdb.Database<string, string, unknown, unknown>;

  readonly workflowStatusBuffer: Map<string, unknown> = new Map();

  constructor() {
    fdb.setAPIVersion(710, 710);
    this.dbRoot = fdb.open();
    this.workflowStatusDB = this.dbRoot
      .at(Tables.WorkflowStatus)
      .withKeyEncoding(fdb.encoders.string) // We use workflowUUID as the key
      .withValueEncoding(fdb.encoders.json); // and values using JSON
    this.operationOutputsDB = this.dbRoot
      .at(Tables.OperationOutputs)
      .withKeyEncoding(fdb.encoders.tuple) // We use [workflowUUID, function_id] as the key
      .withValueEncoding(fdb.encoders.json); // and values using JSON
    this.notificationsDB = this.dbRoot
      .at(Tables.Notifications)
      .withKeyEncoding(fdb.encoders.tuple) // We use [destinationUUID, topic] as the key
      .withValueEncoding(fdb.encoders.json); // and values using JSON
    this.workflowEventsDB = this.dbRoot
      .at(Tables.WorkflowEvents)
      .withKeyEncoding(fdb.encoders.tuple) // We use [workflowUUID, key] as the key
      .withValueEncoding(fdb.encoders.json); // and values using JSON
    this.workflowInputsDB = this.dbRoot
      .at(Tables.WorkflowInpus)
      .withKeyEncoding(fdb.encoders.string) // We use workflowUUID as the key
      .withValueEncoding(fdb.encoders.json);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async init(): Promise<void> { }

  // eslint-disable-next-line @typescript-eslint/require-await
  async destroy(): Promise<void> {
    this.dbRoot.close();
  }

  async checkWorkflowOutput<R>(workflowUUID: string): Promise<R | OperonNull> {
    const output = (await this.workflowStatusDB.get(workflowUUID)) as WorkflowOutput<R> | undefined;
    if (output === undefined || output.status === StatusString.PENDING) {
      return operonNull;
    } else if (output.status === StatusString.ERROR) {
      throw deserializeError(JSON.parse(output.error));
    } else {
      return output.output;
    }
  }

  async initWorkflowStatus<T extends any[]>(workflowUUID: string, name: string, authenticatedUser: string, assumedRole: string, authenticatedRoles: string[], request: HTTPRequest | null, args: T): Promise<T> {
    return this.dbRoot.doTransaction(async (txn) => {
      const statusDB = txn.at(this.workflowStatusDB);
      const inputsDB = txn.at(this.workflowInputsDB);

      const present = await statusDB.get(workflowUUID);
      if (present === undefined) {
        statusDB.set(workflowUUID, {
          status: StatusString.PENDING,
          error: null,
          output: null,
          name: name,
          authenticatedUser: authenticatedUser,
          assumedRole: assumedRole,
          authenticatedRoles: authenticatedRoles,
          request: request,
        });
      }

      const inputs = await inputsDB.get(workflowUUID);
      if (inputs === undefined) {
        inputsDB.set(workflowUUID, args);
        return args;
      }
      return inputs as T;
    });
  }

  bufferWorkflowOutput<R>(workflowUUID: string, output: R) {
    this.workflowStatusBuffer.set(workflowUUID, output);
  }

  async flushWorkflowStatusBuffer(): Promise<string[]> {
    const localBuffer = new Map(this.workflowStatusBuffer);
    this.workflowStatusBuffer.clear();
    // eslint-disable-next-line @typescript-eslint/require-await
    await this.workflowStatusDB.doTransaction(async (txn) => {
      for (const [workflowUUID, output] of localBuffer) {
          const currWf = (await txn.get(workflowUUID)) as WorkflowOutput<unknown>;
          txn.set(workflowUUID, {
            status: StatusString.SUCCESS,
            error: null,
            output: output,
            name: currWf?.name ?? null,
            authenticatedUser: currWf?.authenticatedUser ?? null,
            authenticatedRoles: currWf?.authenticatedRoles ?? null,
            assumedRole: currWf?.assumedRole ?? null,
            request: currWf?.request ?? null,
          });
      }
    });
    return Array.from(localBuffer.keys());
  }

  async recordWorkflowError(workflowUUID: string, error: Error): Promise<void> {
    const serialErr = JSON.stringify(serializeError(error));
    await this.workflowStatusDB.set(workflowUUID, {
      status: StatusString.ERROR,
      error: serialErr,
      output: null,
    });
  }

  async getPendingWorkflows(): Promise<string[]> {
    const workflows = await this.workflowStatusDB.getRangeAll('', '\xff') as Array<[string, WorkflowOutput<unknown>]>;
    return workflows.filter(i => i[1].status === StatusString.PENDING).map(i => i[0]);
  }

  async getWorkflowInputs<T extends any[]>(workflowUUID: string): Promise<T | null> {
    return await this.workflowInputsDB.get(workflowUUID) as T ?? null;
  }

  async checkOperationOutput<R>(workflowUUID: string, functionID: number): Promise<OperonNull | R> {
    const output = (await this.operationOutputsDB.get([workflowUUID, functionID])) as OperationOutput<R> | undefined;
    if (output === undefined) {
      return operonNull;
    } else if (JSON.parse(output.error) !== null) {
      throw deserializeError(JSON.parse(output.error));
    } else {
      return output.output;
    }
  }

  async recordOperationOutput<R>(workflowUUID: string, functionID: number, output: R): Promise<void> {
    await this.operationOutputsDB.doTransaction(async (txn) => {
      // Check if the key exists.
      const keyOutput = await txn.get([workflowUUID, functionID]);
      if (keyOutput !== undefined) {
        throw new OperonWorkflowConflictUUIDError(workflowUUID);
      }
      txn.set([workflowUUID, functionID], {
        error: null,
        output: output,
      });
    });
  }

  async recordOperationError(workflowUUID: string, functionID: number, error: Error): Promise<void> {
    const serialErr = JSON.stringify(serializeError(error));
    await this.operationOutputsDB.doTransaction(async (txn) => {
      // Check if the key exists.
      const keyOutput = await txn.get([workflowUUID, functionID]);
      if (keyOutput !== undefined) {
        throw new OperonWorkflowConflictUUIDError(workflowUUID);
      }
      txn.set([workflowUUID, functionID], {
        error: serialErr,
        output: null,
      });
    });
  }

  async getWorkflowStatus(workflowUUID: string, callerUUID?: string, functionID?: number): Promise<WorkflowStatus | null> {
    // Check if the operation has been done before for OAOO (only do this inside a workflow).
    if (callerUUID !== undefined && functionID !== undefined) {
      const prev = (await this.operationOutputsDB.get([callerUUID, functionID])) as OperationOutput<WorkflowStatus | null> | undefined;
      if (prev !== undefined) {
        return prev.output;
      }
    }

    const output = (await this.workflowStatusDB.get(workflowUUID)) as WorkflowOutput<unknown> | undefined;
    let value = null;
    if (output !== undefined) {
      value = {
        status: output.status,
        workflowName: output.name,
        authenticatedUser: output.authenticatedUser,
        authenticatedRoles: output.authenticatedRoles,
        assumedRole: output.assumedRole,
        request: output.request,
      };
    }

    // Record the output if it is inside a workflow.
    if (callerUUID !== undefined && functionID !== undefined) {
      await this.recordOperationOutput(callerUUID, functionID, value);
    }
    return value;
  }

  async getWorkflowResult<R>(workflowUUID: string): Promise<R> {
    const watch = await this.workflowStatusDB.getAndWatch(workflowUUID);
    let value = watch.value;
    if (value === undefined) {
      await watch.promise;
      value = await this.workflowStatusDB.get(workflowUUID);
    } else {
      watch.cancel();
    }
    const output = value as WorkflowOutput<R>;
    const status = output.status;
    if (status === StatusString.SUCCESS) {
      return output.output;
    } else if (status === StatusString.ERROR) {
      throw deserializeError(JSON.parse(output.error));
    } else { // StatusString.PENDING
      return this.getWorkflowResult(workflowUUID);
    }
  }

  readonly nullTopic = "__null__topic__";

  async send<T>(workflowUUID: string, functionID: number, destinationUUID: string, message: T, topic?: string): Promise<void> {
    const currTopic: string = topic ?? this.nullTopic;

    return this.dbRoot.doTransaction(async (txn) => {
      const operationOutputs = txn.at(this.operationOutputsDB);
      const notifications = txn.at(this.notificationsDB);
      // For OAOO, check if the send already ran.
      const output = (await operationOutputs.get([workflowUUID, functionID])) as OperationOutput<boolean>;
      if (output !== undefined) {
        return;
      }

      // Retrieve the message queue.
      const exists = (await notifications.get([destinationUUID, currTopic])) as Array<unknown> | undefined;
      if (exists === undefined) {
        notifications.set([destinationUUID, currTopic], [message]);
      } else {
        // Append to the existing message queue.
        exists.push(message);
        notifications.set([destinationUUID, currTopic], exists);
      }
      operationOutputs.set([workflowUUID, functionID], { error: null, output: undefined });
    });
  }

  async recv<T>(workflowUUID: string, functionID: number, topic?: string, timeoutSeconds: number = Operon.defaultNotificationTimeoutSec): Promise<T | null> {
    const currTopic = topic ?? this.nullTopic;
    // For OAOO, check if the recv already ran.
    const output = (await this.operationOutputsDB.get([workflowUUID, functionID])) as OperationOutput<T | null> | undefined;
    if (output !== undefined) {
      return output.output;
    }
    // Check if there is a message in the queue, waiting for one to arrive if not.
    const watch = await this.notificationsDB.getAndWatch([workflowUUID, currTopic]);
    if (watch.value === undefined) {
      const timeout = setTimeout(() => {
        watch.cancel();
      }, timeoutSeconds * 1000);
      await watch.promise;
      clearInterval(timeout);
    } else {
      watch.cancel();
    }
    // Consume and return the message, recording the operation for OAOO.
    return this.dbRoot.doTransaction(async (txn) => {
      const operationOutputs = txn.at(this.operationOutputsDB);
      const notifications = txn.at(this.notificationsDB);
      const messages = (await notifications.get([workflowUUID, currTopic])) as Array<unknown> | undefined;
      const message = (messages ? messages.shift() as T : undefined) ?? null;  // If no message is found, return null.
      const output = await operationOutputs.get([workflowUUID, functionID]);
      if (output !== undefined) {
        throw new OperonWorkflowConflictUUIDError(workflowUUID);
      }
      operationOutputs.set([workflowUUID, functionID], { error: null, output: message });
      if (messages && messages.length > 0) {
        notifications.set([workflowUUID, currTopic], messages);  // Update the message table.
      } else {
        notifications.clear([workflowUUID, currTopic]);
      }
      return message;
    });
  }

  async setEvent<T extends NonNullable<any>>(workflowUUID: string, functionID: number, key: string, value: T): Promise<void> {
    return this.dbRoot.doTransaction(async (txn) => {
      const operationOutputs = txn.at(this.operationOutputsDB);
      const workflowEvents = txn.at(this.workflowEventsDB);
      // For OAOO, check if the set already ran.
      const output = (await operationOutputs.get([workflowUUID, functionID])) as OperationOutput<boolean>;
      if (output !== undefined) {
        return;
      }

      const exists = await workflowEvents.get([workflowUUID, key]);
      if (exists === undefined) {
        workflowEvents.set([workflowUUID, key], value);
      } else {
        throw new OperonDuplicateWorkflowEventError(workflowUUID, key);
      }
      // For OAOO, record the set.
      operationOutputs.set([workflowUUID, functionID], { error: null, output: undefined });
    });
  }

  async getEvent<T extends NonNullable<any>>(workflowUUID: string, key: string, timeoutSeconds: number, callerUUID?: string, functionID?: number): Promise<T | null> {
    // Check if the operation has been done before for OAOO (only do this inside a workflow).
    if (callerUUID !== undefined && functionID !== undefined) {
      const output = (await this.operationOutputsDB.get([callerUUID, functionID])) as OperationOutput<T | null> | undefined;
      if (output !== undefined) {
        return output.output;
      }
    }

    // Check if the value is present, otherwise wait for it to arrive.
    const watch = await this.workflowEventsDB.getAndWatch([workflowUUID, key]);
    if (watch.value === undefined) {
      const timeout = setTimeout(() => {
        watch.cancel();
      }, timeoutSeconds * 1000);
      await watch.promise;
      clearInterval(timeout);
    } else {
      watch.cancel();
    }
    // Return the value, or null if none exists.
    let value: T | null = null;
    if (watch.value !== undefined) {
      value = watch.value as T;
    } else {
      value = ((await this.workflowEventsDB.get([workflowUUID, key])) as T) ?? null;
    }

    // Record the output if it is inside a workflow.
    if (callerUUID !== undefined && functionID !== undefined) {
      await this.recordOperationOutput(callerUUID, functionID, value);
    }
    return value;
  }
}
