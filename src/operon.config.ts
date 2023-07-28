import { OperonError } from './error';

import { PoolConfig } from 'pg';
import YAML from 'yaml'
import fs from 'fs'

const configFile: string = "operon-config.yaml";

interface OperonConfigFile {
    database: DatabaseConfig;
}

export interface DatabaseConfig {
    hostname: string;
    port: number;
    username: string;
    password?: string;
    connectionTimeoutMillis: number;
}

export class OperonConfig {
  readonly poolConfig: PoolConfig;
  // We will add a "debug" flag here to be used in other parts of the codebase

  constructor() {
    // Check if configFile is a valid file
    try {
      fs.stat(configFile, (error: NodeJS.ErrnoException | null, stats: fs.Stats) => {
        if (error) {
          throw new OperonError(`checking on ${configFile}. Errno: ${error.errno}`);
        } else if (!stats.isFile()) {
          throw new OperonError(`config file ${configFile} is not a file`);
        }
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new OperonError(`calling fs.stat on ${configFile}: ${error.message}`);
      }
    }

    // Logic to parse configFile.
    const configFileContent: string = fs.readFileSync(configFile, 'utf8')
    const parsedConfig: OperonConfigFile = YAML.parse(configFileContent) as OperonConfigFile;

    // Handle DB config
    const dbConfig: DatabaseConfig = parsedConfig.database;
    const dbPassword: string | undefined = process.env.DB_PASSWORD || process.env.PGPASSWORD;
    if (!dbPassword) {
      throw new OperonError('DB_PASSWORD or PGPASSWORD environment variable not set');
    }

    this.poolConfig = {
      host: dbConfig.hostname,
      port: dbConfig.port,
      user: dbConfig.username,
      password: dbPassword,
      connectionTimeoutMillis: dbConfig.connectionTimeoutMillis,
      database: 'postgres', // For now we use the default postgres database
    };
  }
}
