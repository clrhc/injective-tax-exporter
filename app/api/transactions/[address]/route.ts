// app/api/transactions/[address]/route.ts
// Generic transaction fetching API - uses chain.config.ts for chain-specific logic
// Fetches both normal transactions AND token transfers (ERC20 events)

import { getChain, defaultChain } from '../../../../chains';

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const resolvedParams = await params;
  const address = resolvedParams.address;
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '100');
  const skip = parseInt(searchParams.get('skip') || '0');
  const chainId = searchParams.get('chain') || 'celo';

  // Get chain config
  const config = getChain(chainId) || defaultChain;

  // Validate address using chain config
  if (!address || !config.validateAddress(address)) {
    return Response.json(
      { error: `Invalid ${config.name} address` },
      { status: 400 }
    );
  }

  try {
    // Build URLs for both normal txs and token transfers
    const txUrl = config.transactionApi.buildUrl(address, limit, skip);
    const tokenTxUrl = txUrl.replace('action=txlist', 'action=tokentx');

    // Fetch both in parallel
    const [txResponse, tokenResponse] = await Promise.all([
      fetch(txUrl, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      }),
      fetch(tokenTxUrl, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      }),
    ]);

    if (!txResponse.ok) {
      return Response.json(
        { error: `${config.name} API error: ${txResponse.status}` },
        { status: txResponse.status }
      );
    }

    const txData = await txResponse.json();
    const tokenData = tokenResponse.ok ? await tokenResponse.json() : { result: [] };

    // Get raw transactions and token transfers
    const rawTransactions = txData.result || txData.data || txData.txs || [];
    const tokenTransfers = tokenData.result || tokenData.data || [];

    // Mark token transfers with a flag so frontend can identify them
    const markedTokenTransfers = tokenTransfers.map((t: any) => ({
      ...t,
      _isTokenTransfer: true,
    }));

    // Get paging info
    const paging = config.transactionApi.getPagingInfo?.(txData) || {
      total: rawTransactions.length,
      hasMore: rawTransactions.length >= limit,
    };

    return Response.json({
      data: rawTransactions,
      tokenTransfers: markedTokenTransfers,
      paging,
      chain: config.name,
      chainId: config.id,
    });

  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch data' },
      { status: 500 }
    );
  }
}
