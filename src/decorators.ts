/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* May make sense: eslint-disable @typescript-eslint/ban-types */

// TODO List
// General
//   Class level decorators - defaults
//   Field / property decorators - persistent data
//   Integrate with API registration
//   Integrate parameter validation
//   Integrate with Authentication
//   Integrate with error handling
//   Find a way to unit test - perhaps a mock log collector?
//     Or is it easier once there is a real log collector?
//
// Logging
//   Collect a SQL-Like schema
//   Log a structured line (to console)
//   Integrate with Logger setup
//   Integrate with Logger buffer
//   Mask parameters

import "reflect-metadata";

/**
 * Any column type column can be.
 */
export type OperonFieldType =
    | 'integer'
    | 'double'
    | 'decimal'
    | 'timestamp'
    | 'text'
    | 'varchar'
    | 'boolean'
    | 'uuid'
    | 'json'
;

class OperonDataType {
  dataType : OperonFieldType = 'text';
  length : number = -1;
  precision : number = -1;
  scale : number = -1;

  /** Varchar has length */
  static varchar(length: number) {
    const dt = new OperonDataType();
    dt.dataType = 'varchar';
    dt.length = length;
    return dt;
  }

  /** Some decimal has precision / scale (as opposed to floating point decimal) */
  static decimal(precision: number, scale: number) {
    const dt = new OperonDataType();
    dt.dataType = 'decimal';
    dt.precision = precision;
    dt.scale = scale;

    return dt;
  }

  /** Take type from reflect metadata */
  // eslint-disable-next-line @typescript-eslint/ban-types
  static fromArg(arg: Function) {
    const dt = new OperonDataType();

    if (arg === String) {
      dt.dataType = 'text';
    }
    else if (arg === Date) {
      dt.dataType = 'timestamp';
    }
    else if (arg === Number) {
      dt.dataType = 'double';
    }
    else if (arg === Boolean) {
      dt.dataType = 'boolean';
    }
    else {
      dt.dataType = 'json';
    }

    return dt;
  }

  formatAsString(): string {
    let rv: string = this.dataType;
    if (this.dataType === 'varchar' && this.length > 0) {
      rv += `(${this.length})`;
    }
    if (this.dataType === 'decimal' && this.precision > 0) {
      if (this.scale > 0) {
        rv += `(${this.precision},${this.scale})`;
      }
      else {
        rv += `(${this.precision})`;
      }
    }
    return rv;
  }
}

const operonParamMetadataKey = Symbol("operon:parameter");
const operonMethodMetadataKey = Symbol("operon:method");

// eslint-disable-next-line @typescript-eslint/ban-types
function getArgNames(func: Function): string[] {
  // Convert the function to a string and extract the arguments using a regular expression
  const fn = func.toString();

  // Match various function and method declarations including constructors
  // If this RE is wrong, complain to ChatGPT that it's 5th try at least gave an answer, but was still wrong :-D
  const rematch = fn.match(/(?:function\s+[a-zA-Z_$][0-9a-zA-Z_$]*|function\s*|class\s+.*?extends.*?constructor|class\s+.*?constructor|constructor|[a-zA-Z_$][0-9a-zA-Z_$]*\s*\()?([^)]*)\)/);
  const args = rematch ? rematch[1] : '';

  // Split the arguments string into an array and remove whitespace
  return args ? args.split(',').map(arg => arg.replace(/\s+/g, '')) : [];
}

export enum LogLevel {
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
    CRITICAL = "CRITICAL"
}

export enum LogMask {
    NONE = "NONE",
    HASH = "HASH",
}

export enum LogEventType {
    METHOD_ENTER = 'METHOD_ENTER',
    METHOD_EXIT = 'METHOD_EXIT',
    METHOD_ERROR = 'METHOD_ERROR',
}

class BaseLogEvent {
  eventType: LogEventType = LogEventType.METHOD_ENTER;
  eventComponent: string = '';
  eventLevel: LogLevel = LogLevel.DEBUG;
  eventTime: Date = new Date();
  authorizedUser: string = '';
  authorizedRole: string = '';
  positionalArgs: unknown[] = [];
  namedArgs: {[x: string]: unknown} = {};
}

class OperonParameter {
  name: string = "";
  required: boolean = false;
  validate: boolean = true;
  skipLogging: boolean = false;
  logMask: LogMask = LogMask.NONE;
  // eslint-disable-next-line @typescript-eslint/ban-types
  argType: Function = String;
  dataType: OperonDataType;
  // TODO: If we override the logging behavior (say to mask/hash it), where do we record that?
  index:number = -1;

  // eslint-disable-next-line @typescript-eslint/ban-types
  constructor(idx: number, at: Function) {
    this.index = idx;
    this.argType = at;
    this.dataType = OperonDataType.fromArg(at);
  }
}

class OperonMethodRegistrationBase {
  name: string = "";
  logLevel : LogLevel = LogLevel.INFO;
  args : OperonParameter[] = [];
}

class OperonMethodRegistration <This, Args extends unknown[], Return>
  extends OperonMethodRegistrationBase
{
  constructor(origFunc: (this: This, ...args: Args) => Promise<Return>) {
    super();
    this.origFunction = origFunc;
  }
  needInitialized: boolean = true;
  origFunction : ((this: This, ...args: Args) => Promise<Return>);

  // TODO: Permissions, attachment point, error handling, etc.
}

