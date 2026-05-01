const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENV_PATH = path.resolve(__dirname, "..", ".env");

function parseEnvValue(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadEnvFile(envPath = DEFAULT_ENV_PATH, { override = false } = {}) {
  if (!fs.existsSync(envPath)) {
    return false;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || (!override && process.env[key] != null)) {
      continue;
    }

    process.env[key] = parseEnvValue(line.slice(separatorIndex + 1));
  }

  return true;
}

module.exports = {
  loadEnvFile,
};
