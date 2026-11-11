/**
 * @file integrations/local-cli/bridge.d.mts
 * bridge.mjs 的类型声明：只描述测试与入口实际使用的公开接口，运行时行为以 bridge.mjs 为准。
 */
export declare const BRIDGE_PORT: 18765;
export declare const BRIDGE_NAME: 'fluentread-local-cli';
export declare const BRIDGE_VERSION: number;
export declare const BACKEND_IDS: readonly ['claude', 'codex'];

export type LocalCliBackendId = 'claude' | 'codex';

export interface LocalCliBackendOverride {
  command?: string;
  prefixArgs?: readonly string[];
  label?: string;
  models?: readonly string[];
}

export interface LocalCliLogEntry {
  backend: LocalCliBackendId;
  model: string;
  status: number;
  ms: number;
  inputChars: number;
  outputChars: number;
  code?: string;
}

export interface LocalCliBridgeOptions {
  port?: number;
  token?: string;
  backends?: Partial<Record<LocalCliBackendId, LocalCliBackendOverride>>;
  concurrency?: Partial<Record<LocalCliBackendId, number>>;
  maxQueue?: number;
  timeoutMs?: number;
  allowOrigins?: readonly string[];
  defaultModels?: Partial<Record<LocalCliBackendId, string>>;
  efforts?: Partial<Record<LocalCliBackendId, string>>;
  codexUserConfig?: boolean;
  spawnEnv?: NodeJS.ProcessEnv;
  log?: (entry: LocalCliLogEntry) => void;
}

export interface LocalCliBackendStatus {
  id: LocalCliBackendId;
  label: string;
  available: boolean | null;
  version: string | null;
}

export interface LocalCliBridge {
  port: number;
  url: string;
  workdir: string;
  endpoints: Record<LocalCliBackendId, string>;
  detect(): Promise<LocalCliBackendStatus[]>;
  close(): Promise<void>;
}

export declare function createLocalCliBridge(options?: LocalCliBridgeOptions): Promise<LocalCliBridge>;
