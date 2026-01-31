// chain.config.ts
// Configure this file for your specific EVM chain
// This is the ONLY file you need to modify to add a new chain

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface Transaction {
  hash: string;
  timestamp: string; // ISO format
  blockHeight?: number;

  // Transfers
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

  // Fee
  fee?: {
    amount: string;
    symbol: string;
    decimals: number;
  };

  // Classification
  type: string; // 'transfer', 'swap', 'stake', 'unstake', 'claim', etc.
  notes?: string;
}

export interface ChainConfig {
  // Basic info
  name: string;
  symbol: string;
  chainId: number | string;
  logo: string; // Short text for logo (e.g., 'CELO', 'ETH')

  // DefiLlama integration (for pricing)
  defiLlamaId: string; // e.g., 'ethereum', 'celo', 'arbitrum'

  // Address format
  addressPrefix: string; // e.g., '0x'
  addressLength: number; // e.g., 42 for 0x addresses
  validateAddress: (address: string) => boolean;
  addressPlaceholder: string; // e.g., '0x...'

  // Native token
  nativeToken: {
    symbol: string;
    decimals: number;
    coingeckoId?: string;
    wrappedAddress?: string;
  };

  // API endpoints
  transactionApi: {
    baseUrl: string;
    apiKey?: string;
    // Function to build the URL for fetching transactions
    buildUrl: (address: string, limit: number, offset: number) => string;
    // Function to parse API response into standard format
    parseResponse: (data: any, address: string) => Transaction[];
    // Function to get paging info from response
    getPagingInfo?: (data: any) => { total: number; hasMore: boolean };
  };

  // Token list (optional)
  tokenListUrl?: string;

