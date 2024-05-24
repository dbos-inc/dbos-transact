import { MethodRegistration, MethodParameter, registerAndWrapFunction, getOrCreateMethodArgsRegistration, MethodRegistrationBase, getRegisteredOperations, InitConfigMethod, ConfiguredClass } from "../decorators";
import { DBOSExecutor, OperationType } from "../dbos-executor";
import { DBOSContext, DBOSContextImpl } from "../context";
import Koa from "koa";
import { Workflow, TailParameters, WorkflowHandle, WorkflowParams, WorkflowContext, WFInvokeFuncs, WFInvokeFuncsConf } from "../workflow";
import { Transaction } from "../transaction";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { trace, defaultTextMapGetter, ROOT_CONTEXT } from '@opentelemetry/api';
import { Span } from "@opentelemetry/sdk-trace-base";
import { v4 as uuidv4 } from 'uuid';
import { Communicator } from "../communicator";
import { APITypes, ArgSources } from "./handlerTypes";

// local type declarations for workflow functions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WFFunc = (ctxt: WorkflowContext, ...args: any[]) => Promise<unknown>;
export type InvokeFuncs<T> = WFInvokeFuncs<T> & AsyncHandlerWfFuncs<T>;
export type InvokeFuncsConf<T> = WFInvokeFuncsConf<T>;

export type AsyncHandlerWfFuncs<T> = 
  T extends InitConfigMethod
  ? never
  : {
    [P in keyof T as T[P] extends WFFunc ? P : never]: T[P] extends WFFunc ? (...args: TailParameters<T[P]>) => Promise<WorkflowHandle<Awaited<ReturnType<T[P]>>>> : never;
  };

export type SyncHandlerWfFuncs<T> =
  T extends InitConfigMethod
  ? never
  : {
    [P in keyof T as T[P] extends WFFunc ? P : never]: T[P] extends WFFunc ? (...args: TailParameters<T[P]>) => Promise<Awaited<ReturnType<T[P]>>> : never;
  };

export type AsyncHandlerWfFuncsConf<T> =
  T extends InitConfigMethod
  ? {
    [P in keyof T as T[P] extends WFFunc ? P : never]: T[P] extends WFFunc ? (...args: TailParameters<T[P]>) => Promise<WorkflowHandle<Awaited<ReturnType<T[P]>>>> : never;
  }
  : never;

export type SyncHandlerWfFuncsConf<T> =
  T extends InitConfigMethod
  ? {
    [P in keyof T as T[P] extends WFFunc ? P : never]: T[P] extends WFFunc ? (...args: TailParameters<T[P]>) => Promise<Awaited<ReturnType<T[P]>>> : never;
  }
  : never;

export interface HandlerContext extends DBOSContext {
  readonly koaContext: Koa.Context;
  invoke<T extends object>(targetClass: T, workflowUUID?: string): InvokeFuncs<T>;
  invokeWorkflow<T extends object>(targetClass: T, workflowUUID?: string): SyncHandlerWfFuncs<T>;
  startWorkflow<T extends object>(targetClass: T, workflowUUID?: string): AsyncHandlerWfFuncs<T>;
  invokeOnConfig<T extends object>(targetCfg: ConfiguredClass<T>, workflowUUID?: string): InvokeFuncsConf<T>;
  invokeWorkflowOnConfig<T extends object>(targetCfg: ConfiguredClass<T>, workflowUUID?: string): SyncHandlerWfFuncsConf<T>;
  startWorkflowOnConfig<T extends object>(targetCfg: ConfiguredClass<T>, workflowUUID?: string): AsyncHandlerWfFuncsConf<T>;
  retrieveWorkflow<R>(workflowUUID: string): WorkflowHandle<R>;
  send<T>(destinationUUID: string, message: T, topic?: string, idempotencyKey?: string): Promise<void>;
  getEvent<T>(workflowUUID: string, key: string, timeoutSeconds?: number): Promise<T | null>;
}

export const RequestIDHeader = "x-request-id";
function getOrGenerateRequestID(ctx: Koa.Context): string {
  const reqID = ctx.get(RequestIDHeader);
  if (reqID) {
    return reqID;
  }
  const newID = uuidv4();
  ctx.set(RequestIDHeader, newID);
  return newID;
}

