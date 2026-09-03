import { logger } from "./logger.js";
/* global fetch */
const CRATES_API_BASE = "https://crates.io/api/v1/crates";

const FRAMEWORK_DEPENDENCIES = [
  {
    name: "soroban-sdk",
    upgradeUrl: "https://soroban.stellar.org/docs/getting-started/upgrading",
  },
  {
    name: "soroban-env",
    upgradeUrl: "https://soroban.stellar.org/docs/getting-started/upgrading",
  },
];

const latestVersionCache = new Map();

function normalizeVersionSpec(value) {
  if (!value) return null;
  let version = String(value).trim();
  version = version.replace(/^["']|["']$/g, "");
  version = version.replace(/^(?:\^|~|>=|<=|>|<|=)\s*/g, "");
  version = version.split(/\s*,\s*/)[0];
  version = version.split(/\s*\|\|\s*/)[0];
  version = version.split(/\s*\+\s*/)[0];
  version = version.split(/\s*;\s*/)[0];
  version = version.split(/[\s[]/)[0];
  if (!version) return null;
  return version;
}

function compareSemver(a, b) {
  const norm = (version) =>
    String(version || "")
      .split(".")
      .slice(0, 3)
      .map((part) => {
        const num = Number(part.replace(/[^0-9].*$/, ""));
        return Number.isNaN(num) ? 0 : num;
      });

  const aParts = norm(a);
  const bParts = norm(b);
  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] < bParts[i]) return -1;
    if (aParts[i] > bParts[i]) return 1;
  }
  return 0;
}

function parseCargoTomlDependencies(content) {
  const deps = {};
  const lines = content.split(/\r?\n/);
  let currentSection = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    if (!/^(dependencies|dev-dependencies|build-dependencies)$/.test(currentSection)) continue;

    const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!depMatch) continue;
    const name = depMatch[1].trim();
    let rawValue = depMatch[2].trim();

    if (rawValue.startsWith("{")) {
      const versionMatch = rawValue.match(/version\s*=\s*"([^"]+)"/);
      if (versionMatch) rawValue = versionMatch[1];
      else rawValue = "";
    }

    const versionSpec = normalizeVersionSpec(rawValue);
    if (versionSpec) deps[name] = versionSpec;
  }

  return deps;
}

async function fetchLatestCrateVersion(crateName) {
  if (latestVersionCache.has(crateName)) return latestVersionCache.get(crateName);

  try {
    const res = await fetch(`${CRATES_API_BASE}/${crateName}`);
    if (!res.ok) throw new Error(`Crates.io responded ${res.status}`);
    const json = await res.json();
    const latest = json?.crate?.max_version;
    if (latest) {
      latestVersionCache.set(crateName, latest);
      return latest;
    }
  } catch (err) {
    logger.warn(`Unable to fetch latest version for ${crateName}:`, err?.message ?? err);
  }

  return null;
}

export async function analyzeSourceDependencies(sourceFiles = []) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) return null;

  const cargoFiles = sourceFiles.filter((file) => file.path.toLowerCase().endsWith("cargo.toml"));
  if (!cargoFiles.length) return null;

  const packages = [];
  for (const file of cargoFiles) {
    const deps = parseCargoTomlDependencies(file.content || "");
    for (const pkg of FRAMEWORK_DEPENDENCIES) {
      const current = deps[pkg.name];
      if (current) {
        packages.push({
          name: pkg.name,
          currentVersion: current,
          upgradeUrl: pkg.upgradeUrl,
        });
      }
    }
  }

  if (!packages.length) return null;

  const outdated = [];
  for (const item of packages) {
    const latestVersion = await fetchLatestCrateVersion(item.name);
    if (!latestVersion) continue;
    const current = normalizeVersionSpec(item.currentVersion);
    if (current && compareSemver(current, latestVersion) < 0) {
      outdated.push({
        name: item.name,
        currentVersion: item.currentVersion,
        latestVersion,
        upgradeUrl: item.upgradeUrl,
      });
    }
  }

  if (!outdated.length) return null;

  return {
    outdated: true,
    summary: `Detected ${outdated.length} outdated Soroban dependency${outdated.length > 1 ? "ies" : "y"}.`,
    packages: outdated,
  };
}
