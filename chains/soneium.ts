// chains/soneium.ts
// Soneium chain configuration

import { ChainConfig, TokenInfo, Transaction } from './types';

const NATIVE_TOKEN = {
  symbol: 'ETH',
  decimals: 18,
  coingeckoId: 'ethereum',
  wrappedAddress: '0x4200000000000000000000000000000000000006',
};

const COMMON_TOKENS: Record<string, TokenInfo> = {};

function getTokenInfo(addressOrSymbol: string, tokenCache?: Record<string, TokenInfo>): TokenInfo {
  if (!addressOrSymbol) return { symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals };
  const key = addressOrSymbol.toLowerCase();

  if (COMMON_TOKENS[key]) return COMMON_TOKENS[key];

  const cached = tokenCache?.[key];
  if (cached) return cached;

  if (addressOrSymbol.startsWith('0x')) {
    return { symbol: `${addressOrSymbol.slice(0, 6)}...${addressOrSymbol.slice(-4)}`, decimals: 18 };
  }

  return { symbol: addressOrSymbol.toUpperCase(), decimals: 18 };
}

function parseTransaction(tx: any, walletAddress: string): Transaction[] {
  const results: Transaction[] = [];
  const walletLower = walletAddress.toLowerCase();
  const timestamp = tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString() : tx.timestamp;
  const txHash = tx.hash || tx.txHash;

  const gasUsed = tx.gasUsed ? parseFloat(tx.gasUsed) : 0;
  const gasPrice = tx.gasPrice ? parseFloat(tx.gasPrice) : 0;
  const feeAmount = (gasUsed * gasPrice) / 1e18;

  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  const value = tx.value ? parseFloat(tx.value) / 1e18 : 0;
  const isReceive = to === walletLower;
  const isSend = from === walletLower;

  if (tx.isError === '1' || tx.txreceipt_status === '0') {
    if (feeAmount > 0 && isSend) {
      results.push({
        hash: txHash,
        timestamp,
        type: 'fee',
        notes: 'Failed transaction',
        fee: { amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals },
      });
    }
    return results;
  }

  const functionName = tx.functionName || tx.input?.slice(0, 10) || '';
  const txNote = functionName.split('(')[0] || 'Transfer';
  const txTag = isReceive ? 'Transfer In' : (isSend ? 'Transfer Out' : 'fee');

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

  if (value === 0 && isSend && feeAmount > 0) {
    results.push({
      hash: txHash,
      timestamp,
      type: 'fee',
      notes: txNote || 'Contract interaction',
      fee: { amount: feeAmount.toFixed(8).replace(/\.?0+$/, ''), symbol: NATIVE_TOKEN.symbol, decimals: NATIVE_TOKEN.decimals },
    });
  }

  return results;
}

const soneium: ChainConfig = {
  id: 'soneium',
  name: 'Soneium',
  symbol: 'ETH',
  chainId: 1868,
  logo: 'SONEIUM',

  defiLlamaId: 'soneium',

  addressPrefix: '0x',
  addressLength: 42,
  validateAddress: (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr),
  addressPlaceholder: '0x...',

  nativeToken: NATIVE_TOKEN,

  transactionApi: {
    baseUrl: 'https://soneium.blockscout.com/api',
    buildUrl: (address, limit, offset) => {
      const page = Math.floor(offset / limit) + 1;
      return `https://soneium.blockscout.com/api?module=account&action=txlist&address=${address}&page=${page}&offset=${limit}&sort=desc`;
    },
    parseResponse: (data, address) => {
      if (data.status !== '1' || !data.result) return [];
      const results: Transaction[] = [];
      for (const tx of data.result) {
        results.push(...parseTransaction(tx, address));
      }
      return results;
    },
    getPagingInfo: (data) => ({
      total: data.result?.length || 0,
      hasMore: data.result?.length === 100,
    }),
  },

  cacheKeyPrefix: 'soneium',
  commonTokens: COMMON_TOKENS,
  getTokenInfo,
  buildTokenMap: (tokens: any) => {
    const map: Record<string, TokenInfo> = {};
    const tokenList = tokens.tokens || tokens;
    for (const t of tokenList) {
      if (t.chainId === 1868 || !t.chainId) {
        const entry = { symbol: t.symbol || 'UNKNOWN', decimals: t.decimals ?? 18 };
        if (t.address) map[t.address.toLowerCase()] = entry;
      }
    }
    return map;
  },

  explorerUrl: 'https://soneium.blockscout.com',
  txUrl: (hash) => `https://soneium.blockscout.com/tx/${hash}`,
  addressUrl: (addr) => `https://soneium.blockscout.com/address/${addr}`,

  theme: {
    primary: '#000000',
    gradient: 'linear-gradient(135deg, #000000 0%, #333333 100%)',
  },
};

export default soneium;
