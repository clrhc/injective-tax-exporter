'use client';
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

const EXPLORER_API = '/api/transactions';
const PRICES_API = '/api/prices';
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json';
const TOKEN_CACHE_KEY = 'inj_token_cache_v2';
const ITEMS_PER_PAGE = 25;

// ============================================================================
// PRICE STORAGE - In-memory only (no localStorage caching)
// ============================================================================
let sessionPrices = { data: {}, sources: {} };

// Fetch prices from API - returns { prices, sources, missing, warning }
async function fetchPricesBatch(requests) {
  if (requests.length === 0) return { missing: [], sources: {} };

  try {
    const response = await fetch(PRICES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (response.ok) {
      const data = await response.json();
      // Store in session memory (values can be number or null)
      Object.assign(sessionPrices.data, data.prices || {});
      Object.assign(sessionPrices.sources, data.sources || {});
      return {
        missing: data.missing || [],
        sources: data.sources || {},
        warning: data.warning
      };
    }
  } catch (e) { /* ignore */ }
  return { missing: [], sources: {} };
}

// Get price - returns number or null if not available
function getPrice(token, date) {
  const key = `${token.toUpperCase()}-${date}`;
  const price = sessionPrices.data[key];
  return price === undefined || price === null ? null : price;
}

// Get price source - returns 'injective-dex', 'pyth', or null
function getPriceSource(token, date) {
  const key = `${token.toUpperCase()}-${date}`;
  return sessionPrices.sources?.[key] || null;
}

// ============================================================================
// COST BASIS TRACKING (FIFO)
// ============================================================================
class CostBasisTracker {
  constructor() {
    this.lots = {}; // { [asset]: [{ amount, costPerUnit, date }] }
  }

  addLot(asset, amount, pricePerUnit, date) {
    if (!this.lots[asset]) this.lots[asset] = [];
    if (amount > 0 && pricePerUnit > 0) {
      this.lots[asset].push({ amount, costPerUnit: pricePerUnit, date });
    }
  }

  // FIFO: sell oldest lots first, return { costBasis, realizedPnl }
  sellFIFO(asset, sellAmount, sellPricePerUnit) {
    if (!this.lots[asset] || this.lots[asset].length === 0) {
      // No cost basis - can't calculate PnL
      return { costBasis: 0, realizedPnl: null };
    }

    let remaining = Math.abs(sellAmount);
    let totalCostBasis = 0;
    let totalSold = 0;

    while (remaining > 0 && this.lots[asset].length > 0) {
      const lot = this.lots[asset][0];

      if (lot.amount <= remaining) {
        // Use entire lot
        totalCostBasis += lot.amount * lot.costPerUnit;
        totalSold += lot.amount;
        remaining -= lot.amount;
        this.lots[asset].shift();
      } else {
        // Partial lot
        totalCostBasis += remaining * lot.costPerUnit;
        totalSold += remaining;
        lot.amount -= remaining;
        remaining = 0;
      }
    }

    if (totalSold === 0 || sellPricePerUnit === 0) {
      return { costBasis: 0, realizedPnl: null };
    }

    const proceeds = totalSold * sellPricePerUnit;
    const realizedPnl = proceeds - totalCostBasis;

    return {
      costBasis: totalCostBasis,
      realizedPnl: Math.round(realizedPnl * 100) / 100
    };
  }

  // Get current holdings
  getHoldings(asset) {
    if (!this.lots[asset]) return 0;
    return this.lots[asset].reduce((sum, lot) => sum + lot.amount, 0);
  }
}

// ============================================================================
// TOKEN CACHE - Persistent with localStorage + memory
// ============================================================================
const tokenCache = { data: null, loading: null, loaded: false };

async function loadTokensGlobal() {
  if (tokenCache.loaded) return tokenCache.data;
  if (tokenCache.loading) return tokenCache.loading;

  // Try localStorage first
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(TOKEN_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
          tokenCache.data = data;
          tokenCache.loaded = true;
          refreshTokensBackground();
          return data;
        }
      }
    } catch (e) { /* ignore */ }
  }

  tokenCache.loading = fetchAndCacheTokens();
  return tokenCache.loading;
}

async function fetchAndCacheTokens() {
  try {
    const res = await fetch(TOKEN_LIST_URL);
    if (res.ok) {
      const tokens = await res.json();
      const map = buildTokenMap(tokens);
      tokenCache.data = map;
      tokenCache.loaded = true;
      tokenCache.loading = null;
      persistTokenCache(map);
      return map;
    }
  } catch (e) { /* ignore */ }
  tokenCache.loading = null;
  return tokenCache.data || {};
}

function refreshTokensBackground() {
  fetch(TOKEN_LIST_URL)
    .then(res => res.ok ? res.json() : null)
    .then(tokens => {
      if (!tokens) return;
      const map = buildTokenMap(tokens);
      tokenCache.data = map;
      persistTokenCache(map);
    })
    .catch(() => {});
}

function buildTokenMap(tokens) {
  const map = {};
  for (const t of tokens) {
    const entry = { symbol: t.symbol || t.name || 'UNKNOWN', decimals: t.decimals ?? 18 };
    if (t.denom) map[t.denom.toLowerCase()] = entry;
    if (t.address) map[`peggy${t.address}`.toLowerCase()] = entry;
    if (t.baseDenom) map[t.baseDenom.toLowerCase()] = entry;
    if (t.cw20?.address) map[t.cw20.address.toLowerCase()] = entry;
  }
  return map;
}

function persistTokenCache(map) {
  try {
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ data: map, timestamp: Date.now() }));
  } catch (e) { /* ignore */ }
}

// Common tokens hardcoded for instant resolution
const COMMON_TOKENS = {
  'inj': { symbol: 'INJ', decimals: 18 },
  'peggy0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  'peggy0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  'peggy0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
  'peggy0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  'peggy0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': { symbol: 'MATIC', decimals: 18 },
  'peggy0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
  'peggy0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18 },
  'peggy0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
};

function getTokenInfo(denom) {
  if (!denom) return { symbol: 'INJ', decimals: 18 };
  const key = denom.toLowerCase();

  // Check common tokens first
  if (COMMON_TOKENS[key]) return COMMON_TOKENS[key];

  // Check cache
  const cached = tokenCache.data?.[key];
  if (cached) return cached;

  // Parse denom string
  if (denom.startsWith('peggy0x')) {
    const addr = denom.slice(5);
    return { symbol: `${addr.slice(0, 6)}...${addr.slice(-4)}`, decimals: 18 };
  }
  if (denom.startsWith('ibc/')) {
    return { symbol: `IBC/${denom.slice(4, 10)}`, decimals: 6 };
  }
  if (denom.startsWith('factory/')) {
    const parts = denom.split('/');
    return { symbol: (parts[parts.length - 1] || 'TOKEN').toUpperCase(), decimals: 18 };
  }
  if (denom.startsWith('share')) {
    return { symbol: 'LP-TOKEN', decimals: 18 };
  }

  return { symbol: denom.length > 12 ? `${denom.slice(0, 8)}...` : denom.toUpperCase(), decimals: 18 };
}

