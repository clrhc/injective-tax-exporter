# Plan: Multi-Asset CSV Support

## Summary
Generate two separate CSVs in a ZIP file:
- **Standard CSV**: Simple transactions (0-1 token each side)
- **Multi-Asset CSV**: Complex transactions (2+ tokens on either side)

---

## Transaction Classification

| Received Tokens | Sent Tokens | Goes In |
|-----------------|-------------|---------|
| 0-1 | 0-1 | Standard CSV |
| 2+ | any | Multi-Asset CSV |
| any | 2+ | Multi-Asset CSV |

**Examples:**
- Swap 100 USDC → 0.05 ETH → **Standard**
- Transfer In 50 CELO → **Standard**
- Remove LP: 10 LP → 100 USDC + 0.05 ETH → **Multi-Asset**
- Add LP: 100 USDC + 0.05 ETH → 10 LP → **Multi-Asset**

---

## CSV Formats

### Standard CSV (unchanged)
```
Date, Received Quantity, Received Currency, Received Fiat Amount,
Sent Quantity, Sent Currency, Sent Fiat Amount,
Fee Amount, Fee Currency, Transaction Hash, Notes, Tag
```

### Multi-Asset CSV (new)
```
Date, Received Quantity, Received Currency, Received Fiat Amount,
Sent Quantity, Sent Currency, Sent Fiat Amount,
Received Quantity 2, Received Currency 2,
Sent Quantity 2, Sent Currency 2,
Fee Amount, Fee Currency, Notes, Tag
```
*Note: No Transaction Hash column per Awaken template*

---

## Download Output

**Single button** → Downloads ZIP file

**ZIP filename:** `{chain}_{address}_export.zip`

**ZIP contents:**
- `standard.csv` - Simple transactions
- `multi_asset.csv` - Complex transactions

---

## Implementation Steps

### Step 1: Modify Transaction Parsing
**File:** `app/page.jsx` (~line 450-540)

Current behavior: Splits multi-token txs into multiple rows
New behavior: Keep all tokens in arrays, classify later

```javascript
// After processing tokentx, keep arrays:
const txData = {
  hash: txHash,
  timestamp: timestamp,
  tokensIn: netTokensIn,   // Array of {symbol, amount, decimals, contractAddress}
  tokensOut: netTokensOut, // Array of {symbol, amount, decimals, contractAddress}
  feeAmount,
  feeCurrency,
  notes,
  // Classification determined later
};
```

### Step 2: Classify Transactions
After parsing, split into two lists:

```javascript
const simpleTxs = [];    // For standard CSV
const complexTxs = [];   // For multi-asset CSV

for (const tx of allTxs) {
  const isComplex = tx.tokensIn.length > 1 || tx.tokensOut.length > 1;

  if (isComplex) {
    // Handle overflow: if >2 tokens on a side, split into multiple rows
    complexTxs.push(...expandComplexTx(tx));
  } else {
    simpleTxs.push(flattenSimpleTx(tx));
  }
}
```

### Step 3: Handle Overflow (>2 tokens)
```javascript
function expandComplexTx(tx) {
  const rows = [];
  const maxIn = tx.tokensIn.length;
  const maxOut = tx.tokensOut.length;
  const rowCount = Math.max(Math.ceil(maxIn / 2), Math.ceil(maxOut / 2));

  for (let i = 0; i < rowCount; i++) {
    rows.push({
      ...tx,
      received1: tx.tokensIn[i * 2] || null,
      received2: tx.tokensIn[i * 2 + 1] || null,
      sent1: tx.tokensOut[i * 2] || null,
      sent2: tx.tokensOut[i * 2 + 1] || null,
      // Only first row gets the fee
      feeAmount: i === 0 ? tx.feeAmount : '',
      feeCurrency: i === 0 ? tx.feeCurrency : '',
    });
  }
  return rows;
}
```

### Step 4: Update Price Fetching
Fetch prices for ALL tokens in both arrays:

```javascript
for (const tx of allTxs) {
  for (const token of tx.tokensIn) {
    priceRequests.push({
      token: token.symbol,
      timestamp: tx.timestamp,
      address: token.contractAddress,
    });
  }
  for (const token of tx.tokensOut) {
    priceRequests.push({
      token: token.symbol,
      timestamp: tx.timestamp,
      address: token.contractAddress,
    });
  }
}
```

### Step 5: Add `generateMultiAssetCSV()` Function
**File:** `app/page.jsx` (~after line 609)

```javascript
function generateMultiAssetCSV(transactions) {
  const headers = [
    'Date',
    'Received Quantity', 'Received Currency', 'Received Fiat Amount',
    'Sent Quantity', 'Sent Currency', 'Sent Fiat Amount',
    'Received Quantity 2', 'Received Currency 2',
    'Sent Quantity 2', 'Sent Currency 2',
    'Fee Amount', 'Fee Currency',
    'Notes', 'Tag'
  ];

  const rows = transactions.map(tx => [
    tx.dateFormatted,
    tx.received1?.amount || '', tx.received1?.symbol || '', tx.received1?.fiat || '',
    tx.sent1?.amount || '', tx.sent1?.symbol || '', tx.sent1?.fiat || '',
    tx.received2?.amount || '', tx.received2?.symbol || '',
    tx.sent2?.amount || '', tx.sent2?.symbol || '',
    tx.feeAmount || '', tx.feeCurrency || '',
    tx.notes || '', tx.tag || ''
  ]);

  return [headers.join(','), ...rows.map(r => r.map(escapeCell).join(','))].join('\n');
}
```

### Step 6: Create ZIP Download
**File:** `app/page.jsx` - download section

```javascript
import JSZip from 'jszip';

async function downloadZip() {
  const zip = new JSZip();

  const standardCsv = generateCSV(simpleTxs);
  const multiAssetCsv = generateMultiAssetCSV(complexTxs);

  zip.file('standard.csv', standardCsv);
  zip.file('multi_asset.csv', multiAssetCsv);

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${selectedChainId}_${address.slice(0,6)}...${address.slice(-4)}_export.zip`;
  a.click();
}
```

### Step 7: Update UI
Replace current download with single ZIP download:

```jsx
<button onClick={downloadZip}>
  Download CSV Export (ZIP)
</button>
<p>Contains: standard.csv + multi_asset.csv</p>
```

### Step 8: Add JSZip Dependency
```bash
npm install jszip
```

---

## Files to Modify

1. **`app/page.jsx`**
   - Transaction parsing structure (~line 380-540)
   - Price fetching (~line 1243-1270)
   - Add `generateMultiAssetCSV()` function
   - Add ZIP download logic
   - Update UI download section

2. **`package.json`**
   - Add `jszip` dependency

---

## Test Case

**Wallet:** `0x459dc0dcb82c7e3c791041f9cdb5f797b6459315` (Fuse)
**Expected:** LP removals appear in `multi_asset.csv` with proper token 1 + token 2 columns
