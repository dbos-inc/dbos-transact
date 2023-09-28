import Koa from "koa";
import { OperonClassRegistration, OperonRegistrationDefaults, getOrCreateOperonClassRegistration } from "../decorators";
import { OperonUndefinedDecoratorInputError } from "../error";

// Middleware context does not extend Operon context because it runs before actual Operon operations.
export class MiddlewareContext {
  constructor(
    readonly koaContext: Koa.Context,
    readonly name: string, // Method (handler, transaction, workflow) name
    readonly requiredRole: string[]
  ) { }
}

/**
 * Authentication middleware that executes before a request reaches a function.
 * This is expected to:
 *   - Validate the request found in the handler context and extract auth information from the request.
 *   - Map the HTTP request to the user identity and roles defined in Operon app.
 * If this succeeds, return the current authenticated user and a list of roles.
 * If any step fails, throw an error.
 */
export type OperonHttpAuthMiddleware = (ctx: MiddlewareContext) => Promise<OperonHttpAuthReturn | void>;

export interface OperonHttpAuthReturn {
  authenticatedUser: string;
  authenticatedRoles: string[];
}

// Class-level decorators
export interface OperonMiddlewareDefaults extends OperonRegistrationDefaults {
  koaMiddlewares?: Koa.Middleware[];
  authMiddleware?: OperonHttpAuthMiddleware;
}

export class OperonMiddlewareClassRegistration<CT extends { new(...args: unknown[]): object }> extends OperonClassRegistration<CT> implements OperonMiddlewareDefaults {
  authMiddleware?: OperonHttpAuthMiddleware;
  koaMiddlewares?: Koa.Middleware[];

  constructor(ctor: CT) {
    super(ctor);
  }
}

/////////////////////////////////
/* MIDDLEWARE CLASS DECORATORS */
/////////////////////////////////

/**
 * Define an authentication function for each endpoint in this class.
 */
export function Authentication(authMiddleware: OperonHttpAuthMiddleware) {
  if (authMiddleware === undefined) {
    throw new OperonUndefinedDecoratorInputError("Authentication");
  }
  function clsdec<T extends { new(...args: unknown[]): object }>(ctor: T) {
    const clsreg = getOrCreateOperonClassRegistration(ctor) as OperonMiddlewareClassRegistration<T>;
    clsreg.authMiddleware = authMiddleware;
  }
  return clsdec;
}

/**
 * Define Koa middleware that is applied in order to each endpoint in this class.
 */
export function KoaMiddleware(...koaMiddleware: Koa.Middleware[]) {
  koaMiddleware.forEach((i) => {
    if (i === undefined) {
      throw new OperonUndefinedDecoratorInputError("KoaMiddleware");
    }
  });
  function clsdec<T extends { new(...args: unknown[]): object }>(ctor: T) {
    const clsreg = getOrCreateOperonClassRegistration(ctor) as OperonMiddlewareClassRegistration<T>;
    clsreg.koaMiddlewares = koaMiddleware;
  }
  return clsdec;
}