  // Token resolution
  cacheKeyPrefix: string; // e.g., 'celo', 'eth' - for localStorage keys
  commonTokens: Record<string, TokenInfo>; // Hardcoded common tokens for instant resolution
  getTokenInfo: (addressOrSymbol: string, tokenCache?: Record<string, TokenInfo>) => TokenInfo;
  buildTokenMap?: (tokens: any[]) => Record<string, TokenInfo>; // Parse token list response

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

// =============================================================================
// CELO CHAIN CONFIGURATION
// =============================================================================

// Define native token first so it can be used in parsing functions
const NATIVE_TOKEN = {
  symbol: 'CELO',
  decimals: 18,
  coingeckoId: 'celo',
  wrappedAddress: '0x471EcE3750Da237f93B8E339c536989b8978a438', // CELO token contract
};

// No hardcoded tokens - all token info comes from on-chain data or token lists
const CELO_COMMON_TOKENS: Record<string, TokenInfo> = {};

function getCeloTokenInfo(addressOrSymbol: string, tokenCache?: Record<string, TokenInfo>): TokenInfo {
  if (!addressOrSymbol) return { symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals };
  const key = addressOrSymbol.toLowerCase();

  // Check common tokens first
  if (CELO_COMMON_TOKENS[key]) return CELO_COMMON_TOKENS[key];

  // Check cache
  const cached = tokenCache?.[key];
  if (cached) return cached;

  // For unknown 0x addresses, return truncated address
  if (addressOrSymbol.startsWith('0x')) {
    return { symbol: `${addressOrSymbol.slice(0, 6)}...${addressOrSymbol.slice(-4)}`, decimals: 18 };
  }

  // For symbols, return as-is
  return { symbol: addressOrSymbol.toUpperCase(), decimals: 18 };
}

// Classify transaction based on function name
function classifyEVMTransaction(tx: any): string | null {
  const functionName = (tx.functionName || tx.methodId || '').toLowerCase();

  if (functionName.includes('swap') || functionName.includes('exchange')) {
    return 'swap';
  }
  if (functionName.includes('stake') || functionName.includes('deposit')) {
    return 'Staking Deposit';
  }
  if (functionName.includes('unstake') || functionName.includes('withdraw')) {
    return 'Staking Return';
  }
  if (functionName.includes('claim') || functionName.includes('harvest') || functionName.includes('getReward')) {
    return 'Staking Claim';
  }
  if (functionName.includes('addLiquidity') || functionName.includes('mint')) {
    return 'Add Liquidity';
  }
  if (functionName.includes('removeLiquidity') || functionName.includes('burn')) {
    return 'Remove Liquidity';
  }
  if (functionName.includes('transfer') || functionName.includes('send')) {
    return null; // Will be determined by direction
  }

  return null;
}

// Parse BlockScout/Etherscan-style API response
function parseCeloTransaction(tx: any, walletAddress: string): Transaction[] {
  const results: Transaction[] = [];
  const walletLower = walletAddress.toLowerCase();
  const timestamp = tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString() : tx.timestamp;
  const txHash = tx.hash || tx.txHash;

  // Calculate gas fee
  const gasUsed = tx.gasUsed ? parseFloat(tx.gasUsed) : 0;
  const gasPrice = tx.gasPrice ? parseFloat(tx.gasPrice) : 0;
  const feeWei = gasUsed * gasPrice;
  const feeAmount = feeWei / 1e18;

  // Determine if this is a send or receive
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  const value = tx.value ? parseFloat(tx.value) / 1e18 : 0;
  const isReceive = to === walletLower;
  const isSend = from === walletLower;

  // Failed transaction - just record gas fee
  if (tx.isError === '1' || tx.txreceipt_status === '0') {
    if (feeAmount > 0 && isSend) {
      results.push({
        hash: txHash,
        timestamp,
        type: 'fee',
        notes: 'Failed transaction',
        fee: { amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals },
        sent: [{ amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals }],
      });
    }
    return results;
  }

  // Classify transaction
  const txClassification = classifyEVMTransaction(tx);
  const txTag = txClassification || (isReceive ? 'Transfer In' : (isSend ? 'Transfer Out' : 'fee'));

  // Get function name for notes
  const functionName = tx.functionName || tx.input?.slice(0, 10) || '';
  const txNote = functionName.split('(')[0] || 'Transfer';

  // Native token transfer
  if (value > 0) {
    const valueStr = value.toFixed(8).replace(/\.?0+$/, '');
    if (isReceive) {
      results.push({
        hash: txHash,
        timestamp,
        type: txTag,
        notes: txNote,
        received: [{ amount: valueStr, symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals }],
      });
    } else if (isSend) {
      results.push({
        hash: txHash,
        timestamp,
        type: txTag,
        notes: txNote,
        sent: [{ amount: valueStr, symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals }],
        fee: feeAmount > 0 ? { amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals } : undefined,
      });
    }
  }

  // Contract interaction with no value - just gas fee
  if (value === 0 && isSend && feeAmount > 0) {
    results.push({
      hash: txHash,
      timestamp,
      type: txTag === 'Transfer Out' ? 'fee' : txTag,
      notes: txNote || 'Contract interaction',
      fee: { amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals },
      sent: [{ amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals }],
    });
  }

  return results;
}

const config: ChainConfig = {
  name: 'Celo',
  symbol: 'CELO',
  chainId: 42220,
  logo: 'CELO',

  defiLlamaId: 'celo',

  addressPrefix: '0x',
  addressLength: 42,
  validateAddress: (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr),
  addressPlaceholder: '0x...',

  nativeToken: NATIVE_TOKEN,

  transactionApi: {
    baseUrl: 'https://celo.blockscout.com/api',
    buildUrl: (address, limit, offset) => {
      const page = Math.floor(offset / limit) + 1;
      return `https://celo.blockscout.com/api?module=account&action=txlist&address=${address}&page=${page}&offset=${limit}&sort=desc`;
    },
    parseResponse: (data, address) => {
      if (data.status !== '1' || !data.result) return [];
      const results: Transaction[] = [];
      for (const tx of data.result) {
        results.push(...parseCeloTransaction(tx, address));
      }
      return results;
    },
    getPagingInfo: (data) => ({
      total: data.result?.length || 0,
      hasMore: data.result?.length === 100,
    }),
  },

  tokenListUrl: 'https://raw.githubusercontent.com/celo-org/celo-token-list/main/celo.tokenlist.json',
  cacheKeyPrefix: 'celo',
  commonTokens: CELO_COMMON_TOKENS,
  getTokenInfo: getCeloTokenInfo,
  buildTokenMap: (tokens: any) => {
    const map: Record<string, TokenInfo> = {};
    // Celo token list format: { tokens: [{ address, symbol, decimals, chainId }] }
    const tokenList = tokens.tokens || tokens;
    for (const t of tokenList) {
      if (t.chainId === 42220 || !t.chainId) {
        const entry = { symbol: t.symbol || 'UNKNOWN', decimals: t.decimals ?? 18 };
        if (t.address) map[t.address.toLowerCase()] = entry;
      }
    }
    return map;
  },

  explorerUrl: 'https://celo.blockscout.com',
  txUrl: (hash) => `https://celo.blockscout.com/tx/${hash}`,
  addressUrl: (addr) => `https://celo.blockscout.com/address/${addr}`,

  theme: {
    primary: '#FCFF52',
    gradient: 'linear-gradient(135deg, #FCFF52 0%, #35D07F 100%)',
  },
};

export default config;

// =============================================================================
// HELPER: Create config for other EVM chains
// =============================================================================
// To add a new chain, copy the config above and modify:
// 1. name, symbol, chainId, logo
// 2. defiLlamaId (see GENERICIZE.md for the full list)
// 3. NATIVE_TOKEN (symbol, decimals, addresses)
// 4. transactionApi.baseUrl and buildUrl (use the chain's block explorer API)
// 5. explorerUrl, txUrl, addressUrl
// 6. theme colors
// 7. tokenListUrl if available
//
// Example chains you can add:
// - Aurora: defiLlamaId='aurora', api=explorer.aurora.dev
// - Moonbeam: defiLlamaId='moonbeam', api=moonscan.io
// - Boba: defiLlamaId='boba', api=bobascan.com
