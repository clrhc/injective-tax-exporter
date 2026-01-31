'use client';
import React, { useState, useCallback, useMemo, useEffect } from 'react';

const EXPLORER_API = '/api/transactions';
const ITEMS_PER_PAGE = 25;

// Token metadata cache (fetched from API)
let globalTokenCache = {};

// Format denom using fetched metadata or fallback logic
const formatDenom = (denom, tokenMeta = {}) => {
  if (!denom) return 'INJ';
  
  const denomLower = denom.toLowerCase();
  
  // Check cache first
  if (tokenMeta[denomLower]) {
    return tokenMeta[denomLower].symbol;
  }
  if (globalTokenCache[denomLower]) {
    return globalTokenCache[denomLower].symbol;
  }
  
  // Native INJ
  if (denom === 'inj') return 'INJ';
  
  // Peggy tokens (bridged from Ethereum)
  if (denom.startsWith('peggy0x')) {
    // Return shortened address if not in metadata
    const addr = denom.replace('peggy', '');
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }
  
  // IBC tokens
  if (denom.startsWith('ibc/')) {
    return `IBC/${denom.slice(4, 10)}...`;
  }
  
  // Factory tokens
  if (denom.startsWith('factory/')) {
    const parts = denom.split('/');
    return parts[parts.length - 1].toUpperCase();
  }
  
  return denom.length > 12 ? `${denom.slice(0, 10)}...` : denom.toUpperCase();
};

// Get decimals from metadata or default
const getDecimals = (denom, tokenMeta = {}) => {
  if (!denom) return 18;
  const denomLower = denom.toLowerCase();
  if (tokenMeta[denomLower]) return tokenMeta[denomLower].decimals;
  if (globalTokenCache[denomLower]) return globalTokenCache[denomLower].decimals;
  if (denom === 'inj') return 18;
  return 18; // Default
};

const formatAmount = (amount, denom, tokenMeta = {}) => {
  if (!amount) return '';
  const decimals = getDecimals(denom, tokenMeta);
  const num = parseFloat(amount) / Math.pow(10, decimals);
  if (num === 0) return '0';
  if (Math.abs(num) < 0.000001) return num.toExponential(4);
  if (Math.abs(num) < 1) return num.toFixed(8).replace(/\.?0+$/, '');
  if (Math.abs(num) < 1000) return num.toFixed(6).replace(/\.?0+$/, '');
  return num.toFixed(4).replace(/\.?0+$/, '');
};

