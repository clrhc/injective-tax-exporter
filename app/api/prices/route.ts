// app/api/prices/route.ts
// Fetches historical prices from multiple sources
// Primary: Kujira Oracle (on-chain, current prices)
// Fallback: CoinGecko historical API (for historical prices)

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KUJIRA_RPC = 'https://kujira-rpc.publicnode.com';

// IBC denom hash to symbol mapping
const IBC_SYMBOLS: Record<string, string> = {
  // axlUSDC
  'FE98AA': 'USDC',
  '295548': 'USDC',
  // ATOM
  '3CF31C': 'ATOM',
  '27394F': 'ATOM',
  // OSMO
  '4F393C': 'OSMO',
  '47BD20': 'OSMO',
  // wETH (Axelar)
  '173E56': 'WETH',
  '1B3880': 'WETH',
  // wBTC (Axelar)
  '239BFF': 'WBTC',
  // STARS
  'DA59C0': 'STARS',
  '4F3934': 'STARS',
  // SCRT
  '91DAE8': 'SCRT',
  'A358D7': 'SCRT',
  // TIA
  '0306D6': 'TIA',
  // DYDX
  '15FF6D': 'DYDX',
  // INJ
  '301DAF': 'INJ',
  // NTRN
  'D20559': 'NTRN',
};

// DefiLlama/CoinGecko IDs for historical prices
const DEFILLAMA_IDS: Record<string, string> = {
  'KUJI': 'coingecko:kujira',
  'ATOM': 'coingecko:cosmos',
  'OSMO': 'coingecko:osmosis',
  'TIA': 'coingecko:celestia',
  'STARS': 'coingecko:stargaze',
  'SCRT': 'coingecko:secret',
  'INJ': 'coingecko:injective-protocol',
  'NTRN': 'coingecko:neutron-3',
  'DYDX': 'coingecko:dydx-chain',
  'WETH': 'coingecko:ethereum',
  'ETH': 'coingecko:ethereum',
  'WBTC': 'coingecko:bitcoin',
  'BTC': 'coingecko:bitcoin',
  'USDC': 'coingecko:usd-coin',
  'USDT': 'coingecko:tether',
  'USK': 'coingecko:usk',
  'MNTA': 'coingecko:mantadao',
  'WHALE': 'coingecko:white-whale',
  'SOL': 'coingecko:solana',
  'BNB': 'coingecko:binancecoin',
  'AVAX': 'coingecko:avalanche-2',
  'DOT': 'coingecko:polkadot',
  'LINK': 'coingecko:chainlink',
  'UNI': 'coingecko:uniswap',
  'AKT': 'coingecko:akash-network',
  'JUNO': 'coingecko:juno-network',
  'LUNA': 'coingecko:terra-luna-2',
  'SEI': 'coingecko:sei-network',
};

interface PriceResult {
  price: number;
  source: string;
}

// Oracle symbol normalization (Kujira oracle uses specific symbols)
function normalizeSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  // Map common variations
  if (upper === 'AXLUSDC') return 'USDC';
  if (upper === 'WETH') return 'ETH'; // Oracle may use ETH
  if (upper === 'WBTC') return 'BTC'; // Oracle may use BTC
  return upper;
}

function getDenomSymbol(denom: string): string {
  if (denom === 'ukuji') return 'KUJI';
  if (denom === 'uosmo') return 'OSMO';
  if (denom === 'uatom') return 'ATOM';
  if (denom.includes('umnta')) return 'MNTA';
  if (denom.includes('uusk')) return 'USK';
  if (denom.startsWith('ibc/') || denom.startsWith('IBC/')) {
    const hash = denom.slice(4, 10).toUpperCase();
    return IBC_SYMBOLS[hash] || `IBC/${hash}`;
  }
  if (denom.startsWith('factory/')) {
    const parts = denom.split('/');
    const last = parts[parts.length - 1];
    return last.startsWith('u') ? last.slice(1).toUpperCase() : last.toUpperCase();
  }
  return denom.toUpperCase();
}

// Cache for oracle prices (refreshes every 5 minutes)
let oraclePriceCache: Map<string, number> | null = null;
let oracleCacheTime = 0;
const ORACLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch current prices from Kujira Oracle
async function fetchOraclePrices(): Promise<Map<string, number>> {
  // Return cached if fresh
  if (oraclePriceCache && Date.now() - oracleCacheTime < ORACLE_CACHE_TTL) {
    return oraclePriceCache;
  }

  try {
    const url = `${KUJIRA_RPC}/abci_query?path="/kujira.oracle.Query/ExchangeRates"&data=""`;
    const res = await fetch(url);
    if (!res.ok) return oraclePriceCache || new Map();

    const data = await res.json();
    const value = data.result?.response?.value;
    if (!value) return oraclePriceCache || new Map();

    // Decode base64 protobuf
    const bytes = Buffer.from(value, 'base64');
    const prices = new Map<string, number>();

    // Parse protobuf: each entry is \n + entry_len + \n + sym_len + symbol + \x12 + price_len + price_str
    let i = 0;
    while (i < bytes.length) {
      if (bytes[i] === 0x0a) { // Entry start
        const entryLen = bytes[i + 1];
        const entry = bytes.slice(i + 2, i + 2 + entryLen);

        if (entry.length >= 3 && entry[0] === 0x0a) {
          const symLen = entry[1];
          const symbol = entry.slice(2, 2 + symLen).toString('ascii');
          const rest = entry.slice(2 + symLen);

          if (rest.length > 2 && rest[0] === 0x12) {
            const priceLen = rest[1];
            const priceStr = rest.slice(2, 2 + priceLen).toString('ascii');

            if (/^\d+$/.test(priceStr) && /^[A-Z]+$/.test(symbol)) {
              // Price is scaled by 10^18
              const price = parseInt(priceStr) / 1e18;
              prices.set(symbol, price);
            }
          }
        }
        i += 2 + entryLen;
      } else {
        i++;
      }
    }

    oraclePriceCache = prices;
    oracleCacheTime = Date.now();
    return prices;

  } catch {
    return oraclePriceCache || new Map();
  }
}

