// app/api/transactions/[address]/route.ts
// Fetches transaction history from Kujira RPC API (tx_search endpoint)

const KUJIRA_RPC = 'https://kujira-rpc.publicnode.com';

// Cache for block timestamps to avoid repeated fetches
const blockTimestampCache: Map<string, string> = new Map();

async function getBlockTimestamp(height: string): Promise<string | null> {
  if (blockTimestampCache.has(height)) {
    return blockTimestampCache.get(height) || null;
  }

  try {
    const response = await fetch(`${KUJIRA_RPC}/block?height=${height}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return null;

    const data = await response.json();
    const timestamp = data.result?.block?.header?.time;
    if (timestamp) {
      blockTimestampCache.set(height, timestamp);
    }
    return timestamp || null;
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const resolvedParams = await params;
  const address = resolvedParams.address;
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 100);
  const skip = parseInt(searchParams.get('skip') || '0');

  // Convert skip to page number (1-indexed for RPC)
  const page = Math.floor(skip / limit) + 1;

  if (!address || !address.startsWith('kujira1')) {
    return Response.json({ error: 'Invalid Kujira address' }, { status: 400 });
  }

  try {
    // Use RPC tx_search endpoint which has full transaction indexing
    // Query for transactions where this address is the sender
    const query = `"message.sender='${address}'"`;
    const rpcUrl = `${KUJIRA_RPC}/tx_search?query=${encodeURIComponent(query)}&per_page=${limit}&page=${page}&order_by="desc"`;

    const response = await fetch(rpcUrl, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Kujira RPC error:', errorText);
      return Response.json(
        { error: `Kujira API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const result = data.result || {};
    const txs = result.txs || [];

    // Fetch block timestamps for all unique heights
    const uniqueHeights = [...new Set(txs.map((tx: any) => tx.height))];
    await Promise.all(uniqueHeights.map((h: string) => getBlockTimestamp(h)));

    // Transform RPC response to match expected format
    const transactions = txs.map((txData: any) => {
      const txResult = txData.tx_result || {};
      const height = txData.height;

      // Parse events to extract transaction details
      // RPC returns base64 encoded keys/values
      const events = (txResult.events || []).map((event: any) => ({
        type: event.type,
        attributes: (event.attributes || []).map((attr: any) => ({
          key: attr.key ? Buffer.from(attr.key, 'base64').toString() : '',
          value: attr.value ? Buffer.from(attr.value, 'base64').toString() : '',
        })),
      }));

      // Get timestamp from cache
      const blockTimestamp = blockTimestampCache.get(height) || null;

      // Parse the log to extract structured data
      let logs: any[] = [];
      try {
        if (txResult.log) {
          logs = JSON.parse(txResult.log);
        }
      } catch {
        // Log might not be valid JSON
      }

      return {
        hash: txData.hash,
        blockTimestamp: blockTimestamp,
        height: height,
        code: txResult.code || 0,
        gasUsed: txResult.gas_used,
        gasWanted: txResult.gas_wanted,
        logs: logs,
        events: events,
        tx: {},
        messages: [],
        fee: null,
        memo: '',
        rawLog: txResult.log,
      };
    });

    return Response.json({
      data: transactions,
      paging: {
        total: parseInt(result.total_count || '0'),
      }
    });

  } catch (error) {
    console.error('Fetch error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch data' },
      { status: 500 }
    );
  }
}
