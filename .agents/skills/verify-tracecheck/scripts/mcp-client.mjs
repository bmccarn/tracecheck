// MCP client and environment helpers shared by journey.mjs and mcp-call.mjs.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const KEY_VARIABLES = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY'];
export const PROVIDER_ENVIRONMENT = [...KEY_VARIABLES, 'TYPESAFE_BASE_URL', 'JEV_MODEL', 'JEV_TIMEOUT_MS', 'JEV_CONCURRENCY'];

/** PATH, HOME, and each named variable that is set; nothing else from this process reaches the server. */
export function forwardedEnv(names) {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  return env;
}

/** A client and a stdio transport for `launch` ({ command, args, env }); the server's stderr collects in `log`. */
export function stdioClient(name, launch) {
  const client = new Client({ name, version: '1.0.0' });
  const log = [];
  const transport = new StdioClientTransport({ stderr: 'pipe', ...launch });
  transport.stderr?.on('data', chunk => log.push(String(chunk)));
  return { client, transport, log };
}

/** The saved form of one tool call. */
export function toolRecord(tool, args, result) {
  return {
    tool, arguments: args, isError: Boolean(result.isError), structuredContent: result.structuredContent ?? null,
    text: result.content?.filter(item => item.type === 'text').map(item => item.text) ?? []
  };
}
