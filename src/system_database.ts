/* eslint-disable @typescript-eslint/no-explicit-any */

import { deserializeError, serializeError } from "serialize-error";
import { operonNull, OperonNull } from "./operon";
import { DatabaseError, Pool, PoolClient, Notification, PoolConfig, Client } from "pg";
import { OperonWorkflowConflictUUIDError } from "./error";
import { StatusString, WorkflowStatus } from "./workflow";
import { systemDBSchema, notifications, operation_outputs, workflow_status } from "../schemas/system_db_schema";
import { sleep } from "./utils";

export interface SystemDatabase {
  init(): Promise<void>;
  destroy(): Promise<void>;

  checkWorkflowOutput<R>(workflowUUID: string): Promise<OperonNull | R>;
  bufferWorkflowOutput<R>(workflowUUID: string, output: R): Promise<void>;
  flushWorkflowOutputBuffer(): Promise<Array<string>>;
  recordWorkflowError(workflowUUID: string, error: Error): Promise<void>;

  checkCommunicatorOutput<R>(workflowUUID: string, functionID: number): Promise<OperonNull | R>;
  recordCommunicatorOutput<R>(workflowUUID: string, functionID: number, output: R): Promise<void>;
  recordCommunicatorError(workflowUUID: string, functionID: number, error: Error): Promise<void>;

  getWorkflowStatus(workflowUUID: string): Promise<WorkflowStatus>;
  getWorkflowResult<R>(workflowUUID: string): Promise<R>;

  send<T extends NonNullable<any>>(workflowUUID: string, functionID: number, topic: string, key: string, message: T): Promise<boolean>;
  recv<T extends NonNullable<any>>(workflowUUID: string, functionID: number, topic: string, key: string, timeout: number): Promise<T | null>;
}

export class PostgresSystemDatabase implements SystemDatabase {
  readonly pool: Pool;

  notificationsClient: PoolClient | null = null;
  readonly listenerMap: Record<string, () => void> = {};

  readonly workflowOutputBuffer: Map<string, any> = new Map();

  constructor(readonly pgPoolConfig: PoolConfig, readonly systemDatabaseName: string) {
    const poolConfig = { ...pgPoolConfig };
    poolConfig.database = systemDatabaseName;
    this.pool = new Pool(poolConfig);
  }

  async init() {
    const pgSystemClient = new Client(this.pgPoolConfig);
    await pgSystemClient.connect();
    // Create the system database and load tables.
    const dbExists = await pgSystemClient.query(`SELECT FROM pg_database WHERE datname = '${this.systemDatabaseName}'`);
    if (dbExists.rows.length === 0) {
      // Create the Operon system database.
      await pgSystemClient.query(`CREATE DATABASE "${this.systemDatabaseName}"`);
    }
    // Load the Operon system schemas.
    await this.pool.query(systemDBSchema);
    await this.listenForNotifications();
    await pgSystemClient.end();
  }

  async destroy() {
    if (this.notificationsClient) {
      this.notificationsClient.removeAllListeners();
      this.notificationsClient.release();
    }
    await this.pool.end();
  }

