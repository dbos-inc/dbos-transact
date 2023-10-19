import axios from "axios";
import { execSync } from "child_process";
import fs from "fs";
import FormData from "form-data";
import { operonEnvPath } from "./login";

export async function deploy(appName: string, host: string) {
  let userToken = fs.readFileSync(`./${operonEnvPath}/credentials`).toString("utf-8");
  userToken = userToken.replace(/\r|\n/g, ''); // Trim the trailing /r /n.
  const bearerToken = "Bearer " + userToken;
  try {
    const register = await axios.post(
      `http://${host}:8080/application/register`,
      {
        name: appName,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: bearerToken,
        },
      }
    );
    const uuid = register.data as string;
    execSync(`mkdir -p operon_deploy`);
    execSync(`envsubst < operon-config.yaml > operon_deploy/operon-config.yaml`);
    execSync(`zip -ry operon_deploy/${uuid}.zip ./* -x operon_deploy/* operon-config.yaml > /dev/null`);
    execSync(`zip -j operon_deploy/${uuid}.zip operon_deploy/operon-config.yaml > /dev/null`);

    const formData = new FormData();
    formData.append("app_archive", fs.createReadStream(`operon_deploy/${uuid}.zip`));

    await axios.post(`http://${host}:8080/application/${uuid}`, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: bearerToken,
      },
    });
    console.log(`Successfully deployed: ${appName}`);
    console.log(`${appName} ID: ${uuid}`);
  } catch (e) {
    console.log(`Deploying ${appName} failed`);
    throw e;
  }
}
