/**
 * #567: Decoder plugin system for community-contributed event decoders.
 *
 * Plugins are JS modules in indexer/src/plugins/ that export:
 *   { matches(ev, topics, data, contractId), decode(ev, topics, data, contractId) }
 *
 * - `matches()` returns true when the plugin handles this event.
 * - `decode()` returns { description, function? } or throws.
 * - Plugins run before built-in decoders; first match wins.
 * - A plugin that throws is caught and logged; the built-in fallback runs.
 */
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, "plugins");

let _plugins = null;

/**
 * Scan the plugins directory and load all .js modules that export
 * matches() and decode() functions. Cached after first load.
 *
 * @returns {Promise<Array<{ matches: Function, decode: Function }>>}
 */
export async function loadPlugins() {
  if (_plugins) return _plugins;

  let files;
  try {
    files = await readdir(PLUGINS_DIR);
  } catch {
    // No plugins directory — return empty
    _plugins = [];
    return _plugins;
  }

  const jsFiles = files.filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  const plugins = [];

  for (const file of jsFiles) {
    try {
      const mod = await import(join(PLUGINS_DIR, file));
      if (typeof mod.matches === "function" && typeof mod.decode === "function") {
        plugins.push({ name: file, matches: mod.matches, decode: mod.decode });
      }
    } catch (err) {
      console.error(`[decoderPlugins] failed to load ${file}: ${err.message}`);
    }
  }

  _plugins = plugins;
  if (plugins.length) {
    console.log(`[decoderPlugins] loaded ${plugins.length} plugin(s): ${plugins.map((p) => p.name).join(", ")}`);
  }
  return _plugins;
}

/**
 * Run all loaded plugins against an event. Returns the first matching result.
 *
 * @param {object}  ev         Raw Soroban RPC event
 * @param {any[]}   topics     scValToNative-decoded topics (without fn name)
 * @param {any}     data       scValToNative-decoded data
 * @param {string}  contractId Contract address
 * @returns {Promise<{ description: string, function?: string } | null>}
 */
export async function runPlugins(ev, topics, data, contractId) {
  const plugins = await loadPlugins();
  for (const plugin of plugins) {
    try {
      if (plugin.matches(ev, topics, data, contractId)) {
        const result = await plugin.decode(ev, topics, data, contractId);
        if (result && typeof result.description === "string") {
          return result;
        }
      }
    } catch (err) {
      console.error(`[decoderPlugins] plugin ${plugin.name} threw: ${err.message}`);
    }
  }
  return null;
}
