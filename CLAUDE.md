# Claude Instructions

## NEVER DO THESE THINGS

1. **NEVER hardcode token lists or "common tokens"** - all token info must come from on-chain data, token list APIs, or transaction responses
2. **NEVER hardcode stablecoin prices to $1** - USDT, USDC, DAI, etc. CAN AND DO DEPEG. Always fetch real prices from DefiLlama/Pyth/CoinGecko
3. **NEVER assume any token's price or decimals** - always fetch from price APIs or parse from transaction data
4. **NEVER hardcode chain-specific values outside of chain.config.ts**
5. **NEVER spend more than 2 attempts on a chain's transaction API** - if the API returns 403/404/errors or requires authentication, IMMEDIATELY switch to a different chain. Don't waste time debugging chains without free public APIs.
6. **NEVER use daily prices** - prices vary throughout the day. Always use exact transaction timestamps for price lookups, not just the date.
7. **NEVER cache prices by date** - each transaction needs its own price at its exact timestamp. Cache key should be `TOKEN-{timestamp}` not `TOKEN-{date}`.
8. **NEVER rely only on basic transaction data for token movements** - basic `txlist` only shows native token transfers and gas. You MUST also fetch `tokentx` (ERC20 token transfers) to see actual token movements in swaps/DeFi.

## EVM Transaction Parsing Rules

### CRITICAL: Fetch BOTH endpoints
For any EVM chain, you need TWO API calls to get complete transaction data:
```
action=txlist     → Normal transactions (native transfers, gas fees, contract calls)
action=tokentx    → Token transfers (ERC20 events - the actual tokens moving)
```

### Why this matters
- A swap transaction in `txlist` shows: value=0, just gas fee
- The SAME transaction in `tokentx` shows: Token A sent, Token B received
- Without `tokentx`, all swaps appear as "fee" transactions

### Classification Logic
Classify transactions based on ACTUAL TOKEN MOVEMENTS, not function names:
- **Swap**: tokens IN and tokens OUT in same tx
- **Transfer In**: only tokens IN (received)
- **Transfer Out**: only tokens OUT (sent)
- **Fee**: only gas fee, no token movement

### CRITICAL: Failed Transaction Handling
The `tokentx` API returns token transfer events even for FAILED transactions (events emitted before revert). These transfers **did not actually happen**.

```javascript
// WRONG - includes phantom transfers from failed txs
for (const tt of tokenTransfers) {
  tokensByHash[tt.hash].push(tt);
}

// RIGHT - exclude failed tx token transfers
const failedHashes = new Set(txs.filter(t => t.isError === '1').map(t => t.hash));
for (const tt of tokenTransfers) {
  if (failedHashes.has(tt.hash)) continue;  // Skip - didn't actually happen
  tokensByHash[tt.hash].push(tt);
}
```

Failed transactions should ONLY show gas fee, nothing else.

### Token Transfer Data Structure
```javascript
// tokentx response includes:
{
  hash: "0x...",           // Links to parent transaction
  from: "0x...",           // Sender
  to: "0x...",             // Receiver
  value: "1000000",        // Raw amount (need to divide by 10^decimals)
  tokenSymbol: "USDC",
  tokenDecimal: "6",
  contractAddress: "0x..." // Token contract
}
```

## Chain Selection Rules

Before implementing a chain, verify it has a **FREE, PUBLIC transaction history API**:

### Known Working (Free BlockScout/Etherscan-style APIs)
- Celo: `celo.blockscout.com/api`
- Gnosis: `gnosis.blockscout.com/api`
- Aurora: `explorer.aurora.dev/api`
- Moonbeam: `api-moonbeam.moonscan.io/api`

### Known NOT Working (No free public tx API)
- Kava EVM - Kavascan has no public API, returns 403/404
- Any chain requiring API keys without free tier

### Quick Test
```bash
# Test txlist
curl "https://{explorer}/api?module=account&action=txlist&address=0x{any_address}&page=1&offset=5"

# Test tokentx (MUST also work)
curl "https://{explorer}/api?module=account&action=tokentx&address=0x{any_address}&page=1&offset=5"
```
If BOTH return JSON with data, the chain works. If 403/404/error, move on.