// Quick and dirty method registration list...
const methodRegistry: OperonMethodRegistrationBase[] = [];
export function forEachMethod(f: (m: OperonMethodRegistrationBase) => void) {
  methodRegistry.forEach(f);
}

function getOrCreateOperonMethodArgsRegistration(target: object, propertyKey: string | symbol) : OperonParameter[]
{
  let mParameters: OperonParameter[]
        = Reflect.getOwnMetadata(operonParamMetadataKey, target, propertyKey) as OperonParameter[]
        || [];

  if (!mParameters.length) {
    // eslint-disable-next-line @typescript-eslint/ban-types
    const designParamTypes = Reflect.getMetadata('design:paramtypes', target, propertyKey) as Function [];

    // Infer data types - can override with decorators
    mParameters = designParamTypes.map((value, index) => new OperonParameter(index, value));

    Reflect.defineMetadata(operonParamMetadataKey, mParameters, target, propertyKey);
  }

  return mParameters;
}

function getOrCreateOperonMethodRegistration<This, Args extends unknown[], Return>(target: object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>)
{
  const methReg : OperonMethodRegistration<This, Args, Return> = 
       Reflect.getOwnMetadata(operonMethodMetadataKey, target, propertyKey) as OperonMethodRegistration<This, Args, Return>
       || new OperonMethodRegistration<This, Args, Return>(descriptor.value!);

  if (methReg.needInitialized) {
    methReg.name = propertyKey.toString();

    methReg.args = getOrCreateOperonMethodArgsRegistration(target, propertyKey);

    const argNames = getArgNames(descriptor.value!);
    methReg.args.forEach( (e) => {
      if (!e.name) {
        if (e.index < argNames.length) {
          e.name = argNames[e.index];
        }   
      }
    });

    Reflect.defineMetadata(operonMethodMetadataKey, methReg, target, propertyKey);

    // This is the replacement method
    const nmethod = async function(this: This, ...args: Args) {
      const mn = methReg.name;
        
      // TODO: Validate the user authentication

      // TODO: Here let's validate the arguments, being careful to log any validation errors that occur
      //        And skip/mask arguments

      // Here let's log the structured record
      const sLogRec = new BaseLogEvent();
      sLogRec.authorizedUser = "Get user from middleware arg 0?";
      sLogRec.authorizedRole = "Get role from middleware arg 0?";
      sLogRec.eventType = LogEventType.METHOD_ENTER;
      sLogRec.eventComponent = mn;
      sLogRec.eventLevel = methReg.logLevel;

      args.forEach((v, idx) => {
        if (methReg.args[idx].skipLogging) {
          return;
        }
        else {
          sLogRec.positionalArgs.push(v);
          sLogRec.namedArgs[methReg.args[idx].name] = v;
        }
      });

      console.log(`${methReg.logLevel}: ${mn}: Invoked - `+JSON.stringify(sLogRec));
      try {
        // It is unclear if this is the right thing to do about async... in some contexts await may not be desired
        const result = await methReg.origFunction.call(this, ...args);
        console.log(`${methReg.logLevel}: ${mn}: Returned`);
        return result;
      }
      catch (e) {
        console.log(`${methReg.logLevel}: ${mn}: Threw`, e);
        throw e;
      }
    };
    descriptor.value = nmethod;

    methReg.needInitialized = false;
    methodRegistry.push(methReg);
  }

  return methReg;
}

function registerAndWrapFunction<This, Args extends unknown[], Return>(
  target: object,
  propertyKey: string,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>)
{
  if (!descriptor.value) {
    throw Error("Use of operon decorator when original method is undefined");
  }

  const registration = getOrCreateOperonMethodRegistration(target, propertyKey, descriptor);
    
  return {descriptor, registration};
}

export function required(target: object, propertyKey: string | symbol, parameterIndex: number) {
  const existingParameters = getOrCreateOperonMethodArgsRegistration(target, propertyKey);

  const curParam = existingParameters[parameterIndex];
  curParam.required = true;
}

export function skipLogging(target: object, propertyKey: string | symbol, parameterIndex: number) {
  const existingParameters = getOrCreateOperonMethodArgsRegistration(target, propertyKey);

  const curParam = existingParameters[parameterIndex];
  curParam.skipLogging = true;
}

export function paramName(name: string) {
  return function(target: object, propertyKey: string | symbol, parameterIndex: number) {
    const existingParameters = getOrCreateOperonMethodArgsRegistration(target, propertyKey);

    const curParam = existingParameters[parameterIndex];
    curParam.name = name;
  };
}

/*
type MethodDecorator = <T>(
  target: Object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>
) => TypedPropertyDescriptor<T> | void;
*/

// Outer shell is the factory that produces decorator - which gets parameters for building the decorator code
export function loglevel(level: LogLevel) {
  // This is the decorator that will get applied to the decorator item
  function logdec<This, Args extends unknown[], Return>(
    target: object,
    propertyKey: string,
    inDescriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>)
  {
    const {descriptor, registration} = registerAndWrapFunction(target, propertyKey, inDescriptor);
    registration.logLevel = level;    
    return descriptor;
  }
  return logdec;
}


export function logged<This, Args extends unknown[], Return>(
  target: object,
  propertyKey: string,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<Return>>)
{
  return loglevel(LogLevel.INFO)(target, propertyKey, descriptor);
}