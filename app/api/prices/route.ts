// app/api/prices/route.ts
// Fetches historical prices from Injective DEX trades (chain-specific)
// Falls back to Pyth Benchmarks API for tokens without DEX liquidity

// Disable Next.js caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

interface PriceResult {
  price: number;
  source: 'injective-dex' | 'injective-dex-twohop' | 'pyth';
  intermediary?: string; // For two-hop, tracks the swap token used (e.g., 'INJ')
  tradeTimestamp?: number; // Actual timestamp of the trade used for pricing
  timeDiffHours?: number; // Difference between requested time and trade time
}

interface MarketInfo {
  marketId: string;
  ticker: string;
  baseDenom: string;
  quoteDenom: string;
  quoteSymbol: string; // e.g., 'INJ', 'USDT'
  baseDecimals: number;
  quoteDecimals: number;
}

// Convert raw price from Injective trade to USD
function calculatePrice(rawPrice: string, baseDecimals: number, quoteDecimals: number): number {
  return parseFloat(rawPrice) * Math.pow(10, baseDecimals - quoteDecimals);
}

// Convert block height to timestamp
async function getBlockTimestamp(blockHeight: number): Promise<number | null> {
  try {
    // Query the block before the target to get its timestamp
    const url = `${INJECTIVE_EXCHANGE_API}/api/explorer/v1/blocks?before=${blockHeight + 1}&limit=1`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.data?.[0]?.timestamp) return null;

    // Parse timestamp string like "2025-05-07 13:12:45.9 +0000 UTC"
    const tsString = data.data[0].timestamp;
    const date = new Date(tsString.replace(' UTC', 'Z').replace(' +0000', ''));
    return date.getTime();
  } catch (e) {
    return null;
  }
}

// Cache markets for 5 minutes to avoid repeated API calls
let marketsCache: { data: MarketInfo[]; timestamp: number } | null = null;
const MARKETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch all spot markets from Injective LCD (includes all memecoins)
async function getAllMarkets(): Promise<MarketInfo[]> {
  // Return cached markets if still valid
  if (marketsCache && Date.now() - marketsCache.timestamp < MARKETS_CACHE_TTL) {
    return marketsCache.data;
  }

  try {
    // Use LCD endpoint which has ALL markets including memecoins
    const url = `${INJECTIVE_LCD_API}/injective/exchange/v1beta1/spot/markets?status=Active`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) return marketsCache?.data || [];

    const data = await response.json();
    if (!data.markets) return marketsCache?.data || [];

    // Map to simplified structure and identify quote symbols
    return data.markets.map((m: any) => {
      const quoteDenom = m.quote_denom || '';
      const baseDenom = m.base_denom || '';
      const ticker = m.ticker || ''; // Use actual ticker from API

      let quoteSymbol = 'UNKNOWN';
      if (quoteDenom === 'inj') quoteSymbol = 'INJ';
      else if (quoteDenom.toLowerCase().includes('peggy0xdac17f958d2ee523a2206206994597c13d831ec7')) quoteSymbol = 'USDT';
      else if (quoteDenom.toLowerCase().includes('peggy0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')) quoteSymbol = 'USDC';
      else if (ticker.includes('/')) quoteSymbol = ticker.split('/')[1] || 'UNKNOWN';

      return {
        marketId: m.market_id,
        ticker,
        baseDenom,
        quoteDenom,
        quoteSymbol,
        baseDecimals: m.base_decimals ?? 18,
        quoteDecimals: m.quote_decimals ?? 18,
      };
    });
  } catch (e) {
    console.error('getAllMarkets error:', e);
    return [];
  }
}

// Find markets for a given token (by symbol in ticker)
async function findMarketsForToken(symbol: string): Promise<MarketInfo[]> {
  const markets = await getAllMarkets();
  const upperSymbol = symbol.toUpperCase();

  return markets.filter(m => {
    // Primary: match ticker base (e.g., "SHROOM/INJ" -> "SHROOM")
    const tickerBase = m.ticker.split('/')[0]?.toUpperCase();
    if (tickerBase === upperSymbol) return true;

    // Also match case-insensitive (hINJ vs HINJ)
    if (tickerBase?.toLowerCase() === upperSymbol.toLowerCase()) return true;

    return false;
  });
}

interface TradesPriceResult {
  rawPrice: number;
  tradeTimestamp: number; // When the trade actually occurred
}

// Get historical price from trades API (for memecoins without Chronos data)
// Returns RAW price and trade timestamp - caller must apply decimal conversion
async function getTradesPrice(marketId: string, timestamp: number): Promise<TradesPriceResult | null> {
  try {
    // Search wider window (±7 days) for memecoins with sparse trading
    const startTime = timestamp - 7 * 24 * 60 * 60 * 1000;
    const endTime = timestamp + 7 * 24 * 60 * 60 * 1000;

    const url = `${INJECTIVE_EXCHANGE_API}/api/exchange/spot/v2/trades?marketId=${marketId}&startTime=${startTime}&endTime=${endTime}&limit=100`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.trades?.length) return null;

    // Find trade closest to target timestamp
    const closest = data.trades.reduce((prev: any, curr: any) => {
      return Math.abs(curr.executedAt - timestamp) < Math.abs(prev.executedAt - timestamp) ? curr : prev;
    });

    return {
      rawPrice: parseFloat(closest.price.price),
      tradeTimestamp: closest.executedAt,
    };
  } catch (e) {
    return null;
  }
}