export class HandlerContextImpl extends DBOSContextImpl implements HandlerContext {
  readonly #dbosExec: DBOSExecutor;
  readonly W3CTraceContextPropagator: W3CTraceContextPropagator;

  constructor(dbosExec: DBOSExecutor, readonly koaContext: Koa.Context) {
    // Retrieve or generate the request ID
    const requestID = getOrGenerateRequestID(koaContext);

    // If present, retrieve the trace context from the request
    const httpTracer = new W3CTraceContextPropagator();
    const extractedSpanContext = trace.getSpanContext(
        httpTracer.extract(ROOT_CONTEXT, koaContext.request.headers, defaultTextMapGetter)
    )
    let span: Span;
    const spanAttributes = {
      operationType: OperationType.HANDLER,
      requestID: requestID,
      requestIP: koaContext.request.ip,
      requestURL: koaContext.request.url,
      requestMethod: koaContext.request.method,
    };
    if (extractedSpanContext === undefined) {
      span = dbosExec.tracer.startSpan(koaContext.url, spanAttributes);
    } else {
      extractedSpanContext.isRemote = true;
      span = dbosExec.tracer.startSpanWithContext(extractedSpanContext, koaContext.url, spanAttributes);
    }

    super(koaContext.url, span, dbosExec.logger);

    // If running in DBOS Cloud, set the executor ID
    if (process.env.DBOS__VMID) {
      this.executorID = process.env.DBOS__VMID
    }

    this.W3CTraceContextPropagator = httpTracer;
    this.request = {
      headers: koaContext.request.headers,
      rawHeaders: koaContext.req.rawHeaders,
      params: koaContext.params,
      body: koaContext.request.body,
      rawBody: koaContext.request.rawBody,
      query: koaContext.request.query,
      querystring: koaContext.request.querystring,
      url: koaContext.request.url,
      ip: koaContext.request.ip,
      requestID: requestID,
    };
    this.applicationConfig = dbosExec.config.application;
    this.#dbosExec = dbosExec;
  }

  ///////////////////////
  /* PUBLIC INTERFACE  */
  ///////////////////////

  async send<T>(destinationUUID: string, message: T, topic?: string, idempotencyKey?: string): Promise<void> {
    return this.#dbosExec.send(destinationUUID, message, topic, idempotencyKey);
  }

  async getEvent<T>(workflowUUID: string, key: string, timeoutSeconds: number = DBOSExecutor.defaultNotificationTimeoutSec): Promise<T | null> {
    return this.#dbosExec.getEvent(workflowUUID, key, timeoutSeconds);
  }

  retrieveWorkflow<R>(workflowUUID: string): WorkflowHandle<R> {
    return this.#dbosExec.retrieveWorkflow(workflowUUID);
  }

  /**
   * Generate a proxy object for the provided class that wraps direct calls (i.e. OpClass.someMethod(param))
   * to use WorkflowContext.Transaction(OpClass.someMethod, param);
   */
  mainInvoke<T extends object>(object: T, workflowUUID: string | undefined, asyncWf: boolean, classConfig: ConfiguredClass<unknown> | null): InvokeFuncs<T> {
    const ops = getRegisteredOperations(object);
    const proxy: Record<string, unknown> = {};
    const params = { workflowUUID: workflowUUID, parentCtx: this, classConfig };

    for (const op of ops) {
      if (asyncWf) {
         
        proxy[op.name] = op.txnConfig
           
          ? (...args: unknown[]) => this.#transaction(op.registeredFunction as Transaction<unknown[], unknown>, params, ...args)
          : op.workflowConfig
           
          ? (...args: unknown[]) => this.#workflow(op.registeredFunction as Workflow<unknown[], unknown>, params, ...args)
          : op.commConfig
           
          ? (...args: unknown[]) => this.#external(op.registeredFunction as Communicator<unknown[], unknown>, params, ...args)
          : undefined;
      } else {
         
        proxy[op.name] = op.workflowConfig
           
          ? (...args: unknown[]) => this.#workflow(op.registeredFunction as Workflow<unknown[], unknown>, params, ...args).then((handle) => handle.getResult())
          : undefined;
      }
    }
    return proxy as InvokeFuncs<T>;
  }

  invoke<T extends object>(object: T, workflowUUID?: string): InvokeFuncs<T> {
    return this.mainInvoke(object, workflowUUID, true, null);
  }

