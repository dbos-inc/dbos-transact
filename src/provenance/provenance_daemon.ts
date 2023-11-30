import { Client, DatabaseError } from "pg";
import { PostgresExporter } from "../telemetry/exporters";
import { TelemetryCollector } from "../telemetry/collector";
import { DBOSConfig } from "../dbos-executor";
import { ProvenanceSignal } from "../telemetry/signals";

interface wal2jsonRow {
  xid: string;
  data: string;
}

interface wal2jsonData {
  change: wal2jsonChange[];
}

interface wal2jsonChange {
  kind: string;
  schema: string;
  table: string;
  columnnames: string[];
  columntypes: string[];
  columnvalues: string[];
}

/**
 * A class implementing a daemon which collects and exports provenance information,
 * specifically a record of all INSERTs, UPDATEs, and DELETEs in the target database.
 * Only one daemon is needed per database. The daemon need not run in the same process as workflow runtime.
 * The daemon has three requirements and will fail to launch if any is not met:
 *
 *  1.  The database must be configured with wal_level=logical.
 *  2.  An open replication slot must be available.
 *  3.  The wal2json Postgres plugin must be installed. It is installed by default on most cloud databases, including RDS.
 *
 * Because the daemon depends on Postgres logical replication, it can only export information on updates and deletes in tables
 * whose rows are uniquely identifiable, either because the table has a primary key or a replica identity.
 */
export class ProvenanceDaemon {
  readonly client;
  readonly daemonID;
  readonly recordProvenanceIntervalMs = 1000;
  readonly telemetryCollector: TelemetryCollector;
  initialized = false;

  /**
   * @param dbosConfig An DBOS config defining exporters and database connection information.
   * @param slotName  The name of a logical replication slot. This slot is persistent and must be deleted if the daemon is no longer to be used.
   */
  constructor(dbosConfig: DBOSConfig, readonly slotName: string) {
    this.client = new Client(dbosConfig.poolConfig);
    this.daemonID = setInterval(() => {
      void this.recordProvenance();
    }, this.recordProvenanceIntervalMs);
    const telemetryExporters = [new PostgresExporter(dbosConfig.poolConfig, dbosConfig?.observability_database)];
    this.telemetryCollector = new TelemetryCollector(telemetryExporters);
  }

  async start() {
    await this.client.connect();
    // Create a logical replication slot with the given name.
    try { // TODO: Make this robust to daemon crashes, so records are not consumed until they've been exported.
      await this.client.query("SELECT pg_create_logical_replication_slot($1, 'wal2json');", [this.slotName]);
    } catch (error) {
      const err: DatabaseError = error as DatabaseError;
      if (err.code === "42710") {
        // The slot has already been created.
      } else {
        console.error(err);
        throw err;
      }
    }
    await this.telemetryCollector.init();
    this.initialized = true;
  }

  async recordProvenance() {
    if (this.initialized) {
      const { rows } = await this.client.query<wal2jsonRow>("SELECT CAST(xid AS TEXT), data FROM pg_logical_slot_get_changes($1, NULL, NULL, 'filter-tables', 'dbos.*')", [this.slotName]);
      for (const row of rows) {
        const data = (JSON.parse(row.data) as wal2jsonData).change;
        for (const change of data) {
          const signal: ProvenanceSignal = {
            provTransactionID: row.xid,
            kind: change.kind,
            schema: change.schema,
            table: change.table,
            columnnames: change.columnnames,
            columntypes: change.columntypes,
            columnvalues: change.columnvalues
          }
          this.telemetryCollector.push(signal);
        }
      }
    }
  }

  async stop() {
    clearInterval(this.daemonID);
    await this.client.end();
    await this.telemetryCollector.destroy();
  }
}