## Price Fetching Rules

### Use exact timestamps
```javascript
// WRONG - all txs on same day get same price
priceRequests.push({ token, date: tx.dateStr });

// RIGHT - each tx gets price at exact time
priceRequests.push({ token, timestamp: tx.timestamp });
```

### Cache by timestamp, not date
```javascript
// WRONG
const key = `${token}-${date}`;  // "CELO-2025-01-15"

// RIGHT
const key = `${token}-${timestamp}`;  // "CELO-1705312800000"
```

### ALWAYS include contract address for DefiLlama
DefiLlama needs contract addresses, not just symbols. Many tokens (especially DeFi protocol tokens) won't resolve by symbol alone:
```javascript
// WRONG - symbol only, many tokens won't resolve
priceRequests.push({ token: 'aCelUSDC', timestamp });

// RIGHT - include contract address
priceRequests.push({
  token: 'aCelUSDC',
  timestamp,
  address: '0x...',  // Contract address from token transfer
});
```

Tokens that need contract addresses:
- Aave receipt tokens (aCel*, aToken*)
- Protocol-specific tokens (Moola M*, etc.)
- Wrapped/bridged tokens
- Lesser known stablecoins (USDGLO, etc.)
- ANY token that's not a major like ETH/BTC/USDC

### DeFi Receipt/Debt Token Mapping
Some tokens are ~1:1 with underlying and need to be mapped:
```javascript
// Aave receipt tokens: aCelUSDC -> USDC
// Aave debt tokens: variableDebtCelWETH -> WETH
// Moola tokens: mCELO -> CELO

function getUnderlyingToken(symbol) {
  if (symbol.startsWith('aCel')) return symbol.slice(4);  // aCelUSDC -> USDC
  if (symbol.startsWith('variableDebtCel')) return symbol.slice(15);
  if (symbol.startsWith('m')) return symbol.slice(1);  // mCELO -> CELO
}
```
Then look up the underlying token's price instead.

## RALPH TASK: Add All DefiLlama-Supported Chains

### Goal
Add EVERY EVM chain that DefiLlama supports that is NOT already covered by existing tax software.

### Process for Each Chain
1. Check if chain has free public BlockScout/Etherscan-style API
2. Test BOTH `action=txlist` AND `action=tokentx` endpoints
3. If working, create a new `chain.config.ts` configuration
4. Test with a REAL wallet that has swaps/transfers
5. Verify transactions parse correctly with token movements
6. Verify prices fetch from DefiLlama
7. Mark chain as DONE in the checklist below

