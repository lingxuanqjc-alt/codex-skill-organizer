import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const dataRoot = process.env.CSO_INTERNAL_HEALTH_DATA_ROOT;
if (process.argv.length !== 3 || process.argv[2] !== "--internal-health-check"
    || process.env.CSO_INTERNAL_HEALTH_PARENT_PID !== String(process.ppid)
    || process.env.CSO_DESKTOP_PID !== String(process.ppid)
    || !dataRoot || !path.isAbsolute(dataRoot)) {
  throw new Error("The internal health-check transport is invalid");
}

const token = "desktop-shell-test-token";
const protocolVersion = process.env.CSO_TEST_PROTOCOL_VERSION ?? "2.0";
const server = http.createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "codex-skill-organizer",
      version: "0.2.0-test",
      protocolVersion,
      protocolMin: protocolVersion,
      protocolMax: protocolVersion.endsWith(".0") ? `${protocolVersion.slice(0, -2)}.x` : protocolVersion,
      pid: process.pid,
    }));
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Skill Organizer fixture</title><h1>Skill Organizer fixture ready</h1>");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const descriptor = {
  service: "codex-skill-organizer",
  version: "0.2.0-test",
  protocolVersion,
  protocolMin: protocolVersion,
  protocolMax: protocolVersion.endsWith(".0") ? `${protocolVersion.slice(0, -2)}.x` : protocolVersion,
  host: "127.0.0.1",
  port: address.port,
  token,
  credentialExpiresAt: Date.now() + 24 * 60 * 60 * 1_000,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  installRoot: process.env.CSO_INSTALL_ROOT,
};
await fs.mkdir(dataRoot, { recursive: true });
await fs.writeFile(path.join(dataRoot, "runtime.json"), `${JSON.stringify(descriptor)}\n`, "utf8");

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
