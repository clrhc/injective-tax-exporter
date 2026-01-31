'use client';
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';

const EXPLORER_API = '/api/transactions';
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json';
const TOKEN_CACHE_KEY = 'inj_token_cache_v2';
const ITEMS_PER_PAGE = 25;

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
function parseTransaction(tx, walletAddress) {
  // Skip failed transactions
  if (tx.code && tx.code !== 0) return [];
  if (tx.txCode && tx.txCode !== 0) return [];
  if (tx.errorLog || tx.error_log) return [];

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

  const messages = tx.messages || tx.data?.messages || tx.tx?.body?.messages || [];

  const baseTx = {
    dateStr,
    dateDisplay,
    timeDisplay,
    txHash,
    feeAmount,
    feeCurrency,
    asset: '',
    amount: '',
    pnl: '',
    notes: '',
    tag: '',
  };

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
      results.push({
        ...baseTx,
        asset: 'INJ',
        amount: '', // Amount comes from events, not always in message
        tag: 'reward',
        notes: `Claim staking rewards from ${truncateValidator(value.validator_address || value.validatorAddress)}`,
      });
    }

    else if (typeShort === 'MsgWithdrawValidatorCommission') {
      results.push({
        ...baseTx,
        asset: 'INJ',
        amount: '',
        tag: 'reward',
        notes: 'Withdraw validator commission',
      });
    }

    else if (typeShort === 'MsgSetWithdrawAddress') {
      results.push({
        ...baseTx,
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
      // These are relayer messages, usually not directly relevant to user
      // but we log them for completeness
      results.push({
        ...baseTx,
        tag: '',
        notes: `IBC ${typeShort.replace('Msg', '')}`,
      });
    }

    // ========== EXCHANGE MODULE (Injective-specific) ==========
    else if (typeShort === 'MsgDeposit') {
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

    else if (typeShort === 'MsgWithdraw') {
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

    else if (typeShort === 'MsgCreateSpotLimitOrder') {
      const order = value.order || value;
      results.push({
        ...baseTx,
        tag: 'swap',
        notes: `Spot limit order on ${truncateMarketId(order.market_id)}`,
      });
    }

    else if (typeShort === 'MsgCreateSpotMarketOrder') {
      const order = value.order || value;
      results.push({
        ...baseTx,
        tag: 'swap',
        notes: `Spot market order on ${truncateMarketId(order.market_id)}`,
      });
    }

    else if (typeShort === 'MsgCancelSpotOrder') {
      results.push({
        ...baseTx,
        tag: '',
        notes: `Cancel spot order on ${truncateMarketId(value.market_id)}`,
      });
    }

    else if (typeShort === 'MsgBatchCancelSpotOrders') {
      const count = value.data?.length || 'multiple';
      results.push({
        ...baseTx,
        tag: '',
        notes: `Cancel ${count} spot orders`,
      });
    }

    else if (typeShort === 'MsgCreateDerivativeLimitOrder') {
      const order = value.order || value;
      results.push({
        ...baseTx,
        asset: 'USDT',
        tag: 'open_position',
        notes: `Derivative limit order on ${truncateMarketId(order.market_id)}`,
      });
    }

    else if (typeShort === 'MsgCreateDerivativeMarketOrder') {
      const order = value.order || value;
      results.push({
        ...baseTx,
        asset: 'USDT',
        tag: 'open_position',
        notes: `Derivative market order on ${truncateMarketId(order.market_id)}`,
      });
    }

    else if (typeShort === 'MsgCancelDerivativeOrder') {
      results.push({
        ...baseTx,
        tag: 'close_position',
        notes: `Cancel derivative order on ${truncateMarketId(value.market_id)}`,
      });
    }

    else if (typeShort === 'MsgBatchCancelDerivativeOrders') {
      const count = value.data?.length || 'multiple';
      results.push({
        ...baseTx,
        tag: 'close_position',
        notes: `Cancel ${count} derivative orders`,
      });
    }

    else if (typeShort === 'MsgBatchUpdateOrders') {
      const spotCreates = value.spot_orders_to_create?.length || 0;
      const spotCancels = value.spot_orders_to_cancel?.length || 0;
      const derivCreates = value.derivative_orders_to_create?.length || 0;
      const derivCancels = value.derivative_orders_to_cancel?.length || 0;
      results.push({
        ...baseTx,
        tag: 'swap',
        notes: `Batch update: ${spotCreates + derivCreates} create, ${spotCancels + derivCancels} cancel`,
      });
    }

    else if (typeShort === 'MsgLiquidatePosition') {
      results.push({
        ...baseTx,
        tag: 'close_position',
        notes: `Position liquidated on ${truncateMarketId(value.market_id)}`,
      });
    }

    else if (typeShort === 'MsgIncreasePositionMargin') {
      const amt = value.amount;
      results.push({
        ...baseTx,
        asset: 'USDT',
        amount: amt ? `-${formatAmount(amt, 'peggy0xdac17f958d2ee523a2206206994597c13d831ec7')}` : '',
        tag: 'open_position',
        notes: `Add margin on ${truncateMarketId(value.market_id)}`,
      });
    }

    else if (typeShort === 'MsgDecreasePositionMargin') {
      const amt = value.amount;
      results.push({
        ...baseTx,
        asset: 'USDT',
        amount: amt ? formatAmount(amt, 'peggy0xdac17f958d2ee523a2206206994597c13d831ec7') : '',
        tag: 'close_position',
        notes: `Remove margin on ${truncateMarketId(value.market_id)}`,
      });
    }

    else if (typeShort === 'MsgInstantSpotMarketLaunch' || typeShort === 'MsgInstantPerpetualMarketLaunch') {
      results.push({
        ...baseTx,
        tag: '',
        notes: `Launch market ${value.ticker || ''}`,
      });
    }

    // ========== AUCTION MODULE ==========
    else if (typeShort === 'MsgBid') {
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

    // ========== INSURANCE MODULE ==========
    else if (typeShort === 'MsgUnderwrite') {
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

    else if (typeShort === 'MsgRequestRedemption') {
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

    // ========== PEGGY (Bridge) MODULE ==========
    else if (typeShort === 'MsgSendToEth') {
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

    else if (typeShort === 'MsgConfirmBatch' || typeShort === 'MsgDepositClaim' || typeShort === 'MsgValsetConfirm') {
      results.push({
        ...baseTx,
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

      const funds = Array.isArray(value.funds) ? value.funds : [];

      if (funds.length > 0 && funds[0]) {
        const { symbol } = getTokenInfo(funds[0].denom);
        results.push({
          ...baseTx,
          asset: symbol,
          amount: `-${formatAmount(funds[0].amount, funds[0].denom)}`,
          tag: 'contract_interaction',
          notes: `${action} on ${truncateAddress(contract)}`,
        });
      } else {
        results.push({
          ...baseTx,
          tag: 'contract_interaction',
          notes: `${action} on ${truncateAddress(contract)}`,
        });
      }
    }

    else if (typeShort === 'MsgInstantiateContract' || typeShort === 'MsgInstantiateContract2') {
      results.push({
        ...baseTx,
        tag: 'contract_interaction',
        notes: `Instantiate contract (code ${value.code_id || ''})`,
      });
    }

    else if (typeShort === 'MsgMigrateContract') {
      results.push({
        ...baseTx,
        tag: 'contract_interaction',
        notes: `Migrate contract ${truncateAddress(value.contract)}`,
      });
    }

    else if (typeShort === 'MsgStoreCode') {
      results.push({
        ...baseTx,
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
        tag: '',
        notes: `Vote ${option} on proposal #${value.proposal_id || value.proposalId || ''}`,
      });
    }

    else if (typeShort === 'MsgVoteWeighted') {
      results.push({
        ...baseTx,
        tag: '',
        notes: `Weighted vote on proposal #${value.proposal_id || value.proposalId || ''}`,
      });
    }

    else if (typeShort === 'MsgDeposit' && value.proposal_id) {
      const amounts = value.amount || [];
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
          tag: '',
          notes: 'Submit governance proposal',
        });
      }
    }

    // ========== AUTHZ MODULE ==========
    else if (typeShort === 'MsgGrant') {
      results.push({
        ...baseTx,
        tag: '',
        notes: `Grant authorization to ${truncateAddress(value.grantee)}`,
      });
    }

    else if (typeShort === 'MsgRevoke') {
      results.push({
        ...baseTx,
        tag: '',
        notes: `Revoke authorization from ${truncateAddress(value.grantee)}`,
      });
    }

    else if (typeShort === 'MsgExec') {
      results.push({
        ...baseTx,
        tag: '',
        notes: 'Execute authorized message',
      });
    }

    // ========== TOKEN FACTORY MODULE ==========
    else if (typeShort === 'MsgCreateDenom') {
      results.push({
        ...baseTx,
        tag: '',
        notes: `Create token ${value.subdenom || ''}`,
      });
    }

    else if (typeShort === 'MsgMint') {
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
      }
    }

    else if (typeShort === 'MsgBurn') {
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
      }
    }

    // ========== FALLBACK ==========
    else if (typeShort.startsWith('Msg')) {
      results.push({
        ...baseTx,
        tag: '',
        notes: typeShort.replace('Msg', ''),
      });
    }
  }

  // If no messages were parsed but tx exists, log it
  if (results.length === 0 && messages.length > 0) {
    results.push({
      ...baseTx,
      tag: '',
      notes: 'Transaction',
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
    minWidth: '900px',
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
  const cancelRef = useRef(false);

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

            // Parse and add transactions (failed ones are filtered inside parseTransaction)
            const parsed = parseTransaction(tx, trimmedAddress);
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

      // Sort by date descending (newest first)
      allTxs.sort((a, b) => new Date(b.dateStr) - new Date(a.dateStr));

      setTransactions(allTxs);

      // Calculate stats
      const tagCounts = {};
      allTxs.forEach(tx => {
        const tag = tx.tag || '';
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });

      setStats({ total: allTxs.length, tagCounts, uniqueTxs: seenHashes.size });
      setShowSuccess(true);

    } catch (err) {
      setError(err.message || 'Failed to fetch transactions');
    } finally {
      setLoading(false);
    }
  }, [address]);

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
            Token data from Injective Labs. This tool is not financial advice.
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
