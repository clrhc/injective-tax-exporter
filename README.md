# Multi-Chain Tax Exporter

A web application that fetches, processes, and exports blockchain transaction history in [Awaken Tax](https://awaken.tax) CSV format. Supports any EVM chain with a public BlockScout/Etherscan-style API. Built with Next.js 16, React 19, and Tailwind CSS 4.

## Supported Chains

- **Celo** - `celo.blockscout.com/api`
- More chains being added...

## Features

- **Multi-Chain Support** — Switch between chains via dropdown selector
- **Full Transaction History** — Fetches complete transaction history including token transfers (ERC20 events)
- **Awaken Tax Compatible** — Exports CSV files formatted specifically for [Awaken Tax](https://help.awaken.tax/en/articles/10422149-how-to-format-your-csv-for-awaken-tax) import
- **Historical Price Fetching** — Retrieves USD prices from DefiLlama with Pyth/CoinGecko fallback
- **Exact Timestamp Pricing** — Prices fetched at exact transaction time, not daily averages
- **FIFO Cost Basis Tracking** — Automatically calculates realized P&L using First-In-First-Out cost basis accounting
- **Transaction Classification** — Automatically categorizes transactions into Awaken Tax compatible tags:
  - Swaps (detected from token transfer events)
  - Transfers (In/Out)
  - Staking (Deposit/Return/Claim)
  - Liquidity (Add/Remove)
  - Derivatives (Open/Close Position)
  - Rewards & Fees
- **Failed Transaction Handling** — Correctly excludes phantom token transfers from reverted transactions
- **Date Range Filtering** — Filter transactions by custom date ranges
- **Transaction Type Filtering** — Toggle specific transaction types to include/exclude
- **Pagination** — Browse large transaction histories with paginated results

## Getting Started

### Prerequisites

- Node.js 18+
- npm, yarn, pnpm, or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/clrhc/injective-tax-exporter.git
cd injective-tax-exporter

# Switch to multi-chain branch
git checkout multi-chain

# Install dependencies
npm install
```

### Development

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build

```bash
npm run build
npm run start
```

## Usage

1. **Select Chain** — Choose your blockchain from the dropdown (top right)
2. **Enter Wallet Address** — Input your wallet address (0x... for EVM chains)
3. **Set Date Range** — Optionally adjust the start and end dates (defaults to past year)
4. **Select Transaction Types** — Toggle which transaction types to include
5. **Fetch Transactions** — Click "Fetch Transactions" to retrieve your history
6. **Review Data** — Browse the paginated transaction table
7. **Export CSV** — Download the Awaken Tax formatted CSV file

## Project Structure

```
multi-chain-tax-exporter/
├── app/
│   ├── api/
│   │   ├── chains/
│   │   │   └── route.ts         # Returns available chains for UI
│   │   ├── prices/
│   │   │   └── route.ts         # Historical price API (DefiLlama + Pyth + CoinGecko)
│   │   └── transactions/
│   │       └── [address]/
│   │           └── route.ts     # Transaction fetching (txlist + tokentx)
│   ├── globals.css              # Global styles
│   ├── layout.jsx               # Root layout with metadata
│   ├── page.jsx                 # Main application component
│   └── favicon.ico
├── chains/
│   ├── types.ts                 # TypeScript interfaces
│   ├── index.ts                 # Chain registry
│   └── celo.ts                  # Celo chain config (example)
├── public/                      # Static assets
├── CLAUDE.md                    # Instructions for adding new chains
└── package.json
```

## Adding a New Chain

1. Copy `chains/celo.ts` to `chains/{newchain}.ts`
2. Update all chain-specific values:
   - `id`, `name`, `symbol`, `chainId`
   - `defiLlamaId` (from DefiLlama API)
   - `nativeToken` with correct symbol and coingeckoId
   - `transactionApi.buildUrl` with explorer API endpoint
   - `explorerUrl`, `txUrl`, `addressUrl`
   - `theme` colors
3. Import and add to `chains/index.ts`
4. Test with a real wallet that has swaps and transfers

See `CLAUDE.md` for detailed instructions and the full chain checklist.

## API Routes

### `GET /api/chains`

Returns list of available chains for the UI dropdown.

**Response:**
```json
{
  "chains": [
    {
      "id": "celo",
      "name": "Celo",
      "symbol": "CELO",
      "chainId": 42220,
      "explorerUrl": "https://celo.blockscout.com",
      "theme": { "primary": "#FCFF52", "gradient": "..." },
      "nativeToken": { "symbol": "CELO", "decimals": 18 }
    }
  ]
}
```

### `GET /api/transactions/[address]`

Fetches transactions and token transfers for a wallet.

**Query Parameters:**
- `chain` (default: "celo") — Chain ID to query
- `limit` (default: 100) — Number of transactions per page
- `skip` (default: 0) — Offset for pagination

**Response:**
```json
{
  "data": [...],           // Raw transactions (txlist)
  "tokenTransfers": [...], // ERC20 token transfers (tokentx)
  "paging": { "total": 150, "hasMore": true },
  "chain": "Celo",
  "chainId": "celo"
}
```

### `POST /api/prices`

Fetches historical USD prices for tokens at exact timestamps.

**Request Body:**
```json
{
  "chain": "celo",
  "requests": [
    { "token": "CELO", "timestamp": 1705312800000, "address": "0x..." },
    { "token": "USDC", "timestamp": 1705312800000, "address": "0x..." }
  ]
}
```

**Response:**
```json
{
  "prices": { "CELO-1705312800000": 0.52, "USDC-1705312800000": 1.0 },
  "sources": { "CELO-1705312800000": "defillama", "USDC-1705312800000": "defillama" },
  "missing": ["UNKNOWN-1705312800000"]
}
```

**Price Sources (in priority order):**
1. **DefiLlama** — Historical prices by chain:token_address
2. **Pyth Network** — Cross-chain oracle prices
3. **CoinGecko** — Fallback for major tokens

## CSV Export Format

The exported CSV follows [Awaken Tax's required format](https://help.awaken.tax/en/articles/10422149-how-to-format-your-csv-for-awaken-tax):

| Column | Description |
|--------|-------------|
| Date | `MM/DD/YYYY HH:MM:SS` in UTC |
| Received Quantity | Amount received (positive number) |
| Received Currency | Token symbol received |
| Received Fiat Amount | USD value at time of transaction |
| Sent Quantity | Amount sent (positive number) |
| Sent Currency | Token symbol sent |
| Sent Fiat Amount | USD value at time of transaction |
| Fee Amount | Transaction fee amount |
| Fee Currency | Fee token symbol (native token) |
| Transaction Hash | On-chain transaction hash |
| Notes | Function name or transaction description |
| Tag | Awaken Tax category label |

## Supported Transaction Types

| Tag | Description |
|-----|-------------|
| `Swap` | Token-to-token exchanges (detected from token transfers) |
| `Transfer In` | Incoming transfers |
| `Transfer Out` | Outgoing transfers |
| `Staking Deposit` | Delegation/staking deposits |
| `Staking Return` | Unstaking returns |
| `Staking Claim` | Staking reward claims |
| `Add Liquidity` | LP token minting |
| `Remove Liquidity` | LP token burning |
| `Open Position` | Derivatives position opening |
| `Close Position` | Derivatives position closing |
| `Reward` | Protocol rewards, airdrops |
| `Fee` | Gas fees (contract interactions with no token movement) |

## Configuration

### Environment Variables

No environment variables required. The application uses public API endpoints:

- **DefiLlama:** `https://coins.llama.fi`
- **Pyth Benchmarks:** `https://benchmarks.pyth.network`
- **CoinGecko:** `https://api.coingecko.com`
- **Chain Explorers:** Various (see chain configs)

## Tech Stack

- **Framework:** [Next.js 16](https://nextjs.org/) (App Router)
- **UI:** [React 19](https://react.dev/)
- **Styling:** [Tailwind CSS 4](https://tailwindcss.com/)
- **Language:** JavaScript/TypeScript
- **Price APIs:** DefiLlama, Pyth Network, CoinGecko

## Limitations

- Requires chains with free public BlockScout/Etherscan-style APIs
- Historical prices only available for tokens with DefiLlama/Pyth/CoinGecko support
- Some DeFi receipt tokens (aTokens, etc.) may need manual price mapping
- Rate limits apply to external API calls (batched requests with delays)

## Deployment

### Vercel (Recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/clrhc/injective-tax-exporter&branch=multi-chain)

### Other Platforms

The application can be deployed to any platform supporting Next.js:
- [Netlify](https://docs.netlify.com/frameworks/next-js/)
- [AWS Amplify](https://docs.amplify.aws/guides/hosting/nextjs/)
- [Railway](https://railway.app/)
- Self-hosted with `npm run build && npm run start`

## Disclaimer

This tool is provided for informational purposes only and is **not financial or tax advice**. Always consult with a qualified tax professional for your specific situation. Transaction classifications and price data should be verified before filing taxes.

## License

MIT

## Contributing

Contributions are welcome! To add a new chain:
1. Check `CLAUDE.md` for the chain checklist
2. Follow the "Adding a New Chain" instructions above
3. Test with real wallet addresses
4. Submit a pull request

## Related Links

- [Awaken Tax](https://awaken.tax) — Crypto tax software
- [Awaken Tax CSV Format Guide](https://help.awaken.tax/en/articles/10422149-how-to-format-your-csv-for-awaken-tax)
- [Awaken Tax Labels Guide](https://help.awaken.tax/en/articles/10453755-how-do-i-label-my-transactions)
- [DefiLlama](https://defillama.com/) — DeFi TVL and pricing data
- [Pyth Network](https://pyth.network/) — Cross-chain oracle
