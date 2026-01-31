// app/api/prices/route.ts
// Fetches historical prices from Injective DEX trades (chain-specific)
// Falls back to Pyth Benchmarks API for tokens without DEX liquidity

// Injective Exchange Indexer endpoints
const INJECTIVE_EXCHANGE_API = 'https://sentry.exchange.grpc-web.injective.network';
const INJECTIVE_LCD_API = 'https://lcd.injective.network';
const PYTH_BENCHMARKS_API = 'https://benchmarks.pyth.network';

// Token to market ID mapping (quote asset is USDT)
// These are the primary markets for pricing each token
const TOKEN_MARKETS: Record<string, { marketId: string; baseDecimals: number; quoteDecimals: number }> = {
  'INJ': {
    marketId: '0xa508cb32923323679f29a032c70342c147c17d0145625922b0ef22e955c844c0',
    baseDecimals: 18,
    quoteDecimals: 6,
  },
  'WETH': {
    marketId: '0xd1956e20d74eeb1febe31cd37060781ff1cb266f49e0512b446a5fafa9a16034',
    baseDecimals: 18,
    quoteDecimals: 6,
  },
  'ATOM': {
    marketId: '0x0511ddc4e6586f3bfe1acb2dd905f8b8a82c97e1edaef654b12ca7e6031ca0fa',
    baseDecimals: 6,
    quoteDecimals: 6,
  },
  'SOL': {
    marketId: '0x9b3fa54bef33fd216b84614cd8abc3e5cc134727a511cef37d366ecaf3e03a80',
    baseDecimals: 9,
    quoteDecimals: 6,
  },
  'TIA': {
    marketId: '0xce1829d4942ed939580e72e66fd8be3502396fc840b6d12b2d676bdb86542363',
    baseDecimals: 6,
    quoteDecimals: 6,
  },
  // Add more markets as needed
};

// Pyth price feed IDs for fallback
const PYTH_PRICE_IDS: Record<string, string> = {
  'INJ': 'Crypto.INJ/USD',
  'ETH': 'Crypto.ETH/USD',
  'WETH': 'Crypto.ETH/USD',
  'BTC': 'Crypto.BTC/USD',
  'WBTC': 'Crypto.BTC/USD',
  'ATOM': 'Crypto.ATOM/USD',
  'SOL': 'Crypto.SOL/USD',
  'USDT': 'Crypto.USDT/USD',
  'USDC': 'Crypto.USDC/USD',
  'TIA': 'Crypto.TIA/USD',
  'OSMO': 'Crypto.OSMO/USD',
  'AVAX': 'Crypto.AVAX/USD',
  'MATIC': 'Crypto.MATIC/USD',
  'LINK': 'Crypto.LINK/USD',
  'UNI': 'Crypto.UNI/USD',
  'BNB': 'Crypto.BNB/USD',
};

// In-memory cache: { price, source } or null
interface PriceResult {
  price: number;
  source: 'injective-dex' | 'pyth';
}
const priceCache: Map<string, PriceResult | null> = new Map();

// Convert raw price from Injective trade to USD
function calculatePrice(rawPrice: string, baseDecimals: number, quoteDecimals: number): number {
  return parseFloat(rawPrice) * Math.pow(10, baseDecimals - quoteDecimals);
}

// Get historical price from Injective DEX trades
async function getInjectiveDexPrice(symbol: string, timestamp: number): Promise<number | null> {
  const market = TOKEN_MARKETS[symbol];
  if (!market) return null;

  try {
    // Fetch trades around the timestamp (±2 hour window)
    const startTime = timestamp - 2 * 60 * 60 * 1000;
    const endTime = timestamp + 2 * 60 * 60 * 1000;

    const url = `${INJECTIVE_EXCHANGE_API}/api/exchange/spot/v2/trades?marketId=${market.marketId}&startTime=${startTime}&endTime=${endTime}&limit=100`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.trades?.length) return null;

    // Find trade closest to timestamp
    const closest = data.trades.reduce((prev: any, curr: any) => {
      return Math.abs(curr.executedAt - timestamp) < Math.abs(prev.executedAt - timestamp) ? curr : prev;
    });

    // Convert price accounting for decimals
    const price = calculatePrice(closest.price.price, market.baseDecimals, market.quoteDecimals);
    return price > 0 ? price : null;
  } catch (e) {
    return null;
  }
}

