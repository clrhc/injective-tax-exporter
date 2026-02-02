// app/api/export/route.ts
// Generate CSV export for a wallet - same logic as page.jsx but server-side
// Used by Ralph for automated testing

import { getChain, defaultChain } from '../../../chains';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes for large wallets

interface ParsedTx {
  dateStr: string;
  dateFormatted: string;
  timestamp: number;
  txHash: string;
  feeAmount: string;
  feeCurrency: string;
  receivedQty: string;
  receivedCurrency: string;
  receivedFiat: string;
  receivedContractAddress?: string;
  sentQty: string;
  sentCurrency: string;
  sentFiat: string;
  sentContractAddress?: string;
  // Multi-asset fields (for LP operations)
  receivedQty2?: string;
  receivedCurrency2?: string;
  receivedFiat2?: string;
  receivedContractAddress2?: string;
  sentQty2?: string;
  sentCurrency2?: string;
  sentFiat2?: string;
  sentContractAddress2?: string;
  isMultiAsset?: boolean;
  notes: string;
  tag: string;
}

// Parse transactions with token transfer data - same logic as page.jsx
function parseTransactionsWithTokens(
  txs: any[],
  tokenTransfers: any[],
  walletAddress: string,
  nativeTokenSymbol: string = 'ETH'
): ParsedTx[] {
  const results: ParsedTx[] = [];
  const walletLower = walletAddress.toLowerCase();

  // Build set of failed transaction hashes
  const failedTxHashes = new Set<string>();
  for (const tx of txs) {
    const isFailed = tx.isError === '1' || tx.txreceipt_status === '0';
    if (isFailed) {
      const hash = (tx.hash || tx.txHash || '').toLowerCase();
      if (hash) failedTxHashes.add(hash);
    }
  }

  // Group token transfers by transaction hash (excluding failed txs)
  const tokensByHash: Record<string, any[]> = {};
  for (const tt of tokenTransfers) {
    const hash = (tt.hash || tt.transactionHash || '').toLowerCase();
    if (!hash) continue;
    if (failedTxHashes.has(hash)) continue;
    if (!tokensByHash[hash]) tokensByHash[hash] = [];
    tokensByHash[hash].push(tt);
  }

  // Process each transaction
  for (const tx of txs) {
    const txHash = (tx.hash || tx.txHash || '').toLowerCase();
    const isFailed = tx.isError === '1' || tx.txreceipt_status === '0';

    const timestamp = tx.timeStamp ? parseInt(tx.timeStamp) * 1000 : Date.now();
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;

    const dateFormatted = `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    const gasUsed = tx.gasUsed ? parseFloat(tx.gasUsed) : 0;
    const gasPrice = tx.gasPrice ? parseFloat(tx.gasPrice) : 0;
    const feeRaw = (gasUsed * gasPrice) / 1e18;
    const feeAmount = feeRaw > 0 ? feeRaw.toFixed(8).replace(/\.?0+$/, '') : '';
    const feeCurrency = nativeTokenSymbol;

    const from = (tx.from || '').toLowerCase();
    const to = (tx.to || '').toLowerCase();
    const walletInitiated = from === walletLower;
    const nativeValue = tx.value ? parseFloat(tx.value) / 1e18 : 0;

    const functionName = tx.functionName || tx.input?.slice(0, 10) || '';
    const txNote = functionName.split('(')[0] || 'Transaction';

    const baseTx: ParsedTx = {
      dateStr,
      dateFormatted,
      timestamp,
      txHash,
      feeAmount: '',
      feeCurrency: '',
      receivedQty: '',
      receivedCurrency: '',
      receivedFiat: '',
      sentQty: '',
      sentCurrency: '',
      sentFiat: '',
      notes: txNote,
      tag: '',
    };

    // For failed transactions, just record gas fee
    if (isFailed) {
      if (feeRaw > 0 && walletInitiated) {
        results.push({
          ...baseTx,
          feeAmount,
          feeCurrency,
          tag: 'fee',
          notes: `Failed: ${txNote}`,
        });
      }
      continue;
    }

    // Get token transfers for this tx
    const ttList = tokensByHash[txHash] || [];

    // Separate tokens in vs out
    const tokensIn: { symbol: string; amount: number; contractAddress?: string }[] = [];
    const tokensOut: { symbol: string; amount: number; contractAddress?: string }[] = [];

    for (const tt of ttList) {
      const ttFrom = (tt.from || '').toLowerCase();
      const ttTo = (tt.to || '').toLowerCase();
      const decimals = parseInt(tt.tokenDecimal || tt.decimals || '18');
      const rawValue = tt.value || '0';
      const amount = parseFloat(rawValue) / Math.pow(10, decimals);
      const symbol = tt.tokenSymbol || tt.symbol || `${tt.contractAddress?.slice(0, 6)}...`;

      if (ttTo === walletLower && amount > 0) {
        tokensIn.push({ symbol, amount, contractAddress: tt.contractAddress });
      }
      if (ttFrom === walletLower && amount > 0) {
        tokensOut.push({ symbol, amount, contractAddress: tt.contractAddress });
      }
    }

    // Add native value to tokens in/out
    if (nativeValue > 0) {
      if (to === walletLower) {
        tokensIn.push({ symbol: nativeTokenSymbol, amount: nativeValue });
      }
      if (from === walletLower) {
        tokensOut.push({ symbol: nativeTokenSymbol, amount: nativeValue });
      }
    }

    // Net out tokens that appear in both lists (wrap/unwrap operations)
    // This prevents showing WETH->WETH when it's actually USDC->WETH with a wrap
    const inBySymbol: Record<string, { amount: number; contractAddress?: string }> = {};
    const outBySymbol: Record<string, { amount: number; contractAddress?: string }> = {};

    for (const t of tokensIn) {
      if (!inBySymbol[t.symbol]) inBySymbol[t.symbol] = { amount: 0, contractAddress: t.contractAddress };
      inBySymbol[t.symbol].amount += t.amount;
    }
    for (const t of tokensOut) {
      if (!outBySymbol[t.symbol]) outBySymbol[t.symbol] = { amount: 0, contractAddress: t.contractAddress };
      outBySymbol[t.symbol].amount += t.amount;
    }

    // Calculate net amounts per token
    const netTokensIn: { symbol: string; amount: number; contractAddress?: string }[] = [];
    const netTokensOut: { symbol: string; amount: number; contractAddress?: string }[] = [];

    const allSymbols = new Set([...Object.keys(inBySymbol), ...Object.keys(outBySymbol)]);
    for (const symbol of allSymbols) {
      const inAmt = inBySymbol[symbol]?.amount || 0;
      const outAmt = outBySymbol[symbol]?.amount || 0;
      const contractAddress = inBySymbol[symbol]?.contractAddress || outBySymbol[symbol]?.contractAddress;
      const net = inAmt - outAmt;

      if (net > 0.00000001) {
        netTokensIn.push({ symbol, amount: net, contractAddress });
      } else if (net < -0.00000001) {
        netTokensOut.push({ symbol, amount: Math.abs(net), contractAddress });
      }
      // If net ≈ 0, the token cancels out (wrap/unwrap)
    }

    const hasIn = netTokensIn.length > 0;
    const hasOut = netTokensOut.length > 0;

    let tag: string;
    if (hasIn && hasOut) {
      tag = 'swap';
    } else if (hasIn) {
      tag = 'Transfer In';
    } else if (hasOut) {
      tag = 'Transfer Out';
    } else if (walletInitiated && feeRaw > 0) {
      tag = 'fee';
    } else {
      continue;
    }

    // Determine if this is a multi-asset transaction (2+ tokens on either side)
    const isMultiAsset = netTokensIn.length > 1 || netTokensOut.length > 1;

    // Helper to format token amount
    const fmtAmt = (amt: number) => amt.toFixed(8).replace(/\.?0+$/, '');

    // Create transaction records
    if (tag === 'swap') {
      if (!isMultiAsset) {
        // Simple swap: 1 token in, 1 token out -> Standard CSV
        const sentToken = netTokensOut[0];
        const recvToken = netTokensIn[0];
        results.push({
          ...baseTx,
          isMultiAsset: false,
          sentQty: fmtAmt(sentToken.amount),
          sentCurrency: sentToken.symbol,
          sentContractAddress: sentToken.contractAddress,
          receivedQty: fmtAmt(recvToken.amount),
          receivedCurrency: recvToken.symbol,
          receivedContractAddress: recvToken.contractAddress,
          feeAmount: walletInitiated ? feeAmount : '',
          feeCurrency: walletInitiated ? feeCurrency : '',
          tag: 'swap',
          notes: txNote || 'Swap',
        });
      } else {
        // Multi-asset swap: 2+ tokens on either side -> Multi-Asset CSV
        const maxRows = Math.max(Math.ceil(netTokensIn.length / 2), Math.ceil(netTokensOut.length / 2));

        for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
          const recv1 = netTokensIn[rowIdx * 2] || null;
          const recv2 = netTokensIn[rowIdx * 2 + 1] || null;
          const sent1 = netTokensOut[rowIdx * 2] || null;
          const sent2 = netTokensOut[rowIdx * 2 + 1] || null;

          results.push({
            ...baseTx,
            isMultiAsset: true,
            receivedQty: recv1 ? fmtAmt(recv1.amount) : '',
            receivedCurrency: recv1?.symbol || '',
            receivedContractAddress: recv1?.contractAddress,
            sentQty: sent1 ? fmtAmt(sent1.amount) : '',
            sentCurrency: sent1?.symbol || '',
            sentContractAddress: sent1?.contractAddress,
            receivedQty2: recv2 ? fmtAmt(recv2.amount) : '',
            receivedCurrency2: recv2?.symbol || '',
            receivedContractAddress2: recv2?.contractAddress,
            sentQty2: sent2 ? fmtAmt(sent2.amount) : '',
            sentCurrency2: sent2?.symbol || '',
            sentContractAddress2: sent2?.contractAddress,
            feeAmount: rowIdx === 0 && walletInitiated ? feeAmount : '',
            feeCurrency: rowIdx === 0 && walletInitiated ? feeCurrency : '',
            tag: 'swap',
            notes: txNote || 'Swap',
          });
        }
      }
    } else if (tag === 'Transfer In') {
      if (netTokensIn.length === 1) {
        const t = netTokensIn[0];
        results.push({
          ...baseTx,
          isMultiAsset: false,
          receivedQty: fmtAmt(t.amount),
          receivedCurrency: t.symbol,
          receivedContractAddress: t.contractAddress,
          tag: 'Transfer In',
          notes: txNote || 'Received',
        });
      } else {
        const maxRows = Math.ceil(netTokensIn.length / 2);
        for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
          const recv1 = netTokensIn[rowIdx * 2] || null;
          const recv2 = netTokensIn[rowIdx * 2 + 1] || null;
          results.push({
            ...baseTx,
            isMultiAsset: true,
            receivedQty: recv1 ? fmtAmt(recv1.amount) : '',
            receivedCurrency: recv1?.symbol || '',
            receivedContractAddress: recv1?.contractAddress,
            receivedQty2: recv2 ? fmtAmt(recv2.amount) : '',
            receivedCurrency2: recv2?.symbol || '',
            receivedContractAddress2: recv2?.contractAddress,
            tag: 'Transfer In',
            notes: txNote || 'Received',
          });
        }
      }
    } else if (tag === 'Transfer Out') {
      if (netTokensOut.length === 1) {
        const t = netTokensOut[0];
        results.push({
          ...baseTx,
          isMultiAsset: false,
          sentQty: fmtAmt(t.amount),
          sentCurrency: t.symbol,
          sentContractAddress: t.contractAddress,
          feeAmount: walletInitiated ? feeAmount : '',
          feeCurrency: walletInitiated ? feeCurrency : '',
          tag: 'Transfer Out',
          notes: txNote || 'Sent',
        });
      } else {
        const maxRows = Math.ceil(netTokensOut.length / 2);
        for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
          const sent1 = netTokensOut[rowIdx * 2] || null;
          const sent2 = netTokensOut[rowIdx * 2 + 1] || null;
          results.push({
            ...baseTx,
            isMultiAsset: true,
            sentQty: sent1 ? fmtAmt(sent1.amount) : '',
            sentCurrency: sent1?.symbol || '',
            sentContractAddress: sent1?.contractAddress,
            sentQty2: sent2 ? fmtAmt(sent2.amount) : '',
            sentCurrency2: sent2?.symbol || '',
            sentContractAddress2: sent2?.contractAddress,
            feeAmount: rowIdx === 0 && walletInitiated ? feeAmount : '',
            feeCurrency: rowIdx === 0 && walletInitiated ? feeCurrency : '',
            tag: 'Transfer Out',
            notes: txNote || 'Sent',
          });
        }
      }
    } else if (tag === 'fee') {
      results.push({
        ...baseTx,
        isMultiAsset: false,
        feeAmount,
        feeCurrency,
        tag: 'fee',
        notes: txNote || 'Contract interaction',
      });
    }
  }

  return results;
}

// Generate CSV - same format as page.jsx
function generateCSV(transactions: ParsedTx[]): string {
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
    tx.dateFormatted,
    tx.receivedQty || '',
    tx.receivedCurrency || '',
    tx.receivedFiat || '',
    tx.sentQty || '',
    tx.sentCurrency || '',
    tx.sentFiat || '',
    tx.feeAmount || '',
    tx.feeCurrency || '',
    tx.txHash || '',
    tx.notes || '',
    tx.tag || '',
  ]);

  const escapeCell = (cell: string) => {
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

// Generate Multi-Asset CSV - Awaken Tax multi-asset format
function generateMultiAssetCSV(transactions: ParsedTx[]): string {
  const headers = [
    'Date',
    'Received Quantity',
    'Received Currency',
    'Received Fiat Amount',
    'Sent Quantity',
    'Sent Currency',
    'Sent Fiat Amount',
    'Received Quantity 2',
    'Received Currency 2',
    'Sent Quantity 2',
    'Sent Currency 2',
    'Fee Amount',
    'Fee Currency',
    'Notes',
    'Tag'
  ];

  const rows = transactions.map(tx => [
    tx.dateFormatted,
    tx.receivedQty || '',
    tx.receivedCurrency || '',
    tx.receivedFiat || '',
    tx.sentQty || '',
    tx.sentCurrency || '',
    tx.sentFiat || '',
    tx.receivedQty2 || '',
    tx.receivedCurrency2 || '',
    tx.sentQty2 || '',
    tx.sentCurrency2 || '',
    tx.feeAmount || '',
    tx.feeCurrency || '',
    tx.notes || '',
    tx.tag || '',
  ]);

  const escapeCell = (cell: string) => {
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

// Fetch prices for transactions
async function fetchPrices(
  transactions: ParsedTx[],
  chainId: string,
  baseUrl: string
): Promise<{ prices: Record<string, number | null>; sources: Record<string, string>; missing: string[] }> {
  const priceRequests: { token: string; timestamp: number; address?: string }[] = [];
  const seen = new Set<string>();

  for (const tx of transactions) {
    if (tx.receivedCurrency) {
      const key = `${tx.receivedCurrency}|${tx.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        priceRequests.push({
          token: tx.receivedCurrency,
          timestamp: tx.timestamp,
          address: tx.receivedContractAddress,
        });
      }
    }
    if (tx.sentCurrency) {
      const key = `${tx.sentCurrency}|${tx.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        priceRequests.push({
          token: tx.sentCurrency,
          timestamp: tx.timestamp,
          address: tx.sentContractAddress,
        });
      }
    }
    // Multi-asset: request prices for second tokens
    if (tx.receivedCurrency2) {
      const key = `${tx.receivedCurrency2}|${tx.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        priceRequests.push({
          token: tx.receivedCurrency2,
          timestamp: tx.timestamp,
          address: tx.receivedContractAddress2,
        });
      }
    }
    if (tx.sentCurrency2) {
      const key = `${tx.sentCurrency2}|${tx.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        priceRequests.push({
          token: tx.sentCurrency2,
          timestamp: tx.timestamp,
          address: tx.sentContractAddress2,
        });
      }
    }
  }

  if (priceRequests.length === 0) {
    return { prices: {}, sources: {}, missing: [] };
  }

  const allPrices: Record<string, number | null> = {};
  const allSources: Record<string, string> = {};
  const allMissing: string[] = [];

  // Batch requests in groups of 10
  for (let i = 0; i < priceRequests.length; i += 10) {
    const batch = priceRequests.slice(i, i + 10);

    try {
      const response = await fetch(`${baseUrl}/api/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: batch, chain: chainId }),
      });

      if (response.ok) {
        const data = await response.json();
        Object.assign(allPrices, data.prices || {});
        Object.assign(allSources, data.sources || {});
        if (data.missing) allMissing.push(...data.missing);
      }
    } catch (e) {
      // Continue on error
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  return { prices: allPrices, sources: allSources, missing: allMissing };
}

