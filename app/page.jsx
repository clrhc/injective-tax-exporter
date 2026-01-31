'use client';
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

const EXPLORER_API = '/api/transactions';
const PRICES_API = '/api/prices';
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json';
const TOKEN_CACHE_KEY = 'inj_token_cache_v2';
const PRICE_CACHE_KEY = 'inj_price_cache_v1';
const ITEMS_PER_PAGE = 25;

// ============================================================================
// PRICE CACHE - For historical prices
// ============================================================================
const priceCache = { data: {}, loaded: false };

function loadPriceCache() {
  if (priceCache.loaded) return;
  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(PRICE_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        // Use cache if less than 24 hours old
        if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
          priceCache.data = data;
        }
      }
    } catch (e) { /* ignore */ }
  }
  priceCache.loaded = true;
}

function savePriceCache() {
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({
      data: priceCache.data,
      timestamp: Date.now()
    }));
  } catch (e) { /* ignore */ }
}

async function fetchPricesBatch(requests, swapPrices = {}) {
  // Filter out already cached (including swap-derived prices)
  const uncached = requests.filter(r => {
    const key = `${r.token.toUpperCase()}-${r.date}`;
    return priceCache.data[key] === undefined;
  });

  if (uncached.length === 0) return;

  try {
    const response = await fetch(PRICES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: uncached,
        swapPrices: swapPrices // Pass swap-derived prices for the API to use as fallback
      }),
    });

    if (response.ok) {
      const data = await response.json();
      // Merge into cache
      Object.assign(priceCache.data, data.prices || {});
    }
  } catch (e) { /* ignore */ }
}

function getPrice(token, date) {
  const key = `${token.toUpperCase()}-${date}`;
  return priceCache.data[key] || 0;
}

