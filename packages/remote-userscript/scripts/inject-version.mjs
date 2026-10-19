import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const outputPath = resolve(packageDirectory, "dist/remote-agent.user.js");
const output = await readFile(outputPath, "utf8");
const versionedOutput = output.replace(
  /@version\s+__PACKAGE_VERSION__/,
  `@version      ${packageJson.version}`,
);
await writeFile(outputPath, versionedOutput);