### EXCLUDED CHAINS (Already supported by tax software - DO NOT ADD)
```
Ethereum, Coinbase, Base, Solana, Hyperliquid, HyperEVM, Sui, Polygon, Optimism,
Arbitrum, Avalanche, Kucoin, Binance US, Coinbase Pro, Coinbase Prime,
Coinbase Exchange, Abstract, Binance Chain, Berachain, Linea, Inkchain,
Worldchain, Katana, Taiko, Zora, Blast, Gemini, Kraken, Bitcoin, Crypto.com,
Fantom, Binance (new), Binance (old), Robinhood Crypto, Cash App, Vanish,
Zcash, Apechain, Ton, Unichain, Pacifica, Extended, Variational, Aster,
Rujira, Lighter, Backpack, Terra Classic, Terra 2, Shape, Mantle, Monad,
MegaETH, Rise, Near, Ripple, Sei, Plasma, Scroll, Thorchain, Celestia,
Ronin, Algorand, OKX, BlockFi, Voyager, Fuse, Juno, Uphold, MetalPay,
Bitvavo, Aptos, Tezos, Cardano, Dogechain, Dogecoin, Litecoin, Sonic,
Flow, Exodus, Polkadot, Pokt, Gnosis, BitForex, Crypto4Winners, UpBit,
CoinDCX, CoinEx, Bitcoin Swan, Chia, Proof of Memes, Celsius, FTX, FTX US,
Helium, Metis, Coinmetro, LedgerX, Newton Exchange, LocalBitcoins, Swyftx,
Cronos, CoinStats, Huobi, Bitfinex, Bitmax, Bitstamp, ByBit, Gate.io,
Poloniex, MEXC, Digifinex, Tron, Coincheck, Whitebit, BKEX, Bitrue, BTCEX,
Bithumb, CoinSpot, Nexo, Bitclout, Stacks, zkSync Lite, zkSync Era,
StarkNet, Story, Wax, Cosmos, Juno Chain, Osmosis, Secret, Bingx, Coinhako,
Deribit, Theta, VeChain, xt.com, Canto, ImmutableX, STEX, Bitso, Bitbank,
Bittrex, Okcoin, BitMEX, BitFlyer, LBANK, Bitget, Bitmart, Coinone, Tapbit,
Blockchain.com, Bit.com, Bitpanda, CEX.io, Dcoin, Bitfront, BTSE, Citex,
Bione, Changelly, Bitay, Harmony, Nifty Gateway, Moonriver, Energy Web,
Klaytn, Plume, Circle, Mercury, Meow, Bank of America, Chase, Citi,
Charles Schwab, General Exchange, General Blockchain, General Perpetuals,
Koinly, Token Tax, CoinTracker
```

### Chain Progress Checklist
Track progress here. Mark [x] when fully tested and working, [!] if no working API.

#### Confirmed Working
- [x] Celo - `celo.blockscout.com/api` - DONE

#### Confirmed NOT Working (No free API)
- [!] Kava - No public API, returns 403/404

#### DefiLlama EVM Chains To Add (NOT in exclusion list)
Test each one. If API works, implement and mark [x]. If no API, mark [!].

**Priority 1 - Likely have BlockScout APIs:**
- [x] Aurora - `explorer.aurora.dev/api` - Tested with 0x88928ff265a144aef2c5e228d536d9e477a68cfc (50 swaps, 0% missing prices)
- [ ] Moonbeam
- [ ] Moonriver
- [ ] Boba
- [ ] Evmos
- [ ] Astar
- [ ] Shiden
- [ ] Palm
- [ ] Milkomeda
- [ ] Milkomeda A1
- [ ] Oasis
- [ ] Heco
- [ ] RSK
- [ ] Telos
- [x] Fuse - `explorer.fuse.io/api` - Tested with 0x459dc0dcb82c7e3c791041f9cdb5f797b6459315 (11 swaps, 7.5% missing prices - LP tokens)
- [ ] Elastos
- [ ] Cube
- [ ] Syscoin
- [ ] Meter
- [ ] ThunderCore
- [ ] Nahmii
- [ ] Godwoken
- [ ] GodwokenV1
- [ ] Velas
- [ ] EnergyWeb
- [ ] CLV
- [ ] Callisto

