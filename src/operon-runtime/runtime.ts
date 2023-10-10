import { Operon, OperonConfig } from '../operon';
import { Logger } from 'winston';
import { OperonHttpServer } from '../httpServer/server';
import * as fs from 'fs';
import { isObject } from 'lodash';
import { Server } from 'http';
import { OperonError } from '../error';

interface ModuleExports {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface OperonRuntimeConfig {
  port: number;
  logger: Logger;
}

export class OperonRuntime {
  private operon: Operon;
  private server: Server | null = null;

  constructor(operonConfig: OperonConfig, private readonly runtimeConfig: OperonRuntimeConfig) {
    // Initialize Operon.
    this.operon = new Operon(operonConfig);
  }

  /**
   * Initialize the runtime by loading user functions and initiatilizing the Operon object
   */
  async init() {
    const exports = await this.loadFunctions();
    if (exports === null) {
      this.runtimeConfig.logger.error("operations not found");
      throw new OperonError("operations not found");
    }

    const classes: object[] = [];
    for (const key in exports) {
      if (isObject(exports[key])) {
        classes.push(exports[key] as object);
        this.runtimeConfig.logger.debug(`Loaded class: ${key}`);
      }
    }

    await this.operon.init(...classes);
  }

  /**
   * Load an application's Operon functions, assumed to be in src/operations.ts (which is compiled to dist/operations.js).
   */
  private loadFunctions(): Promise<ModuleExports> | null {
    const workingDirectory = process.cwd();
    const operations = workingDirectory + "/dist/operations.js";
    if (fs.existsSync(operations)) {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      return import(operations) as Promise<ModuleExports>;
    } else {
      this.runtimeConfig.logger.warn("operations not found");
      return null;
    }
  }

  /**
   * Start an HTTP server hosting an application's Operon functions.
   */
  startServer() {
    // CLI takes precedence over config file, which takes precedence over default config.

    const server: OperonHttpServer = new OperonHttpServer(this.operon)

    this.server = server.listen(this.runtimeConfig.port);
    this.operon.logRegisteredHTTPUrls();
  }

  /**
   * Shut down the HTTP server and destroy Operon.
   */
  async destroy() {
    this.server?.close();
    await this.operon?.destroy();
  }
}
