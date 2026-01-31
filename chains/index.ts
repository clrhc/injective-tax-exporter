// chains/index.ts
// Export all chain configurations

import { ChainConfig } from './types';
import aurora from './aurora';
import celo from './celo';
import fuse from './fuse';

// All available chains
export const chains: Record<string, ChainConfig> = {
  aurora,
  celo,
  fuse,
};

// Get chain by ID
export function getChain(id: string): ChainConfig | undefined {
  return chains[id];
}

// Get all chain IDs
export function getChainIds(): string[] {
  return Object.keys(chains);
}

// Get all chains as array (sorted by name)
export function getAllChains(): ChainConfig[] {
  return Object.values(chains).sort((a, b) => a.name.localeCompare(b.name));
}

// Default chain
export const defaultChain = celo;

// Re-export types
export type { ChainConfig, TokenInfo, Transaction } from './types';