function formatAmount(amount, denom) {
  if (!amount || amount === '0') return '0';
  const { decimals } = getTokenInfo(denom);
  const num = parseFloat(amount) / Math.pow(10, decimals);
  if (num === 0) return '0';
  if (Math.abs(num) < 0.000001) return num.toExponential(4);
  if (Math.abs(num) < 0.01) return num.toFixed(8).replace(/\.?0+$/, '');
  if (Math.abs(num) < 1) return num.toFixed(6).replace(/\.?0+$/, '');
  if (Math.abs(num) < 10000) return num.toFixed(4).replace(/\.?0+$/, '');
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ============================================================================
// TRANSACTION PARSING - Comprehensive handler for all Injective message types
// ============================================================================

// Helper: Parse coin amount from event attribute value like "1000000inj" or "500000peggy0x..."
function parseCoinFromString(coinStr) {
  if (!coinStr) return null;
  const match = coinStr.match(/^(\d+)(.+)$/);
  if (!match) return null;
  const rawAmount = match[1];
  const denom = match[2];
  const { symbol, decimals } = getTokenInfo(denom);
  const amount = parseFloat(rawAmount) / Math.pow(10, decimals);
  return { amount, symbol, denom, rawAmount };
}

// Helper: Extract all coin movements from transaction events (deduplicated by denom)
function extractCoinMovements(tx, walletAddress) {
  const received = {}; // { denom: { amount, symbol, denom, rawAmount } }
  const spent = {};    // { denom: { amount, symbol, denom, rawAmount } }
  const events = tx.logs?.[0]?.events || tx.events || [];
  const walletLower = walletAddress.toLowerCase();

  for (const event of events) {
    const attrs = event.attributes || [];
    const getAttr = (key) => attrs.find(a => a.key === key)?.value;

    // Only process coin_received and coin_spent (skip transfer to avoid dupes)
    if (event.type === 'coin_received') {
      const receiver = getAttr('receiver')?.toLowerCase();
      const amount = getAttr('amount');
      if (receiver?.includes(walletLower.slice(0, 10)) && amount) {
        const coins = amount.split(',');
        for (const c of coins) {
          const parsed = parseCoinFromString(c.trim());
          if (parsed) {
            // Aggregate by denom
            if (received[parsed.denom]) {
              received[parsed.denom].amount += parsed.amount;
            } else {
              received[parsed.denom] = { ...parsed };
            }
          }
        }
      }
    }

    if (event.type === 'coin_spent') {
      const spender = getAttr('spender')?.toLowerCase();
      const amount = getAttr('amount');
      if (spender?.includes(walletLower.slice(0, 10)) && amount) {
        const coins = amount.split(',');
        for (const c of coins) {
          const parsed = parseCoinFromString(c.trim());
          if (parsed) {
            // Aggregate by denom
            if (spent[parsed.denom]) {
              spent[parsed.denom].amount += parsed.amount;
            } else {
              spent[parsed.denom] = { ...parsed };
            }
          }
        }
      }
    }
  }

  // Convert to arrays
  return {
    received: Object.values(received),
    spent: Object.values(spent)
  };
}

// Helper: Get human-readable note for a transaction
function getTransactionNote(tx) {
  const messages = tx.messages || tx.data?.messages || tx.tx?.body?.messages || [];
  const msg = messages[0];
  if (!msg) return 'Transaction';

  const type = msg['@type'] || msg.type || '';
  const typeShort = type.split('.').pop().replace('Msg', '');

  // For contract executions, extract the action name
  if (typeShort === 'ExecuteContract' || typeShort === 'ExecuteContractCompat') {
    try {
      const msgData = typeof msg.msg === 'string' ? JSON.parse(msg.msg) : msg.msg;
      if (msgData) {
        const action = Object.keys(msgData)[0] || 'execute';
        return action;
      }
    } catch { /* ignore */ }
    return 'contract';
  }

  return typeShort || 'Transaction';
}

function parseTransaction(tx, walletAddress, includeFailedForGas = false) {
  // Check if transaction failed
  const isFailed = (tx.code && tx.code !== 0) || (tx.txCode && tx.txCode !== 0) || tx.errorLog || tx.error_log;

  // Skip failed transactions unless we're including them for gas deduction
  if (isFailed && !includeFailedForGas) return [];

  const results = [];
  const timestamp = tx.blockTimestamp || tx.block_timestamp || tx.timestamp || tx.time;
  const date = new Date(timestamp);

  if (isNaN(date.getTime())) return []; // Invalid date

  // Awaken Tax date format: MM/DD/YYYY HH:MM:SS in UTC
  const dateFormatted = `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;

  // Internal date for sorting/filtering
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dateDisplay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeDisplay = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const txHash = tx.hash || tx.txHash || tx.id || '';

  // Parse fee
  const feeData = tx.gasFee?.amount?.[0] || tx.gas_fee?.amount?.[0] || tx.fee?.amount?.[0];
  const feeRaw = feeData ? parseFloat(feeData.amount) / Math.pow(10, getTokenInfo(feeData.denom).decimals) : 0;
  const feeAmount = feeRaw > 0 ? feeRaw.toFixed(8).replace(/\.?0+$/, '') : '';
  const feeCurrency = feeData ? getTokenInfo(feeData.denom).symbol : '';

  // Extract coin movements from events (deduplicated)
  const movements = extractCoinMovements(tx, walletAddress);

  // Get transaction note from message type/action
  const txNote = getTransactionNote(tx);

  // Base transaction object for Awaken Tax format
  const baseTx = {
    dateStr,
    dateFormatted,
    dateDisplay,
    timeDisplay,
    txHash,
    feeAmount: '',
    feeCurrency: '',
    feeRaw,
    // Awaken format: separate sent/received columns (no negative numbers!)
    receivedQty: '',
    receivedCurrency: '',
    receivedFiat: '',
    sentQty: '',
    sentCurrency: '',
    sentFiat: '',
    notes: txNote,
    tag: '',
    isFailed: isFailed,
    // For UI display (legacy)
    asset: '',
    amount: '',
    pnl: '',
    pnlDisplay: '',
  };

  // For failed transactions, just record the gas fee as a fee
  if (isFailed) {
    if (feeRaw > 0) {
      return [{
        ...baseTx,
        sentQty: feeAmount,
        sentCurrency: feeCurrency || 'INJ',
        feeAmount,
        feeCurrency: feeCurrency || 'INJ',
        tag: 'fee',
        notes: `Failed: ${txNote}`,
        // Legacy UI fields
        asset: feeCurrency || 'INJ',
        amount: `-${feeAmount}`,
      }];
    }
    return [];
  }

  // Determine transaction type based on message type and token flows
  const hasSpent = movements.spent.length > 0;
  const hasReceived = movements.received.length > 0;

  // Try to classify based on message type
  const messages = tx.messages || tx.data?.messages || tx.tx?.body?.messages || [];
  const msgType = messages[0]?.['@type']?.split('.').pop() || messages[0]?.type?.split('.').pop() || '';

  // Classify the transaction - returns Awaken Tax compatible tag
  const classifyTransaction = () => {
    const typeLower = msgType.toLowerCase();
    const noteLower = txNote.toLowerCase();

    // Staking operations
    if (typeLower.includes('delegate') && !typeLower.includes('undelegate')) {
      return 'Staking Deposit';
    }
    if (typeLower.includes('undelegate')) {
      return 'Staking Return';
    }
    if (typeLower.includes('withdrawdelegatorreward') || typeLower.includes('withdrawvalidatorcommission')) {
      return 'Staking Claim';
    }

    // IBC / Bridge
    if (typeLower.includes('transfer') && typeLower.includes('ibc')) {
      return hasSpent ? 'Transfer Out' : 'Transfer In';
    }
    if (typeLower.includes('sendtoeth') || typeLower.includes('bridge')) {
      return 'Transfer Out';
    }

    // Governance
    if (typeLower.includes('vote') || typeLower.includes('proposal')) {
      return ''; // Just a fee transaction
    }

    // Contract execution - try to identify swap/LP actions
    if (typeLower.includes('executecontract')) {
      if (noteLower.includes('swap') || noteLower.includes('execute_swap')) {
        return 'swap';
      }
      if (noteLower.includes('provide_liquidity') || noteLower.includes('add_liquidity')) {
        return 'Add Liquidity';
      }
      if (noteLower.includes('withdraw_liquidity') || noteLower.includes('remove_liquidity')) {
        return 'Remove Liquidity';
      }
      if (noteLower.includes('claim') || noteLower.includes('harvest')) {
        return 'Reward';
      }
      if (noteLower.includes('stake') || noteLower.includes('bond')) {
        return 'Staking Deposit';
      }
      if (noteLower.includes('unstake') || noteLower.includes('unbond')) {
        return 'Staking Return';
      }
      // Contract with both in/out is likely a swap
      if (hasSpent && hasReceived) {
        return 'swap';
      }
    }

    // Simple transfers
    if (typeLower === 'msgsend' || typeLower.includes('send')) {
      return hasSpent ? 'Transfer Out' : 'Transfer In';
    }

    // Exchange operations
    if (typeLower.includes('spotmarket') || typeLower.includes('spotlimit')) {
      return 'swap';
    }
    if (typeLower.includes('derivative') || typeLower.includes('perpetual')) {
      if (typeLower.includes('create')) return 'Open Position';
      if (typeLower.includes('cancel')) return 'Close Position';
      return 'swap';
    }

    // Auction
    if (typeLower.includes('bid') || typeLower.includes('auction')) {
      return 'swap';
    }

    // If has both in and out, likely a swap
    if (hasSpent && hasReceived) {
      return 'swap';
    }

    // Default based on flow direction
    if (hasSpent && !hasReceived) return 'Transfer Out';
    if (hasReceived && !hasSpent) return 'Transfer In';

    return ''; // Unknown - will show as empty tag
  };

  const txTag = classifyTransaction();

  // SWAP/TRADE: Both sent and received tokens
  if (hasSpent && hasReceived) {
    if (movements.spent.length === 1 && movements.received.length === 1) {
      // Clean swap: one token for another - single row
      const sent = movements.spent[0];
      const recv = movements.received[0];
      results.push({
        ...baseTx,
        sentQty: sent.amount.toFixed(8).replace(/\.?0+$/, ''),
        sentCurrency: sent.symbol,
        receivedQty: recv.amount.toFixed(8).replace(/\.?0+$/, ''),
        receivedCurrency: recv.symbol,
        feeAmount,
        feeCurrency,
        tag: txTag,
        notes: txNote,
        asset: `${sent.symbol}→${recv.symbol}`,
        amount: recv.amount.toFixed(6).replace(/\.?0+$/, ''),
      });
    } else {
      // Multiple tokens: create rows for each movement
      for (const sent of movements.spent) {
        results.push({
          ...baseTx,
          sentQty: sent.amount.toFixed(8).replace(/\.?0+$/, ''),
          sentCurrency: sent.symbol,
          feeAmount: results.length === 0 ? feeAmount : '',
          feeCurrency: results.length === 0 ? feeCurrency : '',
          tag: txTag,
          notes: txNote,
          asset: sent.symbol,
          amount: `-${sent.amount.toFixed(6).replace(/\.?0+$/, '')}`,
        });
      }
      for (const recv of movements.received) {
        results.push({
          ...baseTx,
          receivedQty: recv.amount.toFixed(8).replace(/\.?0+$/, ''),
          receivedCurrency: recv.symbol,
          tag: txTag,
          notes: txNote,
          asset: recv.symbol,
          amount: recv.amount.toFixed(6).replace(/\.?0+$/, ''),
        });
      }
    }
  }
  // SENT ONLY
  else if (hasSpent && !hasReceived) {
    for (const sent of movements.spent) {
      results.push({
        ...baseTx,
        sentQty: sent.amount.toFixed(8).replace(/\.?0+$/, ''),
        sentCurrency: sent.symbol,
        feeAmount: results.length === 0 ? feeAmount : '',
        feeCurrency: results.length === 0 ? feeCurrency : '',
        tag: txTag,
        notes: txNote,
        asset: sent.symbol,
        amount: `-${sent.amount.toFixed(6).replace(/\.?0+$/, '')}`,
      });
    }
  }
  // RECEIVED ONLY
  else if (hasReceived && !hasSpent) {
    for (const recv of movements.received) {
      results.push({
        ...baseTx,
        receivedQty: recv.amount.toFixed(8).replace(/\.?0+$/, ''),
        receivedCurrency: recv.symbol,
        tag: txTag,
        notes: txNote,
        asset: recv.symbol,
        amount: recv.amount.toFixed(6).replace(/\.?0+$/, ''),
      });
    }
  }

  // Add gas fee as separate row if not already in spent tokens
  if (feeRaw > 0 && results.length > 0) {
    const feeInSent = movements.spent.some(s => s.symbol === feeCurrency);
    if (!feeInSent) {
      results.push({
        ...baseTx,
        sentQty: feeAmount,
        sentCurrency: feeCurrency,
        feeAmount,
        feeCurrency,
        tag: 'fee',
        notes: 'Transaction fee',
        asset: feeCurrency,
        amount: `-${feeAmount}`,
      });
    }
  }

  // If no movements at all, just record the gas fee
  if (results.length === 0 && feeRaw > 0) {
    results.push({
      ...baseTx,
      sentQty: feeAmount,
      sentCurrency: feeCurrency,
      feeAmount,
      feeCurrency,
      tag: 'fee',
      notes: txNote || 'Transaction fee',
      asset: feeCurrency,
      amount: `-${feeAmount}`,
    });
  }

  return results;
}


// Helper functions - no truncation for CSV accuracy
function truncateAddress(addr) {
  return addr || '';
}

function truncateValidator(addr) {
  return addr || '';
}

function truncateMarketId(id) {
  return id || 'market';
}

// ============================================================================
// CSV GENERATION - Awaken Tax format
// https://help.awaken.tax/en/articles/10422149-how-to-format-your-csv-for-awaken-tax
// ============================================================================
function generateCSV(transactions) {
  // Awaken Tax CSV columns (in order):
  // Date, Received Quantity, Received Currency, Received Fiat Amount,
  // Sent Quantity, Sent Currency, Sent Fiat Amount,
  // Fee Amount, Fee Currency, Transaction Hash, Notes, Tag
  const headers = [
    'Date',
    'Received Quantity',
    'Received Currency',
    'Received Fiat Amount',
    'Sent Quantity',
    'Sent Currency',
    'Sent Fiat Amount',
    'Fee Amount',
    'Fee Currency',
    'Transaction Hash',
    'Notes',
    'Tag'
  ];

  const rows = transactions.map(tx => [
    tx.dateFormatted,           // MM/DD/YYYY HH:MM:SS UTC
    tx.receivedQty || '',       // Positive number only
    tx.receivedCurrency || '',
    tx.receivedFiat || '',      // Optional fiat value
    tx.sentQty || '',           // Positive number only
    tx.sentCurrency || '',
    tx.sentFiat || '',          // Optional fiat value
    tx.feeAmount || '',
    tx.feeCurrency || '',
    tx.txHash || '',
    tx.notes || '',
    tx.tag || '',
  ]);

  const escapeCell = (cell) => {
    const str = (cell ?? '').toString();
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  return [
    headers.join(','),
    ...rows.map(row => row.map(escapeCell).join(','))
  ].join('\n');
}

// ============================================================================
// TAG CONFIGURATION - Awaken Tax compatible labels
// https://help.awaken.tax/en/articles/10453755-how-do-i-label-my-transactions
// ============================================================================
const TAG_CONFIG = {
  // Trading
  'swap': { bg: 'rgba(234, 179, 8, 0.15)', color: '#fbbf24', label: 'Swap' },
  // Transfers
  'Transfer In': { bg: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', label: 'Transfer In' },
  'Transfer Out': { bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', label: 'Transfer Out' },
  // Staking
  'Staking Deposit': { bg: 'rgba(139, 92, 246, 0.15)', color: '#a78bfa', label: 'Staking Deposit' },
  'Staking Return': { bg: 'rgba(139, 92, 246, 0.15)', color: '#c4b5fd', label: 'Staking Return' },
  'Staking Claim': { bg: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', label: 'Staking Claim' },
  // Liquidity
  'Add Liquidity': { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', label: 'Add Liquidity' },
  'Remove Liquidity': { bg: 'rgba(59, 130, 246, 0.15)', color: '#93c5fd', label: 'Remove Liquidity' },
  // Income
  'Reward': { bg: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', label: 'Reward' },
  'Airdrop': { bg: 'rgba(236, 72, 153, 0.15)', color: '#f472b6', label: 'Airdrop' },
  // Derivatives
  'Open Position': { bg: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', label: 'Open Position' },
  'Close Position': { bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', label: 'Close Position' },
  // Fee
  'fee': { bg: 'rgba(251, 146, 60, 0.15)', color: '#fb923c', label: 'Fee' },
  // Unknown/Other
  '': { bg: 'rgba(107, 114, 128, 0.12)', color: '#71717a', label: 'Unknown' },
};

// ============================================================================
// STYLES
// ============================================================================
const styles = {
  container: {
    minHeight: '100vh',
    background: '#09090b',
    color: '#fafafa',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  inner: {
    maxWidth: '1280px',
    margin: '0 auto',
    padding: '48px 24px',
  },
  header: {
    marginBottom: '48px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '24px',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  logo: {
    width: '48px',
    height: '48px',
    background: 'linear-gradient(135deg, #00f2fe 0%, #4facfe 50%, #00f2fe 100%)',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#000',
    fontWeight: '800',
    fontSize: '20px',
  },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: '600',
    letterSpacing: '-0.025em',
    color: '#fafafa',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: '14px',
    color: '#71717a',
  },
  card: {
    background: '#18181b',
    borderRadius: '16px',
    border: '1px solid #27272a',
    padding: '24px',
    marginBottom: '24px',
  },
  cardTitle: {
    margin: '0 0 20px',
    fontSize: '13px',
    fontWeight: '600',
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
  },
  inputGroup: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
  },
  input: {
    flex: '1 1 320px',
    background: '#09090b',
    border: '1px solid #27272a',
    borderRadius: '10px',
    padding: '14px 16px',
    color: '#fafafa',
    fontSize: '15px',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  button: {
    padding: '14px 24px',
    background: 'linear-gradient(135deg, #00f2fe 0%, #4facfe 100%)',
    border: 'none',
    borderRadius: '10px',
    color: '#000',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'opacity 0.2s, transform 0.1s',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  buttonDisabled: {
    background: '#27272a',
    color: '#52525b',
    cursor: 'not-allowed',
  },
  error: {
    marginTop: '16px',
    padding: '12px 16px',
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.2)',
    borderRadius: '10px',
    color: '#fca5a5',
    fontSize: '14px',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '12px',
    marginBottom: '24px',
  },
  statCard: {
    background: '#18181b',
    borderRadius: '12px',
    border: '1px solid #27272a',
    padding: '20px',
  },
  statValue: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#fafafa',
    marginBottom: '4px',
    fontVariantNumeric: 'tabular-nums',
  },
  statLabel: {
    fontSize: '12px',
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  filterSection: {
    marginBottom: '24px',
  },
  filterLabel: {
    fontSize: '12px',
    color: '#71717a',
    marginBottom: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  filterGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  filterButton: {
    padding: '8px 16px',
    background: '#27272a',
    border: '1px solid #3f3f46',
    borderRadius: '8px',
    color: '#a1a1aa',
    fontSize: '13px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  downloadSection: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    marginBottom: '32px',
    flexWrap: 'wrap',
  },
  downloadButton: {
    padding: '16px 32px',
    background: 'linear-gradient(135deg, #22c55e, #16a34a)',
    border: 'none',
    borderRadius: '12px',
    color: '#fff',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'transform 0.1s, box-shadow 0.2s',
    boxShadow: '0 4px 24px rgba(34, 197, 94, 0.3)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    minWidth: '1000px',
  },
  th: {
    padding: '12px 16px',
    fontSize: '11px',
    fontWeight: '600',
    color: '#52525b',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    borderBottom: '1px solid #27272a',
    background: '#0f0f11',
  },
  td: {
    padding: '14px 16px',
    borderBottom: '1px solid #1f1f23',
    fontSize: '14px',
    verticalAlign: 'middle',
  },
  tag: {
    padding: '5px 10px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: '500',
    whiteSpace: 'nowrap',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    background: '#27272a',
    borderRadius: '8px',
    color: '#71717a',
    textDecoration: 'none',
    transition: 'all 0.15s',
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  pageButton: {
    padding: '8px 12px',
    background: 'transparent',
    border: '1px solid #3f3f46',
    borderRadius: '6px',
    color: '#a1a1aa',
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  emptyState: {
    textAlign: 'center',
    padding: '80px 24px',
  },
  emptyIcon: {
    width: '80px',
    height: '80px',
    background: 'linear-gradient(135deg, #18181b, #27272a)',
    borderRadius: '20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 24px',
    border: '1px solid #3f3f46',
  },
  footer: {
    marginTop: '64px',
    paddingTop: '32px',
    borderTop: '1px solid #27272a',
    textAlign: 'center',
  },
};

// ============================================================================
// COMPONENTS
// ============================================================================
function LoadingModal({ isOpen, progress, onCancel }) {
  if (!isOpen) return null;

  const percentage = progress.total > 0
    ? Math.min((progress.current / progress.total) * 100, 98)
    : 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }} />
      <div style={{ position: 'relative', background: '#18181b', borderRadius: '20px', border: '1px solid #27272a', padding: '48px', maxWidth: '420px', width: '90%', textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', margin: '0 auto 32px', position: 'relative' }}>
          <svg style={{ position: 'absolute', inset: 0 }} viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" fill="none" stroke="#27272a" strokeWidth="4" />
            <circle
              cx="40" cy="40" r="36"
              fill="none"
              stroke="url(#gradient)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${percentage * 2.26} 226`}
              transform="rotate(-90 40 40)"
              style={{ transition: 'stroke-dasharray 0.3s ease-out' }}
            />
            <defs>
              <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#00f2fe" />
                <stop offset="100%" stopColor="#4facfe" />
              </linearGradient>
            </defs>
          </svg>
          <div style={{ position: 'absolute', inset: '16px', background: '#27272a', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: '#fafafa' }}>
            {Math.round(percentage)}%
          </div>
        </div>
        <h3 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: '600', color: '#fafafa' }}>Fetching Transactions</h3>
        <p style={{ margin: '0 0 32px', color: '#71717a', fontSize: '14px' }}>{progress.status}</p>
        <div style={{ fontSize: '36px', fontWeight: '700', color: '#fafafa', marginBottom: '32px', fontVariantNumeric: 'tabular-nums' }}>
          {progress.current.toLocaleString()}
          <span style={{ fontSize: '14px', color: '#52525b', fontWeight: '400', marginLeft: '8px' }}>records</span>
        </div>
        <button
          onClick={onCancel}
          style={{ padding: '12px 32px', background: 'transparent', border: '1px solid #3f3f46', borderRadius: '10px', color: '#a1a1aa', fontSize: '14px', fontWeight: '500', cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SuccessModal({ isOpen, stats, onClose }) {
  if (!isOpen || !stats) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: '#18181b', borderRadius: '20px', border: '1px solid #27272a', padding: '48px', maxWidth: '420px', width: '90%', textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', margin: '0 auto 32px', background: 'rgba(34, 197, 94, 0.15)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h3 style={{ margin: '0 0 8px', fontSize: '22px', fontWeight: '600', color: '#fafafa' }}>Ready to Export</h3>
        <p style={{ margin: '0 0 32px', color: '#71717a', fontSize: '15px' }}>
          {stats.total.toLocaleString()} transactions loaded
        </p>
        <button
          onClick={onClose}
          style={{ width: '100%', padding: '14px', background: '#22c55e', border: 'none', borderRadius: '10px', color: '#fff', fontSize: '15px', fontWeight: '600', cursor: 'pointer' }}
        >
          View Transactions
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function Home() {
  const [address, setAddress] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0, status: '' });
  const [stats, setStats] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [filter, setFilter] = useState('all');
  const [showSuccess, setShowSuccess] = useState(false);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  // Default date range: 1 year ago to today
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });
  // Transaction type filters - Awaken Tax compatible tags
  const [txTypeFilters, setTxTypeFilters] = useState({
    swap: true,
    'Transfer In': true,
    'Transfer Out': true,
    'Staking Deposit': true,
    'Staking Return': true,
    'Staking Claim': true,
    'Add Liquidity': true,
    'Remove Liquidity': true,
    'Open Position': true,
    'Close Position': true,
    Reward: true,
    fee: true,
    other: true, // For empty/unknown tags
  });
  const cancelRef = useRef(false);

  const toggleTxType = (type) => {
    setTxTypeFilters(prev => ({ ...prev, [type]: !prev[type] }));
  };

  const toggleAllTxTypes = (value) => {
    const newState = {};
    Object.keys(txTypeFilters).forEach(k => { newState[k] = value; });
    setTxTypeFilters(newState);
  };

  useEffect(() => {
    loadTokensGlobal().then(() => setTokensLoaded(true));
  }, []);

  const filteredTxs = useMemo(() => {
    if (filter === 'all') return transactions;
    return transactions.filter(tx => tx.tag === filter);
  }, [transactions, filter]);

  const paginatedTxs = useMemo(() => {
    return filteredTxs.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
  }, [filteredTxs, currentPage]);

  const totalPages = Math.ceil(filteredTxs.length / ITEMS_PER_PAGE);

  const fetchTransactions = useCallback(async () => {
    const trimmedAddress = address.trim();

    if (!trimmedAddress || !trimmedAddress.startsWith('inj1') || trimmedAddress.length !== 42) {
      setError('Please enter a valid Injective address (starts with inj1, 42 characters)');
      return;
    }

    cancelRef.current = false;
    setLoading(true);
    setError('');
    setTransactions([]);
    setCurrentPage(1);
    setFilter('all');
    setShowSuccess(false);
    setProgress({ current: 0, total: 0, status: 'Initializing...' });

    try {
      // Ensure tokens are loaded
      await loadTokensGlobal();
      setTokensLoaded(true);
      setProgress(p => ({ ...p, status: 'Connecting to Injective...' }));

      const allTxs = [];
      const rawTxs = []; // Keep raw transactions for swap price extraction
      const seenHashes = new Set();
      let hasMore = true;
      let skip = 0;
      let batch = 0;
      let totalEstimate = 0;

      while (hasMore && !cancelRef.current) {
        batch++;
        setProgress(p => ({ ...p, status: `Fetching batch ${batch}...` }));

        const response = await fetch(`${EXPLORER_API}/${trimmedAddress}?limit=100&skip=${skip}`);

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `API error: ${response.status}`);
        }

        const data = await response.json();
        const txs = data.data || data.txs || [];

        // Update total estimate from paging info
        if (data.paging?.total && data.paging.total > totalEstimate) {
          totalEstimate = data.paging.total;
        }

        if (txs.length === 0) {
          hasMore = false;
        } else {
          for (const tx of txs) {
            const txHash = tx.hash || tx.txHash || tx.id;

            // Skip duplicates
            if (seenHashes.has(txHash)) continue;
            seenHashes.add(txHash);

            // Keep raw transaction for swap price extraction
            rawTxs.push(tx);

            // Parse and add transactions (failed ones included if gas deductible is enabled)
            const parsed = parseTransaction(tx, trimmedAddress, true); // Always include failed txs
            allTxs.push(...parsed);
          }

          skip += 100;
          if (txs.length < 100) hasMore = false;

          setProgress({
            current: allTxs.length,
            total: totalEstimate || allTxs.length,
            status: `Processing ${allTxs.length.toLocaleString()} transactions...`,
          });

          // Small delay to prevent rate limiting
          await new Promise(r => setTimeout(r, 50));
        }
      }

      if (cancelRef.current) {
        setLoading(false);
        return;
      }

      // Sort by date ASCENDING (oldest first) for cost basis calculation
      allTxs.sort((a, b) => new Date(a.dateStr) - new Date(b.dateStr));

      // Filter by date range if specified
      let filteredTxs = allTxs;
      if (startDate) {
        filteredTxs = filteredTxs.filter(tx => tx.dateStr >= startDate);
      }
      if (endDate) {
        filteredTxs = filteredTxs.filter(tx => tx.dateStr <= endDate);
      }

      // Filter by transaction type
      filteredTxs = filteredTxs.filter(tx => {
        const tag = tx.tag || '';
        if (tag === '') return txTypeFilters.other;
        return txTypeFilters[tag] !== false; // Include if not explicitly false
      });

      // Fetch prices and calculate P&L
      let missingPrices = [];
      if (filteredTxs.length > 0) {
        setProgress({ current: filteredTxs.length, total: filteredTxs.length, status: 'Fetching historical prices...' });

        // Reset session prices (no caching between fetches)
        sessionPrices = { data: {}, sources: {} };

        // Calculate P&L using FIFO cost basis
        const costTracker = new CostBasisTracker();

        // Collect unique token/date combinations for price fetching
        const priceRequests = [];
        const seen = new Set();
        for (const tx of filteredTxs) {
          // Request prices for received tokens
          if (tx.receivedCurrency) {
            const key = `${tx.receivedCurrency}|${tx.dateStr}`;
            if (!seen.has(key)) {
              seen.add(key);
              priceRequests.push({ token: tx.receivedCurrency, date: tx.dateStr });
            }
          }
          // Request prices for sent tokens
          if (tx.sentCurrency) {
            const key = `${tx.sentCurrency}|${tx.dateStr}`;
            if (!seen.has(key)) {
              seen.add(key);
              priceRequests.push({ token: tx.sentCurrency, date: tx.dateStr });
            }
          }
        }

        // Fetch prices from Injective DEX trades (chain-specific) with Pyth fallback
        setProgress(p => ({ ...p, status: `Fetching ${priceRequests.length} prices from Injective DEX...` }));

        // Batch into groups of 10 for CoinGecko rate limits
        for (let i = 0; i < priceRequests.length; i += 10) {
          if (cancelRef.current) break;
          const batch = priceRequests.slice(i, i + 10);
          const result = await fetchPricesBatch(batch);
          if (result.missing) {
            missingPrices.push(...result.missing);
          }
          setProgress(p => ({ ...p, status: `Fetching prices... ${Math.min(100, Math.round(((i + 10) / priceRequests.length) * 100))}%` }));
        }

        // Process transactions: populate fiat values and calculate P&L
        for (const tx of filteredTxs) {
          const receivedQty = tx.receivedQty ? parseFloat(tx.receivedQty) : 0;
          const sentQty = tx.sentQty ? parseFloat(tx.sentQty) : 0;
          const receivedPrice = tx.receivedCurrency ? getPrice(tx.receivedCurrency, tx.dateStr) : null;
          const sentPrice = tx.sentCurrency ? getPrice(tx.sentCurrency, tx.dateStr) : null;

          // Populate fiat values for CSV (leave empty if price unavailable)
          if (receivedQty > 0 && receivedPrice !== null) {
            tx.receivedFiat = (receivedQty * receivedPrice).toFixed(2);
          }
          if (sentQty > 0 && sentPrice !== null) {
            tx.sentFiat = (sentQty * sentPrice).toFixed(2);
          }

          // Mark transactions with missing prices
          tx.missingPrice = (receivedQty > 0 && receivedPrice === null) ||
                            (sentQty > 0 && sentPrice === null);

          // Track price sources for this transaction
          const recvSource = tx.receivedCurrency ? getPriceSource(tx.receivedCurrency, tx.dateStr) : null;
          const sentSource = tx.sentCurrency ? getPriceSource(tx.sentCurrency, tx.dateStr) : null;
          tx.priceSource = recvSource || sentSource; // 'injective-dex' or 'pyth'

          // Add received tokens to cost basis (only if we have a price)
          if (receivedQty > 0 && tx.receivedCurrency && receivedPrice !== null) {
            costTracker.addLot(tx.receivedCurrency, receivedQty, receivedPrice, tx.dateStr);
          }

          // Calculate P&L for sent tokens (only if we have a price)
          if (sentQty > 0 && tx.sentCurrency && sentPrice !== null) {
            const { realizedPnl } = costTracker.sellFIFO(tx.sentCurrency, sentQty, sentPrice);
            if (realizedPnl !== null) {
              tx.pnl = realizedPnl.toFixed(2);
              tx.pnlDisplay = realizedPnl >= 0 ? `+${realizedPnl.toFixed(2)}` : realizedPnl.toFixed(2);
            } else {
              tx.pnl = '';
              tx.pnlDisplay = '';
            }
          } else {
            // No price available or no sent amount
            tx.pnl = '';
            tx.pnlDisplay = '';
          }
        }
      }

      // Use filtered transactions
      const finalTxs = filteredTxs;

      // Sort by date DESCENDING (newest first) for display
      finalTxs.sort((a, b) => new Date(b.dateStr) - new Date(a.dateStr));

      setTransactions(finalTxs);

      // Calculate stats
      const tagCounts = {};
      let totalPnl = 0;
      let missingPriceCount = 0;
      finalTxs.forEach(tx => {
        const tag = tx.tag || '';
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;

        if (tx.missingPrice) {
          missingPriceCount++;
        }
        if (tx.pnl && tx.pnl !== '') {
          totalPnl += parseFloat(tx.pnl) || 0;
        }
      });

      // Deduplicate missing prices list
      const uniqueMissing = [...new Set(missingPrices)];

      setStats({
        total: finalTxs.length,
        tagCounts,
        uniqueTxs: seenHashes.size,
        totalPnl,
        missingPriceCount,
        missingPrices: uniqueMissing
      });
      setShowSuccess(true);

    } catch (err) {
      setError(err.message || 'Failed to fetch transactions');
    } finally {
      setLoading(false);
    }
  }, [address, startDate, endDate, txTypeFilters]);

  const downloadCSV = useCallback(() => {
    const csv = generateCSV(transactions);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    link.href = URL.createObjectURL(blob);
    link.download = `injective-${address.slice(0, 10)}-${timestamp}-awaken.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }, [transactions, address]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !loading) {
      fetchTransactions();
    }
  }, [fetchTransactions, loading]);

  return (
    <div style={styles.container}>
      <LoadingModal
        isOpen={loading}
        progress={progress}
        onCancel={() => { cancelRef.current = true; setLoading(false); }}
      />
      <SuccessModal
        isOpen={showSuccess}
        stats={stats}
        onClose={() => setShowSuccess(false)}
      />

      <div style={styles.inner}>
        {/* Header */}
        <header style={styles.header}>
          <div style={styles.headerLeft}>
            <div style={styles.logo}>INJ</div>
            <div>
              <h1 style={styles.title}>Injective Tax Exporter</h1>
              <p style={styles.subtitle}>
                Export transaction history for Awaken Tax
                {tokensLoaded && (
                  <span style={{ color: '#4facfe', marginLeft: '8px' }}>
                    {Object.keys(tokenCache.data || {}).length} tokens
                  </span>
                )}
              </p>
            </div>
          </div>
        </header>

        {/* Input Card */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Wallet Address</h2>
          <div style={styles.inputGroup}>
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="inj1..."
              disabled={loading}
              style={{
                ...styles.input,
                opacity: loading ? 0.5 : 1,
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              onClick={fetchTransactions}
              disabled={loading || !address.trim()}
              style={{
                ...styles.button,
                ...(loading || !address.trim() ? styles.buttonDisabled : {}),
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              Fetch Transactions
            </button>
          </div>

          {/* Date Range & Options */}
          <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '13px', color: '#71717a' }}>From:</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                disabled={loading}
                style={{
                  ...styles.input,
                  flex: 'none',
                  width: '150px',
                  padding: '10px 12px',
                  fontSize: '13px',
                  colorScheme: 'dark',
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '13px', color: '#71717a' }}>To:</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                disabled={loading}
                style={{
                  ...styles.input,
                  flex: 'none',
                  width: '150px',
                  padding: '10px 12px',
                  fontSize: '13px',
                  colorScheme: 'dark',
                }}
              />
            </div>
          </div>

          {/* Transaction Type Filters */}
          <div style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <span style={{ fontSize: '12px', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Include Transaction Types
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => toggleAllTxTypes(true)}
                  disabled={loading}
                  style={{ padding: '4px 10px', background: 'transparent', border: '1px solid #3f3f46', borderRadius: '6px', color: '#71717a', fontSize: '11px', cursor: 'pointer' }}
                >
                  All
                </button>
                <button
                  onClick={() => toggleAllTxTypes(false)}
                  disabled={loading}
                  style={{ padding: '4px 10px', background: 'transparent', border: '1px solid #3f3f46', borderRadius: '6px', color: '#71717a', fontSize: '11px', cursor: 'pointer' }}
                >
                  None
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {[
                { key: 'swap', label: 'Swap', color: '#fbbf24' },
                { key: 'Transfer In', label: 'Transfer In', color: '#4ade80' },
                { key: 'Transfer Out', label: 'Transfer Out', color: '#f87171' },
                { key: 'Staking Deposit', label: 'Stake', color: '#a78bfa' },
                { key: 'Staking Return', label: 'Unstake', color: '#c4b5fd' },
                { key: 'Staking Claim', label: 'Rewards', color: '#4ade80' },
                { key: 'Add Liquidity', label: 'Add LP', color: '#60a5fa' },
                { key: 'Remove Liquidity', label: 'Remove LP', color: '#93c5fd' },
                { key: 'fee', label: 'Fee', color: '#fb923c' },
                { key: 'other', label: 'Other', color: '#71717a' },
              ].map(({ key, label, color }) => (
                <label
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    background: txTypeFilters[key] ? `${color}15` : '#1f1f23',
                    border: `1px solid ${txTypeFilters[key] ? color : '#27272a'}`,
                    borderRadius: '6px',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.5 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={txTypeFilters[key]}
                    onChange={() => toggleTxType(key)}
                    disabled={loading}
                    style={{ display: 'none' }}
                  />
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: txTypeFilters[key] ? color : '#3f3f46'
                  }} />
                  <span style={{ fontSize: '12px', color: txTypeFilters[key] ? color : '#52525b' }}>
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {error && <div style={styles.error}>{error}</div>}
        </div>

        {/* Stats Grid */}
        {stats && (
          <div style={styles.statsGrid}>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{stats.total.toLocaleString()}</div>
              <div style={styles.statLabel}>Total Records</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#a78bfa' }}>{stats.uniqueTxs?.toLocaleString() || '—'}</div>
              <div style={styles.statLabel}>Unique Txs</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#fbbf24' }}>{stats.tagCounts['swap'] || 0}</div>
              <div style={styles.statLabel}>Swaps</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#4ade80' }}>{stats.tagCounts['Transfer In'] || 0}</div>
              <div style={styles.statLabel}>Transfers In</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#f87171' }}>{stats.tagCounts['Transfer Out'] || 0}</div>
              <div style={styles.statLabel}>Transfers Out</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#fb923c' }}>{stats.tagCounts['fee'] || 0}</div>
              <div style={styles.statLabel}>Fees</div>
            </div>
            {stats.totalPnl !== undefined && stats.totalPnl !== 0 && (
              <div style={styles.statCard}>
                <div style={{ ...styles.statValue, color: stats.totalPnl >= 0 ? '#4ade80' : '#f87171' }}>
                  {stats.totalPnl >= 0 ? '+' : ''}${Math.abs(stats.totalPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={styles.statLabel}>Est. P&L (USD)</div>
              </div>
            )}
            {stats.missingPriceCount > 0 && (
              <div style={{ ...styles.statCard, borderColor: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)' }}>
                <div style={{ ...styles.statValue, color: '#f59e0b' }}>{stats.missingPriceCount}</div>
                <div style={styles.statLabel}>Missing Prices</div>
              </div>
            )}
          </div>
        )}

        {/* Warning for missing prices */}
        {stats?.missingPrices?.length > 0 && (
          <div style={{
            padding: '16px 20px',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '12px',
            marginBottom: '24px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <path d="M12 9v4"/>
                <path d="M12 17h.01"/>
              </svg>
              <div>
                <div style={{ fontWeight: '600', color: '#f59e0b', marginBottom: '4px' }}>
                  Missing Historical Prices
                </div>
                <div style={{ color: '#a1a1aa', fontSize: '14px', lineHeight: '1.5' }}>
                  Could not find USD prices for {stats.missingPrices.length} token/date combinations.
                  These transactions will have empty fiat values and P&L in the CSV export.
                  You may need to manually add prices for accurate tax reporting.
                </div>
                <details style={{ marginTop: '8px' }}>
                  <summary style={{ color: '#f59e0b', cursor: 'pointer', fontSize: '13px' }}>
                    Show missing prices ({stats.missingPrices.length})
                  </summary>
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#71717a', maxHeight: '120px', overflow: 'auto' }}>
                    {stats.missingPrices.slice(0, 50).map((item, i) => (
                      <div key={i}>{item}</div>
                    ))}
                    {stats.missingPrices.length > 50 && (
                      <div style={{ color: '#f59e0b' }}>...and {stats.missingPrices.length - 50} more</div>
                    )}
                  </div>
                </details>
              </div>
            </div>
          </div>
        )}

        {/* Filter Buttons */}
        {stats && (
          <div style={styles.filterSection}>
            <div style={styles.filterLabel}>Filter by Type</div>
            <div style={styles.filterGroup}>
              <button
                onClick={() => { setFilter('all'); setCurrentPage(1); }}
                style={{
                  ...styles.filterButton,
                  ...(filter === 'all' ? { background: 'rgba(79, 172, 254, 0.15)', border: '1px solid #4facfe', color: '#4facfe' } : {}),
                }}
              >
                All ({stats.total})
              </button>
              {Object.entries(stats.tagCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([tag, count]) => {
                  const c = TAG_CONFIG[tag] || TAG_CONFIG[''];
                  const isActive = filter === tag;
                  return (
                    <button
                      key={tag || 'other'}
                      onClick={() => { setFilter(tag); setCurrentPage(1); }}
                      style={{
                        ...styles.filterButton,
                        ...(isActive ? { background: c.bg, border: `1px solid ${c.color}`, color: c.color } : {}),
                      }}
                    >
                      {c.label} ({count})
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Download Button */}
        {transactions.length > 0 && (
          <div style={styles.downloadSection}>
            <button onClick={downloadCSV} style={styles.downloadButton}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              Download CSV for Awaken Tax
            </button>
            <span style={{ color: '#52525b', fontSize: '14px' }}>
              {transactions.length.toLocaleString()} rows
            </span>
          </div>
        )}

        {/* Transaction Table */}
        {filteredTxs.length > 0 && (
          <div style={{ ...styles.card, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid #27272a', flexWrap: 'wrap', gap: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#fafafa' }}>
                Transaction History
                <span style={{ marginLeft: '8px', color: '#52525b', fontWeight: '400' }}>
                  {filteredTxs.length.toLocaleString()} records
                </span>
              </h3>
              {totalPages > 1 && (
                <div style={styles.pagination}>
                  <button
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    style={{ ...styles.pageButton, opacity: currentPage === 1 ? 0.3 : 1 }}
                  >
                    First
                  </button>
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    style={{ ...styles.pageButton, opacity: currentPage === 1 ? 0.3 : 1 }}
                  >
                    Prev
                  </button>
                  <span style={{ padding: '0 12px', color: '#52525b', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    style={{ ...styles.pageButton, opacity: currentPage === totalPages ? 0.3 : 1 }}
                  >
                    Next
                  </button>
                  <button
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                    style={{ ...styles.pageButton, opacity: currentPage === totalPages ? 0.3 : 1 }}
                  >
                    Last
                  </button>
                </div>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ ...styles.table, minWidth: '1400px' }}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Date</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Received Qty</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Received</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Recv Fiat</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Sent Qty</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Sent</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Sent Fiat</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Fee</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Fee Cur</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Tag</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Notes</th>
                    <th style={{ ...styles.th, textAlign: 'center', width: '56px' }}>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTxs.map((tx, i) => {
                    const c = TAG_CONFIG[tx.tag] || TAG_CONFIG[''];
                    const hasMissingPrice = tx.missingPrice;
                    return (
                      <tr key={`${tx.txHash}-${i}`} style={hasMissingPrice ? { background: 'rgba(245, 158, 11, 0.08)' } : {}}>
                        <td style={styles.td}>
                          <div style={{ fontWeight: '500', color: '#fafafa', fontSize: '13px' }}>{tx.dateFormatted}</div>
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          color: tx.receivedQty ? '#4ade80' : '#3f3f46',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {tx.receivedQty || ''}
                        </td>
                        <td style={{ ...styles.td, fontWeight: '500', color: tx.receivedCurrency ? '#4ade80' : '#3f3f46' }}>
                          {tx.receivedCurrency || ''}
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          color: tx.receivedFiat ? '#4ade80' : '#3f3f46',
                          fontVariantNumeric: 'tabular-nums',
                        }} title={tx.priceSource ? `Price from ${tx.priceSource}` : ''}>
                          {tx.receivedFiat ? `$${tx.receivedFiat}` : ''}
                          {tx.receivedFiat && tx.priceSource === 'pyth' && (
                            <span style={{ fontSize: '9px', color: '#f59e0b', marginLeft: '2px' }} title="Cross-chain price (Pyth)">*</span>
                          )}
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          color: tx.sentQty ? '#f87171' : '#3f3f46',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {tx.sentQty || ''}
                        </td>
                        <td style={{ ...styles.td, fontWeight: '500', color: tx.sentCurrency ? '#f87171' : '#3f3f46' }}>
                          {tx.sentCurrency || ''}
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          color: tx.sentFiat ? '#f87171' : '#3f3f46',
                          fontVariantNumeric: 'tabular-nums',
                        }} title={tx.priceSource ? `Price from ${tx.priceSource}` : ''}>
                          {tx.sentFiat ? `$${tx.sentFiat}` : ''}
                          {tx.sentFiat && tx.priceSource === 'pyth' && (
                            <span style={{ fontSize: '9px', color: '#f59e0b', marginLeft: '2px' }} title="Cross-chain price (Pyth)">*</span>
                          )}
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          color: '#fb923c',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {tx.feeAmount || ''}
                        </td>
                        <td style={{ ...styles.td, color: '#fb923c' }}>
                          {tx.feeCurrency || ''}
                        </td>
                        <td style={styles.td}>
                          {tx.tag ? (
                            <span style={{ ...styles.tag, background: c.bg, color: c.color }}>
                              {c.label}
                            </span>
                          ) : (
                            <span style={{ color: '#3f3f46' }}>—</span>
                          )}
                        </td>
                        <td style={{ ...styles.td, color: '#71717a', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tx.notes}>
                          {tx.notes || ''}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'center' }}>
                          <a
                            href={`https://explorer.injective.network/transaction/${tx.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={styles.link}
                            title={tx.txHash}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" x2="21" y1="14" y2="3" />
                            </svg>
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!loading && transactions.length === 0 && !error && (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px', color: '#fafafa' }}>
              No Transactions Yet
            </h3>
            <p style={{ color: '#52525b', margin: 0, fontSize: '15px', maxWidth: '320px', marginInline: 'auto' }}>
              Enter your Injective wallet address above to fetch and export your transaction history
            </p>
          </div>
        )}

        {/* Footer */}
        <footer style={styles.footer}>
          <p style={{ color: '#52525b', margin: '0 0 8px', fontSize: '14px' }}>
            Built for{' '}
            <a
              href="https://awaken.tax"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#4facfe', textDecoration: 'none' }}
            >
              Awaken Tax
            </a>
          </p>
          <p style={{ fontSize: '12px', color: '#3f3f46', margin: 0 }}>
            Prices from Injective DEX trades (chain-specific). <span style={{ color: '#f59e0b' }}>*</span> = Pyth fallback (cross-chain).
          </p>
          <p style={{ fontSize: '12px', color: '#3f3f46', margin: '4px 0 0' }}>
            This tool is not financial advice.
          </p>
        </footer>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input::placeholder { color: #3f3f46; }
        input:focus { border-color: #4facfe; box-shadow: 0 0 0 3px rgba(79, 172, 254, 0.15); }
        button:hover:not(:disabled) { opacity: 0.9; }
        button:active:not(:disabled) { transform: scale(0.98); }
        tr:hover td { background: rgba(255, 255, 255, 0.02); }
        a:hover { background: #3f3f46 !important; color: #fafafa !important; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #09090b; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #18181b; }
        ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #52525b; }
      `}</style>
    </div>
  );
}
