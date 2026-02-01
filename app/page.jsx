'use client';
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

const EXPLORER_API = '/api/transactions';
const PRICES_API = '/api/prices';
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/nicholasgodfreyclarke/kujira-lists/refs/heads/main/tokens.json';
const TOKEN_CACHE_KEY = 'kujira_token_cache_v1';
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

// Get price source - returns 'pyth' or null
function getPriceSource(token, date) {
  const key = `${token.toUpperCase()}-${date}`;
  return sessionPrices.sources?.[key] || null;
}

// Check if price has time difference warning (returns hours or null)
function getPriceTimeDiff(token, date) {
  const source = getPriceSource(token, date);
  if (!source) return null;
  const match = source.match(/\(price from (\d+\.?\d*)h away\)/);
  return match ? parseFloat(match[1]) : null;
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
  'ukuji': { symbol: 'KUJI', decimals: 6 },
  // axlUSDC
  'ibc/295548a78785a1007f232de286149a6ff512f180af5657780fc89c009e2c348f': { symbol: 'axlUSDC', decimals: 6 },
  // ATOM
  'ibc/27394fb092d2eccd56123c74f36e4c1f926001ceada9ca97ea622b25f41e5eb2': { symbol: 'ATOM', decimals: 6 },
  // OSMO
  'ibc/47bd209179859cde4a2806763d7189b6e6fe13a17880fe2b42de1e6c1e329e23': { symbol: 'OSMO', decimals: 6 },
  // USK (Kujira stablecoin)
  'factory/kujira1qk00h5atutpsv900x202pxx42npjr9thg58dnqpa72f2p7m2luase444a7/uusk': { symbol: 'USK', decimals: 6 },
  // MNTA
  'factory/kujira1643jxg8wasy5cfcn7xm8rd742yeazcksqlg4d7/umnta': { symbol: 'MNTA', decimals: 6 },
};

