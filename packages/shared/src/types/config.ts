export interface HezoConfig {
  port: number;
  dataDir: string;
  masterKey?: string;
  connectUrl: string;
  connectApiKey?: string;
  reset: boolean;
}

export interface ConnectConfig {
  port: number;
  mode: "self_hosted" | "centrally_hosted";
  stateSigningKey: string;
  github?: {
    clientId: string;
    clientSecret: string;
  };
}

export type MasterKeyState = "unset" | "locked" | "unlocked";