// Extract prices from swap transactions by looking at paired amounts
// When someone swaps X of TokenA for Y of USDT, price of TokenA = Y/X
function extractSwapPrices(parsedTransactions, rawTransactions, walletAddress) {
  const swapPrices = {};
  const stables = ['USDT', 'USDC', 'DAI', 'BUSD', 'UST', 'FRAX'];

  // Build a map of txHash -> raw transaction for event parsing
  const txMap = {};
  for (const tx of rawTransactions) {
    const hash = tx.hash || tx.txHash || tx.id;
    if (hash) txMap[hash] = tx;
  }

  // Group parsed transactions by txHash to find paired swaps
  const txGroups = {};
  for (const tx of parsedTransactions) {
    if (!txGroups[tx.txHash]) txGroups[tx.txHash] = [];
    txGroups[tx.txHash].push(tx);
  }

  // Look for swap pairs (one positive, one negative amount in same tx)
  for (const [hash, txList] of Object.entries(txGroups)) {
    if (txList.length < 2) continue;

    const inflows = txList.filter(t => t.amount && !t.amount.startsWith('-') && t.asset);
    const outflows = txList.filter(t => t.amount && t.amount.startsWith('-') && t.asset);

    // If we have exactly one inflow and one outflow, it's likely a swap
    if (inflows.length === 1 && outflows.length === 1) {
      const inf = inflows[0];
      const out = outflows[0];
      const infAmt = parseFloat(inf.amount.replace(/,/g, '')) || 0;
      const outAmt = Math.abs(parseFloat(out.amount.replace(/,/g, '')) || 0);

      if (infAmt > 0 && outAmt > 0) {
        // If one side is a stablecoin, we can derive the price of the other
        if (stables.includes(inf.asset.toUpperCase())) {
          // Received stable, sent token: price of token = stableAmount / tokenAmount
          const price = infAmt / outAmt;
          const key = `${out.asset.toUpperCase()}-${out.dateStr}`;
          if (!swapPrices[key] || price > 0) {
            swapPrices[key] = price;
          }
        } else if (stables.includes(out.asset.toUpperCase())) {
          // Sent stable, received token: price of token = stableAmount / tokenAmount
          const price = outAmt / infAmt;
          const key = `${inf.asset.toUpperCase()}-${inf.dateStr}`;
          if (!swapPrices[key] || price > 0) {
            swapPrices[key] = price;
          }
        }
      }
    }
  }

  // Also try to parse events from raw transactions for more accurate data
  for (const rawTx of rawTransactions) {
    const events = rawTx.logs?.[0]?.events || rawTx.events || [];
    const hash = rawTx.hash || rawTx.txHash || rawTx.id;
    const timestamp = rawTx.blockTimestamp || rawTx.block_timestamp || rawTx.timestamp;
    if (!timestamp) continue;

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    for (const event of events) {
      // Look for trade execution events
      if (event.type === 'coin_received' || event.type === 'coin_spent' || event.type === 'transfer') {
        const attrs = event.attributes || [];
        const amountAttr = attrs.find(a => a.key === 'amount');
        if (amountAttr?.value) {
          // Parse amount like "1000000peggy0x..." or "500000inj"
          const match = amountAttr.value.match(/^(\d+)(.+)$/);
          if (match) {
            const rawAmount = match[1];
            const denom = match[2];
            const { symbol, decimals } = getTokenInfo(denom);
            const amount = parseFloat(rawAmount) / Math.pow(10, decimals);

            // Store for later cross-referencing
            // This helps when we see both sides of a trade in events
          }
        }
      }

      // Injective-specific spot trade events
      if (event.type === 'spot_trade' || event.type === 'derivative_trade') {
        const attrs = event.attributes || [];
        const getAttr = (key) => attrs.find(a => a.key === key)?.value;

        const price = parseFloat(getAttr('price') || '0');
        const quantity = parseFloat(getAttr('quantity') || '0');
        const baseDenom = getAttr('base_denom') || getAttr('base_currency');

        if (price > 0 && baseDenom) {
          const { symbol } = getTokenInfo(baseDenom);
          const key = `${symbol.toUpperCase()}-${dateStr}`;
          swapPrices[key] = price;
        }
      }
    }
  }

  return swapPrices;
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

// Helper: Extract all coin movements from transaction events
function extractCoinMovements(tx, walletAddress) {
  const movements = { received: [], spent: [] };
  const events = tx.logs?.[0]?.events || tx.events || [];
  const walletLower = walletAddress.toLowerCase();

  for (const event of events) {
    const attrs = event.attributes || [];
    const getAttr = (key) => attrs.find(a => a.key === key)?.value;

    if (event.type === 'coin_received') {
      const receiver = getAttr('receiver')?.toLowerCase();
      const amount = getAttr('amount');
      if (receiver?.includes(walletLower.slice(0, 10)) && amount) {
        const coins = amount.split(',');
        for (const c of coins) {
          const parsed = parseCoinFromString(c.trim());
          if (parsed) movements.received.push(parsed);
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
          if (parsed) movements.spent.push(parsed);
        }
      }
    }

    // Injective-specific transfer events
    if (event.type === 'transfer') {
      const recipient = getAttr('recipient')?.toLowerCase();
      const sender = getAttr('sender')?.toLowerCase();
      const amount = getAttr('amount');
      if (amount) {
        const coins = amount.split(',');
        for (const c of coins) {
          const parsed = parseCoinFromString(c.trim());
          if (parsed) {
            if (recipient?.includes(walletLower.slice(0, 10))) {
              movements.received.push(parsed);
            }
            if (sender?.includes(walletLower.slice(0, 10))) {
              movements.spent.push(parsed);
            }
          }
        }
      }
    }
  }

  return movements;
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

  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dateDisplay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeDisplay = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const txHash = tx.hash || tx.txHash || tx.id || '';

  // Parse fee
  const feeData = tx.gasFee?.amount?.[0] || tx.gas_fee?.amount?.[0] || tx.fee?.amount?.[0];
  const feeAmount = feeData ? formatAmount(feeData.amount, feeData.denom) : '';
  const feeCurrency = feeData ? getTokenInfo(feeData.denom).symbol : '';
  const feeRaw = feeData ? parseFloat(feeData.amount) / Math.pow(10, getTokenInfo(feeData.denom).decimals) : 0;

  // Extract coin movements from events (for trades)
  const movements = extractCoinMovements(tx, walletAddress);

  const messages = tx.messages || tx.data?.messages || tx.tx?.body?.messages || [];

  const baseTx = {
    dateStr,
    dateDisplay,
    timeDisplay,
    txHash,
    feeAmount,
    feeCurrency,
    feeRaw,
    asset: '',
    amount: '',
    pnl: '',
    pnlDisplay: '',
    notes: '',
    tag: '',
    isFailed: isFailed,
  };

  // For failed transactions, just return a gas fee entry
  if (isFailed) {
    const msgType = messages[0]?.['@type']?.split('.').pop() || messages[0]?.type?.split('.').pop() || 'Transaction';
    return [{
      ...baseTx,
      asset: feeCurrency || 'INJ',
      amount: feeAmount ? `-${feeAmount}` : '',
      tag: 'failed',
      notes: `Failed: ${msgType.replace('Msg', '')}`,
    }];
  }

  for (const msg of messages) {
    const type = msg['@type'] || msg.type || '';
    const value = msg.value || msg;
    const typeShort = type.split('.').pop() || type;

    // ========== BANK MODULE ==========
    if (typeShort === 'MsgSend') {
      const from = value.from_address || value.fromAddress || '';
      const to = value.to_address || value.toAddress || '';
      const amounts = value.amount || [];

      for (const coin of amounts) {
        const { symbol } = getTokenInfo(coin.denom);
        const qty = formatAmount(coin.amount, coin.denom);

        if (from.toLowerCase() === walletAddress.toLowerCase()) {
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${qty}`,
            tag: 'transfer',
            notes: `Send to ${to}`,
          });
        } else if (to.toLowerCase() === walletAddress.toLowerCase()) {
          results.push({
            ...baseTx,
            asset: symbol,
            amount: qty,
            feeAmount: '', // Receiver doesn't pay fee
            feeCurrency: '',
            tag: 'transfer',
            notes: `Receive from ${from}`,
          });
        }
      }
    }

    else if (typeShort === 'MsgMultiSend') {
      for (const input of (value.inputs || [])) {
        if (input.address?.toLowerCase() === walletAddress.toLowerCase()) {
          for (const coin of (input.coins || [])) {
            const { symbol } = getTokenInfo(coin.denom);
            results.push({
              ...baseTx,
              asset: symbol,
              amount: `-${formatAmount(coin.amount, coin.denom)}`,
              tag: 'transfer',
              notes: 'MultiSend out',
            });
          }
        }
      }
      for (const output of (value.outputs || [])) {
        if (output.address?.toLowerCase() === walletAddress.toLowerCase()) {
          for (const coin of (output.coins || [])) {
            const { symbol } = getTokenInfo(coin.denom);
            results.push({
              ...baseTx,
              asset: symbol,
              amount: formatAmount(coin.amount, coin.denom),
              feeAmount: '',
              feeCurrency: '',
              tag: 'transfer',
              notes: 'MultiSend in',
            });
          }
        }
      }
    }

    // ========== STAKING MODULE ==========
    else if (typeShort === 'MsgDelegate') {
      const amt = value.amount;
      if (amt) {
        const { symbol } = getTokenInfo(amt.denom);
        results.push({
          ...baseTx,
          asset: symbol,
          amount: `-${formatAmount(amt.amount, amt.denom)}`,
          tag: 'stake',
          notes: `Delegate to ${truncateValidator(value.validator_address || value.validatorAddress)}`,
        });
      }
    }

    else if (typeShort === 'MsgUndelegate') {
      const amt = value.amount;
      if (amt) {
        const { symbol } = getTokenInfo(amt.denom);
        results.push({
          ...baseTx,
          asset: symbol,
          amount: formatAmount(amt.amount, amt.denom),
          tag: 'unstake',
          notes: `Undelegate from ${truncateValidator(value.validator_address || value.validatorAddress)}`,
        });
      }
    }

    else if (typeShort === 'MsgBeginRedelegate') {
      const amt = value.amount;
      if (amt) {
        const { symbol } = getTokenInfo(amt.denom);
        results.push({
          ...baseTx,
          asset: symbol,
          amount: '0',
          tag: 'stake',
          notes: `Redelegate ${truncateValidator(value.validator_src_address)} → ${truncateValidator(value.validator_dst_address)}`,
        });
      }
    }

    else if (typeShort === 'MsgCancelUnbondingDelegation') {
      const amt = value.amount;
      if (amt) {
        const { symbol } = getTokenInfo(amt.denom);
        results.push({
          ...baseTx,
          asset: symbol,
          amount: `-${formatAmount(amt.amount, amt.denom)}`,
          tag: 'stake',
          notes: `Cancel unbonding from ${truncateValidator(value.validator_address)}`,
        });
      }
    }

    // ========== DISTRIBUTION MODULE ==========
    else if (typeShort === 'MsgWithdrawDelegatorReward') {
      // Extract reward amount from events
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'reward',
            notes: `Claim staking rewards from ${truncateValidator(value.validator_address || value.validatorAddress)}`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: 'INJ',
          amount: '',
          tag: 'reward',
          notes: `Claim staking rewards from ${truncateValidator(value.validator_address || value.validatorAddress)}`,
        });
      }
    }

    else if (typeShort === 'MsgWithdrawValidatorCommission') {
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'reward',
            notes: 'Withdraw validator commission',
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: 'INJ',
          amount: '',
          tag: 'reward',
          notes: 'Withdraw validator commission',
        });
      }
    }

    else if (typeShort === 'MsgSetWithdrawAddress') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Set withdraw address to ${truncateAddress(value.withdraw_address)}`,
      });
    }

    // ========== IBC MODULE ==========
    else if (typeShort === 'MsgTransfer') {
      const token = value.token;
      if (token) {
        const { symbol } = getTokenInfo(token.denom);
        const qty = formatAmount(token.amount, token.denom);
        const isSender = value.sender?.toLowerCase() === walletAddress.toLowerCase();

        results.push({
          ...baseTx,
          asset: symbol,
          amount: isSender ? `-${qty}` : qty,
          feeAmount: isSender ? feeAmount : '',
          feeCurrency: isSender ? feeCurrency : '',
          tag: 'transfer',
          notes: isSender
            ? `IBC transfer to ${truncateAddress(value.receiver)} via ${value.source_channel || 'channel'}`
            : `IBC receive from ${truncateAddress(value.sender)}`,
        });
      }
    }

    else if (typeShort === 'MsgRecvPacket' || typeShort === 'MsgAcknowledgement' || typeShort === 'MsgTimeout') {
      // IBC relayer messages - check if user received tokens
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'transfer',
            notes: `IBC ${typeShort.replace('Msg', '')} (received)`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: feeCurrency || 'INJ',
          amount: feeAmount ? `-${feeAmount}` : '0',
          tag: '',
          notes: `IBC ${typeShort.replace('Msg', '')}`,
        });
      }
    }

    // ========== EXCHANGE MODULE (Injective-specific) ==========
    else if (typeShort === 'MsgDeposit' && !value.proposal_id) {
      // Exchange deposit (not governance deposit)
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'transfer',
            notes: 'Deposit to trading account',
          });
        }
      } else {
        const amt = value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(amt.amount, amt.denom)}`,
            tag: 'transfer',
            notes: 'Deposit to trading account',
          });
        }
      }
    }

    else if (typeShort === 'MsgWithdraw') {
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'transfer',
            notes: 'Withdraw from trading account',
          });
        }
      } else {
        const amt = value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: formatAmount(amt.amount, amt.denom),
            tag: 'transfer',
            notes: 'Withdraw from trading account',
          });
        }
      }
    }

    else if (typeShort === 'MsgCreateSpotLimitOrder' || typeShort === 'MsgCreateSpotMarketOrder') {
      const order = value.order || value;
      const orderType = typeShort.includes('Limit') ? 'limit' : 'market';

      // Extract trade amounts from events
      // For spot orders: we spend one token and receive another
      if (movements.received.length > 0 || movements.spent.length > 0) {
        // Create entries for each side of the trade
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'swap',
            notes: `Spot ${orderType} sell`,
          });
        }
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            feeAmount: '', // Don't double-count fee
            feeCurrency: '',
            tag: 'swap',
            notes: `Spot ${orderType} buy`,
          });
        }
      } else {
        // Fallback if no events - order placed but may not have filled yet
        // This is NOT a taxable event - just a pending order
        results.push({
          ...baseTx,
          asset: feeCurrency || 'INJ',
          amount: feeAmount ? `-${feeAmount}` : '0',
          tag: 'order_placed',
          notes: `Spot ${orderType} order placed (pending)`,
        });
      }
    }

    else if (typeShort === 'MsgCancelSpotOrder') {
      // Check if there were any refunds from the cancellation
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'refund',
            notes: `Cancel spot order (refund)`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: '',
          notes: `Cancel spot order`,
        });
      }
    }

    else if (typeShort === 'MsgBatchCancelSpotOrders') {
      const count = value.data?.length || 'multiple';
      // Check for refunds
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'refund',
            notes: `Cancel ${count} spot orders (refund)`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: '',
          notes: `Cancel ${count} spot orders`,
        });
      }
    }

    else if (typeShort === 'MsgCreateDerivativeLimitOrder' || typeShort === 'MsgCreateDerivativeMarketOrder') {
      const order = value.order || value;
      const orderType = typeShort.includes('Limit') ? 'limit' : 'market';
      const margin = order.margin;

      // For derivatives, track margin movements
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'open_position',
            notes: `Derivative ${orderType} (margin)`,
          });
        }
      } else if (margin) {
        // Use margin from message if events not available
        const marginAmt = parseFloat(margin) / 1e18; // Assuming 18 decimals
        if (marginAmt > 0) {
          results.push({
            ...baseTx,
            asset: 'USDT',
            amount: `-${marginAmt.toFixed(2)}`,
            tag: 'open_position',
            notes: `Derivative ${orderType} order`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: 'USDT',
          tag: 'open_position',
          notes: `Derivative ${orderType} order`,
        });
      }

      // Check for any received amounts (realized PnL, funding, etc.)
      for (const coin of movements.received) {
        results.push({
          ...baseTx,
          asset: coin.symbol,
          amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
          feeAmount: '',
          feeCurrency: '',
          tag: 'close_position',
          notes: `Derivative settlement`,
        });
      }
    }

    else if (typeShort === 'MsgCancelDerivativeOrder') {
      // Check for margin refunds
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'refund',
            notes: `Cancel derivative order (refund)`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: 'close_position',
          notes: `Cancel derivative order`,
        });
      }
    }

    else if (typeShort === 'MsgBatchCancelDerivativeOrders') {
      const count = value.data?.length || 'multiple';
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'refund',
            notes: `Cancel ${count} derivative orders (refund)`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: 'close_position',
          notes: `Cancel ${count} derivative orders`,
        });
      }
    }

    else if (typeShort === 'MsgBatchUpdateOrders') {
      const spotCreates = value.spot_orders_to_create?.length || 0;
      const spotCancels = value.spot_orders_to_cancel?.length || 0;
      const derivCreates = value.derivative_orders_to_create?.length || 0;
      const derivCancels = value.derivative_orders_to_cancel?.length || 0;

      // Extract actual movements from batch
      if (movements.spent.length > 0 || movements.received.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'swap',
            notes: `Batch order sell`,
          });
        }
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            feeAmount: '',
            feeCurrency: '',
            tag: 'swap',
            notes: `Batch order buy`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: 'swap',
          notes: `Batch: +${spotCreates + derivCreates} -${spotCancels + derivCancels} orders`,
        });
      }
    }

    else if (typeShort === 'MsgLiquidatePosition') {
      // Extract any received amounts from liquidation
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'close_position',
            notes: `Position liquidated (remaining margin)`,
          });
        }
      } else if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'close_position',
            notes: `Position liquidated (loss)`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: 'close_position',
          notes: `Position liquidated`,
        });
      }
    }

    // Try to extract realized PnL from position settlements
    else if (typeShort === 'MsgExternalTransfer' || typeShort === 'MsgSubaccountTransfer') {
      const amt = value.amount;
      if (amt) {
        const { symbol } = getTokenInfo(amt.denom);
        const qty = formatAmount(amt.amount, amt.denom);
        // Positive transfers to main account from subaccount could be realized profits
        results.push({
          ...baseTx,
          asset: symbol,
          amount: qty,
          tag: 'transfer',
          notes: 'Subaccount transfer',
        });
      }
    }

    else if (typeShort === 'MsgIncreasePositionMargin') {
      // Check movements first
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'open_position',
            notes: `Add margin`,
          });
        }
      } else {
        const amt = value.amount;
        results.push({
          ...baseTx,
          asset: 'USDT',
          amount: amt ? `-${formatAmount(amt, 'peggy0xdac17f958d2ee523a2206206994597c13d831ec7')}` : '',
          tag: 'open_position',
          notes: `Add margin`,
        });
      }
    }

    else if (typeShort === 'MsgDecreasePositionMargin') {
      // Check movements first
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'close_position',
            notes: `Remove margin`,
          });
        }
      } else {
        const amt = value.amount;
        results.push({
          ...baseTx,
          asset: 'USDT',
          amount: amt ? formatAmount(amt, 'peggy0xdac17f958d2ee523a2206206994597c13d831ec7') : '',
          tag: 'close_position',
          notes: `Remove margin`,
        });
      }
    }

    else if (typeShort === 'MsgInstantSpotMarketLaunch' || typeShort === 'MsgInstantPerpetualMarketLaunch') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Launch market ${value.ticker || ''}`,
      });
    }

    // ========== AUCTION MODULE ==========
    else if (typeShort === 'MsgBid') {
      // Record spent bid amount
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'swap',
            notes: `Auction bid round ${value.round || ''}`,
          });
        }
      } else {
        const amt = value.bid_amount || value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(amt.amount, amt.denom)}`,
            tag: 'swap',
            notes: `Auction bid round ${value.round || ''}`,
          });
        }
      }
      // Record any received tokens from winning auction
      for (const coin of movements.received) {
        results.push({
          ...baseTx,
          asset: coin.symbol,
          amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
          feeAmount: '',
          feeCurrency: '',
          tag: 'swap',
          notes: `Auction win round ${value.round || ''}`,
        });
      }
    }

    // ========== INSURANCE MODULE ==========
    else if (typeShort === 'MsgUnderwrite') {
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'stake',
            notes: 'Insurance fund underwrite',
          });
        }
      } else {
        const amt = value.deposit || value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(amt.amount, amt.denom)}`,
            tag: 'stake',
            notes: 'Insurance fund underwrite',
          });
        }
      }
    }

    else if (typeShort === 'MsgRequestRedemption') {
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'unstake',
            notes: 'Insurance fund redemption',
          });
        }
      } else {
        const amt = value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: formatAmount(amt.amount, amt.denom),
            tag: 'unstake',
            notes: 'Insurance fund redemption',
          });
        }
      }
    }

    // ========== PEGGY (Bridge) MODULE ==========
    else if (typeShort === 'MsgSendToEth') {
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'bridge_out',
            notes: `Bridge to Ethereum ${truncateAddress(value.eth_dest)}`,
          });
        }
      } else {
        const amt = value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(amt.amount, amt.denom)}`,
            tag: 'bridge_out',
            notes: `Bridge to Ethereum ${truncateAddress(value.eth_dest)}`,
          });
        }
      }
    }

    else if (typeShort === 'MsgDepositClaim') {
      // Bridge deposit from Ethereum - check for received tokens
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'bridge_in',
            notes: `Bridge from Ethereum`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          tag: 'bridge_in',
          notes: `Bridge deposit claim`,
        });
      }
    }

    else if (typeShort === 'MsgConfirmBatch' || typeShort === 'MsgValsetConfirm') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Peggy ${typeShort.replace('Msg', '')}`,
      });
    }

    // ========== WASM MODULE ==========
    else if (typeShort === 'MsgExecuteContract' || typeShort === 'MsgExecuteContractCompat') {
      const contract = value.contract || value.contractAddress || '';
      let action = 'execute';

      try {
        const msgData = typeof value.msg === 'string' ? JSON.parse(value.msg) : value.msg;
        if (msgData) {
          action = Object.keys(msgData)[0] || 'execute';
        }
      } catch (e) { /* ignore */ }

      // Check if this looks like a swap (has both spent and received)
      const isSwapLike = movements.spent.length > 0 && movements.received.length > 0;
      const swapActions = ['swap', 'execute_swap_operations', 'swap_exact_for', 'swap_for_exact', 'provide_liquidity', 'withdraw_liquidity'];
      const isSwapAction = swapActions.some(s => action.toLowerCase().includes(s));

      if (isSwapLike || isSwapAction) {
        // This is a swap - record both sides
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'swap',
            notes: `${action} (sell)`,
          });
        }
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            feeAmount: '',
            feeCurrency: '',
            tag: 'swap',
            notes: `${action} (buy)`,
          });
        }
      } else if (movements.spent.length > 0 || movements.received.length > 0) {
        // Has movements but not a swap - record each movement
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'contract_interaction',
            notes: `${action}`,
          });
        }
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            feeAmount: '',
            feeCurrency: '',
            tag: 'contract_interaction',
            notes: `${action}`,
          });
        }
      } else {
        // Fallback to funds from message
        const funds = Array.isArray(value.funds) ? value.funds : [];
        if (funds.length > 0 && funds[0]) {
          const { symbol } = getTokenInfo(funds[0].denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(funds[0].amount, funds[0].denom)}`,
            tag: 'contract_interaction',
            notes: `${action}`,
          });
        } else {
          // No movements or funds - still record with gas fee as the cost
          results.push({
            ...baseTx,
            asset: feeCurrency || 'INJ',
            amount: feeAmount ? `-${feeAmount}` : '0',
            tag: 'contract_interaction',
            notes: `${action}`,
          });
        }
      }
    }

    else if (typeShort === 'MsgInstantiateContract' || typeShort === 'MsgInstantiateContract2') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: 'contract_interaction',
        notes: `Instantiate contract (code ${value.code_id || ''})`,
      });
    }

    else if (typeShort === 'MsgMigrateContract') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: 'contract_interaction',
        notes: `Migrate contract ${truncateAddress(value.contract)}`,
      });
    }

    else if (typeShort === 'MsgStoreCode') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: 'contract_interaction',
        notes: 'Store contract code',
      });
    }

    // ========== GOVERNANCE MODULE ==========
    else if (typeShort === 'MsgVote') {
      const optionMap = { 1: 'Yes', 2: 'Abstain', 3: 'No', 4: 'NoWithVeto' };
      const option = optionMap[value.option] || value.option || '';
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Vote ${option} on proposal #${value.proposal_id || value.proposalId || ''}`,
      });
    }

    else if (typeShort === 'MsgVoteWeighted') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Weighted vote on proposal #${value.proposal_id || value.proposalId || ''}`,
      });
    }

    else if (typeShort === 'MsgDeposit' && value.proposal_id) {
      const amounts = value.amount || [];
      if (amounts.length > 0) {
        for (const coin of amounts) {
          const { symbol } = getTokenInfo(coin.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(coin.amount, coin.denom)}`,
            tag: '',
            notes: `Deposit to proposal #${value.proposal_id}`,
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: feeCurrency || 'INJ',
          amount: feeAmount ? `-${feeAmount}` : '0',
          tag: '',
          notes: `Deposit to proposal #${value.proposal_id}`,
        });
      }
    }

    else if (typeShort === 'MsgSubmitProposal') {
      const deposit = value.initial_deposit?.[0];
      if (deposit) {
        const { symbol } = getTokenInfo(deposit.denom);
        results.push({
          ...baseTx,
          asset: symbol,
          amount: `-${formatAmount(deposit.amount, deposit.denom)}`,
          tag: '',
          notes: 'Submit governance proposal',
        });
      } else {
        results.push({
          ...baseTx,
          asset: feeCurrency || 'INJ',
          amount: feeAmount ? `-${feeAmount}` : '0',
          tag: '',
          notes: 'Submit governance proposal',
        });
      }
    }

    // ========== AUTHZ MODULE ==========
    else if (typeShort === 'MsgGrant') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Grant authorization to ${truncateAddress(value.grantee)}`,
      });
    }

    else if (typeShort === 'MsgRevoke') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Revoke authorization from ${truncateAddress(value.grantee)}`,
      });
    }

    else if (typeShort === 'MsgExec') {
      // Authz execution - extract actual movements
      if (movements.spent.length > 0 || movements.received.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: 'transfer',
            notes: 'Authz execute (out)',
          });
        }
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            feeAmount: '',
            feeCurrency: '',
            tag: 'transfer',
            notes: 'Authz execute (in)',
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: feeCurrency || 'INJ',
          amount: feeAmount ? `-${feeAmount}` : '0',
          tag: '',
          notes: 'Execute authorized message',
        });
      }
    }

    // ========== TOKEN FACTORY MODULE ==========
    else if (typeShort === 'MsgCreateDenom') {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: `Create token ${value.subdenom || ''}`,
      });
    }

    else if (typeShort === 'MsgMint') {
      if (movements.received.length > 0) {
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            tag: 'reward',
            notes: 'Mint tokens',
          });
        }
      } else {
        const amt = value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: formatAmount(amt.amount, amt.denom),
            tag: 'reward',
            notes: 'Mint tokens',
          });
        } else {
          results.push({
            ...baseTx,
            asset: feeCurrency || 'INJ',
            amount: feeAmount ? `-${feeAmount}` : '0',
            tag: 'reward',
            notes: 'Mint tokens',
          });
        }
      }
    }

    else if (typeShort === 'MsgBurn') {
      if (movements.spent.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: '',
            notes: 'Burn tokens',
          });
        }
      } else {
        const amt = value.amount;
        if (amt) {
          const { symbol } = getTokenInfo(amt.denom);
          results.push({
            ...baseTx,
            asset: symbol,
            amount: `-${formatAmount(amt.amount, amt.denom)}`,
            tag: '',
            notes: 'Burn tokens',
          });
        } else {
          results.push({
            ...baseTx,
            asset: feeCurrency || 'INJ',
            amount: feeAmount ? `-${feeAmount}` : '0',
            tag: '',
            notes: 'Burn tokens',
          });
        }
      }
    }

    // ========== FALLBACK ==========
    else if (typeShort.startsWith('Msg')) {
      // Check for any token movements in unknown message types
      if (movements.spent.length > 0 || movements.received.length > 0) {
        for (const coin of movements.spent) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
            tag: '',
            notes: typeShort.replace('Msg', ''),
          });
        }
        for (const coin of movements.received) {
          results.push({
            ...baseTx,
            asset: coin.symbol,
            amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
            feeAmount: '',
            feeCurrency: '',
            tag: '',
            notes: typeShort.replace('Msg', ''),
          });
        }
      } else {
        results.push({
          ...baseTx,
          asset: feeCurrency || 'INJ',
          amount: feeAmount ? `-${feeAmount}` : '0',
          tag: '',
          notes: typeShort.replace('Msg', ''),
        });
      }
    }
  }

  // If no messages were parsed but tx exists, check for movements
  if (results.length === 0 && messages.length > 0) {
    if (movements.spent.length > 0 || movements.received.length > 0) {
      for (const coin of movements.spent) {
        results.push({
          ...baseTx,
          asset: coin.symbol,
          amount: `-${coin.amount.toFixed(6).replace(/\.?0+$/, '')}`,
          tag: '',
          notes: 'Transaction',
        });
      }
      for (const coin of movements.received) {
        results.push({
          ...baseTx,
          asset: coin.symbol,
          amount: coin.amount.toFixed(6).replace(/\.?0+$/, ''),
          feeAmount: '',
          feeCurrency: '',
          tag: '',
          notes: 'Transaction',
        });
      }
    } else {
      results.push({
        ...baseTx,
        asset: feeCurrency || 'INJ',
        amount: feeAmount ? `-${feeAmount}` : '0',
        tag: '',
        notes: 'Transaction',
      });
    }
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
// ============================================================================
function generateCSV(transactions) {
  const headers = ['Date', 'Asset', 'Amount', 'Fee', 'P&L', 'Payment Token', 'ID', 'Notes', 'Tag', 'Transaction Hash'];

  const rows = transactions.map((tx, idx) => [
    tx.dateStr,
    tx.asset,
    tx.amount,
    tx.feeAmount,
    tx.pnl || '',
    tx.feeCurrency,
    `TXN${String(idx + 1).padStart(5, '0')}`,
    tx.notes,
    tx.tag,
    tx.txHash,
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
// TAG CONFIGURATION
// ============================================================================
const TAG_CONFIG = {
  'transfer': { bg: 'rgba(59, 130, 246, 0.12)', color: '#60a5fa', label: 'Transfer' },
  'stake': { bg: 'rgba(139, 92, 246, 0.12)', color: '#a78bfa', label: 'Stake' },
  'unstake': { bg: 'rgba(139, 92, 246, 0.12)', color: '#c4b5fd', label: 'Unstake' },
  'reward': { bg: 'rgba(34, 197, 94, 0.12)', color: '#4ade80', label: 'Reward' },
  'swap': { bg: 'rgba(234, 179, 8, 0.12)', color: '#fbbf24', label: 'Trade' },
  'open_position': { bg: 'rgba(34, 197, 94, 0.12)', color: '#4ade80', label: 'Open Position' },
  'close_position': { bg: 'rgba(239, 68, 68, 0.12)', color: '#f87171', label: 'Close Position' },
  'contract_interaction': { bg: 'rgba(236, 72, 153, 0.12)', color: '#f472b6', label: 'Contract' },
  'bridge_out': { bg: 'rgba(99, 102, 241, 0.12)', color: '#818cf8', label: 'Bridge' },
  'bridge_in': { bg: 'rgba(99, 102, 241, 0.12)', color: '#818cf8', label: 'Bridge' },
  'failed': { bg: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', label: 'Failed' },
  'gas': { bg: 'rgba(251, 146, 60, 0.12)', color: '#fb923c', label: 'Gas Fee' },
  'refund': { bg: 'rgba(156, 163, 175, 0.12)', color: '#9ca3af', label: 'Refund' },
  'order_placed': { bg: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24', label: 'Order' },
  '': { bg: 'rgba(107, 114, 128, 0.12)', color: '#71717a', label: 'Other' },
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
  const [calculatePnl, setCalculatePnl] = useState(true);
  const [includeGasDeductible, setIncludeGasDeductible] = useState(false);
  // Transaction type filters - all enabled by default
  const [txTypeFilters, setTxTypeFilters] = useState({
    transfer: true,
    swap: true,
    stake: true,
    unstake: true,
    reward: true,
    open_position: true,
    close_position: true,
    contract_interaction: true,
    bridge_out: true,
    bridge_in: true,
    refund: true,
    order_placed: true,
    failed: true,
    other: true, // For empty tags
  });
  const cancelRef = useRef(false);

  const toggleTxType = (type) => {
    setTxTypeFilters(prev => ({ ...prev, [type]: !prev[type] }));
  };

  const toggleAllTxTypes = (value) => {
    setTxTypeFilters({
      transfer: value,
      swap: value,
      stake: value,
      unstake: value,
      reward: value,
      open_position: value,
      close_position: value,
      contract_interaction: value,
      bridge_out: value,
      bridge_in: value,
      failed: value,
      other: value,
    });
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
            const parsed = parseTransaction(tx, trimmedAddress, includeGasDeductible);
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

      // Calculate P&L if enabled
      if (calculatePnl && filteredTxs.length > 0) {
        setProgress({ current: filteredTxs.length, total: filteredTxs.length, status: 'Extracting swap prices...' });

        // Load price cache
        loadPriceCache();

        // Extract prices from swap transactions first
        // This gives us accurate on-chain prices before falling back to external APIs
        const swapDerivedPrices = extractSwapPrices(allTxs, rawTxs, trimmedAddress);
        const swapPriceCount = Object.keys(swapDerivedPrices).length;
        if (swapPriceCount > 0) {
          setProgress(p => ({ ...p, status: `Found ${swapPriceCount} prices from swaps...` }));
          // Add swap-derived prices to cache
          Object.assign(priceCache.data, swapDerivedPrices);
        }

        // Calculate P&L using FIFO cost basis
        const costTracker = new CostBasisTracker();

        // Collect unique token/date combinations for price fetching
        const priceRequests = [];
        const seen = new Set();
        for (const tx of filteredTxs) {
          if (tx.asset && tx.amount) {
            const key = `${tx.asset}|${tx.dateStr}`;
            if (!seen.has(key)) {
              seen.add(key);
              priceRequests.push({ token: tx.asset, date: tx.dateStr });
            }
          }
          // Also fetch prices for gas fees if gas deductible is enabled
          if (includeGasDeductible && tx.feeCurrency && tx.feeRaw > 0) {
            const key = `${tx.feeCurrency}|${tx.dateStr}`;
            if (!seen.has(key)) {
              seen.add(key);
              priceRequests.push({ token: tx.feeCurrency, date: tx.dateStr });
            }
          }
        }

        // Fetch prices in batches using POST endpoint (DeFiLlama - no rate limits)
        // Swap-derived prices are already in cache, so we only fetch missing ones
        setProgress(p => ({ ...p, status: `Fetching ${priceRequests.length} prices...` }));

        // Batch into groups of 50 for efficiency
        for (let i = 0; i < priceRequests.length; i += 50) {
          if (cancelRef.current) break;
          const batch = priceRequests.slice(i, i + 50);
          await fetchPricesBatch(batch, swapDerivedPrices);
          setProgress(p => ({ ...p, status: `Fetching prices... ${Math.min(100, Math.round(((i + 50) / priceRequests.length) * 100))}%` }));
        }

        // Save price cache
        savePriceCache();

        // Process transactions for P&L
        // Calculate P&L for ALL transactions
        const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'UST', 'FRAX', 'LUSD', 'TUSD'];

        for (const tx of filteredTxs) {
          const amount = tx.amount ? (parseFloat(tx.amount.replace(/,/g, '')) || 0) : 0;
          const price = tx.asset ? getPrice(tx.asset, tx.dateStr) : 0;
          const isStablecoin = tx.asset && stablecoins.includes(tx.asset.toUpperCase());

          // Calculate gas cost in USD for this transaction
          const gasPrice = tx.feeCurrency ? getPrice(tx.feeCurrency, tx.dateStr) : 0;
          const gasCostUsd = (tx.feeRaw || 0) * gasPrice;

          // Refunds: returning tokens you already owned - P&L = $0
          // Don't add to cost basis since you already had these tokens
          if (tx.tag === 'refund') {
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'stake') {
            // Staking is NOT a sale - you still own the tokens, just locked
            // P&L = $0 for tax purposes
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'unstake') {
            // Unstaking returns your own tokens - NOT income
            // P&L = $0 for tax purposes
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'order_placed') {
            // Order placed but not filled - NOT a taxable event yet
            // P&L = $0 until the order actually executes
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'open_position' && amount < 0) {
            // Posting margin for derivatives - NOT a sale, just collateral
            // P&L = $0 (the actual P&L comes when position is closed)
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'bridge_out' || tx.tag === 'bridge_in') {
            // Bridging tokens between chains - still your tokens, NOT taxable
            // P&L = $0
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'transfer' && amount < 0) {
            // Outgoing transfer - could be gift/payment, but not a "sale"
            // P&L = $0 (user should manually categorize if it's a taxable disposal)
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'swap' && amount > 0) {
            // Buy side of a swap - NOT income, you're acquiring tokens in exchange
            // Just track cost basis, P&L = $0 (the P&L is on the sell side)
            costTracker.addLot(tx.asset, amount, price, tx.dateStr);
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (tx.tag === 'close_position' && amount > 0) {
            // Derivative settlement - receiving margin back +/- P&L
            // Without tracking original margin, we can't calculate actual P&L
            // Show $0 - user should review derivative trades manually
            costTracker.addLot(tx.asset, amount, price, tx.dateStr);
            tx.pnl = '0.00';
            tx.pnlDisplay = '$0.00';
          } else if (amount > 0 && tx.asset) {
            // Incoming tokens (rewards, airdrops, etc.) - show USD value as income
            costTracker.addLot(tx.asset, amount, price, tx.dateStr);
            const usdValue = amount * price;
            // For stablecoins, value is just the amount
            const displayValue = isStablecoin ? amount : usdValue;
            tx.pnl = displayValue.toFixed(2);
            tx.pnlDisplay = `+${displayValue.toFixed(2)}`;
          } else if (amount < 0 && tx.asset) {
            // Outgoing tokens
            const absAmount = Math.abs(amount);

            if (isStablecoin) {
              // Stablecoins: P&L is essentially 0 (selling $1 for $1)
              // But we still track it for cost basis
              costTracker.sellFIFO(tx.asset, amount, price);
              tx.pnl = '0.00';
              tx.pnlDisplay = '$0.00';
            } else {
              // Non-stablecoin: calculate realized P&L
              const { realizedPnl, costBasis } = costTracker.sellFIFO(tx.asset, amount, price);

              if (realizedPnl !== null) {
                // Have cost basis - show actual P&L
                tx.pnl = realizedPnl.toFixed(2);
                tx.pnlDisplay = realizedPnl >= 0 ? `+${realizedPnl.toFixed(2)}` : realizedPnl.toFixed(2);
              } else {
                // No cost basis - assume acquired at current price (P&L = 0)
                // This is conservative; we can't know actual gain/loss without acquisition data
                tx.pnl = '0.00';
                tx.pnlDisplay = '0.00';
              }
            }
          } else if (tx.tag === 'failed' || (!amount && gasCostUsd > 0)) {
            // Failed tx or transaction with only gas - show gas cost
            if (gasCostUsd > 0) {
              tx.pnl = (-gasCostUsd).toFixed(2);
              tx.pnlDisplay = `-${gasCostUsd.toFixed(2)}`;
            } else {
              tx.pnl = '0.00';
              tx.pnlDisplay = '0.00';
            }
          } else {
            // Any other transaction - show 0
            tx.pnl = '0.00';
            tx.pnlDisplay = '0.00';
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
      let totalGasUsd = 0;
      finalTxs.forEach(tx => {
        const tag = tx.tag || '';
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;

        // Track gas fees in USD
        if (includeGasDeductible && tx.feeRaw > 0 && tx.feeCurrency) {
          const gasPrice = getPrice(tx.feeCurrency, tx.dateStr);
          totalGasUsd += tx.feeRaw * gasPrice;
        }
        if (tx.pnl) {
          totalPnl += parseFloat(tx.pnl) || 0;
        }
      });

      setStats({ total: finalTxs.length, tagCounts, uniqueTxs: seenHashes.size, totalPnl, totalGasUsd });
      setShowSuccess(true);

    } catch (err) {
      setError(err.message || 'Failed to fetch transactions');
    } finally {
      setLoading(false);
    }
  }, [address, startDate, endDate, calculatePnl, includeGasDeductible, txTypeFilters]);

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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: '#a1a1aa' }}>
                <input
                  type="checkbox"
                  checked={calculatePnl}
                  onChange={e => setCalculatePnl(e.target.checked)}
                  disabled={loading}
                  style={{ width: '16px', height: '16px', accentColor: '#4facfe' }}
                />
                Calculate P&L (FIFO)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: '#a1a1aa', marginLeft: '16px' }}>
                <input
                  type="checkbox"
                  checked={includeGasDeductible}
                  onChange={e => setIncludeGasDeductible(e.target.checked)}
                  disabled={loading}
                  style={{ width: '16px', height: '16px', accentColor: '#fb923c' }}
                />
                Gas as Deductible
              </label>
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
                { key: 'transfer', label: 'Transfers', color: '#60a5fa' },
                { key: 'swap', label: 'Trades', color: '#fbbf24' },
                { key: 'stake', label: 'Stake', color: '#a78bfa' },
                { key: 'unstake', label: 'Unstake', color: '#c4b5fd' },
                { key: 'reward', label: 'Rewards', color: '#4ade80' },
                { key: 'open_position', label: 'Open Position', color: '#4ade80' },
                { key: 'close_position', label: 'Close Position', color: '#f87171' },
                { key: 'contract_interaction', label: 'Contracts', color: '#f472b6' },
                { key: 'bridge_out', label: 'Bridge Out', color: '#818cf8' },
                { key: 'bridge_in', label: 'Bridge In', color: '#818cf8' },
                { key: 'failed', label: 'Failed', color: '#ef4444' },
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
              <div style={{ ...styles.statValue, color: '#60a5fa' }}>{stats.tagCounts['transfer'] || 0}</div>
              <div style={styles.statLabel}>Transfers</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#fbbf24' }}>{stats.tagCounts['swap'] || 0}</div>
              <div style={styles.statLabel}>Trades</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#4ade80' }}>{(stats.tagCounts['stake'] || 0) + (stats.tagCounts['unstake'] || 0)}</div>
              <div style={styles.statLabel}>Staking</div>
            </div>
            <div style={styles.statCard}>
              <div style={{ ...styles.statValue, color: '#f472b6' }}>{stats.tagCounts['contract_interaction'] || 0}</div>
              <div style={styles.statLabel}>Contracts</div>
            </div>
            {stats.tagCounts['failed'] > 0 && (
              <div style={styles.statCard}>
                <div style={{ ...styles.statValue, color: '#ef4444' }}>{stats.tagCounts['failed']}</div>
                <div style={styles.statLabel}>Failed Txs</div>
              </div>
            )}
            {stats.totalGasUsd > 0 && (
              <div style={styles.statCard}>
                <div style={{ ...styles.statValue, color: '#fb923c' }}>
                  ${stats.totalGasUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={styles.statLabel}>Total Gas (USD)</div>
              </div>
            )}
            {stats.totalPnl !== undefined && stats.totalPnl !== 0 && (
              <div style={styles.statCard}>
                <div style={{ ...styles.statValue, color: stats.totalPnl >= 0 ? '#4ade80' : '#f87171' }}>
                  {stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={styles.statLabel}>Est. P&L (USD)</div>
              </div>
            )}
            {stats.totalGasUsd > 0 && stats.totalPnl !== undefined && (
              <div style={styles.statCard}>
                <div style={{ ...styles.statValue, color: (stats.totalPnl - stats.totalGasUsd) >= 0 ? '#4ade80' : '#f87171' }}>
                  {(stats.totalPnl - stats.totalGasUsd) >= 0 ? '+' : ''}{(stats.totalPnl - stats.totalGasUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={styles.statLabel}>Net (P&L - Gas)</div>
              </div>
            )}
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
                  ...(filter === 'all' ? { background: 'rgba(79, 172, 254, 0.15)', borderColor: '#4facfe', color: '#4facfe' } : {}),
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
                        ...(isActive ? { background: c.bg, borderColor: c.color, color: c.color } : {}),
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
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Date</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Asset</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Fee</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>P&L</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Type</th>
                    <th style={{ ...styles.th, textAlign: 'left' }}>Notes</th>
                    <th style={{ ...styles.th, textAlign: 'center', width: '56px' }}>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTxs.map((tx, i) => {
                    const c = TAG_CONFIG[tx.tag] || TAG_CONFIG[''];
                    const isPositive = tx.amount && !tx.amount.startsWith('-');
                    const isNegative = tx.amount && tx.amount.startsWith('-');
                    return (
                      <tr key={`${tx.txHash}-${i}`}>
                        <td style={styles.td}>
                          <div style={{ fontWeight: '500', color: '#fafafa' }}>{tx.dateDisplay}</div>
                          <div style={{ fontSize: '12px', color: '#52525b', marginTop: '2px' }}>{tx.timeDisplay}</div>
                        </td>
                        <td style={{ ...styles.td, fontWeight: '600', color: '#fafafa' }}>
                          {tx.asset || '—'}
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          fontWeight: '500',
                          color: isPositive ? '#4ade80' : isNegative ? '#f87171' : '#52525b',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {tx.amount || '—'}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'right', color: '#52525b', fontSize: '13px' }}>
                          {tx.feeAmount ? `${tx.feeAmount} ${tx.feeCurrency}` : '—'}
                        </td>
                        <td style={{
                          ...styles.td,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          fontWeight: '500',
                          color: tx.pnl ? (parseFloat(tx.pnl) > 0 ? '#4ade80' : parseFloat(tx.pnl) < 0 ? '#f87171' : '#52525b') : '#3f3f46',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {(() => {
                            if (!tx.pnl) return '—';
                            const pnlNum = parseFloat(tx.pnl);
                            if (Math.abs(pnlNum) < 0.01 && pnlNum !== 0) {
                              return pnlNum > 0 ? '<+$0.01' : '<-$0.01';
                            }
                            return tx.pnlDisplay ? `$${tx.pnlDisplay}` : `$${tx.pnl}`;
                          })()}
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
                        <td style={{ ...styles.td, color: '#71717a', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tx.notes}>
                          {tx.notes || '—'}
                        </td>
                        <td style={{ ...styles.td, textAlign: 'center' }}>
                          <a
                            href={`https://explorer.injective.network/transaction/${tx.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={styles.link}
                            title="View on Explorer"
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
            P&L calculated using FIFO cost basis. All data sourced from Injective APIs.
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
