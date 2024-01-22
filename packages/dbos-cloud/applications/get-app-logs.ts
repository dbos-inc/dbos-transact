import axios from "axios";
import { GlobalLogger } from "../../../src/telemetry/logs";
import { getCloudCredentials } from "../cloudutils";
import path from "node:path";

export async function getAppLogs(host: string): Promise<number> {
  const logger = new GlobalLogger();
  const userCredentials = getCloudCredentials();
  const bearerToken = "Bearer " + userCredentials.token;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJson = require(path.join(process.cwd(), 'package.json')) as { name: string };
  const appName = packageJson.name;
  logger.info(`Retrieving logs for application: ${appName}`)

  try {
    const res = await axios.get(`https://${host}/${userCredentials.userName}/logs/application/${appName}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: bearerToken,
      },
    });

    logger.info(`Successfully retrieved logs of application: ${appName}`);
    logger.info(res.data)
    return 0;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response) {
      logger.error(`Failed to retrieve logs of application ${appName}: ${e.response?.data}`);
      return 1;
    } else {
      logger.error(`Failed to retrieve logs of application ${appName}: ${(e as Error).message}`);
      return 1;
    }
  }
}
