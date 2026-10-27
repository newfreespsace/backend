import { resolve } from "path";
import { loadEnvFile } from "process";

/** Load before application modules construct providers that read process.env. */
export function loadLocalEnvironment(filePath = resolve(__dirname, "../../.env.local")): void {
  try {
    // Node preserves variables already supplied by the shell or deployment.
    loadEnvFile(filePath);
  } catch (error) {
    // The file is optional when configuration is injected by the deployment.
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

loadLocalEnvironment();
