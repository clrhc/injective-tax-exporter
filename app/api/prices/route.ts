// app/api/prices/route.ts
// Generic pricing API using DefiLlama
// Works for ANY chain supported by DefiLlama

import { getChain, defaultChain, ChainConfig } from '../../../chains';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFILLAMA_API = 'https://coins.llama.fi';
const PYTH_API = 'https://benchmarks.pyth.network';

interface PriceResult {
  price: number;
  source: 'defillama' | 'pyth' | 'coingecko';
  confidence?: number;
  timestamp?: number;
}

// Get price from DefiLlama (supports any chain with DEX liquidity)
async function getDefiLlamaPrice(
  chainId: string,
  tokenAddress: string,
  timestamp: number
): Promise<PriceResult | null> {
  try {
    const unixTs = Math.floor(timestamp / 1000);
    const coinId = `${chainId}:${tokenAddress}`;
    const url = `${DEFILLAMA_API}/prices/historical/${unixTs}/${coinId}`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) return null;

    const data = await res.json();
    const coinData = data.coins?.[coinId];

    if (!coinData || !coinData.price) return null;

    return {
      price: coinData.price,
      source: 'defillama',
      confidence: coinData.confidence,
      timestamp: coinData.timestamp,
    };
  } catch (e) {
    return null;
  }
}

// Get current price from DefiLlama (for tokens without historical data)
async function getDefiLlamaCurrentPrice(
  chainId: string,
  tokenAddress: string
): Promise<PriceResult | null> {
  try {
    const coinId = `${chainId}:${tokenAddress}`;
    const url = `${DEFILLAMA_API}/prices/current/${coinId}`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) return null;

    const data = await res.json();
    const coinData = data.coins?.[coinId];

    if (!coinData || !coinData.price) return null;

    return {
      price: coinData.price,
      source: 'defillama',
      confidence: coinData.confidence,
    };
  } catch (e) {
    return null;
  }
}

// Get price from Pyth (fallback for major tokens)
async function getPythPrice(symbol: string, date: string): Promise<number | null> {
  const pythSymbol = `Crypto.${symbol.toUpperCase()}/USD`;

  try {
    const [year, month, day] = date.split('-');
    const startDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
    const fromTs = Math.floor(startDate.getTime() / 1000);
    const toTs = Math.floor(endDate.getTime() / 1000);

    const url = `${PYTH_API}/v1/shims/tradingview/history?symbol=${pythSymbol}&resolution=D&from=${fromTs}&to=${toTs}`;
    const res = await fetch(url, { cache: 'no-store' });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.s !== 'ok' || !data.c?.length) return null;

    return data.c[0];
  } catch (e) {
    return null;
  }
}

