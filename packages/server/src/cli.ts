import { homedir } from "os";
import { resolve } from "path";

export interface HezoConfig {
  port: number;
  dataDir: string;
  masterKey?: string;
  connectUrl: string;
  connectApiKey?: string;
  reset: boolean;
}

const DEFAULT_PORT = 3100;
const DEFAULT_DATA_DIR = "~/.hezo";
const DEFAULT_CONNECT_URL = "http://localhost:4100";

export function parseArgs(argv: string[] = process.argv): HezoConfig {
  const args = argv.slice(2);

  let port = DEFAULT_PORT;
  let dataDir = DEFAULT_DATA_DIR;
  let masterKey: string | undefined;
  let connectUrl = DEFAULT_CONNECT_URL;
  let connectApiKey: string | undefined;
  let reset = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        port = parseInt(args[++i], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port: ${args[i]}. Must be 1-65535.`);
        }
        break;
      case "--data-dir":
        dataDir = args[++i];
        break;
      case "--master-key":
        masterKey = args[++i];
        break;
      case "--connect-url":
        connectUrl = args[++i];
        break;
      case "--connect-api-key":
        connectApiKey = args[++i];
        break;
      case "--reset":
        reset = true;
        break;
    }
  }

  // Resolve tilde to home directory
  if (dataDir.startsWith("~")) {
    dataDir = resolve(homedir(), dataDir.slice(2));
  } else {
    dataDir = resolve(dataDir);
  }

  return { port, dataDir, masterKey, connectUrl, connectApiKey, reset };
}
