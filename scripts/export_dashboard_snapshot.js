#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { ensureDirectories, DATA_DIR } = require("../server/config");
const { initDb } = require("../server/db");
const { buildDashboardSnapshot } = require("../server/dashboard");

function parseArgs(argv) {
  const args = {
    output: path.join(DATA_DIR, "published", "dashboard.json"),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") {
      args.output = path.resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function printHelp() {
  console.log("Usage: node scripts/export_dashboard_snapshot.js [--output path]");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  ensureDirectories();
  initDb();

  const snapshot = buildDashboardSnapshot();
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    JSON.stringify({
      ok: true,
      output: args.output,
      snapshotGeneratedAt: snapshot.snapshotGeneratedAt,
      asOf: snapshot.current?.asOf ?? null,
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
