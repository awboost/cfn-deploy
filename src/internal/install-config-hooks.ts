import { Command } from "commander";
import { readFile } from "fs/promises";

export function installConfigHooks(command: Command): void {
  command.hook("preAction", loadConfig);
  command.commands.forEach(installConfigHooks);
}

async function loadConfig(command: Command): Promise<void> {
  const configPath = command.optsWithGlobals()["config"];
  if (!configPath || typeof configPath !== "string") {
    return;
  }

  let config;

  try {
    config = JSON.parse(await readFile(configPath, "utf-8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      if (command.getOptionValueSourceWithGlobals("config") === "default") {
        return;
      }
    }
    throw new Error(`failed to load config file "${configPath}"`, {
      cause: err,
    });
  }

  for (const [key, value] of Object.entries(config)) {
    const source = command.getOptionValueSourceWithGlobals(key);
    if (!source || source === "default" || source === "env") {
      command.setOptionValueWithSource(key, value, "config");
    }
  }
}
