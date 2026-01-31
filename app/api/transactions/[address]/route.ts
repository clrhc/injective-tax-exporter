// app/api/transactions/[address]/route.js
// Uses official Injective Indexer REST API (no API key needed)

const INDEXER_BASE = 'https://sentry.exchange.grpc-web.injective.network';
const EXPLORER_API = `${INDEXER_BASE}/api/explorer/v1`;
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json';

// Cache token metadata
let tokenCache = null;
let tokenCacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour

async function fetchTokenMetadata() {
  const now = Date.now();
  if (tokenCache && (now - tokenCacheTime) < CACHE_TTL) {
    return tokenCache;
  }
  
  try {
    const response = await fetch(TOKEN_LIST_URL);
    if (response.ok) {
      const tokens = await response.json();
      // Build lookup map by denom
      const tokenMap = {};
      for (const token of tokens) {
        if (token.denom) {
          tokenMap[token.denom.toLowerCase()] = {
            symbol: token.symbol || token.name || token.denom,
            name: token.name || token.symbol,
            decimals: token.decimals || 18,
            logo: token.logo || null
          };
        }
        // Also map by address for peggy tokens
        if (token.address) {
          tokenMap[`peggy${token.address}`.toLowerCase()] = {
            symbol: token.symbol || token.name,
            name: token.name || token.symbol,
            decimals: token.decimals || 18,
            logo: token.logo || null
          };
        }
      }
      tokenCache = tokenMap;
      tokenCacheTime = now;
      console.log(`Loaded ${Object.keys(tokenMap).length} tokens from Injective list`);
      return tokenMap;
    }
  } catch (err) {
    console.error('Failed to fetch token metadata:', err.message);
  }
  return tokenCache || {};
}

export async function GET(request, { params }) {
  const resolvedParams = await params;
  const address = resolvedParams.address;
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get('limit') || '100';
  const skip = searchParams.get('skip') || '0';
  const type = searchParams.get('type') || 'transactions';

  if (!address || !address.startsWith('inj1')) {
    return Response.json({ error: 'Invalid Injective address' }, { status: 400 });
  }

  try {
    // If requesting token metadata
    if (type === 'tokens') {
      const tokens = await fetchTokenMetadata();
      return Response.json({ tokens });
    }
    
    // Default: fetch transactions
    const url = `${EXPLORER_API}/accountTxs/${address}?limit=${limit}&skip=${skip}`;
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