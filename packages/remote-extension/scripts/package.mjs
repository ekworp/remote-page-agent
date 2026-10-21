import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const distDir = join(packageDir, "dist");
const extensionDir = join(distDir, "extension");
const sourceAssetsDir = join(packageDir, "extension");
const output = join(distDir, `remote-page-agent-extension-v${packageJson.version}.zip`);
const staging = mkdtempSync(join(packageDir, ".package-"));

try {
  mkdirSync(distDir, { recursive: true });
  cpSync(sourceAssetsDir, extensionDir, { recursive: true });
  cpSync(extensionDir, staging, { recursive: true });
  execFileSync("zip", ["-qr", output, "."], { cwd: staging, stdio: "inherit" });
  console.log(`Created ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
