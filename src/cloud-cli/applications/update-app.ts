import axios from "axios";
import { createGlobalLogger } from "../../telemetry/logs";
import { getCloudCredentials } from "../utils";
import { Application } from "./types";

export async function updateApp(appName: string, host: string, port: string, machines: number) {
  const logger = createGlobalLogger();
  const userCredentials = getCloudCredentials();
  const bearerToken = "Bearer " + userCredentials.token;

  try {
    logger.info(`Updating application ${appName} to ${machines} machines`);
    const update = await axios.patch(
      `http://${host}:${port}/${userCredentials.userName}/application/${appName}`,
      {
        name: appName,
        max_vms: machines
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: bearerToken,
        },
      }
    );
    const application: Application = update.data as Application;
    logger.info(`Successfully updated: ${application.Name}`);
    console.log(JSON.stringify({ "Name": application.Name, "ID": application.ID, "Status": application.Status, "MaxVMs": application.MaxVMs }));
  } catch (e) {
    if (axios.isAxiosError(e) && e.response) {
      logger.error(`failed to update application ${appName}: ${e.response?.data}`);
    } else {
      logger.error(`failed to update application ${appName}: ${(e as Error).message}`);
    }
  }
}