**Priority 2 - Other EVM chains:**
- [ ] 0G
- [ ] AILayer
- [ ] AirDAO
- [ ] Aleph Zero EVM
- [ ] Althea
- [ ] Ancient8
- [ ] Arbitrum Nova
- [ ] Artela
- [ ] Asset Chain
- [ ] Astar zkEVM
- [ ] Beam
- [ ] BESC Hyperchain
- [ ] Bitcichain
- [ ] Bitgert
- [ ] Bitkub
- [ ] Bitlayer
- [ ] Bitrock
- [ ] Bittensor EVM
- [ ] Bittorrent
- [ ] BOB
- [ ] Botanix
- [ ] BounceBit
- [ ] Capx Chain
- [ ] Chiliz
- [ ] Citrea
- [ ] CMP
- [ ] Corn
- [ ] Crab
- [ ] Cronos zkEVM
- [ ] CROSS
- [ ] CrossFi
- [ ] CSC
- [ ] Cyber
- [ ] DChain
- [ ] DeFiChain EVM
- [ ] DeFiVerse
- [ ] Degen
- [ ] Dexalot
- [ ] DFK
- [ ] Doma
- [ ] EDU Chain
- [ ] Electroneum
- [ ] Endurance
- [ ] Energi
- [ ] ENI
- [ ] Eteria
- [ ] Ethereal
- [x] EthereumClassic - `etc.blockscout.com/api` - API works, limited DeFi activity on chain
- [ ] Etherlink
- [ ] exSat
- [ ] Filecoin
- [ ] Findora
- [ ] Fluence
- [ ] Form Network
- [ ] Fraxtal
- [ ] Fusion
- [ ] GANchain
- [ ] GateLayer
- [ ] Genesys
- [ ] Goat
- [ ] GoChain
- [ ] Gravity
- [ ] GRX Chain
- [ ] Ham
- [ ] HAQQ
- [ ] HashKey Chain
- [ ] Haven1
- [ ] Hedera
- [ ] HeLa
- [ ] Hemi
- [ ] Hoo
- [ ] Horizen EON
- [ ] HPB
- [ ] Mind Network
- [ ] Mint
- [ ] Mode
- [ ] Moonchain
- [ ] Movement
- [ ] MTT Network
- [ ] MUUCHAIN
- [ ] Neon
- [ ] Neo X Mainnet
- [ ] Nibiru
- [ ] Nova Network
- [ ] Odyssey
- [ ] OntologyEVM
- [ ] Op_Bnb
- [ ] OXFUN
- [ ] Parex
- [ ] Peaq
- [ ] Pepu
- [ ] Perennial
- [ ] Planq
- [ ] Plume Mainnet
- [ ] Polis
- [ ] Polygon zkEVM
- [ ] Polynomial
- [ ] Prom
- [ ] Q Protocol
- [ ] Rari
- [ ] re.al
- [ ] Redstone
- [ ] REI
- [ ] REIchain
- [ ] Reya Network
- [ ] Saakuru
- [ ] Saga
- [ ] Sanko
- [ ] Sapphire
- [ ] SatoshiVM
- [ ] Silicon zkEVM
- [ ] smartBCH
- [ ] Somnia
- [ ] Soneium
- [ ] Songbird
- [ ] Sophon
- [ ] Stable
- [ ] Stratis
- [ ] Superposition
- [ ] Superseed
- [ ] Swan
- [ ] Swellchain
- [ ] TAC
- [ ] Taraxa
- [ ] Theta
- [ ] Titan
- [ ] TomoChain
- [ ] Ubiq
- [ ] Ultron
- [ ] VinuChain
- [ ] VirBiCoin
- [ ] Wanchain
- [ ] Waterfall
- [ ] WINR
- [ ] Xone Chain
- [ ] Xphere
- [ ] XRPL EVM
- [ ] Zero Network
- [ ] ZetaChain
- [ ] Zircuit
- [ ] Zkfair
- [ ] zkLink
- [ ] ZYX

### How to Find DefiLlama Chain IDs
```bash
curl -s "https://api.llama.fi/chains" | jq '.[].name' | head -50
```

### Test Requirements for Each Chain

**Step 1: Find a test wallet**
Find a wallet on the chain's block explorer that has:
- At least 5-10 swap transactions
- Some transfer in/out transactions
- Recent activity (within last few months)

**Step 2: Test API endpoints work**
```bash
# Test txlist returns data
curl -s "https://{explorer}/api?module=account&action=txlist&address={wallet}&page=1&offset=5" | jq '.status'
# Should return "1"

# Test tokentx returns data
curl -s "https://{explorer}/api?module=account&action=tokentx&address={wallet}&page=1&offset=5" | jq '.status'
# Should return "1"
```

**Step 3: Test full export with CSV validation**
```bash
# Export with JSON to see stats
curl -s "http://localhost:3000/api/export?address={wallet}&chain={chainId}&limit=50&format=json" | jq '.stats'

# Verify:
# - total > 0
# - tagCounts.swap > 0 (MUST have swaps)
# - missingPrices should be low (< 20% of total)
```