// Parse transaction into Awaken Tax format
const parseTransaction = (tx, walletAddress, tokenMeta = {}) => {
  const results = [];
  const date = new Date(tx.blockTimestamp || tx.block_timestamp || tx.timestamp);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const dateDisplay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeDisplay = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const txHash = tx.hash || tx.txHash || tx.id || '';
  const fee = tx.gasFee?.amount?.[0] || tx.gas_fee?.amount?.[0];
  const feeAmount = fee ? formatAmount(fee.amount, fee.denom, tokenMeta) : '';
  const feeCurrency = fee ? formatDenom(fee.denom, tokenMeta) : '';
  const messages = tx.messages || tx.data?.messages || [];
  
  // Parse event logs
  const logs = tx.logs || tx.rawLog || [];
  const events = [];
  try {
    const parsed = typeof logs === 'string' ? JSON.parse(logs) : logs;
    if (Array.isArray(parsed)) parsed.forEach(log => events.push(...(log.events || [])));
  } catch(e) {}
  
  const findEventAmount = (eventType, attrKey) => {
    for (const evt of events) {
      if (evt.type === eventType) {
        const attr = evt.attributes?.find(a => a.key === attrKey);
        if (attr) return attr.value;
      }
    }
    return null;
  };
  
  const baseTx = { 
    dateStr, dateDisplay, timeDisplay, txHash, 
    feeAmount, feeCurrency,
    asset: '', amount: '', pnl: '', paymentToken: '',
    notes: '', tag: ''
  };
  
  for (const msg of messages) {
    const type = msg['@type'] || msg.type || '';
    const value = msg.value || msg;
    
    // ============ BANK TRANSFERS ============
    if (type.includes('MsgSend') && !type.includes('MsgSendToEth')) {
      const fromAddr = value.from_address || value.fromAddress || '';
      const toAddr = value.to_address || value.toAddress || '';
      for (const coin of (value.amount || [])) {
        const qty = formatAmount(coin.amount, coin.denom, tokenMeta);
        const cur = formatDenom(coin.denom, tokenMeta);
        if (fromAddr === walletAddress) {
          results.push({ ...baseTx, asset: cur, amount: `-${qty}`, tag: 'transfer', notes: `Send to ${toAddr}` });
        } else if (toAddr === walletAddress) {
          results.push({ ...baseTx, asset: cur, amount: qty, feeAmount: '', feeCurrency: '', tag: 'transfer', notes: `Receive from ${fromAddr}` });
        }
      }
    }
    else if (type.includes('MsgMultiSend')) {
      for (const input of (value.inputs || [])) {
        if (input.address === walletAddress) {
          for (const coin of (input.coins || [])) {
            results.push({ ...baseTx, asset: formatDenom(coin.denom, tokenMeta), amount: `-${formatAmount(coin.amount, coin.denom, tokenMeta)}`, tag: 'transfer', notes: `MultiSend output` });
          }
        }
      }
      for (const output of (value.outputs || [])) {
        if (output.address === walletAddress) {
          for (const coin of (output.coins || [])) {
            results.push({ ...baseTx, asset: formatDenom(coin.denom, tokenMeta), amount: formatAmount(coin.amount, coin.denom, tokenMeta), tag: 'transfer', notes: `MultiSend receive` });
          }
        }
      }
    }
    
    // ============ STAKING ============
    else if (type.includes('MsgDelegate') && !type.includes('Undelegate') && !type.includes('Redelegate')) {
      const amt = value.amount;
      const validator = value.validator_address || value.validatorAddress || '';
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: `-${formatAmount(amt.amount, amt.denom, tokenMeta)}`, tag: 'stake', notes: `Stake to ${validator}` });
    }
    else if (type.includes('MsgUndelegate')) {
      const amt = value.amount;
      const validator = value.validator_address || value.validatorAddress || '';
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: formatAmount(amt.amount, amt.denom, tokenMeta), tag: 'unstake', notes: `Unstake from ${validator}` });
    }
    else if (type.includes('MsgBeginRedelegate')) {
      const amt = value.amount;
      const src = value.validator_src_address || '';
      const dst = value.validator_dst_address || '';
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: '0', tag: 'stake', notes: `Redelegate ${formatAmount(amt.amount, amt.denom, tokenMeta)} from ${src} to ${dst}` });
    }
    else if (type.includes('MsgWithdrawDelegatorReward')) {
      const validator = value.validator_address || value.validatorAddress || '';
      let rewardQty = '';
      let rewardCur = 'INJ';
      const rewardStr = findEventAmount('withdraw_rewards', 'amount') || findEventAmount('coin_received', 'amount');
      if (rewardStr) {
        const match = rewardStr.match(/^(\d+)(.+)$/);
        if (match) { 
          rewardQty = formatAmount(match[1], match[2], tokenMeta); 
          rewardCur = formatDenom(match[2], tokenMeta); 
        }
      }
      results.push({ ...baseTx, asset: rewardCur, amount: rewardQty, pnl: rewardQty, tag: 'reward', notes: `Claim staking rewards from ${validator}` });
    }
    else if (type.includes('MsgWithdrawValidatorCommission')) {
      let commQty = '';
      const commStr = findEventAmount('withdraw_commission', 'amount') || findEventAmount('coin_received', 'amount');
      if (commStr) {
        const match = commStr.match(/^(\d+)(.+)$/);
        if (match) commQty = formatAmount(match[1], match[2], tokenMeta);
      }
      results.push({ ...baseTx, asset: 'INJ', amount: commQty, pnl: commQty, tag: 'reward', notes: `Withdraw validator commission` });
    }
    
    // ============ IBC ============
    else if (type.includes('MsgTransfer')) {
      const token = value.token;
      if (token) {
        const isOut = value.sender === walletAddress;
        const receiver = value.receiver || '';
        const sender = value.sender || '';
        const channel = value.source_channel || '';
        const qty = formatAmount(token.amount, token.denom, tokenMeta);
        const cur = formatDenom(token.denom, tokenMeta);
        if (isOut) {
          results.push({ ...baseTx, asset: cur, amount: `-${qty}`, tag: 'transfer', notes: `IBC send to ${receiver} via ${channel}` });
        } else {
          results.push({ ...baseTx, asset: cur, amount: qty, tag: 'transfer', notes: `IBC receive from ${sender} via ${channel}` });
        }
      }
    }
    
    // ============ SPOT TRADING ============
    else if (type.includes('MsgCreateSpotLimitOrder') || type.includes('MsgCreateSpotMarketOrder')) {
      const marketId = value.order?.market_id || value.order?.marketId || '';
      const orderType = value.order?.order_type || '';
      results.push({ ...baseTx, asset: '', amount: '', tag: 'swap', notes: `Spot ${orderType} order on ${marketId}` });
    }
    else if (type.includes('MsgCancelSpotOrder')) {
      const marketId = value.market_id || value.marketId || '';
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Cancel spot order on ${marketId}` });
    }
    else if (type.includes('MsgBatchCancelSpotOrders')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Batch cancel spot orders` });
    }
    
    // ============ DERIVATIVES ============
    else if (type.includes('MsgCreateDerivativeLimitOrder') || type.includes('MsgCreateDerivativeMarketOrder')) {
      const marketId = value.order?.market_id || '';
      const orderType = value.order?.order_type || '';
      const margin = value.order?.margin;
      let marginAmt = '';
      if (margin) marginAmt = formatAmount(margin, 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', tokenMeta);
      results.push({ ...baseTx, asset: 'USDT', amount: marginAmt ? `-${marginAmt}` : '', paymentToken: 'USDT', tag: 'open_position', notes: `${orderType} position on ${marketId}` });
    }
    else if (type.includes('MsgCancelDerivativeOrder')) {
      const marketId = value.market_id || '';
      results.push({ ...baseTx, asset: '', amount: '', tag: 'close_position', notes: `Cancel derivative order on ${marketId}` });
    }
    else if (type.includes('MsgBatchCancelDerivativeOrders')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'close_position', notes: `Batch cancel derivative orders` });
    }
    else if (type.includes('MsgIncreasePositionMargin')) {
      const marketId = value.market_id || '';
      const amount = value.amount;
      results.push({ ...baseTx, asset: 'USDT', amount: amount ? `-${formatAmount(amount, 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', tokenMeta)}` : '', tag: 'open_position', notes: `Increase margin on ${marketId}` });
    }
    else if (type.includes('MsgLiquidatePosition')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'close_position', notes: `Position liquidated` });
    }
    
    // ============ BINARY OPTIONS ============
    else if (type.includes('MsgCreateBinaryOptions')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'open_position', notes: `Binary options order` });
    }
    else if (type.includes('MsgCancelBinaryOptions')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'close_position', notes: `Cancel binary options order` });
    }
    
    // ============ BATCH ORDERS ============
    else if (type.includes('MsgBatchUpdateOrders')) {
      const spotCreates = value.spot_orders_to_create?.length || 0;
      const spotCancels = value.spot_orders_to_cancel?.length || 0;
      const derivCreates = value.derivative_orders_to_create?.length || 0;
      const derivCancels = value.derivative_orders_to_cancel?.length || 0;
      results.push({ ...baseTx, asset: '', amount: '', tag: 'swap', notes: `Batch: ${spotCreates} spot create, ${spotCancels} spot cancel, ${derivCreates} deriv create, ${derivCancels} deriv cancel` });
    }
    
    // ============ SUBACCOUNT ============
    else if (type.includes('MsgDeposit') && !type.includes('gov')) {
      const amt = value.amount;
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: `-${formatAmount(amt.amount, amt.denom, tokenMeta)}`, tag: 'transfer', notes: `Deposit to trading subaccount` });
    }
    else if (type.includes('MsgWithdraw') && !type.includes('Reward') && !type.includes('Commission')) {
      const amt = value.amount;
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: formatAmount(amt.amount, amt.denom, tokenMeta), tag: 'transfer', notes: `Withdraw from trading subaccount` });
    }
    else if (type.includes('MsgSubaccountTransfer') || type.includes('MsgExternalTransfer')) {
      const amt = value.amount;
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: '0', tag: 'transfer', notes: `Subaccount transfer ${formatAmount(amt.amount, amt.denom, tokenMeta)} ${formatDenom(amt.denom, tokenMeta)}` });
    }
    
    // ============ SMART CONTRACTS ============
    else if (type.includes('MsgExecuteContract')) {
      const contract = value.contract || '';
      let action = 'execute';
      try { 
        const msgObj = typeof value.msg === 'string' ? JSON.parse(value.msg) : value.msg;
        if (msgObj && typeof msgObj === 'object') {
          action = Object.keys(msgObj)[0] || 'execute'; 
        }
      } catch(e) {}
      const funds = Array.isArray(value.funds) ? value.funds : [];
      if (funds.length > 0 && funds[0]) {
        results.push({ ...baseTx, asset: formatDenom(funds[0].denom, tokenMeta), amount: `-${formatAmount(funds[0].amount, funds[0].denom, tokenMeta)}`, tag: 'contract_interaction', notes: `${action} on ${contract}` });
      } else {
        results.push({ ...baseTx, asset: '', amount: '', tag: 'contract_interaction', notes: `${action} on ${contract}` });
      }
    }
    else if (type.includes('MsgInstantiateContract')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'contract_interaction', notes: `Instantiate contract` });
    }
    else if (type.includes('MsgMigrateContract')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'contract_interaction', notes: `Migrate contract` });
    }
    
    // ============ BRIDGE ============
    else if (type.includes('MsgSendToEth')) {
      const amt = value.amount;
      const ethDest = value.eth_dest || '';
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: `-${formatAmount(amt.amount, amt.denom, tokenMeta)}`, tag: 'bridge_out', notes: `Bridge to Ethereum ${ethDest}` });
    }
    else if (type.includes('MsgDepositClaim')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: 'bridge_in', notes: `Bridge deposit from Ethereum` });
    }
    
    // ============ GOVERNANCE ============
    else if (type.includes('MsgVote')) {
      const proposalId = value.proposal_id || value.proposalId || '';
      const option = value.option || '';
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Vote ${option} on proposal ${proposalId}` });
    }
    else if (type.includes('MsgSubmitProposal')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Submit governance proposal` });
    }
    
    // ============ INSURANCE ============
    else if (type.includes('MsgCreateInsuranceFund')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Create insurance fund` });
    }
    else if (type.includes('MsgUnderwrite')) {
      const amt = value.deposit;
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: `-${formatAmount(amt.amount, amt.denom, tokenMeta)}`, tag: 'add_liquidity', notes: `Underwrite insurance` });
    }
    
    // ============ AUCTION ============
    else if (type.includes('MsgBid')) {
      const amt = value.bid_amount;
      if (amt) results.push({ ...baseTx, asset: formatDenom(amt.denom, tokenMeta), amount: `-${formatAmount(amt.amount, amt.denom, tokenMeta)}`, tag: '', notes: `Auction bid` });
    }
    
    // ============ AUTHZ ============
    else if (type.includes('MsgGrant')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Grant authorization` });
    }
    else if (type.includes('MsgRevoke')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Revoke authorization` });
    }
    else if (type.includes('MsgExec')) {
      results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: `Execute authorized message` });
    }
  }
  
  // Fallback
  if (results.length === 0 && messages.length > 0) {
    const shortType = (messages[0]['@type'] || '').split('.').pop().replace('Msg', '');
    results.push({ ...baseTx, asset: '', amount: '', tag: '', notes: shortType || 'Unknown transaction' });
  }
  
  return results;
};

// Generate Awaken Tax CSV
const generateCSV = (transactions) => {
  const headers = ['Date', 'Asset', 'Amount', 'Fee', 'P&L', 'Payment Token', 'ID', 'Notes', 'Tag', 'Transaction Hash'];
  
  const rows = transactions.map((tx, idx) => [
    tx.dateStr,
    tx.asset,
    tx.amount,
    tx.feeAmount,
    tx.pnl || '',
    tx.paymentToken || tx.feeCurrency,
    `TXN${String(idx + 1).padStart(5, '0')}`,
    tx.notes,
    tx.tag,
    tx.txHash
  ]);
  
  return [headers.join(','), ...rows.map(row => row.map(cell => {
    const str = (cell || '').toString();
    return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(','))].join('\n');
};

const TAG_CONFIG = {
  'transfer': { bg: '#3b82f620', color: '#60a5fa', icon: '↔️', label: 'Transfer' },
  'stake': { bg: '#8b5cf620', color: '#a78bfa', icon: '🔒', label: 'Stake' },
  'unstake': { bg: '#8b5cf620', color: '#c4b5fd', icon: '🔓', label: 'Unstake' },
  'reward': { bg: '#22c55e20', color: '#4ade80', icon: '🎁', label: 'Reward' },
  'swap': { bg: '#eab30820', color: '#fbbf24', icon: '🔄', label: 'Swap' },
  'open_position': { bg: '#22c55e20', color: '#4ade80', icon: '📈', label: 'Open Position' },
  'close_position': { bg: '#ef444420', color: '#f87171', icon: '📉', label: 'Close Position' },
  'contract_interaction': { bg: '#ec489920', color: '#f472b6', icon: '📄', label: 'Contract' },
  'bridge_out': { bg: '#6366f120', color: '#818cf8', icon: '🌉', label: 'Bridge Out' },
  'bridge_in': { bg: '#6366f120', color: '#818cf8', icon: '🌉', label: 'Bridge In' },
  'add_liquidity': { bg: '#14b8a620', color: '#2dd4bf', icon: '💧', label: 'Add Liquidity' },
  'remove_liquidity': { bg: '#14b8a620', color: '#2dd4bf', icon: '💧', label: 'Remove Liquidity' },
  '': { bg: '#6b728020', color: '#9ca3af', icon: '•', label: 'Other' },
};

// Loading Modal
function LoadingModal({ isOpen, progress, onCancel }) {
  if (!isOpen) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }} />
      <div style={{ position: 'relative', background: 'linear-gradient(135deg, #1a1a2e, #16162a)', borderRadius: '24px', border: '1px solid rgba(255,255,255,0.1)', padding: '40px', maxWidth: '420px', width: '90%', textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', margin: '0 auto 24px', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, border: '3px solid rgba(59,130,246,0.2)', borderRadius: '50%' }} />
          <div style={{ position: 'absolute', inset: 0, border: '3px solid transparent', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <div style={{ position: 'absolute', inset: '12px', background: 'linear-gradient(135deg, #3b82f6, #06b6d4)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>◈</div>
        </div>
        <h3 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 600, color: '#fff' }}>Fetching Transactions</h3>
        <p style={{ margin: '0 0 24px', color: '#64748b' }}>{progress.status}</p>
        <div style={{ background: 'rgba(255,255,255,0.1)', borderRadius: '10px', height: '8px', overflow: 'hidden', marginBottom: '16px' }}>
          <div style={{ height: '100%', background: 'linear-gradient(90deg, #3b82f6, #06b6d4)', width: `${Math.min(progress.current / Math.max(progress.total, 1) * 100, 95)}%`, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: '28px', fontWeight: 700, color: '#3b82f6', marginBottom: '24px' }}>{progress.current.toLocaleString()} <span style={{ fontSize: '14px', color: '#64748b' }}>transactions</span></div>
        <button onClick={onCancel} style={{ padding: '12px 24px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', color: '#94a3b8', cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
}

// Success Modal
function SuccessModal({ isOpen, stats, onClose }) {
  if (!isOpen || !stats) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'linear-gradient(135deg, #1a1a2e, #16162a)', borderRadius: '24px', border: '1px solid rgba(34,197,94,0.3)', padding: '40px', maxWidth: '420px', width: '90%', textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', margin: '0 auto 24px', background: 'linear-gradient(135deg, #22c55e, #16a34a)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '40px' }}>✓</div>
        <h3 style={{ margin: '0 0 8px', fontSize: '24px', fontWeight: 700, color: '#fff' }}>Export Ready!</h3>
        <p style={{ margin: '0 0 16px', color: '#64748b' }}>{stats.total.toLocaleString()} transactions loaded</p>
        <p style={{ margin: '0 0 24px', color: '#4ade80', fontSize: '14px' }}>✓ {stats.tokenCount} tokens identified</p>
        <button onClick={onClose} style={{ width: '100%', padding: '14px', background: 'linear-gradient(135deg, #22c55e, #16a34a)', border: 'none', borderRadius: '12px', color: '#fff', fontSize: '16px', fontWeight: 600, cursor: 'pointer' }}>View Transactions</button>
      </div>
    </div>
  );
}

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
  const [tokenMeta, setTokenMeta] = useState({});
  const [cancelRef] = useState({ cancelled: false });

  // Fetch token metadata on mount
  useEffect(() => {
    async function loadTokens() {
      try {
        const res = await fetch(`${EXPLORER_API}/tokens?type=tokens`);
        if (res.ok) {
          const data = await res.json();
          if (data.tokens) {
            setTokenMeta(data.tokens);
            globalTokenCache = data.tokens;
            console.log(`Loaded ${Object.keys(data.tokens).length} token metadata`);
          }
        }
      } catch (err) {
        console.log('Token metadata fetch failed, using fallbacks');
      }
    }
    loadTokens();
  }, []);

  const filteredTxs = useMemo(() => filter === 'all' ? transactions : transactions.filter(tx => tx.tag === filter), [transactions, filter]);
  const paginatedTxs = useMemo(() => filteredTxs.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE), [filteredTxs, currentPage]);
  const totalPages = Math.ceil(filteredTxs.length / ITEMS_PER_PAGE);

  const fetchTransactions = useCallback(async () => {
    if (!address || !address.startsWith('inj1') || address.length !== 42) {
      setError('Please enter a valid Injective address (starts with inj1, 42 characters)');
      return;
    }
    cancelRef.cancelled = false;
    setLoading(true); setError(''); setTransactions([]); setCurrentPage(1); setFilter('all'); setShowSuccess(false);
    setProgress({ current: 0, total: 0, status: 'Loading token metadata...' });

    try {
      // Ensure we have token metadata
      if (Object.keys(tokenMeta).length === 0) {
        try {
          const tokRes = await fetch(`${EXPLORER_API}/tokens?type=tokens`);
          if (tokRes.ok) {
            const tokData = await tokRes.json();
            if (tokData.tokens) {
              setTokenMeta(tokData.tokens);
              globalTokenCache = tokData.tokens;
            }
          }
        } catch(e) {}
      }
      
      const allTxs = [];
      let hasMore = true, skip = 0, batch = 0;
      const uniqueAssets = new Set();
      
      setProgress({ current: 0, total: 0, status: 'Connecting to Injective...' });
      
      while (hasMore && !cancelRef.cancelled) {
        batch++;
        setProgress(p => ({ ...p, status: `Loading batch ${batch}...` }));
        const response = await fetch(`${EXPLORER_API}/${address}?limit=100&skip=${skip}`);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `API error: ${response.status}`);
        const data = await response.json();
        const txs = data.data || data.txs || [];
        
        if (!txs.length) hasMore = false;
        else {
          for (const tx of txs) {
            const parsed = parseTransaction(tx, address, tokenMeta);
            allTxs.push(...parsed);
            parsed.forEach(p => { if (p.asset) uniqueAssets.add(p.asset); });
          }
          skip += 100;
          if (txs.length < 100) hasMore = false;
          setProgress({ current: allTxs.length, total: data.paging?.total || allTxs.length, status: `Found ${allTxs.length.toLocaleString()} transactions...` });
          await new Promise(r => setTimeout(r, 150));
        }
      }
      
      if (cancelRef.cancelled) { setLoading(false); return; }
      
      setTransactions(allTxs);
      
      const tagCounts = {};
      allTxs.forEach(tx => { 
        const tag = tx.tag || '';
        tagCounts[tag] = (tagCounts[tag] || 0) + 1; 
      });
      setStats({ total: allTxs.length, tagCounts, tokenCount: uniqueAssets.size });
      setShowSuccess(true);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [address, cancelRef, tokenMeta]);

  const downloadCSV = useCallback(() => {
    const blob = new Blob([generateCSV(transactions)], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `injective-${address.slice(0, 8)}-awaken.csv`;
    link.click();
  }, [transactions, address]);

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f0f1a, #1a1a2e, #0f0f1a)', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
      <LoadingModal isOpen={loading} progress={progress} onCancel={() => { cancelRef.cancelled = true; setLoading(false); }} />
      <SuccessModal isOpen={showSuccess} stats={stats} onClose={() => setShowSuccess(false)} />
      
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 20px' }}>
        {/* Header */}
        <header style={{ marginBottom: '40px', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '56px', height: '56px', background: 'linear-gradient(135deg, #3b82f6, #06b6d4)', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', boxShadow: '0 8px 32px rgba(59,130,246,0.3)' }}>◈</div>
          <div>
            <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 700 }}>Injective Tax Exporter</h1>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '14px' }}>Export transactions for Awaken Tax • {Object.keys(tokenMeta).length > 0 ? `${Object.keys(tokenMeta).length} tokens loaded` : 'Loading tokens...'}</p>
          </div>
        </header>

        {/* Search */}
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.06)', padding: '24px', marginBottom: '24px' }}>
          <h2 style={{ margin: '0 0 16px', fontSize: '16px', color: '#e2e8f0' }}>🔍 Wallet Lookup</h2>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <input value={address} onChange={e => setAddress(e.target.value.trim())} placeholder="Enter Injective address (inj1...)" disabled={loading}
              style={{ flex: '1 1 300px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '14px 18px', color: '#fff', fontSize: '15px', outline: 'none' }}
              onKeyDown={e => e.key === 'Enter' && fetchTransactions()} />
            <button onClick={fetchTransactions} disabled={loading || !address}
              style={{ padding: '14px 28px', background: loading || !address ? '#374151' : 'linear-gradient(135deg, #3b82f6, #2563eb)', border: 'none', borderRadius: '12px', color: '#fff', fontSize: '15px', fontWeight: 600, cursor: loading || !address ? 'not-allowed' : 'pointer' }}>
              Fetch Transactions →
            </button>
          </div>
          {error && <div style={{ marginTop: '16px', padding: '12px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', color: '#fca5a5' }}>⚠️ {error}</div>}
        </div>

        {/* Stats */}
        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 700 }}>{stats.total.toLocaleString()}</div>
              <div style={{ fontSize: '13px', color: '#64748b' }}>Total Transactions</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#a78bfa' }}>{Object.keys(stats.tagCounts).length}</div>
              <div style={{ fontSize: '13px', color: '#64748b' }}>Transaction Types</div>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#4ade80' }}>{stats.tokenCount}</div>
              <div style={{ fontSize: '13px', color: '#64748b' }}>Unique Assets</div>
            </div>
          </div>
        )}

        {/* Filters */}
        {stats && (
          <div style={{ marginBottom: '24px' }}>
            <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '10px' }}>Filter by type:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <button onClick={() => { setFilter('all'); setCurrentPage(1); }} style={{ padding: '8px 14px', background: filter === 'all' ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)', border: `1px solid ${filter === 'all' ? '#3b82f6' : 'rgba(255,255,255,0.1)'}`, borderRadius: '20px', color: filter === 'all' ? '#60a5fa' : '#94a3b8', fontSize: '13px', cursor: 'pointer' }}>All ({stats.total})</button>
              {Object.entries(stats.tagCounts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => {
                const c = TAG_CONFIG[tag] || TAG_CONFIG[''];
                return <button key={tag || 'other'} onClick={() => { setFilter(tag); setCurrentPage(1); }} style={{ padding: '8px 14px', background: filter === tag ? c.bg : 'rgba(255,255,255,0.03)', border: `1px solid ${filter === tag ? c.color : 'rgba(255,255,255,0.1)'}`, borderRadius: '20px', color: filter === tag ? c.color : '#94a3b8', fontSize: '13px', cursor: 'pointer' }}>{c.icon} {c.label} ({count})</button>;
              })}
            </div>
          </div>
        )}

        {/* Download */}
        {transactions.length > 0 && (
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <button onClick={downloadCSV} style={{ padding: '16px 32px', background: 'linear-gradient(135deg, #22c55e, #16a34a)', border: 'none', borderRadius: '14px', color: '#fff', fontSize: '16px', fontWeight: 600, cursor: 'pointer', boxShadow: '0 8px 32px rgba(34,197,94,0.3)' }}>
              ⬇️ Download Awaken Tax CSV ({transactions.length} rows)
            </button>
            <p style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>Format: Date, Asset, Amount, Fee, P&L, Payment Token, ID, Notes, Tag, Transaction Hash</p>
          </div>
        )}

        {/* Table */}
        {filteredTxs.length > 0 && (
          <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap', gap: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>📋 Transactions ({filteredTxs.length})</h3>
              {totalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1} style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: currentPage === 1 ? '#374151' : '#94a3b8', cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}>««</button>
                  <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: currentPage === 1 ? '#374151' : '#94a3b8', cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}>‹</button>
                  <span style={{ padding: '0 12px', color: '#64748b' }}>Page {currentPage} of {totalPages}</span>
                  <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: currentPage === totalPages ? '#374151' : '#94a3b8', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }}>›</button>
                  <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: currentPage === totalPages ? '#374151' : '#94a3b8', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }}>»»</button>
                </div>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1000px' }}>
                <thead>
                  <tr style={{ background: 'rgba(0,0,0,0.2)' }}>
                    <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Date</th>
                    <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Asset</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Amount</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Fee</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>P&L</th>
                    <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Tag</th>
                    <th style={{ padding: '14px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Notes</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTxs.map((tx, i) => {
                    const c = TAG_CONFIG[tx.tag] || TAG_CONFIG[''];
                    const isPositive = tx.amount && !tx.amount.startsWith('-');
                    const isNegative = tx.amount && tx.amount.startsWith('-');
                    return (
                      <tr key={`${tx.txHash}-${i}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '14px 16px' }}><div style={{ fontWeight: 500 }}>{tx.dateDisplay}</div><div style={{ fontSize: '12px', color: '#64748b' }}>{tx.timeDisplay}</div></td>
                        <td style={{ padding: '14px 16px', fontWeight: 600 }}>{tx.asset || '—'}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', color: isPositive ? '#4ade80' : isNegative ? '#f87171' : '#64748b' }}>{tx.amount || '—'}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'right', color: '#64748b', fontSize: '13px' }}>{tx.feeAmount ? `${tx.feeAmount} ${tx.feeCurrency}` : '—'}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'right', fontFamily: 'monospace', color: tx.pnl ? '#4ade80' : '#64748b' }}>{tx.pnl || '—'}</td>
                        <td style={{ padding: '14px 16px' }}>{tx.tag ? <span style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '12px', background: c.bg, color: c.color }}>{c.icon} {c.label}</span> : '—'}</td>
                        <td style={{ padding: '14px 16px', color: '#94a3b8', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tx.notes}>{tx.notes}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'center' }}><a href={`https://explorer.injective.network/transaction/${tx.txHash}`} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', background: 'rgba(59,130,246,0.1)', borderRadius: '6px', color: '#60a5fa', textDecoration: 'none' }}>↗</a></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: '#64748b' }}>Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredTxs.length)} of {filteredTxs.length}</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: currentPage === 1 ? '#374151' : '#94a3b8', cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}>← Previous</button>
                  <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: currentPage === totalPages ? '#374151' : '#94a3b8', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }}>Next →</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Empty State */}
        {!loading && transactions.length === 0 && !error && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔎</div>
            <h3 style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 8px' }}>Ready to Export</h3>
            <p style={{ color: '#64748b', margin: '0 0 24px' }}>Enter your Injective wallet address to fetch transaction history</p>
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '12px' }}>
              {['✓ Staking & Rewards', '✓ IBC Transfers', '✓ DEX Swaps', '✓ Derivatives', '✓ Smart Contracts'].map(f => <span key={f} style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.03)', borderRadius: '20px', fontSize: '13px', color: '#94a3b8' }}>{f}</span>)}
            </div>
          </div>
        )}

        {/* Footer */}
        <footer style={{ marginTop: '48px', paddingTop: '24px', borderTop: '1px solid rgba(255,255,255,0.06)', textAlign: 'center' }}>
          <p style={{ color: '#64748b', margin: '0 0 8px' }}>Built for the <a href="https://awaken.tax" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'none' }}>Awaken Tax</a> bounty program</p>
          <p style={{ fontSize: '12px', color: '#4b5563', margin: 0 }}>Token metadata from Injective Labs • Not financial advice</p>
        </footer>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}