// Apply prices to transactions
function applyPrices(transactions: ParsedTx[], prices: Record<string, number | null>): void {
  for (const tx of transactions) {
    const receivedQty = tx.receivedQty ? parseFloat(tx.receivedQty) : 0;
    const sentQty = tx.sentQty ? parseFloat(tx.sentQty) : 0;

    if (receivedQty > 0 && tx.receivedCurrency) {
      const key = `${tx.receivedCurrency.toUpperCase()}-${tx.timestamp}`;
      const price = prices[key];
      if (price !== null && price !== undefined) {
        tx.receivedFiat = (receivedQty * price).toFixed(2);
      }
    }

    if (sentQty > 0 && tx.sentCurrency) {
      const key = `${tx.sentCurrency.toUpperCase()}-${tx.timestamp}`;
      const price = prices[key];
      if (price !== null && price !== undefined) {
        tx.sentFiat = (sentQty * price).toFixed(2);
      }
    }

    // Handle second tokens for multi-asset transactions
    const receivedQty2 = tx.receivedQty2 ? parseFloat(tx.receivedQty2) : 0;
    const sentQty2 = tx.sentQty2 ? parseFloat(tx.sentQty2) : 0;

    if (receivedQty2 > 0 && tx.receivedCurrency2) {
      const key = `${tx.receivedCurrency2.toUpperCase()}-${tx.timestamp}`;
      const price = prices[key];
      if (price !== null && price !== undefined) {
        tx.receivedFiat2 = (receivedQty2 * price).toFixed(2);
      }
    }

    if (sentQty2 > 0 && tx.sentCurrency2) {
      const key = `${tx.sentCurrency2.toUpperCase()}-${tx.timestamp}`;
      const price = prices[key];
      if (price !== null && price !== undefined) {
        tx.sentFiat2 = (sentQty2 * price).toFixed(2);
      }
    }
  }
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
  const { searchParams } = requestUrl;
  const address = searchParams.get('address');
  const chainId = searchParams.get('chain') || 'celo';
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const limit = parseInt(searchParams.get('limit') || '500');
  const format = searchParams.get('format') || 'csv'; // csv or json
  const skipPrices = searchParams.get('skipPrices') === 'true';

  // Get chain config
  const config = getChain(chainId) || defaultChain;

  if (!address || !config.validateAddress(address)) {
    return Response.json({ error: `Invalid ${config.name} address` }, { status: 400 });
  }

  try {
    // Fetch all transactions
    const allRawTxs: any[] = [];
    const allTokenTransfers: any[] = [];
    let hasMore = true;
    let skip = 0;

    while (hasMore && allRawTxs.length < limit) {
      const txUrl = config.transactionApi.buildUrl(address, 100, skip);
      const tokenTxUrl = txUrl.replace('action=txlist', 'action=tokentx');

      const [txResponse, tokenResponse] = await Promise.all([
        fetch(txUrl, { headers: { 'Accept': 'application/json' } }),
        fetch(tokenTxUrl, { headers: { 'Accept': 'application/json' } }),
      ]);

      if (!txResponse.ok) {
        throw new Error(`${config.name} API error: ${txResponse.status}`);
      }

      const txData = await txResponse.json();
      const tokenData = tokenResponse.ok ? await tokenResponse.json() : { result: [] };

      const txs = txData.result || [];
      const tokenTransfers = tokenData.result || [];

      if (txs.length === 0) {
        hasMore = false;
      } else {
        // Filter by date range
        for (const tx of txs) {
          const txTimestamp = tx.timeStamp ? parseInt(tx.timeStamp) * 1000 : null;
          const txDate = txTimestamp ? new Date(txTimestamp).toISOString().split('T')[0] : null;

          if (txDate && startDate && txDate < startDate) {
            hasMore = false;
            break;
          }
          if (txDate && endDate && txDate > endDate) continue;

          allRawTxs.push(tx);
        }

        allTokenTransfers.push(...tokenTransfers);
        skip += 100;
        if (txs.length < 100) hasMore = false;
      }

      // Small delay
      await new Promise(r => setTimeout(r, 50));
    }

    // Parse transactions
    const parsedTxs = parseTransactionsWithTokens(
      allRawTxs,
      allTokenTransfers,
      address,
      config.nativeToken.symbol
    );

    // Filter by date range
    let filteredTxs = parsedTxs;
    if (startDate) {
      filteredTxs = filteredTxs.filter(tx => tx.dateStr >= startDate);
    }
    if (endDate) {
      filteredTxs = filteredTxs.filter(tx => tx.dateStr <= endDate);
    }

    // Sort by date ascending
    filteredTxs.sort((a, b) => new Date(a.dateStr).getTime() - new Date(b.dateStr).getTime());

    // Fetch and apply prices
    let priceInfo = { prices: {}, sources: {}, missing: [] as string[] };
    if (!skipPrices && filteredTxs.length > 0) {
      priceInfo = await fetchPrices(filteredTxs, chainId, baseUrl);
      applyPrices(filteredTxs, priceInfo.prices);
    }

    // Sort by date descending for output
    filteredTxs.sort((a, b) => new Date(b.dateStr).getTime() - new Date(a.dateStr).getTime());

    // Separate transactions by type
    const simpleTxs = filteredTxs.filter(tx => !tx.isMultiAsset);
    const multiAssetTxs = filteredTxs.filter(tx => tx.isMultiAsset);

    // Calculate stats
    const tagCounts: Record<string, number> = {};
    filteredTxs.forEach(tx => {
      tagCounts[tx.tag] = (tagCounts[tx.tag] || 0) + 1;
    });

    if (format === 'json') {
      return Response.json({
        transactions: filteredTxs,
        stats: {
          total: filteredTxs.length,
          simple: simpleTxs.length,
          multiAsset: multiAssetTxs.length,
          tagCounts,
          missingPrices: priceInfo.missing.length,
        },
        chain: config.name,
        chainId: config.id,
      });
    }

    // Generate CSVs - standard for simple txs, multi-asset for complex txs
    const standardCsv = generateCSV(simpleTxs);
    const multiAssetCsv = generateMultiAssetCSV(multiAssetTxs);

    // Return combined CSV with header comment
    const combinedCsv = [
      '# Standard Transactions (simple swaps and transfers)',
      standardCsv,
      '',
      '# Multi-Asset Transactions (LP operations with multiple tokens)',
      multiAssetCsv,
    ].join('\n');

    return new Response(combinedCsv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${chainId}-${address.slice(0, 10)}-export.csv"`,
        'X-Total-Transactions': filteredTxs.length.toString(),
        'X-Simple-Transactions': simpleTxs.length.toString(),
        'X-Multi-Asset-Transactions': multiAssetTxs.length.toString(),
        'X-Swaps': (tagCounts['swap'] || 0).toString(),
        'X-Transfers-In': (tagCounts['Transfer In'] || 0).toString(),
        'X-Transfers-Out': (tagCounts['Transfer Out'] || 0).toString(),
        'X-Fees': (tagCounts['fee'] || 0).toString(),
        'X-Missing-Prices': priceInfo.missing.length.toString(),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 }
    );
  }
}
