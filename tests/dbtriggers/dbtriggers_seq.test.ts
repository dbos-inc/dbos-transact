import { Knex } from "knex";
import { DBOSConfig, TestingRuntime, Transaction, TransactionContext, Workflow, WorkflowContext } from "../../src";
import { DBTriggerWorkflow, TriggerOperation } from "../../src/dbtrigger/dbtrigger";
import { createInternalTestRuntime } from "../../src/testing/testing_runtime";
import { UserDatabaseName } from "../../src/user_database";
import { generateDBOSTestConfig, setUpDBOSTestDb } from "../helpers";
import { sleepms } from "../../src/utils";

const testTableName = "dbos_test_trig_seq";

type KnexTransactionContext = TransactionContext<Knex>;

class DBOSTestNoClass {

}

class DBOSTriggerTestClassSN {
    static nTSUpdates = 0;
    static tsRecordMap: Map<number, TestTable> = new Map();

    static nSNUpdates = 0;
    static snRecordMap: Map<number, TestTable> = new Map();

    static reset() {
        DBOSTriggerTestClassSN.nTSUpdates = 0;
        DBOSTriggerTestClassSN.tsRecordMap = new Map();

        DBOSTriggerTestClassSN.nSNUpdates = 0;
        DBOSTriggerTestClassSN.snRecordMap = new Map();
    }

    @DBTriggerWorkflow({tableName: testTableName, recordIDColumns: ['order_id'], sequenceNumColumn: 'order_id', sequenceNumJitter: 2})
    @Workflow()
    static async triggerWFBySeq(_ctxt: WorkflowContext, op: TriggerOperation, key: number[], rec: unknown) {
        console.log(`WF ${op} - ${JSON.stringify(key)} / ${JSON.stringify(rec)}`);
        if (op === TriggerOperation.RecordUpserted) {
            DBOSTriggerTestClassSN.snRecordMap.set(key[0], rec as TestTable);
            ++DBOSTriggerTestClassSN.nSNUpdates;
        }
        return Promise.resolve();
    }

    @DBTriggerWorkflow({tableName: testTableName, recordIDColumns: ['order_id'], timestampColumn: 'order_date', timestampSkewMS: 60000})
    @Workflow()
    static async triggerWFByTS(_ctxt: WorkflowContext, op: TriggerOperation, key: number[], rec: unknown) {
        console.log(`WF ${op} - ${JSON.stringify(key)} / ${JSON.stringify(rec)}`);
        if (op === TriggerOperation.RecordUpserted) {
            DBOSTriggerTestClassSN.snRecordMap.set(key[0], rec as TestTable);
            ++DBOSTriggerTestClassSN.nSNUpdates;
        }
        return Promise.resolve();
    }

    @Transaction()
    static async insertRecord(ctx: KnexTransactionContext, rec: TestTable) {
        await ctx.client<TestTable>(testTableName).insert(rec);
    }

    @Transaction()
    static async deleteRecord(ctx: KnexTransactionContext, order_id: number) {
        await ctx.client<TestTable>(testTableName).where({order_id}).delete();
    }

    @Transaction()
    static async updateRecordStatus(ctx: KnexTransactionContext, order_id: number, status: string) {
        await ctx.client<TestTable>(testTableName).where({order_id}).update({status});
    }
}

interface TestTable {
    order_id: number,
    seqnum: number,
    update_date: Date,
    price: number,
    item: string,
    status: string,
}

describe("test-db-triggers", () => {
    let config: DBOSConfig;
    let testRuntime: TestingRuntime;
  
    beforeAll(async () => {
        config = generateDBOSTestConfig(UserDatabaseName.KNEX);
        await setUpDBOSTestDb(config);  
    });

    beforeEach(async () => {
        testRuntime = await createInternalTestRuntime([DBOSTestNoClass], config);
        await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
        await testRuntime.queryUserDB(`
            CREATE TABLE IF NOT EXISTS ${testTableName}(
              order_id SERIAL PRIMARY KEY,
              seqnum INTEGER,
              update_date TIMESTAMP,
              price DECIMAL(10,2),
              item TEXT,
              status VARCHAR(10)
            );`
        );
        await testRuntime.destroy();
        testRuntime = await createInternalTestRuntime(undefined, config);
        DBOSTriggerTestClassSN.reset()
    });
    
    afterEach(async () => {
        // Don't.  Listeners will block this.
        //await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
        await testRuntime.destroy();
    });
  
    test("trigger-seqnum", async () => {
        await sleepms(10);
        /*
        await testRuntime.invoke(DBOSTriggerTestClass).insertRecord({order_id: 1, order_date: new Date(), price: 10, item: "Spacely Sprocket", status:"Ordered"});
        while (DBOSTriggerTestClass.nInserts < 1) await sleepms(10);
        expect(DBOSTriggerTestClass.nInserts).toBe(1);
        expect(DBOSTriggerTestClass.recordMap.get(1)?.status).toBe("Ordered");
        while (DBOSTriggerTestClass.nWFUpdates < 1) await sleepms(10);
        expect(DBOSTriggerTestClass.nWFUpdates).toBe(1);
        expect(DBOSTriggerTestClass.wfRecordMap.get(1)?.status).toBe("Ordered");

        await testRuntime.invoke(DBOSTriggerTestClass).insertRecord({order_id: 2, order_date: new Date(), price: 10, item: "Cogswell Cog", status:"Ordered"});
        while (DBOSTriggerTestClass.nInserts < 2) await sleepms(10);
        expect(DBOSTriggerTestClass.nInserts).toBe(2);
        expect(DBOSTriggerTestClass.nDeletes).toBe(0);
        expect(DBOSTriggerTestClass.nUpdates).toBe(0);
        expect(DBOSTriggerTestClass.recordMap.get(2)?.status).toBe("Ordered");
        while (DBOSTriggerTestClass.nWFUpdates < 2) await sleepms(10);
        expect(DBOSTriggerTestClass.nWFUpdates).toBe(2);
        expect(DBOSTriggerTestClass.wfRecordMap.get(2)?.status).toBe("Ordered");

        await testRuntime.invoke(DBOSTriggerTestClass).deleteRecord(2);
        while (DBOSTriggerTestClass.nDeletes < 1) await sleepms(10);
        expect(DBOSTriggerTestClass.nInserts).toBe(2);
        expect(DBOSTriggerTestClass.nDeletes).toBe(1);
        expect(DBOSTriggerTestClass.nUpdates).toBe(0);
        expect(DBOSTriggerTestClass.recordMap.get(2)?.status).toBeUndefined();
        expect(DBOSTriggerTestClass.nWFUpdates).toBe(2); // Workflow does not trigger on delete

        await testRuntime.invoke(DBOSTriggerTestClass).updateRecordStatus(1, "Shipped");
        while (DBOSTriggerTestClass.nUpdates < 1) await sleepms(10);
        expect(DBOSTriggerTestClass.nInserts).toBe(2);
        expect(DBOSTriggerTestClass.nDeletes).toBe(1);
        expect(DBOSTriggerTestClass.nUpdates).toBe(1);
        expect(DBOSTriggerTestClass.recordMap.get(1)?.status).toBe("Shipped");
        await sleepms(100);
        // This update does not start a workflow as there is no update marker column.
        expect(DBOSTriggerTestClass.nWFUpdates).toBe(2);
        */
    }, 15000);
});