// Check if date is within oracle validity (within last day)
function isRecentDate(dateStr: string): boolean {
  const now = new Date();
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const diffMs = now.getTime() - target.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  return diffDays < 1; // Within last 24 hours
}

// Get price from Kujira Oracle (current prices only)
async function getPriceFromOracle(symbol: string): Promise<PriceResult | null> {
  const prices = await fetchOraclePrices();
  const normalized = normalizeSymbol(symbol);

  // Try direct match
  let price = prices.get(normalized);

  // Try without W prefix for wrapped tokens
  if (!price && normalized.startsWith('W')) {
    price = prices.get(normalized.slice(1));
  }

  // Try with W prefix
  if (!price) {
    price = prices.get('W' + normalized);
  }

  if (price && price > 0) {
    return { price, source: 'kujira-oracle' };
  }
  return null;
}

// Get historical price from DefiLlama API (free, unlimited historical data)
async function getPriceFromDefiLlama(symbol: string, dateStr: string): Promise<PriceResult | null> {
  const normalized = normalizeSymbol(symbol);
  const llamaId = DEFILLAMA_IDS[normalized];
  if (!llamaId) return null;

  try {
    // Convert date to Unix timestamp (noon UTC)
    const [year, month, day] = dateStr.split('-').map(Number);
    const targetDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const timestamp = Math.floor(targetDate.getTime() / 1000);

    const url = `https://coins.llama.fi/prices/historical/${timestamp}/${llamaId}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const coinData = data.coins?.[llamaId];

    if (coinData?.price && coinData.price > 0) {
      return { price: coinData.price, source: 'defillama' };
    }
  } catch { }
  return null;
}

// Main price lookup function
async function getHistoricalPrice(symbol: string, dateStr: string): Promise<PriceResult | null> {
  let normalizedSymbol = normalizeSymbol(symbol);

  // Normalize IBC symbols
  if (normalizedSymbol.startsWith('IBC/')) {
    const hash = normalizedSymbol.slice(4, 10).toUpperCase();
    normalizedSymbol = IBC_SYMBOLS[hash] || normalizedSymbol;
  }

  // 1. For recent transactions (within 24h), use Kujira Oracle
  if (isRecentDate(dateStr)) {
    const oraclePrice = await getPriceFromOracle(normalizedSymbol);
    if (oraclePrice) return oraclePrice;
  }

  // 2. Fallback to DefiLlama for historical data
  const llamaPrice = await getPriceFromDefiLlama(normalizedSymbol, dateStr);
  if (llamaPrice) return llamaPrice;

  // 3. If nothing found and it's recent, try oracle anyway
  const oraclePrice = await getPriceFromOracle(normalizedSymbol);
  if (oraclePrice) {
    return { ...oraclePrice, source: 'kujira-oracle-current' };
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

    const results: Record<string, { price: number; source: string } | null> = {};
    const missing: string[] = [];
    const sources: Record<string, string> = {};

    for (const req of requests) {
      const { token, date, timestamp } = req;
      const symbol = token?.toUpperCase();
      const dateStr = timestamp ? new Date(timestamp).toISOString().split('T')[0] : date;
      const key = timestamp ? `${symbol}-${timestamp}` : `${symbol}-${dateStr}`;

      const result = await getHistoricalPrice(symbol, dateStr);

      if (result) {
        results[key] = { price: result.price, source: result.source };
        sources[key] = result.source;
      } else {
        results[key] = null;
        missing.push(`${symbol} on ${dateStr}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    }

    return Response.json({
      prices: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, v?.price ?? null])
      ),
      sources,
      missing: missing.length > 0 ? missing : undefined,
      warning: missing.length > 0
        ? `Could not find prices for ${missing.length} token/date combinations.`
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
  const timestampParam = searchParams.get('timestamp');

  if (!token) {
    return Response.json({ error: 'token required' }, { status: 400 });
  }

  const symbol = token.toUpperCase();
  const dateStr = timestampParam
    ? new Date(parseInt(timestampParam)).toISOString().split('T')[0]
    : date || new Date().toISOString().split('T')[0];

  const result = await getHistoricalPrice(symbol, dateStr);

  return Response.json({
    price: result?.price ?? null,
    source: result?.source ?? null,
    date: dateStr,
    warning: result === null ? `Price not available for ${symbol} on ${dateStr}` : undefined,
  });
}
