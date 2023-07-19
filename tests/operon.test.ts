/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Operon, WorkflowContext, TransactionContext } from "src/";
import { v1 as uuidv1 } from 'uuid';

describe('operon-tests', () => {
  let operon: Operon;
  const username: string = process.env.DB_USER || 'postgres';

  beforeEach(async () => {
    operon = new Operon({
      user: username,
      password: process.env.DB_PASSWORD || 'dbos',
      connectionTimeoutMillis:  3000
    });
    await operon.resetOperonTables();
    await operon.pool.query("DROP TABLE IF EXISTS OperonKv;");
    await operon.pool.query("CREATE TABLE IF NOT EXISTS OperonKv (id SERIAL PRIMARY KEY, value TEXT);");
  });

  afterEach(async () => {
    await operon.pool.end();
  });


  test('simple-function', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };

    const workflowResult: string = await operon.workflow(testWorkflow, {}, username);

    expect(JSON.parse(workflowResult)).toEqual({"current_user": username});
  });


  test('tight-loop', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };

    for (let i = 0; i < 100; i++) {
      const workflowResult: string = await operon.workflow(testWorkflow, {}, username);
      expect(JSON.parse(workflowResult)).toEqual({"current_user": username});
    }
  });
  

  test('abort-function', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query("INSERT INTO OperonKv(value) VALUES ($1) RETURNING id", [name]);
      if (name === "fail") {
        await txnCtxt.rollback();
      }
      return Number(rows[0].id);
    };

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query("SELECT id FROM OperonKv WHERE id=$1", [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };

    for (let i = 0; i < 10; i++) {
      const workflowResult: number = await operon.workflow(testWorkflow, {}, username);
      expect(workflowResult).toEqual(i + 1);
    }
    
    // Should not appear in the database.
    const workflowResult: number = await operon.workflow(testWorkflow, {}, "fail");
    expect(workflowResult).toEqual(-1);
  });


  test('oaoo-simple', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query("INSERT INTO OperonKv(value) VALUES ($1) RETURNING id", [name]);
      if (name === "fail") {
        await txnCtxt.rollback();
      }
      return Number(rows[0].id);
    };

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query("SELECT id FROM OperonKv WHERE id=$1", [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };

    let workflowResult: number;
    const uuidArray: string[] = [];
    for (let i = 0; i < 10; i++) {
      const idemKey: string = uuidv1();
      uuidArray.push(idemKey);
      workflowResult = await operon.workflow(testWorkflow, {idempotencyKey: idemKey}, username);
      expect(workflowResult).toEqual(i + 1);
    }
    // Should not appear in the database.
    const idemKeyFail: string = uuidv1();
    workflowResult = await operon.workflow(testWorkflow, {idempotencyKey: idemKeyFail}, "fail");
    expect(workflowResult).toEqual(-1);

    // Rerun with the same idempotency key should return the same output.
    for (let i = 0; i < 10; i++) {
      const idemKey: string = uuidArray[i];
      const workflowResult: number = await operon.workflow(testWorkflow, {idempotencyKey: idemKey}, username);
      expect(workflowResult).toEqual(i + 1);
    }
    // Given the same idempotency key but different input, should return the original execution.
    workflowResult = await operon.workflow(testWorkflow, {idempotencyKey: idemKeyFail}, "hello");
    expect(workflowResult).toEqual(-1);
  });
});
