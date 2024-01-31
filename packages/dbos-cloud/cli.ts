#!/usr/bin/env node

import {
  registerApp,
  updateApp,
  listApps,
  deleteApp,
  deployAppCode,
  getAppLogs,
} from "./applications";
import { Command } from 'commander';
import { login } from "./login";
import { registerUser } from "./register";
import { createUserDb, getUserDb, deleteUserDb } from "./userdb";
import { credentialsExist } from "./cloudutils";

const program = new Command();

const DEFAULT_HOST = process.env.DBOS_DOMAIN; // TODO: Once we have a "production" cluster, hardcode its domain name here

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../../package.json') as { version: string };
program.
  version(packageJson.version);

/////////////////////
/* AUTHENTICATION  */
/////////////////////

program
  .command('login')
  .description('Log in to DBOS cloud')
  .requiredOption('-u, --username <string>', 'Username')
  .action(async (options: { username: string }) => {
    const exitCode = await login(options.username);
    process.exit(exitCode);
  });

program
  .command('register')
  .description('Register a user and log in to DBOS cloud')
  .requiredOption('-u, --username <string>', 'Username')
  .option('-h, --host <string>', 'Specify the host', DEFAULT_HOST)
  .action(async (options: { username: string, host: string}) => {
    if (!credentialsExist()) {
      const exitCode = await login(options.username);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    }
    const exitCode = await registerUser(options.username, options.host);
    process.exit(exitCode);
  });

/////////////////////////////
/* APPLICATIONS MANAGEMENT */
/////////////////////////////

const applicationCommands = program
  .command('applications')
  .description('Manage your DBOS applications')
  .option('-h, --host <string>', 'Specify the host', DEFAULT_HOST)

applicationCommands
  .command('register')
  .description('Register a new application')
  .requiredOption('-d, --database <string>', 'Specify the app database name')
  .action(async (options: { database: string }) => {
    const { host }: { host: string } = applicationCommands.opts()
    const exitCode = await registerApp(options.database, host);
    process.exit(exitCode);
  });

applicationCommands
  .command('update')
  .description('Update an application')
  .action(async () => {
    const { host }: { host: string } = applicationCommands.opts()
    const exitCode = await updateApp(host);
    process.exit(exitCode);
  });

applicationCommands
  .command('deploy')
  .description('Deploy an application code to the cloud')
  .option('--no-docker', 'Build the code locally without using Docker')
  .action(async (options: { docker: boolean }) => {
    const { host }: { host: string } = applicationCommands.opts()
    const exitCode = await deployAppCode(host, options.docker);
    process.exit(exitCode);
  });

applicationCommands
  .command('delete')
  .description('Delete a previously deployed application')
  .action(async () => {
    const { host }: { host: string } = applicationCommands.opts()
    const exitCode = await deleteApp(host);
    process.exit(exitCode);
  });

applicationCommands
  .command('list')
  .description('List all deployed applications')
  .option('--json', 'Emit JSON output')
  .action(async (options: { json: boolean }) => {
    const { host }: { host: string } = applicationCommands.opts()
    const exitCode = await listApps(host, options.json);
    process.exit(exitCode);
  });

applicationCommands
  .command('logs')
  .description('Print the microVM logs of a deployed application')
  .option('-l, --last <integer>', 'How far back to query, in seconds from current time. By default, we retrieve all data', parseInt)
  .action(async (options: { last: number}) => {
    const { host }: { host: string } = applicationCommands.opts()
    const exitCode = await getAppLogs(host, options.last);
    process.exit(exitCode);
  });

//////////////////////////////
/* USER DATABASE MANAGEMENT */
//////////////////////////////

const userdbCommands = program
  .command('userdb')
  .description('Manage your databases')
  .option('-h, --host <string>', 'Specify the host', DEFAULT_HOST)

userdbCommands
  .command('create')
  .argument('<string>', 'database name')
  .requiredOption('-a, --admin <string>', 'Specify the admin user')
  .requiredOption('-W, --password <string>', 'Specify the admin password')
  .option('-s, --sync', 'make synchronous call', true)
  .action((async (dbname: string, options: { admin: string, password: string, sync: boolean }) => {
    const { host }: { host: string } = userdbCommands.opts()
    await createUserDb(host, dbname, options.admin, options.password, options.sync)
  }))

userdbCommands
  .command('status')
  .argument('<string>', 'database name')
  .option('--json', 'Emit JSON output')
  .action((async (dbname: string, options: { json: boolean}) => {
    const { host }: { host: string } = userdbCommands.opts()
    await getUserDb(host, dbname, options.json)
  }))

userdbCommands
  .command('delete')
  .argument('<string>', 'database name')
  .action((async (dbname: string) => {
    const { host }: { host: string } = userdbCommands.opts()
    await deleteUserDb(host, dbname)
  }))

program.parse(process.argv);

// If no arguments provided, display help by default
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