// Get historical price from Pyth Benchmarks API (fallback - cross-chain)
async function getPythPrice(symbol: string, date: string): Promise<number | null> {
  const pythSymbol = PYTH_PRICE_IDS[symbol];
  if (!pythSymbol) return null;

  try {
    // Convert date to Unix timestamp
    const [year, month, day] = date.split('-');
    const startDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

    const fromTs = Math.floor(startDate.getTime() / 1000);
    const toTs = Math.floor(endDate.getTime() / 1000);

    const url = `${PYTH_BENCHMARKS_API}/v1/shims/tradingview/history?symbol=${pythSymbol}&resolution=D&from=${fromTs}&to=${toTs}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.s !== 'ok' || !data.c?.length) return null;

    // Use closing price
    return data.c[0];
  } catch (e) {
    return null;
  }
}

// Main price fetching function - tries Injective DEX first, then Pyth
async function getHistoricalPrice(symbol: string, date: string): Promise<PriceResult | null> {
  // Convert date to timestamp (noon UTC for consistency)
  const [year, month, day] = date.split('-');
  const timestamp = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0)).getTime();

  // 1. Try Injective DEX (chain-specific prices)
  const dexPrice = await getInjectiveDexPrice(symbol, timestamp);
  if (dexPrice !== null) {
    return { price: dexPrice, source: 'injective-dex' };
  }

  // 2. Fallback to Pyth (cross-chain aggregated)
  const pythPrice = await getPythPrice(symbol, date);
  if (pythPrice !== null) {
    return { price: pythPrice, source: 'pyth' };
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { requests } = body;

    if (!requests || !Array.isArray(requests)) {
      return Response.json({ error: 'requests array required' }, { status: 400 });
    }

    // Results: { price, source } for found prices, null for missing
    const results: Record<string, { price: number; source: string } | null> = {};
    const missing: string[] = [];
    const sources: Record<string, string> = {};

    for (const req of requests) {
      const { token, date } = req;
      const symbol = token?.toUpperCase();
      const cacheKey = `${symbol}-${date}`;

      // Check cache first
      if (priceCache.has(cacheKey)) {
        const cached = priceCache.get(cacheKey);
        if (cached) {
          results[cacheKey] = { price: cached.price, source: cached.source };
          sources[cacheKey] = cached.source;
        } else {
          results[cacheKey] = null;
          missing.push(`${symbol} on ${date}`);
        }
        continue;
      }

      // Fetch price
      const result = await getHistoricalPrice(symbol, date);

      if (result) {
        results[cacheKey] = { price: result.price, source: result.source };
        sources[cacheKey] = result.source;
        priceCache.set(cacheKey, result);
      } else {
        results[cacheKey] = null;
        priceCache.set(cacheKey, null);
        missing.push(`${symbol} on ${date}`);
      }

      // Small delay to prevent rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    return Response.json({
      prices: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, v?.price ?? null])
      ),
      sources,
      missing: missing.length > 0 ? missing : undefined,
      warning: missing.length > 0
        ? `Could not find prices for ${missing.length} token/date combinations. These will need manual review.`
        : undefined
    });

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
  const dateStr = date || new Date().toISOString().split('T')[0];
  const cacheKey = `${symbol}-${dateStr}`;

  // Check cache
  if (priceCache.has(cacheKey)) {
    const cached = priceCache.get(cacheKey);
    return Response.json({
      price: cached?.price ?? null,
      source: cached?.source ?? null,
      warning: cached === null ? `Price not available for ${symbol} on ${dateStr}` : undefined
    });
  }

  // Fetch price
  const result = await getHistoricalPrice(symbol, dateStr);
  priceCache.set(cacheKey, result);

  return Response.json({
    price: result?.price ?? null,
    source: result?.source ?? null,
    warning: result === null ? `Price not available for ${symbol} on ${dateStr}` : undefined
  });
}
