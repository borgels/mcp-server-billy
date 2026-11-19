import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BillyClient, type BillyClientOptions } from './billy/client.js';
import { registerTools } from './tools/billy.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: BillyClient;
  clientOptions?: BillyClientOptions;
}

let defaultClient: BillyClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): BillyClient {
  defaultClient ??= new BillyClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'billy',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new BillyClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
