import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const artifactDir = join(packageDir, "artifacts");
const output = join(artifactDir, `remote-page-agent-extension-v${packageJson.version}.zip`);
const staging = mkdtempSync(join(packageDir, ".package-"));

try {
  mkdirSync(artifactDir, { recursive: true });
  cpSync(join(packageDir, "manifest.json"), join(staging, "manifest.json"));
  cpSync(join(packageDir, "options.html"), join(staging, "options.html"));
  cpSync(join(packageDir, "popup.html"), join(staging, "popup.html"));
  cpSync(join(packageDir, "dist"), join(staging, "dist"), { recursive: true });
  execFileSync("zip", ["-qr", output, "."], { cwd: staging, stdio: "inherit" });
  console.log(`Created ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
