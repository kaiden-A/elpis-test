#!/usr/bin/env node
/**
 * Bakes the CMS-managed MCP server list (`config/mcp-servers.yml`, a top-level
 * array) into `librechat.yaml`, whose schema requires `mcpServers` to be a map
 * keyed by server name. Runs during the image build so the repository keeps the
 * editable array as the single source of truth.
 *
 * Every entry authenticates with the signed-in user's live Zitadel access
 * token; the bearer header is added here so the CMS form only needs a name,
 * a URL, and a transport.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const configPath = path.resolve(getArg('--config', 'librechat.yaml'));
const serversPath = path.resolve(getArg('--servers', 'config/mcp-servers.yml'));
const promptPath = path.resolve(getArg('--prompt', 'config/system-prompt.md'));
const outPath = path.resolve(getArg('--out', 'librechat.yaml'));

const VALID_TYPES = new Set(['streamable-http', 'sse', 'websocket']);
const AUTH_TEMPLATE = 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}';

const config = yaml.load(readFileSync(configPath, 'utf8')) ?? {};

let listed = [];
try {
  listed = yaml.load(readFileSync(serversPath, 'utf8')) ?? [];
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

if (!Array.isArray(listed)) {
  throw new Error(`${serversPath} must contain a top-level array of MCP servers`);
}

const mcpServers = {};
for (const [index, server] of listed.entries()) {
  const where = `${serversPath} entry #${index + 1}`;
  if (server == null || typeof server !== 'object' || Array.isArray(server)) {
    throw new Error(`${where} must be a mapping with name, url, and type`);
  }
  const { name, url, type = 'streamable-http' } = server;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${where} is missing a server name`);
  }
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(`${where} (${name}) is missing a URL`);
  }
  if (!VALID_TYPES.has(type)) {
    throw new Error(
      `${where} (${name}) has unsupported type "${type}" (expected one of: ${[...VALID_TYPES].join(', ')})`,
    );
  }
  if (mcpServers[name] != null) {
    throw new Error(`${where}: duplicate server name "${name}"`);
  }
  mcpServers[name] = {
    type,
    url,
    headers: { Authorization: AUTH_TEMPLATE },
  };
}

config.mcpServers = mcpServers;

/**
 * One master system prompt for every model spec. The prompt file is the single
 * editable source; a `promptPrefix` left on a spec in the repository is
 * replaced here rather than merged, so the copies cannot drift.
 */
let systemPrompt = '';
try {
  systemPrompt = readFileSync(promptPath, 'utf8').trim();
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

let promptedSpecs = 0;
if (systemPrompt !== '' && Array.isArray(config.modelSpecs?.list)) {
  for (const spec of config.modelSpecs.list) {
    if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
      continue;
    }
    spec.preset = { ...(spec.preset ?? {}), promptPrefix: systemPrompt };
    promptedSpecs += 1;
  }
}

writeFileSync(outPath, yaml.dump(config, { lineWidth: -1, noRefs: true }), 'utf8');
console.log(
  `[assemble-config] baked ${Object.keys(mcpServers).length} MCP server(s) and the master prompt ` +
    `into ${promptedSpecs} model spec(s) -> ${path.relative(process.cwd(), outPath)}`,
);
