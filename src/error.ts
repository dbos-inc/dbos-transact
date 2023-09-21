import { DatabaseError } from "pg";
import { ExportResult } from "@opentelemetry/core";

function formatPgDatabaseError(err: DatabaseError): string {
  let msg = "";
  if (err.severity) {
    msg = msg.concat(`severity: ${err.severity} \n`);
  }
  if (err.code) {
    msg = msg.concat(`code: ${err.code} \n`);
  }
  if (err.detail) {
    msg = msg.concat(`detail: ${err.detail} \n`);
  }
  if (err.hint) {
    msg = msg.concat(`hint: ${err.hint} \n`);
  }
  if (err.position) {
    msg = msg.concat(`position: ${err.position} \n`);
  }
  if (err.internalPosition) {
    msg = msg.concat(`internalPosition: ${err.internalPosition} \n`);
  }
  if (err.internalQuery) {
    msg = msg.concat(`internalQuery: ${err.internalQuery} \n`);
  }
  if (err.where) {
    msg = msg.concat(`where: ${err.where} \n`);
  }
  if (err.schema) {
    msg = msg.concat(`schema: ${err.schema} \n`);
  }
  if (err.table) {
    msg = msg.concat(`table: ${err.table} \n`);
  }
  if (err.column) {
    msg = msg.concat(`column: ${err.column} \n`);
  }
  if (err.dataType) {
    msg = msg.concat(`dataType: ${err.dataType} \n`);
  }
  if (err.constraint) {
    msg = msg.concat(`constraint: ${err.constraint} \n`);
  }
  if (err.file) {
    msg = msg.concat(`file: ${err.file} \n`);
  }
  if (err.line) {
    msg = msg.concat(`line: ${err.line} \n`);
  }
  return msg;
}

// Return if the error is caused by client request or by server internal.
export function isOperonClientError(operonErrorCode: number) {
  return (operonErrorCode === DataValidationError) || (operonErrorCode === WorkflowPermissionDeniedError) || (operonErrorCode === TopicPermissionDeniedError) || (operonErrorCode === ConflictingUUIDError) || (operonErrorCode === NotRegisteredError);
}

export class OperonError extends Error {
  // TODO: define a better coding system.
  constructor(msg: string, readonly operonErrorCode: number = 1) {
    super(msg);
  }
}

const WorkflowPermissionDeniedError = 2;
export class OperonWorkflowPermissionDeniedError extends OperonError {
  constructor(runAs: string, workflowName: string) {
    const msg = `Subject ${runAs} does not have permission to run workflow ${workflowName}`;
    super(msg, WorkflowPermissionDeniedError);
  }
}

const InitializationError = 3;
export class OperonInitializationError extends OperonError {
  constructor(msg: string) {
    super(msg, InitializationError);
  }
}

const TopicPermissionDeniedError = 4;
export class OperonTopicPermissionDeniedError extends OperonError {
  constructor(destinationUUID: string, workflowUUID: string, functionID: number, runAs: string) {
    const msg = `Subject ${runAs} does not have permission on destination UUID ${destinationUUID}.` + `(workflow UUID: ${workflowUUID}, function ID: ${functionID})`;
    super(msg, TopicPermissionDeniedError);
  }
}

const ConflictingUUIDError = 5;
export class OperonWorkflowConflictUUIDError extends OperonError {
  constructor(workflowUUID: string) {
    super(`Conflicting UUID ${workflowUUID}`, ConflictingUUIDError);
  }
}

const NotRegisteredError = 6;
export class OperonNotRegisteredError extends OperonError {
  constructor(name: string) {
    const msg = `Operation (Name: ${name}) not registered`;
    super(msg, NotRegisteredError);
  }
}

const PostgresExporterError = 7;
export class OperonPostgresExporterError extends OperonError {
  constructor(err: Error) {
    let msg = `PostgresExporter error: ${err.message} \n`;
    if (err instanceof DatabaseError) {
      msg = msg.concat(formatPgDatabaseError(err));
    }
    super(msg, PostgresExporterError);
  }
}

const JaegerExporterError = 8;
export class OperonJaegerExporterError extends OperonError {
  constructor(err: ExportResult) {
    let msg = `JaegerExporter error ${err.code}`;
    if (err.error) {
      msg = msg.concat(`: ${err.error.message}`);
    }
    msg = msg.concat(`\n`);
    super(msg, JaegerExporterError);
  }
}

const DataValidationError = 9;
export class OperonDataValidationError extends OperonError {
  constructor(msg: string) {
    super(msg, DataValidationError);
  }
}

const DuplicateWorkflowEvent = 10;
export class OperonDuplicateWorkflowEventError extends OperonError {
  constructor(workflowUUID: string, key: string) {
    super(`Workflow ${workflowUUID} has already emitted an event with key ${key}`, DuplicateWorkflowEvent);
  }
}

// This error is thrown by applications.
const ResponseError = 11;
export class OperonResponseError extends OperonError {
  constructor(msg: string, readonly status: number = 500) {
    super(msg, ResponseError);
  }
}

const NotAuthorizedError = 12;
export class OperonNotAuthorizedError extends OperonError {
  constructor(msg: string, readonly status: number = 403) {
    super(msg, NotAuthorizedError);
  }
}