// Get price from CoinGecko by ID (last resort fallback)
async function getCoinGeckoPrice(coinId: string, date: string): Promise<number | null> {
  try {
    const [year, month, day] = date.split('-');
    const formattedDate = `${day}-${month}-${year}`;
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${formattedDate}`;

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;

    const data = await res.json();
    return data.market_data?.current_price?.usd ?? null;
  } catch (e) {
    return null;
  }
}

// Known token mappings with CoinGecko IDs and contract addresses
const TOKEN_MAPPINGS: Record<string, { coingeckoId?: string; address?: string }> = {
  'USDC': { coingeckoId: 'usd-coin' },
  'USDT': { coingeckoId: 'tether' },
  'WETH': { coingeckoId: 'weth' },
  'CELO': { coingeckoId: 'celo' },
  'CUSD': { coingeckoId: 'celo-dollar', address: '0x765DE816845861e75A25fCA122bb6898B8B1282a' },
  'CEUR': { coingeckoId: 'celo-euro', address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73' },
  'CREAL': { coingeckoId: 'celo-brazilian-real', address: '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787' },
};

// Map DeFi receipt/debt tokens to their underlying tokens
// These tokens are ~1:1 with underlying (plus accrued interest)
function getUnderlyingToken(symbol: string): { symbol: string; coingeckoId?: string; address?: string } | null {
  const upper = symbol.toUpperCase();

  // Direct lookup for known tokens
  if (TOKEN_MAPPINGS[upper]) {
    return { symbol: upper, ...TOKEN_MAPPINGS[upper] };
  }

  // Aave receipt tokens (aCel*, aToken patterns)
  // aCelUSDC -> USDC, aCelWETH -> WETH, aCelcUSD -> CUSD, etc.
  if (upper.startsWith('ACEL')) {
    const underlying = upper.slice(4); // Remove 'ACEL'
    if (TOKEN_MAPPINGS[underlying]) {
      return { symbol: underlying, ...TOKEN_MAPPINGS[underlying] };
    }
    return { symbol: underlying };
  }

  // Aave variable debt tokens
  if (upper.startsWith('VARIABLEDEBTCEL')) {
    const underlying = upper.slice(15); // Remove 'VARIABLEDEBTCEL'
    if (TOKEN_MAPPINGS[underlying]) {
      return { symbol: underlying, ...TOKEN_MAPPINGS[underlying] };
    }
    return { symbol: underlying };
  }

  // Moola tokens (mCELO, mCUSD, etc.)
  if (upper.startsWith('M') && upper.length > 1) {
    const underlying = upper.slice(1);
    if (TOKEN_MAPPINGS[underlying]) {
      return { symbol: underlying, ...TOKEN_MAPPINGS[underlying] };
    }
  }

  // stCELO -> CELO (staked CELO)
  if (upper === 'STCELO') {
    return { symbol: 'CELO', ...TOKEN_MAPPINGS['CELO'] };
  }

  return null;
}

// Main price fetching function
async function getHistoricalPrice(
  config: ChainConfig,
  tokenSymbolOrAddress: string,
  date: string,
  timestampMs?: number,
  tokenAddress?: string,
  coingeckoId?: string
): Promise<PriceResult | null> {
  const upper = tokenSymbolOrAddress.toUpperCase();

  // Calculate timestamp
  const timestamp = timestampMs ||
    new Date(date + 'T12:00:00Z').getTime();

  // 1. Try DefiLlama with token address
  if (tokenAddress?.startsWith('0x')) {
    const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, tokenAddress, timestamp);
    if (llamaPrice) return llamaPrice;
  }

  // 2. Try DefiLlama with native token address (if symbol matches)
  if (upper === config.nativeToken.symbol.toUpperCase()) {
    // For native tokens, use the wrapped version or well-known address
    const wrappedAddress = `0x${'0'.repeat(40)}`; // Native tokens often use zero address
    const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, wrappedAddress, timestamp);
    if (llamaPrice) return llamaPrice;
  }

  // 2.5. Try mapping receipt/debt tokens to underlying
  const underlying = getUnderlyingToken(upper);
  if (underlying) {
    // Try DefiLlama with underlying's contract address
    if (underlying.address) {
      const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, underlying.address, timestamp);
      if (llamaPrice) return llamaPrice;
    }
    // Try underlying with CoinGecko ID
    if (underlying.coingeckoId) {
      const cgPrice = await getCoinGeckoPrice(underlying.coingeckoId, date);
      if (cgPrice !== null) {
        return { price: cgPrice, source: 'coingecko' };
      }
    }
    // Try Pyth with underlying symbol
    const pythPrice = await getPythPrice(underlying.symbol, date);
    if (pythPrice !== null) {
      return { price: pythPrice, source: 'pyth' };
    }
  }

  // 3. Try Pyth
  const pythPrice = await getPythPrice(upper, date);
  if (pythPrice !== null) {
    return { price: pythPrice, source: 'pyth' };
  }

  // 4. Try CoinGecko if ID provided
  if (coingeckoId) {
    const cgPrice = await getCoinGeckoPrice(coingeckoId, date);
    if (cgPrice !== null) {
      return { price: cgPrice, source: 'coingecko' };
    }
  }

  // 5. Try native token's coingecko ID
  if (upper === config.nativeToken.symbol.toUpperCase() && config.nativeToken.coingeckoId) {
    const cgPrice = await getCoinGeckoPrice(config.nativeToken.coingeckoId, date);
    if (cgPrice !== null) {
      return { price: cgPrice, source: 'coingecko' };
    }
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { requests, chain: chainId } = body;

    if (!requests || !Array.isArray(requests)) {
      return Response.json({ error: 'requests array required' }, { status: 400 });
    }

    // Get chain config
    const config = getChain(chainId || 'celo') || defaultChain;

    const results: Record<string, number | null> = {};
    const sources: Record<string, string> = {};
    const missing: string[] = [];

    for (const req of requests) {
      const { token, address, date, timestamp, coingeckoId } = req;
      // Use timestamp as key for exact price lookups
      const key = `${token.toUpperCase()}-${timestamp || date}`;
      // Derive date from timestamp if not provided (needed for Pyth/CoinGecko fallbacks)
      const dateStr = date || (timestamp ? new Date(timestamp).toISOString().split('T')[0] : null);

      const result = await getHistoricalPrice(config, token, dateStr || '', timestamp, address, coingeckoId);

      if (result) {
        results[key] = result.price;
        sources[key] = result.source + (result.confidence && result.confidence < 0.9 ? ' (low confidence)' : '');
      } else {
        results[key] = null;
        missing.push(`${token} on ${date || new Date(timestamp).toISOString().split('T')[0]}`);
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    return Response.json({
      prices: results,
      sources,
      missing: missing.length > 0 ? missing : undefined,
      warning: missing.length > 0
        ? `Could not find prices for ${missing.length} token/date combinations.`
        : undefined,
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
  const address = searchParams.get('address');
  const date = searchParams.get('date');
  const timestampParam = searchParams.get('timestamp');
  const coingeckoId = searchParams.get('coingeckoId');
  const chainId = searchParams.get('chain') || 'celo';

  // Get chain config
  const config = getChain(chainId) || defaultChain;

  if (!token && !address) {
    return Response.json({ error: 'token or address required' }, { status: 400 });
  }

  const timestampMs = timestampParam ? parseInt(timestampParam) : undefined;
  const dateStr = timestampMs
    ? new Date(timestampMs).toISOString().split('T')[0]
    : date || new Date().toISOString().split('T')[0];

  const result = await getHistoricalPrice(
    config,
    token || '',
    dateStr,
    timestampMs,
    address || undefined,
    coingeckoId || undefined
  );

  return Response.json({
    price: result?.price ?? null,
    source: result?.source ?? null,
    confidence: result?.confidence,
    chain: config.defiLlamaId,
    token: token || address,
    date: dateStr,
    timestamp: timestampMs,
    warning: result === null ? `Price not available` : undefined,
  });
}
