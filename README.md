# Injective Tax Exporter

A web application that fetches, processes, and exports your Injective blockchain transaction history in [Awaken Tax](https://awaken.tax) CSV format. Built with Next.js 16, React 19, and Tailwind CSS 4.

## Features

- **Full Transaction History** — Fetches complete transaction history from any Injective wallet address using the Injective Explorer API
- **Awaken Tax Compatible** — Exports CSV files formatted specifically for [Awaken Tax](https://help.awaken.tax/en/articles/10422149-how-to-format-your-csv-for-awaken-tax) import
- **Historical Price Fetching** — Retrieves USD prices from Injective DEX trades (chain-specific) with Pyth Network fallback for cross-chain pricing
- **FIFO Cost Basis Tracking** — Automatically calculates realized P&L using First-In-First-Out cost basis accounting
- **Transaction Classification** — Automatically categorizes transactions into Awaken Tax compatible tags:
  - Swaps
  - Transfers (In/Out)
  - Staking (Deposit/Return/Claim)
  - Liquidity (Add/Remove)
  - Derivatives (Open/Close Position)
  - Rewards & Fees
- **Smart Token Resolution** — Resolves token symbols and decimals from [Injective's official token list](https://github.com/InjectiveLabs/injective-lists) with local caching
- **Date Range Filtering** — Filter transactions by custom date ranges
- **Transaction Type Filtering** — Toggle specific transaction types to include/exclude
- **Pagination** — Browse large transaction histories with paginated results
- **Local Caching** — Caches token metadata and price data in localStorage for faster subsequent loads

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm, yarn, pnpm, or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/injective-tax-exporter.git
cd injective-tax-exporter

# Install dependencies
npm install
# or
yarn install
# or
pnpm install
```

### Development

Start the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build

```bash
npm run build
npm run start
```

## Usage

1. **Enter Wallet Address** — Input your Injective wallet address (starts with `inj1`, 42 characters total)
2. **Set Date Range** — Optionally adjust the start and end dates (defaults to past year)
3. **Select Transaction Types** — Toggle which transaction types to include
4. **Fetch Transactions** — Click "Fetch Transactions" to retrieve your history
5. **Review Data** — Browse the paginated transaction table
6. **Export CSV** — Download the Awaken Tax formatted CSV file

## Project Structure

```
injective-tax-exporter/
├── app/
│   ├── api/
│   │   ├── prices/
│   │   │   └── route.ts         # Historical price API (Injective DEX + Pyth)
│   │   └── transactions/
│   │       └── [address]/
│   │           └── route.ts     # Transaction fetching proxy API
│   ├── globals.css              # Global styles
│   ├── layout.jsx               # Root layout with metadata
│   ├── page.jsx                 # Main application component
│   └── favicon.ico
├── public/                      # Static assets
├── next.config.mjs              # Next.js configuration
├── tailwind.config.js           # Tailwind CSS configuration
├── tsconfig.json                # TypeScript configuration
└── package.json
```

## API Routes

### `GET /api/transactions/[address]`

Proxies requests to the Injective Explorer API to fetch account transactions.

**Query Parameters:**
- `limit` (default: 100) — Number of transactions per page
- `skip` (default: 0) — Offset for pagination

**Response:** Raw transaction data from Injective Explorer API

### `POST /api/prices`

Fetches historical USD prices for tokens.

**Request Body:**
```json
{
  "requests": [
    { "token": "INJ", "date": "2024-01-15" },
    { "token": "ATOM", "date": "2024-01-15" }
  ]
}
```

**Response:**
```json
{
  "prices": { "INJ-2024-01-15": 38.50, "ATOM-2024-01-15": 10.25 },
  "sources": { "INJ-2024-01-15": "injective-dex", "ATOM-2024-01-15": "pyth" },
  "missing": ["UNKNOWN-2024-01-15"]
}
```

**Price Sources (in priority order):**
1. **Injective DEX** — On-chain trade prices from spot markets (most accurate for Injective-specific pricing)
2. **Pyth Network** — Cross-chain oracle prices as fallback

### `GET /api/prices`

Single price lookup endpoint.

**Query Parameters:**
- `token` (required) — Token symbol (e.g., `INJ`, `ATOM`)
- `date` (optional) — Date in `YYYY-MM-DD` format (defaults to today)

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
| Fee Currency | Fee token symbol |
| Transaction Hash | On-chain transaction hash |
| Notes | Transaction type/action description |
| Tag | Awaken Tax category label |

## Supported Transaction Types

| Tag | Description |
|-----|-------------|
| `Swap` | Token-to-token exchanges |
| `Transfer In` | Incoming transfers, IBC receives |
| `Transfer Out` | Outgoing transfers, IBC sends, bridge exits |
| `Staking Deposit` | Delegation to validators |
| `Staking Return` | Undelegation returns |
| `Staking Claim` | Staking reward claims |
| `Add Liquidity` | LP token minting |
| `Remove Liquidity` | LP token burning |
| `Open Position` | Derivatives position opening |
| `Close Position` | Derivatives position closing |
| `Reward` | Protocol rewards, airdrops, farming yields |
| `Fee` | Transaction fees |

## Supported Tokens for Pricing

### Injective DEX Markets (Chain-Specific)
- INJ, WETH, ATOM, SOL, TIA

### Pyth Network Fallback (Cross-Chain)
- INJ, ETH, WETH, BTC, WBTC, ATOM, SOL, USDT, USDC, TIA, OSMO, AVAX, MATIC, LINK, UNI, BNB

Additional tokens are resolved from the Injective token list but may not have historical price data available.

## Configuration

### Environment Variables

No environment variables are required. The application uses public API endpoints:

- **Injective Explorer:** `https://sentry.exchange.grpc-web.injective.network`
- **Pyth Benchmarks:** `https://benchmarks.pyth.network`
- **Token List:** `https://raw.githubusercontent.com/InjectiveLabs/injective-lists/master/json/tokens/mainnet.json`

### Caching

The application uses localStorage for caching:

- **Token Cache** (`inj_token_cache_v2`) — Token metadata, 24-hour TTL
- **Price Cache** (`inj_price_cache_v2`) — Historical prices, 24-hour TTL

## Tech Stack

- **Framework:** [Next.js 16](https://nextjs.org/) (App Router)
- **UI:** [React 19](https://react.dev/)
- **Styling:** [Tailwind CSS 4](https://tailwindcss.com/)
- **Language:** JavaScript/TypeScript
- **APIs:** Injective Explorer, Injective Exchange, Pyth Network

## Limitations

- Historical prices are only available for tokens with Injective DEX trading activity or Pyth oracle support
- Some exotic or newly launched tokens may not have price data
- Failed transactions are included to capture gas fee deductions
- Rate limits apply to external API calls (batched requests with delays)

## Deployment

### Vercel (Recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-username/injective-tax-exporter)

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

Contributions are welcome! Please open an issue or submit a pull request.

## Related Links

- [Awaken Tax](https://awaken.tax) — Crypto tax software
- [Awaken Tax CSV Format Guide](https://help.awaken.tax/en/articles/10422149-how-to-format-your-csv-for-awaken-tax)
- [Awaken Tax Labels Guide](https://help.awaken.tax/en/articles/10453755-how-do-i-label-my-transactions)
- [Injective Protocol](https://injective.com/)
- [Injective Explorer](https://explorer.injective.network/)
- [Pyth Network](https://pyth.network/)