// chains/index.ts
// Export all chain configurations

import { ChainConfig } from './types';
import astar from './astar';
import aurora from './aurora';
import bob from './bob';
import celo from './celo';
import etc from './etc';
import etherlink from './etherlink';
import fuse from './fuse';
import hemi from './hemi';

// All available chains
export const chains: Record<string, ChainConfig> = {
  astar,
  aurora,
  bob,
  celo,
  etc,
  etherlink,
  fuse,
  hemi,
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
