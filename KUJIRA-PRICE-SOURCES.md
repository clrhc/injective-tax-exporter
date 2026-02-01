# Kujira On-Chain Price Sources

## Summary

The Kujira Tax Exporter uses multiple price sources:

1. **Kujira Oracle** (Primary, on-chain) - Current prices from validator consensus
2. **DefiLlama** (Fallback) - Historical prices with unlimited lookback

## 1. Kujira Oracle Module

The Kujira Oracle is an on-chain module where validators submit exchange rates. This provides **real-time prices** for 50+ tokens including:

- Native tokens: KUJI, USK, MNTA
- Major cryptos: BTC, ETH, ATOM, OSMO, SOL, BNB, AVAX
- Stablecoins: USDC, USDT (NOT hardcoded to $1!)
- DeFi tokens: TIA, DYDX, INJ, NTRN, STARS, SCRT

### Query Endpoint

```bash
curl 'https://kujira-rpc.publicnode.com/abci_query?path="/kujira.oracle.Query/ExchangeRates"&data=""'
```

Response is base64-encoded protobuf containing symbol-price pairs scaled by 10^18.

### Example Prices (2026-02-01)

| Token | Price (USD) | Source |
|-------|-------------|--------|
| KUJI  | $0.0341     | kujira-oracle |
| USDC  | $0.9998     | kujira-oracle |
| ATOM  | $1.97       | kujira-oracle |
| BTC   | $78,739     | kujira-oracle |
| ETH   | $2,444      | kujira-oracle |

**Key Feature**: USDC shows $0.9998, not $1.00 - all prices are derived from on-chain oracle data, never hardcoded.

## 2. FIN DEX (Historical Trades)

Query swap transactions on FIN DEX markets for historical price discovery:

```bash
# Query swaps on KUJI-USDC market
curl 'https://kujira-rpc.publicnode.com/tx_search?query="wasm.action=%27swap%27"&per_page=10&order_by="desc"'
```

**Known FIN Markets:**

| Contract | Pair |
|----------|------|
| kujira1pw96huy6z02uk8hdpruk6g8u700dp8yxjhp46c24rwkzay2lfd3quqdum5 | KUJI/USDC |
| kujira1nkgq8xl4flsau7v3vphr3ayc7tprgazg6pzjmq8plkr76v385fhsx26qfa | MNTA/KUJI |
| kujira15a657mgszm30vdhytpmfslcyc4cztn5lsuv9rxzwdqmuwgd8znps8l3yy2 | USDC/USK |

**Limitation**: Public RPC nodes only retain ~6 months of indexed swap data.

## 3. DefiLlama (Historical Fallback)

For historical prices beyond oracle availability, DefiLlama provides free unlimited historical data:

```bash
# Get KUJI price on 2024-06-15 (Unix timestamp)
curl 'https://coins.llama.fi/prices/historical/1718470800/coingecko:kujira'
```

Example response:
```json
{
  "coins": {
    "coingecko:kujira": {
      "symbol": "KUJI",
      "price": 1.21,
      "timestamp": 1718470792,
      "confidence": 0.99
    }
  }
}
```

## Price Lookup Strategy

1. **Current transactions** (within 24h): Use Kujira Oracle
2. **Historical transactions**: Use DefiLlama
3. **Unknown tokens**: Fall back to current oracle price (marked as "kujira-oracle-current")

## IBC Token Mapping

IBC denoms are mapped to symbols using the first 6 characters of the denom hash:

| Hash Prefix | Symbol |
|-------------|--------|
| FE98AA      | USDC   |
| 27394F      | ATOM   |
| 47BD20      | OSMO   |
| 0306D6      | TIA    |
| 15FF6D      | DYDX   |
| 301DAF      | INJ    |
| D20559      | NTRN   |

## Notes

- Oracle prices are updated every block (~6 seconds) by validator consensus
- DefiLlama aggregates prices from multiple DEXes across chains
- No stablecoin prices are hardcoded - all derived from market data
