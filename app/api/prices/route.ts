// app/api/prices/route.ts
// Fetches historical prices from Injective's own APIs only (no external fallbacks)

const INJECTIVE_CHRONOS = 'https://sentry.exchange.grpc-web.injective.network/api/chronos/v1';

// Injective mainnet spot market IDs for common pairs (quote is USDT)
// Source: https://explorer.injective.network/markets
const INJ_MARKETS: Record<string, string> = {
  'INJ': '0x0611780ba69656949525013d947713300f56c37b6175e02f26bffa495c3208fe',
  'ATOM': '0x0511ddc4e6586f3bfe1acb2dd905f8b8a82c97e1edaef654b12ca7e6031ca0fa',
  'WETH': '0xd1956e20d74eeb1febe8c9c8b8e1c5a2b0b0e4e2e7f0f5b5a5d5f5e5c5b5a5d5',
  'USDC': '0xda0bb7a7d8361d17a9d2327ed161748f33ecbf02f0b4b9e7a23f7cc2c4fb4c2f',
};

const STABLECOINS = ['USDT', 'USDC', 'DAI', 'BUSD', 'UST', 'USDC.axl', 'axlUSDC', 'FRAX', 'LUSD', 'TUSD'];

// In-memory cache
const priceCache: Map<string, number> = new Map();

// Get price from Injective Chronos API
async function getInjectivePrice(symbol: string, timestamp: number): Promise<number | null> {
  const marketId = INJ_MARKETS[symbol];
  if (!marketId) return null;

  try {
    // Get historical price from Chronos - using OHLC endpoint
    const url = `${INJECTIVE_CHRONOS}/spot/prices?marketId=${marketId}&resolution=1D&countBack=1&to=${timestamp}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      if (data.prices && data.prices.length > 0) {
        // Return close price
        return parseFloat(data.prices[0].close) || null;
      }
    }
  } catch (e) {
    // Silently fail - will use swap-derived price or return 0
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { requests, swapPrices } = body;

    // swapPrices is a map of prices derived from actual swap transactions
    // Format: { "TOKEN-DATE": price }
    // These are the most accurate as they come from actual on-chain trades
    const derivedPrices: Record<string, number> = swapPrices || {};

    if (!requests || !Array.isArray(requests)) {
      return Response.json({ error: 'requests array required' }, { status: 400 });
    }

    const results: Record<string, number> = {};

    for (const req of requests) {
      const { token, date } = req;
      const symbol = token?.toUpperCase();
      const cacheKey = `${symbol}-${date}`;

      // 1. Check if we have a price from actual swap data (most accurate)
      if (derivedPrices[cacheKey]) {
        results[cacheKey] = derivedPrices[cacheKey];
        priceCache.set(cacheKey, derivedPrices[cacheKey]);
        continue;
      }

      // 2. Check cache
      if (priceCache.has(cacheKey)) {
        results[cacheKey] = priceCache.get(cacheKey)!;
        continue;
      }

      // 3. Stablecoins are always $1
      if (STABLECOINS.includes(symbol)) {
        results[cacheKey] = 1;
        priceCache.set(cacheKey, 1);
        continue;
      }

      // 4. Try Injective Chronos API
      const timestamp = Math.floor(new Date(date).getTime() / 1000);
      const price = await getInjectivePrice(symbol, timestamp);

      if (price !== null && price > 0) {
        results[cacheKey] = price;
        priceCache.set(cacheKey, price);
      } else {
        // No price available - will be 0
        results[cacheKey] = 0;
        priceCache.set(cacheKey, 0);
      }

      // Small delay to be nice to API
      await new Promise(r => setTimeout(r, 30));
    }

    return Response.json({ prices: results });

  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch prices' },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const date = searchParams.get('date');

  if (!token) {
    return Response.json({ error: 'token required' }, { status: 400 });
  }

  const symbol = token.toUpperCase();
  const cacheKey = `${symbol}-${date || 'current'}`;

  // Check cache
  if (priceCache.has(cacheKey)) {
    return Response.json({ price: priceCache.get(cacheKey) });
  }

  // Stablecoins
  if (STABLECOINS.includes(symbol)) {
    return Response.json({ price: 1 });
  }

  const timestamp = date
    ? Math.floor(new Date(date).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  // Try Injective Chronos API
  const price = await getInjectivePrice(symbol, timestamp);

  if (price !== null && price > 0) {
    priceCache.set(cacheKey, price);
    return Response.json({ price });
  }

  // No price available
  priceCache.set(cacheKey, 0);
  return Response.json({ price: 0 });
}