  startWorkflow<T extends object>(object: T, workflowUUID?: string): AsyncHandlerWfFuncs<T> {
    return this.mainInvoke(object, workflowUUID, true, null);
  }

  invokeWorkflow<T extends object>(object: T, workflowUUID?: string): SyncHandlerWfFuncs<T> {
    return this.mainInvoke(object, workflowUUID, false, null) as unknown as SyncHandlerWfFuncs<T>;
  }

  invokeOnConfig<T extends object>(targetCfg: ConfiguredClass<T>, workflowUUID?: string): InvokeFuncsConf<T> {
    return this.mainInvoke(targetCfg.ctor, workflowUUID, true, targetCfg) as unknown as InvokeFuncsConf<T>;
  }

  startWorkflowOnConfig<T extends object>(targetCfg: ConfiguredClass<T>, workflowUUID?: string): AsyncHandlerWfFuncsConf<T> {
    return this.mainInvoke(targetCfg.ctor, workflowUUID, true, targetCfg) as unknown as AsyncHandlerWfFuncsConf<T>;
  }

  invokeWorkflowOnConfig<T extends object>(targetCfg: ConfiguredClass<T>, workflowUUID?: string): SyncHandlerWfFuncsConf<T> {
    return this.mainInvoke(targetCfg.ctor, workflowUUID, false, targetCfg) as unknown as SyncHandlerWfFuncsConf<T>;
  }

  //////////////////////
  /* PRIVATE METHODS */
  /////////////////////

  async #workflow<T extends unknown[], R>(wf: Workflow<T, R>, params: WorkflowParams, ...args: T): Promise<WorkflowHandle<R>> {
    return this.#dbosExec.workflow(wf, params, ...args);
  }

  async #transaction<T extends unknown[], R>(txn: Transaction<T, R>, params: WorkflowParams, ...args: T): Promise<R> {
    return this.#dbosExec.transaction(txn, params, ...args);
  }

  async #external<T extends unknown[], R>(commFn: Communicator<T, R>, params: WorkflowParams, ...args: T): Promise<R> {
    return this.#dbosExec.external(commFn, params, ...args);
  }
}

export interface HandlerRegistrationBase extends MethodRegistrationBase {
  apiType: APITypes;
  apiURL: string;
  args: HandlerParameter[];
}

export class HandlerRegistration<This, Args extends unknown[], Return> extends MethodRegistration<This, Args, Return> {
  apiType: APITypes = APITypes.GET;
  apiURL: string = "";

  args: HandlerParameter[] = [];
  constructor(origFunc: (this: This, ...args: Args) => Promise<Return>) {
    super(origFunc);
  }
}

export class HandlerParameter extends MethodParameter {
  argSource: ArgSources = ArgSources.DEFAULT;

  // eslint-disable-next-line @typescript-eslint/ban-types
  constructor(idx: number, at: Function) {
    super(idx, at);
  }
}

/////////////////////////
/* ENDPOINT DECORATORS */
/////////////////////////

export function GetApi(url: string) {
  function apidec<This, Ctx extends DBOSContext, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: Ctx, ...args: Args) => Promise<Return>>
  ) {
    const { descriptor, registration } = registerAndWrapFunction(target, propertyKey, inDescriptor);
    const handlerRegistration = registration as unknown as HandlerRegistration<This, Args, Return>;
    handlerRegistration.apiURL = url;
    handlerRegistration.apiType = APITypes.GET;

    return descriptor;
  }
  return apidec;
}

export function PostApi(url: string) {
  function apidec<This, Ctx extends DBOSContext, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ctx: Ctx, ...args: Args) => Promise<Return>>
  ) {
    const { descriptor, registration } = registerAndWrapFunction(target, propertyKey, inDescriptor);
    const handlerRegistration = registration as unknown as HandlerRegistration<This, Args, Return>;
    handlerRegistration.apiURL = url;
    handlerRegistration.apiType = APITypes.POST;

    return descriptor;
  }
  return apidec;
}

///////////////////////////////////
/* ENDPOINT PARAMETER DECORATORS */
///////////////////////////////////

export function ArgSource(source: ArgSources) {
  return function (target: object, propertyKey: string | symbol, parameterIndex: number) {
    const existingParameters = getOrCreateMethodArgsRegistration(target, propertyKey);

    const curParam = existingParameters[parameterIndex] as HandlerParameter;
    curParam.argSource = source;
  };
}
