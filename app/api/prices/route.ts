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
  source: 'defillama' | 'pyth' | 'coingecko' | 'dex';
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

// Get price from on-chain DEX (UniswapV2 style)
async function getDexPrice(
  config: ChainConfig,
  tokenAddress: string,
  nativeTokenPriceUsd: number
): Promise<PriceResult | null> {
  if (!config.dex || !config.nativeToken.wrappedAddress) return null;

  const { rpcUrl, factoryAddress } = config.dex;
  const wrappedNative = config.nativeToken.wrappedAddress.toLowerCase();

  try {
    // Get pair address from factory
    const tokenLower = tokenAddress.toLowerCase();
    const getPairData = `0xe6a43905${tokenLower.slice(2).padStart(64, '0')}${wrappedNative.slice(2).padStart(64, '0')}`;

    const pairRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: factoryAddress, data: getPairData }, 'latest'],
        id: 1,
      }),
    });

    const pairData = await pairRes.json();
    const pairAddress = '0x' + pairData.result?.slice(-40);
    if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') return null;

    // Get reserves
    const reservesRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: pairAddress, data: '0x0902f1ac' }, 'latest'],
        id: 2,
      }),
    });

    const reservesData = await reservesRes.json();
    if (!reservesData.result || reservesData.result === '0x') return null;

    // Parse reserves (each is 32 bytes)
    const reserve0 = BigInt('0x' + reservesData.result.slice(2, 66));
    const reserve1 = BigInt('0x' + reservesData.result.slice(66, 130));

    // Get token0 to determine order
    const token0Res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: pairAddress, data: '0x0dfe1681' }, 'latest'],
        id: 3,
      }),
    });

    const token0Data = await token0Res.json();
    const token0 = '0x' + token0Data.result?.slice(-40).toLowerCase();

    // Calculate price
    let tokenReserve: bigint, nativeReserve: bigint;
    if (token0 === tokenLower) {
      tokenReserve = reserve0;
      nativeReserve = reserve1;
    } else {
      tokenReserve = reserve1;
      nativeReserve = reserve0;
    }

    if (tokenReserve === 0n) return null;

    // Price in native token (both assumed 18 decimals for now)
    const priceInNative = Number(nativeReserve) / Number(tokenReserve);
    const priceInUsd = priceInNative * nativeTokenPriceUsd;

    return {
      price: priceInUsd,
      source: 'dex',
      confidence: 0.8, // Lower confidence for DEX prices
    };
  } catch (e) {
    return null;
  }
}

// Celo-specific token addresses for DefiLlama lookups
// These are native Celo stablecoins that need contract addresses
const CELO_TOKEN_ADDRESSES: Record<string, string> = {
  'CUSD': '0x765DE816845861e75A25fCA122bb6898B8B1282a',
  'CEUR': '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73',
  'CREAL': '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787',
};

// Get possible Pyth symbol variants to try (strips common suffixes/prefixes)
function getPythSymbolVariants(symbol: string): string[] {
  const variants: string[] = [];
  let s = symbol.toUpperCase();
  variants.push(s);

  // Strip common bridged token suffixes: .E (Aurora), .e, etc.
  if (s.endsWith('.E')) {
    s = s.slice(0, -2);
    variants.push(s);
  }

  // Try without W prefix (WETH -> ETH, WBTC -> BTC, etc.)
  // Exclude known tokens that start with W but aren't wrapped (WAVES, WEMIX, etc.)
  if (s.startsWith('W') && s.length > 2 && !['WAVES', 'WEMIX', 'WOO', 'WIN', 'WING'].includes(s)) {
    variants.push(s.slice(1));
  }

  return [...new Set(variants)]; // dedupe
}

