// chains/index.ts
// Export all chain configurations

import { ChainConfig } from './types';
import arbitrumNova from './arbitrum-nova';
import astar from './astar';
import aurora from './aurora';
import bob from './bob';
import celo from './celo';
import degen from './degen';
import etc from './etc';
import etherlink from './etherlink';
import filecoin from './filecoin';
import flare from './flare';
import fuse from './fuse';
import gnosis from './gnosis';
import hemi from './hemi';
import lisk from './lisk';
import manta from './manta';
import mode from './mode';
import songbird from './songbird';
import soneium from './soneium';
import zetachain from './zetachain';

// All available chains
export const chains: Record<string, ChainConfig> = {
  'arbitrum-nova': arbitrumNova,
  astar,
  aurora,
  bob,
  celo,
  degen,
  etc,
  etherlink,
  filecoin,
  flare,
  fuse,
  gnosis,
  hemi,
  lisk,
  manta,
  mode,
  songbird,
  soneium,
  zetachain,
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
