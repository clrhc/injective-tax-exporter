// chains/types.ts
// Shared types for chain configurations

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface Transaction {
  hash: string;
  timestamp: string;
  blockHeight?: number;
  sent?: {
    amount: string;
    symbol: string;
    decimals: number;
    contractAddress?: string;
  }[];
  received?: {
    amount: string;
    symbol: string;
    decimals: number;
    contractAddress?: string;
  }[];
  fee?: {
    amount: string;
    symbol: string;
    decimals: number;
  };
  type: string;
  notes?: string;
}

export interface ChainConfig {
  // Basic info
  id: string; // Unique identifier (e.g., 'celo', 'aurora')
  name: string;
  symbol: string;
  chainId: number | string;
  logo: string;

  // DefiLlama integration
  defiLlamaId: string;

  // Address format
  addressPrefix: string;
  addressLength: number;
  validateAddress: (address: string) => boolean;
  addressPlaceholder: string;

  // Native token
  nativeToken: {
    symbol: string;
    decimals: number;
    coingeckoId?: string;
    wrappedAddress?: string;
  };

  // On-chain DEX for price lookups (optional)
  dex?: {
    rpcUrl: string;
    factoryAddress: string;
    type: 'uniswapV2'; // Can add more types later
  };

  // API endpoints
  transactionApi: {
    baseUrl: string;
    apiKey?: string;
    buildUrl: (address: string, limit: number, offset: number) => string;
    parseResponse: (data: any, address: string) => Transaction[];
    getPagingInfo?: (data: any) => { total: number; hasMore: boolean };
  };

  // Token resolution
  tokenListUrl?: string;
  cacheKeyPrefix: string;
  commonTokens: Record<string, TokenInfo>;
  getTokenInfo: (addressOrSymbol: string, tokenCache?: Record<string, TokenInfo>) => TokenInfo;
  buildTokenMap?: (tokens: any) => Record<string, TokenInfo>;

  // Block explorer
  explorerUrl: string;
  txUrl: (hash: string) => string;
  addressUrl: (address: string) => string;

  // UI customization
  theme: {
    primary: string;
    gradient: string;
  };
}
