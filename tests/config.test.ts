import { Operon, OperonConfig, OperonInitializationError } from "src/";
import { generateOperonTestConfig } from "./helpers";
import * as utils from "../src/utils";
import { PoolConfig } from "pg";
import { OperonRuntimeConfig } from "src/operon-runtime/runtime";

describe("operon-config", () => {
  const mockOperonConfigYamlString = `
      database:
        hostname: 'some host'
        port: 1234
        username: 'some user'
        connectionTimeoutMillis: 3000
        user_database: 'some DB'
      localRuntimeConfig:
        port: 1234
      application:
        payments_url: 'http://somedomain.com/payment'
        foo: '\${FOO:default}'
        bar: '\${BAR}'
        baz: '\${:default}'
        nested:
            quz: '\${QUZ:default}'
            quuz: '\${QUUZ}'
            a:
              - 1
              - 2
              - b:
                  c: '\${C:default}'
    `;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Config is valid and is parsed as expected", async () => {
    jest
      .spyOn(utils, "readFileSync")
      .mockReturnValueOnce(mockOperonConfigYamlString);
    jest.spyOn(utils, "readFileSync").mockReturnValueOnce("SQL STATEMENTS");
    process.env.FOO = "foo";
    process.env.BAR = "bar";
    process.env.QUUZ = "quuz";
    process.env.C = "c";

    const operon: Operon = new Operon();
    operon.useNodePostgres();
    expect(operon.initialized).toBe(false);
    const operonConfig: OperonConfig = operon.config;

    // Test pool config options
    const poolConfig: PoolConfig = operonConfig.poolConfig;
    expect(poolConfig.host).toBe("some host");
    expect(poolConfig.port).toBe(1234);
    expect(poolConfig.user).toBe("some user");
    expect(poolConfig.password).toBe(process.env.PGPASSWORD);
    expect(poolConfig.connectionTimeoutMillis).toBe(3000);
    expect(poolConfig.database).toBe("some DB");

    // Application config
    const applicationConfig: any = operonConfig.application;
    expect(applicationConfig.payments_url).toBe("http://somedomain.com/payment")
    expect(applicationConfig.foo).toBe("foo")
    expect(applicationConfig.bar).toBe("bar")
    expect(applicationConfig.baz).toBe("${:default}") // XXX right now we don't match missing env vars
    expect(applicationConfig.nested.quz).toBe("default")
    expect(applicationConfig.nested.quuz).toBe("quuz")
    expect(applicationConfig.nested.a).toBeInstanceOf(Array)
    expect(applicationConfig.nested.a).toHaveLength(3)
    expect(applicationConfig.nested.a[2].b.c).toBe("c")

    // local runtime config
    const localRuntimeConfig: OperonRuntimeConfig = operonConfig.runtimeConfig as OperonRuntimeConfig;
    expect(localRuntimeConfig.port).toBe(1234);

    await operon.destroy();
  });

  test("Custom config is parsed as expected", async () => {
    // We use readFileSync as a proxy for checking the config was not read from the default location
    const readFileSpy = jest.spyOn(utils, "readFileSync");
    const config: OperonConfig = generateOperonTestConfig();
    const operon = new Operon(config);
    operon.useNodePostgres();
    expect(operon.initialized).toBe(false);
    expect(operon.config).toBe(config);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(operon.config.application.counter).toBe(3);
    expect(readFileSpy).toHaveBeenCalledTimes(0);
    await operon.destroy();
  });

  test("fails to read config file", () => {
    jest.spyOn(utils, "readFileSync").mockImplementation(() => {
      throw new Error("some error");
    });
    expect(() => new Operon()).toThrow(OperonInitializationError);
  });

  test("config file is empty", () => {
    const mockConfigFile = "";
    jest
      .spyOn(utils, "readFileSync")
      .mockReturnValue(JSON.stringify(mockConfigFile));
    expect(() => new Operon()).toThrow(OperonInitializationError);
  });

  test("config file is missing database config", () => {
    const mockConfigFile = { someOtherConfig: "some other config" };
    jest
      .spyOn(utils, "readFileSync")
      .mockReturnValue(JSON.stringify(mockConfigFile));
    expect(() => new Operon()).toThrow(OperonInitializationError);
  });
});