function getTokenInfo(denom) {
  if (!denom) return { symbol: 'KUJI', decimals: 6 };
  const key = denom.toLowerCase();

  // Check common tokens first
  if (COMMON_TOKENS[key]) return COMMON_TOKENS[key];

  // Check cache
  const cached = tokenCache.data?.[key];
  if (cached) return cached;

  // Parse denom string - Kujira uses standard Cosmos denoms
  // Native token
  if (denom === 'ukuji') {
    return { symbol: 'KUJI', decimals: 6 };
  }
  // IBC tokens
  if (denom.startsWith('ibc/')) {
    return { symbol: `IBC/${denom.slice(4, 10)}`, decimals: 6 };
  }
  // Factory tokens (e.g., factory/kujira1.../umnta)
  if (denom.startsWith('factory/')) {
    const parts = denom.split('/');
    const lastPart = parts[parts.length - 1] || 'TOKEN';
    // Remove 'u' prefix if present (micro denomination)
    const symbol = lastPart.startsWith('u') ? lastPart.slice(1).toUpperCase() : lastPart.toUpperCase();
    return { symbol, decimals: 6 };
  }
  // CW20 contract addresses
  if (denom.startsWith('kujira1')) {
    return { symbol: `CW20/${denom.slice(7, 13)}`, decimals: 6 };
  }

  return { symbol: denom.length > 12 ? `${denom.slice(0, 8)}...` : denom.toUpperCase(), decimals: 6 };
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
// TRANSACTION PARSING - Comprehensive handler for Kujira/Cosmos message types
// ============================================================================

// Helper: Parse coin amount from event attribute value like "1000000ukuji" or "500000ibc/..."
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
    maxWidth: '1600px',
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
    background: 'linear-gradient(135deg, #E8524A 0%, #F97316 50%, #E8524A 100%)',
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
    background: 'linear-gradient(135deg, #E8524A 0%, #F97316 100%)',
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
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }} />
      <div className="modal-content" style={{ position: 'relative', background: '#18181b', borderRadius: '20px', border: '1px solid #27272a', padding: '48px 32px', maxWidth: '420px', width: '100%', textAlign: 'center' }}>
        <div className="modal-progress-ring" style={{ width: '80px', height: '80px', margin: '0 auto 24px', position: 'relative' }}>
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
                <stop offset="0%" stopColor="#E8524A" />
                <stop offset="100%" stopColor="#F97316" />
              </linearGradient>
            </defs>
          </svg>
          <div style={{ position: 'absolute', inset: '16px', background: '#27272a', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: '#fafafa' }}>
            {Math.round(percentage)}%
          </div>
        </div>
        <h3 className="modal-title" style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: '600', color: '#fafafa' }}>Fetching Transactions</h3>
        <p className="modal-status" style={{ margin: '0 0 24px', color: '#71717a', fontSize: '14px', wordBreak: 'break-word' }}>{progress.status}</p>
        <div className="modal-count" style={{ fontSize: '32px', fontWeight: '700', color: '#fafafa', marginBottom: '24px', fontVariantNumeric: 'tabular-nums' }}>
          {progress.current.toLocaleString()}
          <span style={{ fontSize: '14px', color: '#52525b', fontWeight: '400', marginLeft: '8px' }}>records</span>
        </div>
        <button
          onClick={onCancel}
          className="modal-cancel-btn"
          style={{ padding: '14px 32px', background: 'transparent', border: '1px solid #3f3f46', borderRadius: '10px', color: '#a1a1aa', fontSize: '14px', fontWeight: '500', cursor: 'pointer', width: '100%', maxWidth: '200px' }}
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
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div className="modal-content" style={{ position: 'relative', background: '#18181b', borderRadius: '20px', border: '1px solid #27272a', padding: '48px 32px', maxWidth: '420px', width: '100%', textAlign: 'center' }}>
        <div className="modal-success-icon" style={{ width: '80px', height: '80px', margin: '0 auto 24px', background: 'rgba(34, 197, 94, 0.15)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h3 className="modal-title" style={{ margin: '0 0 8px', fontSize: '22px', fontWeight: '600', color: '#fafafa' }}>Ready to Export</h3>
        <p style={{ margin: '0 0 24px', color: '#71717a', fontSize: '15px' }}>
          {stats.total.toLocaleString()} transactions loaded
        </p>
        <button
          onClick={onClose}
          style={{ width: '100%', padding: '16px', background: '#22c55e', border: 'none', borderRadius: '10px', color: '#fff', fontSize: '15px', fontWeight: '600', cursor: 'pointer' }}
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
  const [tokenCount, setTokenCount] = useState(0);
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
    loadTokensGlobal().then((data) => {
      setTokenCount(Object.keys(data || {}).length);
    });
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

    if (!trimmedAddress || !trimmedAddress.startsWith('kujira1') || trimmedAddress.length < 43) {
      setError('Please enter a valid Kujira address (starts with kujira1)');
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
      const tokenData = await loadTokensGlobal();
      setTokenCount(Object.keys(tokenData || {}).length);
      setProgress(p => ({ ...p, status: 'Connecting to Kujira...' }));

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
          let reachedStartDate = false;
          for (const tx of txs) {
            const txTimestamp = tx.blockTimestamp || tx.block_timestamp || tx.timestamp;
            const txDate = txTimestamp ? new Date(txTimestamp).toISOString().split('T')[0] : null;

            // Check if transaction is older than start date - stop fetching
            if (txDate && startDate && txDate < startDate) {
              reachedStartDate = true;
              console.log(`Stopping fetch: tx date ${txDate} < start date ${startDate}`);
              break;
            }

            // Skip transactions after end date (don't process but keep fetching)
            if (txDate && endDate && txDate > endDate) {
              continue;
            }

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

          // Stop fetching if we've reached transactions older than startDate
          if (reachedStartDate) {
            hasMore = false;
          }

          skip += 100;
          if (txs.length < 100) hasMore = false;

          setProgress({
            current: allTxs.length,
            total: totalEstimate || allTxs.length,
            status: startDate
              ? `Fetching transactions from ${startDate}...`
              : `Processing ${allTxs.length.toLocaleString()} transactions...`,
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

        // Fetch prices from Pyth
        setProgress(p => ({ ...p, status: `Fetching ${priceRequests.length} prices from Pyth...` }));

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

          // Track price sources and time diffs for this transaction
          const recvSource = tx.receivedCurrency ? getPriceSource(tx.receivedCurrency, tx.dateStr) : null;
          const sentSource = tx.sentCurrency ? getPriceSource(tx.sentCurrency, tx.dateStr) : null;
          tx.priceSource = recvSource || sentSource; // 'pyth'

          // Check for time difference warnings
          const recvTimeDiff = tx.receivedCurrency ? getPriceTimeDiff(tx.receivedCurrency, tx.dateStr) : null;
          const sentTimeDiff = tx.sentCurrency ? getPriceTimeDiff(tx.sentCurrency, tx.dateStr) : null;
          tx.priceTimeDiff = recvTimeDiff || sentTimeDiff; // Hours away from actual trade

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
      let timeDiffCount = 0;
      const timeDiffList = [];
      finalTxs.forEach(tx => {
        const tag = tx.tag || '';
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;

        if (tx.missingPrice) {
          missingPriceCount++;
        }
        if (tx.priceTimeDiff && tx.priceTimeDiff > 1) {
          timeDiffCount++;
          const token = tx.receivedCurrency || tx.sentCurrency;
          if (token) {
            timeDiffList.push(`${token} on ${tx.dateStr} (${tx.priceTimeDiff}h away)`);
          }
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
        missingPrices: uniqueMissing,
        timeDiffCount,
        timeDiffList: [...new Set(timeDiffList)],
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
    link.download = `kujira-${address.slice(0, 12)}-${timestamp}-awaken.csv`;
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

      <div style={styles.inner} className="responsive-inner">
        {/* Header */}
        <header style={styles.header} className="responsive-header">
          <div style={styles.headerLeft} className="responsive-header-left">
            <div style={styles.logo} className="responsive-logo">KUJI</div>
            <div>
              <h1 style={styles.title} className="responsive-title">Kujira Tax Exporter</h1>
              <p style={styles.subtitle} className="responsive-subtitle">
                Export transaction history for Awaken Tax
                {tokenCount > 0 && (
                  <span style={{ color: '#F97316', marginLeft: '8px' }}>
                    {tokenCount} tokens
                  </span>
                )}
              </p>
            </div>
          </div>
        </header>

        {/* Input Card */}
        <div style={styles.card} className="responsive-card">
          <h2 style={styles.cardTitle} className="responsive-card-title">Wallet Address</h2>
          <div style={styles.inputGroup} className="responsive-input-group">
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="kujira1..."
              disabled={loading}
              style={{
                ...styles.input,
                opacity: loading ? 0.5 : 1,
              }}
              className="responsive-input"
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
              className="responsive-button"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              Fetch Transactions
            </button>
          </div>

          {/* Date Range & Options */}
          <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }} className="responsive-date-range">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} className="responsive-date-group">
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
                className="responsive-date-input"
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} className="responsive-date-group">
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
                className="responsive-date-input"
              />
            </div>
          </div>

          {/* Transaction Type Filters */}
          <div style={{ marginTop: '20px' }} className="responsive-tx-types">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }} className="responsive-tx-types-header">
              <span style={{ fontSize: '12px', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Include Transaction Types
              </span>
              <div style={{ display: 'flex', gap: '8px' }} className="responsive-tx-types-buttons">
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }} className="responsive-tx-types-grid">
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
                  className="responsive-tx-type-label"
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
          <div style={styles.statsGrid} className="responsive-stats-grid">
            <div style={styles.statCard} className="responsive-stat-card">
              <div style={styles.statValue} className="responsive-stat-value">{stats.total.toLocaleString()}</div>
              <div style={styles.statLabel} className="responsive-stat-label">Total Records</div>
            </div>
            <div style={styles.statCard} className="responsive-stat-card">
              <div style={{ ...styles.statValue, color: '#a78bfa' }} className="responsive-stat-value">{stats.uniqueTxs?.toLocaleString() || '—'}</div>
              <div style={styles.statLabel} className="responsive-stat-label">Unique Txs</div>
            </div>
            <div style={styles.statCard} className="responsive-stat-card">
              <div style={{ ...styles.statValue, color: '#fbbf24' }} className="responsive-stat-value">{stats.tagCounts['swap'] || 0}</div>
              <div style={styles.statLabel} className="responsive-stat-label">Swaps</div>
            </div>
            <div style={styles.statCard} className="responsive-stat-card">
              <div style={{ ...styles.statValue, color: '#4ade80' }} className="responsive-stat-value">{stats.tagCounts['Transfer In'] || 0}</div>
              <div style={styles.statLabel} className="responsive-stat-label">Transfers In</div>
            </div>
            <div style={styles.statCard} className="responsive-stat-card">
              <div style={{ ...styles.statValue, color: '#f87171' }} className="responsive-stat-value">{stats.tagCounts['Transfer Out'] || 0}</div>
              <div style={styles.statLabel} className="responsive-stat-label">Transfers Out</div>
            </div>
            <div style={styles.statCard} className="responsive-stat-card">
              <div style={{ ...styles.statValue, color: '#fb923c' }} className="responsive-stat-value">{stats.tagCounts['fee'] || 0}</div>
              <div style={styles.statLabel} className="responsive-stat-label">Fees</div>
            </div>
            {stats.totalPnl !== undefined && stats.totalPnl !== 0 && (
              <div style={styles.statCard} className="responsive-stat-card">
                <div style={{ ...styles.statValue, color: stats.totalPnl >= 0 ? '#4ade80' : '#f87171' }} className="responsive-stat-value">
                  {stats.totalPnl >= 0 ? '+' : ''}${Math.abs(stats.totalPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={styles.statLabel} className="responsive-stat-label">Est. P&L (USD)</div>
              </div>
            )}
            {stats.missingPriceCount > 0 && (
              <div style={{ ...styles.statCard, borderColor: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)' }} className="responsive-stat-card">
                <div style={{ ...styles.statValue, color: '#f59e0b' }} className="responsive-stat-value">{stats.missingPriceCount}</div>
                <div style={styles.statLabel} className="responsive-stat-label">Missing Prices</div>
              </div>
            )}
            {stats.timeDiffCount > 0 && (
              <div style={{ ...styles.statCard, borderColor: '#3b82f6', background: 'rgba(59, 130, 246, 0.1)' }} className="responsive-stat-card">
                <div style={{ ...styles.statValue, color: '#3b82f6' }} className="responsive-stat-value">{stats.timeDiffCount}</div>
                <div style={styles.statLabel} className="responsive-stat-label">Approx Prices</div>
              </div>
            )}
          </div>
        )}

        {/* Warning for missing prices */}
        {stats?.missingPrices?.length > 0 && (
          <div className="responsive-warning-box" style={{
            padding: '16px 20px',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '12px',
            marginBottom: '24px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }} className="responsive-warning-content">
              <svg className="responsive-warning-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <path d="M12 9v4"/>
                <path d="M12 17h.01"/>
              </svg>
              <div>
                <div className="responsive-warning-title" style={{ fontWeight: '600', color: '#f59e0b', marginBottom: '4px' }}>
                  Missing Historical Prices
                </div>
                <div className="responsive-warning-text" style={{ color: '#a1a1aa', fontSize: '14px', lineHeight: '1.5' }}>
                  Could not find USD prices for {stats.missingPrices.length} token/date combinations.
                  This usually means the token had no trades within 7 days of the transaction.
                  These will have empty fiat values in the CSV - you may need to add prices manually.
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

        {/* Warning for approximate prices (time diff) */}
        {stats?.timeDiffList?.length > 0 && (
          <div className="responsive-warning-box" style={{
            padding: '16px 20px',
            background: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: '12px',
            marginBottom: '24px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }} className="responsive-warning-content">
              <svg className="responsive-warning-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <div>
                <div className="responsive-warning-title" style={{ fontWeight: '600', color: '#3b82f6', marginBottom: '4px' }}>
                  Approximate Prices
                </div>
                <div className="responsive-warning-text" style={{ color: '#a1a1aa', fontSize: '14px', lineHeight: '1.5' }}>
                  {stats.timeDiffCount} transactions use prices from trades that occurred hours away from the actual transaction.
                  These prices may not reflect the exact value at transaction time.
                </div>
                <details style={{ marginTop: '8px' }}>
                  <summary style={{ color: '#3b82f6', cursor: 'pointer', fontSize: '13px' }}>
                    Show approximate prices ({stats.timeDiffList.length})
                  </summary>
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#71717a', maxHeight: '120px', overflow: 'auto' }}>
                    {stats.timeDiffList.slice(0, 50).map((item, i) => (
                      <div key={i}>{item}</div>
                    ))}
                    {stats.timeDiffList.length > 50 && (
                      <div style={{ color: '#3b82f6' }}>...and {stats.timeDiffList.length - 50} more</div>
                    )}
                  </div>
                </details>
              </div>
            </div>
          </div>
        )}

        {/* Filter Buttons */}
        {stats && (
          <div style={styles.filterSection} className="responsive-filter-section">
            <div style={styles.filterLabel}>Filter by Type</div>
            <div style={styles.filterGroup} className="responsive-filter-group">
              <button
                onClick={() => { setFilter('all'); setCurrentPage(1); }}
                className="responsive-filter-button"
                style={{
                  ...styles.filterButton,
                  ...(filter === 'all' ? { background: 'rgba(79, 172, 254, 0.15)', border: '1px solid #F97316', color: '#F97316' } : {}),
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
                      className="responsive-filter-button"
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
          <div style={styles.downloadSection} className="responsive-download-section">
            <button onClick={downloadCSV} style={styles.downloadButton} className="responsive-download-button">
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
          <div style={{ ...styles.card, padding: 0, overflow: 'hidden' }} className="responsive-table-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid #27272a', flexWrap: 'wrap', gap: '16px' }} className="responsive-table-header">
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#fafafa' }} className="responsive-table-title">
                Transaction History
                <span style={{ marginLeft: '8px', color: '#52525b', fontWeight: '400' }}>
                  {filteredTxs.length.toLocaleString()} records
                </span>
              </h3>
              {totalPages > 1 && (
                <div style={styles.pagination} className="responsive-pagination">
                  <button
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    style={{ ...styles.pageButton, opacity: currentPage === 1 ? 0.3 : 1 }}
                    className="responsive-page-button"
                  >
                    First
                  </button>
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    style={{ ...styles.pageButton, opacity: currentPage === 1 ? 0.3 : 1 }}
                    className="responsive-page-button"
                  >
                    Prev
                  </button>
                  <span style={{ padding: '0 12px', color: '#52525b', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }} className="responsive-page-info">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    style={{ ...styles.pageButton, opacity: currentPage === totalPages ? 0.3 : 1 }}
                    className="responsive-page-button"
                  >
                    Next
                  </button>
                  <button
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                    style={{ ...styles.pageButton, opacity: currentPage === totalPages ? 0.3 : 1 }}
                    className="responsive-page-button"
                  >
                    Last
                  </button>
                </div>
              )}
            </div>

            {/* Desktop Table View */}
            <div style={{ overflowX: 'auto' }} className="responsive-table-wrapper">
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
                          {tx.receivedFiat && tx.priceTimeDiff && (
                            <span style={{ fontSize: '9px', color: '#f59e0b', marginLeft: '2px' }} title={`Price from ${tx.priceTimeDiff}h away`}>⏱{tx.priceTimeDiff}h</span>
                          )}
                          {tx.receivedFiat && !tx.priceTimeDiff && tx.priceSource?.includes('pyth') && (
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
                          {tx.sentFiat && tx.priceTimeDiff && (
                            <span style={{ fontSize: '9px', color: '#f59e0b', marginLeft: '2px' }} title={`Price from ${tx.priceTimeDiff}h away`}>⏱{tx.priceTimeDiff}h</span>
                          )}
                          {tx.sentFiat && !tx.priceTimeDiff && tx.priceSource?.includes('pyth') && (
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
                            href={`https://finder.kujira.network/kaiyo-1/tx/${tx.txHash}`}
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

            {/* Mobile Card View */}
            <div className="responsive-mobile-cards" style={{ padding: '12px' }}>
              {paginatedTxs.map((tx, i) => {
                const c = TAG_CONFIG[tx.tag] || TAG_CONFIG[''];
                const hasMissingPrice = tx.missingPrice;
                return (
                  <div
                    key={`mobile-${tx.txHash}-${i}`}
                    className={`mobile-tx-card${hasMissingPrice ? ' missing-price' : ''}`}
                  >
                    <div className="mobile-tx-header">
                      <div className="mobile-tx-date">{tx.dateFormatted}</div>
                      {tx.tag && (
                        <span className="mobile-tx-tag" style={{ background: c.bg, color: c.color }}>
                          {c.label}
                        </span>
                      )}
                    </div>
                    <div className="mobile-tx-body">
                      {tx.receivedQty && (
                        <div className="mobile-tx-row">
                          <span className="mobile-tx-label">Received</span>
                          <span className="mobile-tx-value received">
                            +{tx.receivedQty} {tx.receivedCurrency}
                            {tx.receivedFiat && <span style={{ color: '#71717a', marginLeft: '6px' }}>(${tx.receivedFiat})</span>}
                          </span>
                        </div>
                      )}
                      {tx.sentQty && (
                        <div className="mobile-tx-row">
                          <span className="mobile-tx-label">Sent</span>
                          <span className="mobile-tx-value sent">
                            -{tx.sentQty} {tx.sentCurrency}
                            {tx.sentFiat && <span style={{ color: '#71717a', marginLeft: '6px' }}>(${tx.sentFiat})</span>}
                          </span>
                        </div>
                      )}
                      {tx.feeAmount && (
                        <div className="mobile-tx-row">
                          <span className="mobile-tx-label">Fee</span>
                          <span className="mobile-tx-value fee">
                            {tx.feeAmount} {tx.feeCurrency}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="mobile-tx-notes">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tx.notes || '—'}
                      </span>
                      <a
                        href={`https://finder.kujira.network/kaiyo-1/tx/${tx.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mobile-tx-link"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" x2="21" y1="14" y2="3" />
                        </svg>
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty State */}
        {!loading && transactions.length === 0 && !error && (
          <div style={styles.emptyState} className="responsive-empty-state">
            <div style={styles.emptyIcon} className="responsive-empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px', color: '#fafafa' }} className="responsive-empty-title">
              No Transactions Yet
            </h3>
            <p style={{ color: '#52525b', margin: 0, fontSize: '15px', maxWidth: '320px', marginInline: 'auto' }} className="responsive-empty-text">
              Enter your Kujira wallet address above to fetch and export your transaction history
            </p>
          </div>
        )}

        {/* Footer */}
        <footer style={styles.footer} className="responsive-footer">
          <p style={{ color: '#52525b', margin: '0 0 8px', fontSize: '14px' }}>
            Built for{' '}
            <a
              href="https://awaken.tax"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#F97316', textDecoration: 'none' }}
            >
              Awaken Tax
            </a>
          </p>
          <p style={{ fontSize: '12px', color: '#3f3f46', margin: 0 }}>
            Prices from Pyth Network. Some tokens may not have price data available.
          </p>
          <p style={{ fontSize: '12px', color: '#3f3f46', margin: '4px 0 0' }}>
            This tool is not financial advice.
          </p>
        </footer>
      </div>

    </div>
  );
}
