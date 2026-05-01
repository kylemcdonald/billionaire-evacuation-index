#!/usr/bin/env node

const { loadEnvFile } = require("../server/env");
const { initDb } = require("../server/db");
const { buildDashboardSnapshot, buildStoredHeatmapStatus } = require("../server/dashboard");
const { maybeSendEmergencyLevelTelegramAlert } = require("../server/telegram-alert");

function parseArgs(argv) {
  const args = {
    dryRun: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function printHelp() {
  console.log("Usage: node scripts/send_telegram_alert.js [--dry-run]");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  loadEnvFile();
  initDb();

  const liveStatus = buildStoredHeatmapStatus();
  const snapshot = buildDashboardSnapshot({
    liveStatus,
  });
  const result = await maybeSendEmergencyLevelTelegramAlert({
    snapshot,
    status: liveStatus,
    dryRun: args.dryRun,
  });

  console.log(
    JSON.stringify({
      ...result,
      emergencyLevel: snapshot.signals?.composite?.emergencyLevel ?? snapshot.current?.emergencyLevel ?? null,
      asOf: snapshot.current?.asOf ?? null,
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
