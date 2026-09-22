import { KeychainStore } from './keychain.ts';
import { FileStore } from './fileStore.ts';

export interface CredentialStore {
  get(baseUrl: string): Promise<string | null>;
  set(baseUrl: string, token: string): Promise<void>;
  delete(baseUrl: string): Promise<void>;
}

export function createCredentialStore(platform: string, configDir: string): CredentialStore {
  return platform === 'darwin' ? new KeychainStore() : new FileStore(configDir);
}
