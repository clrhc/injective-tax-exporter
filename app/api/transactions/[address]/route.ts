// app/api/transactions/[address]/route.js
// Uses official Injective Indexer REST API (no API key needed)

const INDEXER_BASE = 'https://sentry.exchange.grpc-web.injective.network';
const EXPLORER_API = `${INDEXER_BASE}/api/explorer/v1`;

export async function GET(request, { params }) {
  const resolvedParams = await params;
  const address = resolvedParams.address;
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get('limit') || '100';
  const skip = searchParams.get('skip') || '0';
  const type = searchParams.get('type') || 'transactions'; // transactions, trades, portfolio

  if (!address || !address.startsWith('inj1')) {
    return Response.json({ error: 'Invalid Injective address' }, { status: 400 });
  }

  try {
    let url;
    
    if (type === 'transactions') {
      url = `${EXPLORER_API}/accountTxs/${address}?limit=${limit}&skip=${skip}`;
    } else if (type === 'portfolio') {
      // Fetch portfolio for subaccount balances and positions
      url = `${INDEXER_BASE}/api/account/v1/portfolio/${address}`;
    }
    
    console.log('Fetching:', url);
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Injective API Error:', response.status, errorText);
      return Response.json(
        { error: `Injective API error: ${response.status}`, details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    return Response.json(data);

  } catch (error) {
    console.error('Fetch Error:', error.message);
    return Response.json(
      { error: error.message || 'Failed to fetch data' },
      { status: 500 }
    );
  }
}