  async checkWorkflowOutput<R>(workflowUUID: string): Promise<OperonNull | R> {
    const { rows } = await this.pool.query<workflow_status>("SELECT status, output, error FROM operon.workflow_status WHERE workflow_uuid=$1", [workflowUUID]);
    // TODO: maybe add back pending state.
    if (rows.length === 0) {
      return operonNull;
    } else if (rows[0].status === StatusString.ERROR) {
      throw deserializeError(JSON.parse(rows[0].error));
    } else {
      return JSON.parse(rows[0].output) as R;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async bufferWorkflowOutput<R>(workflowUUID: string, output: R): Promise<void> {
    this.workflowOutputBuffer.set(workflowUUID, output);
  }

  async recordWorkflowError(workflowUUID: string, error: Error): Promise<void> {
    const serialErr = JSON.stringify(serializeError(error));
    await this.pool.query(
      `INSERT INTO operon.workflow_status (workflow_uuid, status, error) VALUES($1, $2, $3) ON CONFLICT (workflow_uuid)
    DO UPDATE SET status=EXCLUDED.status, error=EXCLUDED.error, updated_at_epoch_ms=(EXTRACT(EPOCH FROM now())*1000)::bigint;`,
      [workflowUUID, StatusString.ERROR, serialErr]
    );
  }

  async checkCommunicatorOutput<R>(workflowUUID: string, functionID: number): Promise<OperonNull | R> {
    const { rows } = await this.pool.query<operation_outputs>("SELECT output, error FROM operon.operation_outputs WHERE workflow_uuid=$1 AND function_id=$2", [workflowUUID, functionID]);
    if (rows.length === 0) {
      return operonNull;
    } else if (JSON.parse(rows[0].error) !== null) {
      throw deserializeError(JSON.parse(rows[0].error));
    } else {
      return JSON.parse(rows[0].output) as R;
    }
  }

  async recordCommunicatorOutput<R>(workflowUUID: string, functionID: number, output: R): Promise<void> {
    const serialOutput = JSON.stringify(output);
    try {
      await this.pool.query("INSERT INTO operon.operation_outputs (workflow_uuid, function_id, output) VALUES ($1, $2, $3);", [workflowUUID, functionID, serialOutput]);
    } catch (error) {
      const err: DatabaseError = error as DatabaseError;
      if (err.code === "40001" || err.code === "23505") {
        // Serialization and primary key conflict (Postgres).
        throw new OperonWorkflowConflictUUIDError(workflowUUID);
      } else {
        throw err;
      }
    }
  }

  async recordCommunicatorError(workflowUUID: string, functionID: number, error: Error): Promise<void> {
    const serialErr = JSON.stringify(serializeError(error));
    try {
      await this.pool.query("INSERT INTO operon.operation_outputs (workflow_uuid, function_id, error) VALUES ($1, $2, $3);", [workflowUUID, functionID, serialErr]);
    } catch (error) {
      const err: DatabaseError = error as DatabaseError;
      if (err.code === "40001" || err.code === "23505") {
        // Serialization and primary key conflict (Postgres).
        throw new OperonWorkflowConflictUUIDError(workflowUUID);
      } else {
        throw err;
      }
    }
  }

  /**
   *  Guard the operation, throwing an error if a conflicting execution is detected.
   */
  async recordNotificationOutput<R>(client: PoolClient, workflowUUID: string, functionID: number, output: R) {
    try {
      await client.query("INSERT INTO operon.operation_outputs (workflow_uuid, function_id, output) VALUES ($1, $2, $3);", [workflowUUID, functionID, JSON.stringify(output)]);
    } catch (error) {
      await client.query("ROLLBACK");
      client.release();
      const err: DatabaseError = error as DatabaseError;
      if (err.code === "40001" || err.code === "23505") {
        // Serialization and primary key conflict (Postgres).
        throw new OperonWorkflowConflictUUIDError(workflowUUID);
      } else {
        throw err;
      }
    }
  }

  async send<T extends NonNullable<any>>(workflowUUID: string, functionID: number, topic: string, key: string, message: T): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();

    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    let { rows } = await client.query<operation_outputs>("SELECT output FROM operon.operation_outputs WHERE workflow_uuid=$1 AND function_id=$2", [workflowUUID, functionID]);
    if (rows.length > 0) {
      await client.query("ROLLBACK");
      client.release();
      return JSON.parse(rows[0].output) as boolean;
    }
    ({ rows } = await client.query(
      `INSERT INTO operon.notifications (topic, key, message) VALUES ($1, $2, $3)
      ON CONFLICT (topic, key) DO NOTHING RETURNING 'Success';`,
      [topic, key, JSON.stringify(message)]
    ));
    const success: boolean = rows.length !== 0; // Return true if successful, false if the key already exists.
    await this.recordNotificationOutput(client, workflowUUID, functionID, success);
    await client.query("COMMIT");
    client.release();
    return success;
  }

  async recv<T extends NonNullable<any>>(workflowUUID: string, functionID: number, topic: string, key: string, timeoutSeconds: number): Promise<T | null> {
    // First, check for previous executions.
    const checkRows = (await this.pool.query<operation_outputs>("SELECT output FROM operon.operation_outputs WHERE workflow_uuid=$1 AND function_id=$2", [workflowUUID, functionID])).rows;
    if (checkRows.length > 0) {
      return JSON.parse(checkRows[0].output) as T;
    }

    // Then, register the key with the global notifications listener.
    let resolveNotification: () => void;
    const messagePromise = new Promise<void>((resolve) => {
      resolveNotification = resolve;
    });
    this.listenerMap[`${topic}::${key}`] = resolveNotification!; // The resolver assignment in the Promise definition runs synchronously.
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        resolve();
      }, timeoutSeconds * 1000);
    });
    const received = Promise.race([messagePromise, timeoutPromise]);

    // Check if the key is already in the DB, then wait for the notification if it isn't.
    const initRecvRows = (await this.pool.query<notifications>("SELECT topic FROM operon.notifications WHERE topic=$1 AND key=$2", [topic, key])).rows;
    if (initRecvRows.length === 0) {
      await received;
    }
    clearTimeout(timer!);

    // Transactionally consume and return the message if it's in the DB, otherwise return null.
    const client = await this.pool.connect();
    await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED`);
    const finalRecvRows = (await client.query<notifications>("DELETE FROM operon.notifications WHERE topic=$1 AND key=$2 RETURNING message", [topic, key])).rows;
    let message: T | null = null;
    if (finalRecvRows.length > 0) {
      message = JSON.parse(finalRecvRows[0].message) as T;
    }
    await this.recordNotificationOutput(client, workflowUUID, functionID, message);
    await client.query(`COMMIT`);
    client.release();
    return message;
  }

  async getWorkflowStatus(workflowUUID: string): Promise<WorkflowStatus> {
    const { rows } = await this.pool.query<workflow_status>("SELECT status, updated_at_epoch_ms FROM operon.workflow_status WHERE workflow_uuid=$1", [workflowUUID]);
    if (rows.length === 0) {
      return { status: StatusString.UNKNOWN, updatedAtEpochMs: -1 };
    }
    return { status: rows[0].status, updatedAtEpochMs: rows[0].updated_at_epoch_ms };
  }

  async getWorkflowResult<R>(workflowUUID: string): Promise<R> {
    const pollingIntervalMs: number = 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { rows } = await this.pool.query<workflow_status>("SELECT status, output, error FROM operon.workflow_status WHERE workflow_uuid=$1", [workflowUUID]);
      if (rows.length > 0) {
        const status = rows[0].status;
        if (status === StatusString.SUCCESS) {
          return JSON.parse(rows[0].output) as R;
        } else if (status === StatusString.ERROR) {
          throw deserializeError(JSON.parse(rows[0].error));
        }
      }
      await sleep(pollingIntervalMs);
    }
  }

  /**
   * Flush the workflow output buffer to the database.
   */
  async flushWorkflowOutputBuffer() {
    const localBuffer = new Map(this.workflowOutputBuffer);
    this.workflowOutputBuffer.clear();
    const client: PoolClient = await this.pool.connect();
    await client.query("BEGIN");
    for (const [workflowUUID, output] of localBuffer) {
      await client.query(
        `INSERT INTO operon.workflow_status (workflow_uuid, status, output) VALUES($1, $2, $3) ON CONFLICT (workflow_uuid)
        DO UPDATE SET status=EXCLUDED.status, output=EXCLUDED.output, updated_at_epoch_ms=(EXTRACT(EPOCH FROM now())*1000)::bigint;`,
        [workflowUUID, StatusString.SUCCESS, JSON.stringify(output)]
      );
    }
    await client.query("COMMIT");
    client.release();
    return Array.from(localBuffer.keys());
  }

  /* BACKGROUND PROCESSES */
  /**
   * A background process that listens for notifications from Postgres then signals the appropriate
   * workflow listener by resolving its promise.
   */
  async listenForNotifications() {
    this.notificationsClient = await this.pool.connect();
    await this.notificationsClient.query("LISTEN operon_notifications_channel;");
    const handler = (msg: Notification) => {
      if (msg.payload && msg.payload in this.listenerMap) {
        this.listenerMap[msg.payload]();
      }
    };
    this.notificationsClient.on("notification", handler);
  }
}