// Get historical OHLC price from Injective Chronos API
async function getChronosPrice(marketId: string, timestamp: number): Promise<number | null> {
  try {
    // Try minute resolution first for precision
    const url = `${INJECTIVE_EXCHANGE_API}/api/chronos/v1/spot/history?marketId=${marketId}&resolution=1&to=${Math.floor(timestamp / 1000) + 3600}&countback=120`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) {
      // Fallback to trades API
      const tradesResult = await getTradesPrice(marketId, timestamp);
      return tradesResult?.rawPrice ?? null;
    }

    const data = await response.json();
    if (data.s !== 'ok' || !data.t?.length) {
      // Fallback to daily resolution
      const dailyUrl = `${INJECTIVE_EXCHANGE_API}/api/chronos/v1/spot/history?marketId=${marketId}&resolution=1D&to=${Math.floor(timestamp / 1000) + 86400}&countback=10`;
      const dailyResponse = await fetch(dailyUrl, {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });

      if (!dailyResponse.ok) {
        // Fallback to trades API
        const tradesResult = await getTradesPrice(marketId, timestamp);
        return tradesResult?.rawPrice ?? null;
      }

      const dailyData = await dailyResponse.json();
      if (dailyData.s !== 'ok' || !dailyData.c?.length) {
        // Fallback to trades API
        const tradesResult = await getTradesPrice(marketId, timestamp);
        return tradesResult?.rawPrice ?? null;
      }

      // Find closest day
      const targetTs = Math.floor(timestamp / 1000);
      let closestIdx = 0;
      let closestDiff = Math.abs(dailyData.t[0] - targetTs);
      for (let i = 1; i < dailyData.t.length; i++) {
        const diff = Math.abs(dailyData.t[i] - targetTs);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestIdx = i;
        }
      }
      return dailyData.c[closestIdx];
    }

    // Find price closest to target timestamp (within ±1 hour)
    const targetTs = Math.floor(timestamp / 1000);
    let closestIdx = 0;
    let closestDiff = Math.abs(data.t[0] - targetTs);
    for (let i = 1; i < data.t.length; i++) {
      const diff = Math.abs(data.t[i] - targetTs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIdx = i;
      }
    }

    // Only accept if within 1 hour, otherwise try trades API
    if (closestDiff > 3600) {
      const tradesResult = await getTradesPrice(marketId, timestamp);
      return tradesResult?.rawPrice ?? null;
    }

    return data.c[closestIdx];
  } catch (e) {
    return null;
  }
}

interface ConvertedTradePrice {
  price: number;
  tradeTimestamp: number;
}

// Get price from trades API with decimal conversion
async function getTradesPriceConverted(market: MarketInfo, timestamp: number): Promise<ConvertedTradePrice | null> {
  const result = await getTradesPrice(market.marketId, timestamp);
  if (result === null) return null;
  return {
    price: calculatePrice(String(result.rawPrice), market.baseDecimals, market.quoteDecimals),
    tradeTimestamp: result.tradeTimestamp,
  };
}

