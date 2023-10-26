import request from "supertest";

import {
  OperonTestingRuntime, OperonTransaction, OperonWorkflow,
  TransactionContext, WorkflowContext,
  GetApi, PostApi,
  HandlerContext,
  RequiredRole, Authentication,
  MiddlewareContext,
} from "../src";
import {
  OperonNotAuthorizedError
} from "../src/error"
import { OperonConfig } from "../src/operon";
import { UserDatabaseName } from "../src/user_database";
import { TestKvTable, generateOperonTestConfig, setupOperonTestDb } from "./helpers";
import { v1 as uuidv1 } from "uuid";
import { Knex } from "knex";
import { DatabaseError } from "pg";
import { createInternalTestRuntime } from "../src/testing/testing_runtime";

type KnexTransactionContext = TransactionContext<Knex>;
const testTableName = "operon_test_kv";

let insertCount = 0;

class TestClass {
  @OperonTransaction()
  static async testInsert(txnCtxt: KnexTransactionContext, value: string) {
    insertCount++;
    const result = await txnCtxt.client<TestKvTable>(testTableName).insert({ value: value }).returning("id");
    return result[0].id!;
  }

  @OperonTransaction()
  static async testSelect(txnCtxt: KnexTransactionContext, id: number) {
    const result = await txnCtxt.client<TestKvTable>(testTableName).select("value").where({ id: id });
    return result[0].value!;
  }

  @OperonWorkflow()
  static async testWf(ctxt: WorkflowContext, value: string) {
    const id = await ctxt.invoke(TestClass).testInsert(value);
    const result = await ctxt.invoke(TestClass).testSelect(id);
    return result;
  }

  @OperonTransaction()
  static async returnVoid(_ctxt: KnexTransactionContext) {}

  @OperonTransaction()
  static async unsafeInsert(txnCtxt: KnexTransactionContext, key: number, value: string) {
    insertCount++;
    const result = await txnCtxt.client<TestKvTable>(testTableName).insert({ id: key, value: value }).returning("id");
    return result[0].id!;
  }
}

describe("knex-tests", () => {
  let testRuntime: OperonTestingRuntime;
  let config: OperonConfig;

  beforeAll(async () => {
    config = generateOperonTestConfig(UserDatabaseName.KNEX);
    await setupOperonTestDb(config);
  });

  beforeEach(async () => {
    testRuntime = await createInternalTestRuntime([TestClass], config);
    await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
    await testRuntime.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
    insertCount = 0;
  });

  afterEach(async () => {
    await testRuntime.destroy();
  });

  test("simple-knex", async () => {
    await expect(testRuntime.invoke(TestClass).testInsert("test-one")).resolves.toBe(1);
    await expect(testRuntime.invoke(TestClass).testSelect(1)).resolves.toBe("test-one");
    await expect(testRuntime.invoke(TestClass).testWf("test-two").then((x) => x.getResult())).resolves.toBe("test-two");
  });

  test("knex-return-void", async () => {
    await expect(testRuntime.invoke(TestClass).returnVoid()).resolves.not.toThrow();
  });

  test("knex-duplicate-workflows", async () => {
    const uuid = uuidv1();
    const results = await Promise.allSettled([
      testRuntime.invoke(TestClass, uuid).testWf("test-one").then((x) => x.getResult()),
      testRuntime.invoke(TestClass, uuid).testWf("test-one").then((x) => x.getResult()),
    ]);
    expect((results[0] as PromiseFulfilledResult<string>).value).toBe("test-one");
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe("test-one");
    expect(insertCount).toBe(1);
  });

  test("knex-key-conflict", async () => {
    await testRuntime.invoke(TestClass).unsafeInsert(1, "test-one");
    try {
      await testRuntime.invoke(TestClass).unsafeInsert(1, "test-two");
      expect(true).toBe(false); // Fail if no error is thrown.
    } catch (e) {
      const err: DatabaseError = e as DatabaseError;
      expect(err.code).toBe("23505");
    }
  });
});

const userTableName = 'operon_test_user';
interface UserTable
{
  id ?: number;
  username ?: string;
}

@Authentication(KUserManager.authMiddlware)
class KUserManager {
  @OperonTransaction()
  @PostApi('/register')
  static async createUser(txnCtxt: KnexTransactionContext, uname: string) {
    const result = await txnCtxt.client<UserTable>(userTableName).insert({username: uname}).returning("id");
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  @GetApi('/hello')
  @RequiredRole(['user'])
  static async hello(hCtxt: HandlerContext) {
    return {messge: "hello "+hCtxt.authenticatedUser};
  }

  static async authMiddlware(ctx: MiddlewareContext) {
    if (!ctx.requiredRole || !ctx.requiredRole.length) {
      return;
    }
    const {user} = ctx.koaContext.query;
    if (!user) {
      throw new OperonNotAuthorizedError("User not provided", 401);
    }
    const u = await ctx.query(
      (dbClient: Knex, uname: string) => {
        return dbClient<UserTable>(userTableName).select("username").where({ username: uname })
      }, user as string
      );

    if (!u || !u.length) {
      throw new OperonNotAuthorizedError("User does not exist", 403);
    }
    ctx.logger.info(`Allowed in user: ${u[0].username}`);
    return {
      authenticatedUser: u[0].username!,
      authenticatedRoles: ["user"],
    };
  }
}

describe("knex-auth-tests", () => {
  let config: OperonConfig;
  let testRuntime: OperonTestingRuntime;

  beforeAll(async () => {
    config = generateOperonTestConfig(UserDatabaseName.KNEX);
    await setupOperonTestDb(config);
  });

  beforeEach(async () => {
    testRuntime = await createInternalTestRuntime([KUserManager], config);
    await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${userTableName};`);
    await testRuntime.queryUserDB(`CREATE TABLE IF NOT EXISTS ${userTableName} (id SERIAL PRIMARY KEY, username TEXT);`);
  });

  afterEach(async () => {
    await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${userTableName};`);
    await testRuntime.destroy();
  });

  test("simple-knex-auth", async () => {
    // No user name
    const response1 = await request(testRuntime.getHandlersCallback()).get("/hello");
    expect(response1.statusCode).toBe(401);

    // User name doesn't exist
    const response2 = await request(testRuntime.getHandlersCallback()).get("/hello?user=paul");
    expect(response2.statusCode).toBe(403);

    const response3 = await request(testRuntime.getHandlersCallback()).post("/register").send({uname: "paul"});
    expect(response3.statusCode).toBe(200);

    const response4 = await request(testRuntime.getHandlersCallback()).get("/hello?user=paul");
    expect(response4.statusCode).toBe(200);
  });
});