// Map DeFi receipt/debt tokens to their underlying token symbol
// These are edge cases where wrapped/receipt tokens need special handling
function getUnderlyingSymbol(symbol: string): string | null {
  const upper = symbol.toUpperCase();

  // Celo Aave receipt tokens: aCelUSDC -> USDC, aCelWETH -> WETH, etc.
  if (upper.startsWith('ACEL')) {
    return upper.slice(4);
  }

  // Celo Aave variable debt tokens: variableDebtCelWETH -> WETH
  if (upper.startsWith('VARIABLEDEBTCEL')) {
    return upper.slice(15);
  }

  // Moola tokens: mCELO -> CELO, mCUSD -> CUSD
  if (upper.startsWith('M') && upper.length > 1) {
    const underlying = upper.slice(1);
    if (['CELO', 'CUSD', 'CEUR', 'CREAL'].includes(underlying)) {
      return underlying;
    }
  }

  // stCELO -> CELO (staked CELO)
  if (upper === 'STCELO') {
    return 'CELO';
  }

  // ZetaChain ZRC-20 tokens: USDT.ETH -> USDT, USDC.ETH -> USDC, ETH.ETH -> ETH, BTC.BTC -> BTC
  if (upper.includes('.')) {
    const base = upper.split('.')[0];
    // Map common ZRC-20 tokens to their underlying
    if (['USDT', 'USDC', 'DAI', 'ETH', 'BTC', 'WETH', 'WBTC'].includes(base)) {
      return base;
    }
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

  // 1. Try DefiLlama with token contract address (primary source)
  if (tokenAddress?.startsWith('0x')) {
    const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, tokenAddress, timestamp);
    if (llamaPrice) return llamaPrice;
  }

  // 2. Try DefiLlama with wrapped native token address
  if (upper === config.nativeToken.symbol.toUpperCase() && config.nativeToken.wrappedAddress) {
    const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, config.nativeToken.wrappedAddress, timestamp);
    if (llamaPrice) return llamaPrice;
  }

  // 3. For Celo stablecoins, try with known contract addresses
  if (config.id === 'celo' && CELO_TOKEN_ADDRESSES[upper]) {
    const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, CELO_TOKEN_ADDRESSES[upper], timestamp);
    if (llamaPrice) return llamaPrice;
  }

  // 4. For DeFi receipt/debt tokens, get underlying and retry
  const underlyingSymbol = getUnderlyingSymbol(upper);
  if (underlyingSymbol) {
    // Try Celo stablecoin address for underlying
    if (config.id === 'celo' && CELO_TOKEN_ADDRESSES[underlyingSymbol]) {
      const llamaPrice = await getDefiLlamaPrice(config.defiLlamaId, CELO_TOKEN_ADDRESSES[underlyingSymbol], timestamp);
      if (llamaPrice) return llamaPrice;
    }
    // Try Pyth with underlying symbol
    const pythPrice = await getPythPrice(underlyingSymbol, date);
    if (pythPrice !== null) {
      return { price: pythPrice, source: 'pyth' };
    }
  }

  // 5. Try Pyth with symbol variants (handles .E suffix, W prefix)
  const symbolVariants = getPythSymbolVariants(upper);
  for (const variant of symbolVariants) {
    const pythPrice = await getPythPrice(variant, date);
    if (pythPrice !== null) {
      return { price: pythPrice, source: 'pyth' };
    }
  }

  // 6. Try native token's coingecko ID via DefiLlama (better for historical)
  if (upper === config.nativeToken.symbol.toUpperCase() && config.nativeToken.coingeckoId) {
    try {
      const unixTs = Math.floor(timestamp / 1000);
      const url = `${DEFILLAMA_API}/prices/historical/${unixTs}/coingecko:${config.nativeToken.coingeckoId}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const coinData = data.coins?.[`coingecko:${config.nativeToken.coingeckoId}`];
        if (coinData?.price) {
          return { price: coinData.price, source: 'defillama', confidence: coinData.confidence };
        }
      }
    } catch (e) { /* continue */ }

    // Fall back to CoinGecko direct API
    const cgPrice = await getCoinGeckoPrice(config.nativeToken.coingeckoId, date);
    if (cgPrice !== null) {
      return { price: cgPrice, source: 'coingecko' };
    }
  }

  // 7. Try on-chain DEX price (for meme coins, etc.)
  if (config.dex && tokenAddress?.startsWith('0x')) {
    // First get native token price
    let nativePrice = 0;
    if (config.nativeToken.coingeckoId) {
      try {
        const unixTs = Math.floor(timestamp / 1000);
        const url = `${DEFILLAMA_API}/prices/historical/${unixTs}/coingecko:${config.nativeToken.coingeckoId}`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          nativePrice = data.coins?.[`coingecko:${config.nativeToken.coingeckoId}`]?.price || 0;
        }
      } catch (e) { /* continue */ }
    }

    if (nativePrice > 0) {
      const dexPrice = await getDexPrice(config, tokenAddress, nativePrice);
      if (dexPrice) return dexPrice;
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