// Two-hop price lookup: TOKEN/SWAP_TOKEN → SWAP_TOKEN/USD
async function getTwoHopPrice(symbol: string, timestamp: number): Promise<{ price: number; intermediary: string; tradeTimestamp: number } | null> {
  const markets = await findMarketsForToken(symbol);
  if (!markets.length) return null;

  // Prefer INJ as intermediary, then USDT, then USDC
  const priorityOrder = ['INJ', 'USDT', 'USDC'];
  const sortedMarkets = markets.sort((a, b) => {
    const aIdx = priorityOrder.indexOf(a.quoteSymbol);
    const bIdx = priorityOrder.indexOf(b.quoteSymbol);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  for (const market of sortedMarkets) {
    // Get TOKEN/QUOTE price from trades (with decimal conversion)
    const tokenResult = await getTradesPriceConverted(market, timestamp);
    if (tokenResult === null || tokenResult.price <= 0) continue;

    // If quote is USD-stable, get its actual USD price from Pyth
    if (market.quoteSymbol === 'USDT' || market.quoteSymbol === 'USDC') {
      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      const stablePrice = await getPythPrice(market.quoteSymbol, dateStr) || 1.0;
      return {
        price: tokenResult.price * stablePrice,
        intermediary: market.quoteSymbol,
        tradeTimestamp: tokenResult.tradeTimestamp,
      };
    }

    // Otherwise, get QUOTE/USD price (e.g., INJ/USDT)
    const quoteMarket = TOKEN_MARKETS[market.quoteSymbol];
    if (!quoteMarket) continue;

    // Get INJ/USDT price from trades
    const quoteResult = await getTradesPrice(quoteMarket.marketId, timestamp);
    if (quoteResult === null) continue;
    const quoteUsdPrice = calculatePrice(String(quoteResult.rawPrice), quoteMarket.baseDecimals, quoteMarket.quoteDecimals);
    if (quoteUsdPrice <= 0) continue;

    // Calculate final USD price - use the token trade timestamp (most relevant)
    const usdPrice = tokenResult.price * quoteUsdPrice;
    return {
      price: usdPrice,
      intermediary: market.quoteSymbol,
      tradeTimestamp: tokenResult.tradeTimestamp,
    };
  }

  return null;
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
      cache: 'no-store',
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
      cache: 'no-store',
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

// Main price fetching function - tries Injective DEX first, then two-hop, then Pyth
async function getHistoricalPrice(symbol: string, date: string, timestampMs?: number): Promise<PriceResult | null> {
  // Convert date to timestamp (noon UTC for consistency) unless timestamp provided
  let timestamp: number;
  if (timestampMs) {
    timestamp = timestampMs;
  } else {
    const [year, month, day] = date.split('-');
    timestamp = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0)).getTime();
  }

  // 1. Try Injective DEX direct USDT pair (chain-specific prices)
  const dexPrice = await getInjectiveDexPrice(symbol, timestamp);
  if (dexPrice !== null) {
    return { price: dexPrice, source: 'injective-dex' };
  }

  // 2. Try two-hop via swap token (e.g., TOKEN/INJ → INJ/USD)
  // This handles memecoins and tokens that only trade against INJ
  const twoHopResult = await getTwoHopPrice(symbol, timestamp);
  if (twoHopResult !== null) {
    const timeDiffMs = Math.abs(twoHopResult.tradeTimestamp - timestamp);
    const timeDiffHours = Math.round(timeDiffMs / (1000 * 60 * 60) * 10) / 10; // Round to 1 decimal
    return {
      price: twoHopResult.price,
      source: 'injective-dex-twohop',
      intermediary: twoHopResult.intermediary,
      tradeTimestamp: twoHopResult.tradeTimestamp,
      timeDiffHours: timeDiffHours > 1 ? timeDiffHours : undefined, // Only include if > 1 hour
    };
  }

  // 3. Fallback to Pyth (cross-chain aggregated - NOT chain-specific)
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
      const { token, date, timestamp } = req;
      const symbol = token?.toUpperCase();
      const key = timestamp ? `${symbol}-${timestamp}` : `${symbol}-${date}`;

      // Fetch price (pass timestamp in ms if provided)
      const result = await getHistoricalPrice(symbol, date, timestamp);

      if (result) {
        results[key] = { price: result.price, source: result.source };
        let sourceDesc = result.intermediary
          ? `${result.source} via ${result.intermediary}`
          : result.source;
        // Add time difference warning if significant (> 1 hour)
        if (result.timeDiffHours && result.timeDiffHours > 1) {
          sourceDesc += ` (price from ${result.timeDiffHours}h away)`;
        }
        sources[key] = sourceDesc;
      } else {
        results[key] = null;
        missing.push(`${symbol} on ${date || new Date(timestamp).toISOString().split('T')[0]} (no trades within 7 days)`);
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
  const blockHeight = searchParams.get('block');
  const timestampParam = searchParams.get('timestamp');

  if (!token) {
    return Response.json({ error: 'token required' }, { status: 400 });
  }

  const symbol = token.toUpperCase();

  // Determine timestamp from block height, timestamp param, or date
  let timestampMs: number | undefined;
  let dateStr: string;

  if (blockHeight) {
    const blockTs = await getBlockTimestamp(parseInt(blockHeight));
    if (!blockTs) {
      return Response.json({ error: `Could not get timestamp for block ${blockHeight}` }, { status: 400 });
    }
    timestampMs = blockTs;
    dateStr = new Date(blockTs).toISOString().split('T')[0];
  } else if (timestampParam) {
    timestampMs = parseInt(timestampParam);
    dateStr = new Date(timestampMs).toISOString().split('T')[0];
  } else {
    dateStr = date || new Date().toISOString().split('T')[0];
  }

  // Fetch price
  const result = await getHistoricalPrice(symbol, dateStr, timestampMs);

  // Build warning message
  let warning: string | undefined;
  if (result === null) {
    warning = `Price not available for ${symbol} on ${dateStr}`;
  } else if (result.timeDiffHours && result.timeDiffHours > 1) {
    warning = `Price is from ${result.timeDiffHours}h away`;
  }

  return Response.json({
    price: result?.price ?? null,
    source: result?.source ?? null,
    intermediary: result?.intermediary,
    timestamp: timestampMs,
    date: dateStr,
    tradeTimestamp: result?.tradeTimestamp,
    timeDiffHours: result?.timeDiffHours,
    warning,
  });
}
