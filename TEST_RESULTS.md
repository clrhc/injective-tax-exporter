# Chain Price API Test Results

## Test Date: 2026-02-02

### DefiLlama Lowercase Chain ID Fix

Fixed `app/api/prices/route.ts` to use lowercase chain identifiers for DefiLlama coins API.

**Before:** `${chainId}:${tokenAddress}` (e.g., `Fuse:0x...`)
**After:** `${chainId.toLowerCase()}:${tokenAddress.toLowerCase()}` (e.g., `fuse:0x...`)

---

## Chain Test Results

| Chain | Test Wallet | Total Txs | Swaps | Missing Prices | % Missing | Status |
|-------|-------------|-----------|-------|----------------|-----------|--------|
| Astar | 0x2412f8511ea0cc48a22b6e1926c51916e3fccae2 | 100 | 76 | 0 | 0% | ✅ |
| Aurora | 0x88928ff265a144aef2c5e228d536d9e477a68cfc | 100 | 50 | 0 | 0% | ✅ |
| BOB | 0x00a94cb9edfe91268dc49cc18c2119bd1e716622 | 121 | 14 | 0 | 0% | ✅ |
| Gnosis | 0x5a52e96bacdabb82fd05763e25335261b270efcb | 100 | 50 | 0 | 0% | ✅ |
| Hemi | 0x25b6f5f1525f0074d53570ea2fb4cd9ee545b296 | 106 | 11 | 8 | 7.5% | ✅ |
| ZetaChain | 0x6daf055c99883d920849d7022f2efabb13e2af57 | 100 | 50 | 8 | 8% | ✅ |
| Degen | 0xba55bdbf959df826da6c35487eb15fad2164662d | 101 | 72 | 11 | 11% | ✅ |
| Fuse | 0x459dc0dcb82c7e3c791041f9cdb5f797b6459315 | 110 | 20 | 17 | 15.5% | ⚠️ |

---

## Missing Price Analysis

### Acceptable Missing Prices (Expected)
- **LP Tokens**: VLP, UNI-V2, xWBTC-WETH3 - Liquidity pool tokens cannot be priced
- **Chain-specific tokens**: fUSD (Fuse), hemiBTC (Hemi) - Not indexed by DefiLlama
- **Bridged tokens**: BNB.BSC (ZetaChain) - Limited DEX liquidity data

### Tokens Now Working After Fix
- **DEGEN** on Degen chain - ✅ Prices via DEX indexing
- **Meme coins** (GOAT, APES, ATH, DeKIMCHI) - ✅ Now have fiat values
- **WFUSE, WASTR, WFLR** - ✅ All wrapped native tokens working

---

## DefiLlama API Format

**Endpoint:** `https://coins.llama.fi/prices/historical/{timestamp}/{coins}`

**Coins format:** `{chain}:{address}` (lowercase)

**Examples:**
- `fuse:0x0BE9e53fd7EDaC9F859882AfdDa116645287C629` (WFUSE)
- `astar:0xAeaaf0e2c81Af264101B9129C00F4440cCF0F720` (WASTR)
- `mode:0x4200000000000000000000000000000000000006` (WETH)
- `degen:0xEb54dACB4C2ccb64F8074eceEa33b5eBb38E5387` (WDEGEN)

**CoinGecko fallback:** `coingecko:{id}` (e.g., `coingecko:fuse-network-token`)

---

## Test Commands

```bash
# Test single price
curl "http://localhost:4000/api/prices?chain=fuse&token=FUSE&timestamp=1736200000000"

# Test export with stats
curl "http://localhost:4000/api/export?address={wallet}&chain={chain}&limit=50&format=json" | jq '.stats'

# Test DefiLlama directly
curl "https://coins.llama.fi/prices/current/{chain}:{address}"
```