**Step 4: Validate CSV output makes sense**
```bash
# Get CSV and check first few swaps
curl -s "http://localhost:3000/api/export?address={wallet}&chain={chainId}&limit=20" | head -10

# Verify for swap rows:
# - Received Quantity is NOT empty
# - Received Currency is NOT empty
# - Sent Quantity is NOT empty
# - Sent Currency is NOT empty
# - Received Fiat Amount has a price (not empty)
# - Sent Fiat Amount has a price (not empty)
# - Fee Amount and Fee Currency are populated
# - Tag is "swap"
```

**Step 5: Sanity check prices**
- Native token price should be reasonable (check CoinGecko)
- Stablecoin prices should be ~$1.00 (+/- 5%)
- Major tokens should have prices, not empty

**WALLET REQUIREMENTS:**
- Test wallet MUST have swap transactions (not just transfers/fees)
- Find wallets on block explorer by looking at DEX contract interactions

**PRICE REQUIREMENTS:**
- Target: 0% missing prices
- If > 0% but <= 10% missing: ACCEPTABLE, proceed to commit
- If > 10% missing prices: TROUBLESHOOT before giving up:
  1. Check if DefiLlama supports this chain (curl https://api.llama.fi/chains | grep -i chainname)
  2. Verify the defiLlamaId is correct in the chain config
  3. Check if token contract addresses are being passed correctly
  4. Try adding token mappings if needed (like aCel* -> underlying)
  5. If still > 10% after troubleshooting: mark chain as problematic in CLAUDE.md and move on

**FAIL CONDITIONS - Do NOT commit if:**
- txlist or tokentx API returns errors/403/404
- No swaps detected (test wallet must have swaps!)
- More than 10% of prices are missing
- CSV has empty Received/Sent columns for swaps
- Prices are clearly wrong (e.g., $0.00 or $999999)

### When Chain Complete
1. Create new chain file: `chains/{chainname}.ts` (copy from `chains/celo.ts` as template)
2. Export from `chains/index.ts`
3. Test with real wallet (swaps + transfers)
4. Verify prices fetch correctly
5. Commit and push to remote:

**IMPORTANT: Always push to remote after committing!**
```bash
git push origin multi-chain
```
Remote: https://github.com/clrhc/injective-tax-exporter/tree/multi-chain
```bash
git add chains/{chainname}.ts chains/index.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
feat: Add {ChainName} chain support

- DefiLlama ID: {id}
- Explorer API: {url}
- Tested with wallet: {address}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push origin multi-chain
```
6. Mark [x] in checklist above in CLAUDE.md
7. Say: CHAIN_{NAME}_DONE

## Project Context

This is a generic multi-chain tax exporter for EVM chains.

### Key Files
- `chains/` folder - Each chain has its own file (e.g., `chains/celo.ts`)
- `chains/index.ts` - Exports all chains and provides getChain(), getAllChains()
- `chains/types.ts` - TypeScript interfaces for chain config
- `app/api/prices/route.ts` - Generic pricing using DefiLlama (no hardcoded prices!)
- `app/api/transactions/[address]/route.ts` - Fetches BOTH txlist AND tokentx
- `app/api/chains/route.ts` - Returns list of available chains for UI dropdown
- `app/page.jsx` - UI with chain selector that parses transactions using token transfer data

### Adding a New Chain
1. Copy `chains/celo.ts` to `chains/{newchain}.ts`
2. Update all chain-specific values (id, name, symbol, chainId, defiLlamaId, explorerUrl, etc.)
3. Update `nativeToken` with correct symbol and coingeckoId
4. Update `transactionApi.buildUrl` with the correct explorer API
5. Import and export from `chains/index.ts`:
```typescript
import newchain from './newchain';
export const chains: Record<string, ChainConfig> = { celo, newchain };
```

### Price Sources (in order)
1. DefiLlama historical prices (with exact timestamp)
2. Pyth Network oracle
3. CoinGecko API

All prices must be fetched at exact transaction time - no assumptions, no shortcuts, no daily aggregation.
