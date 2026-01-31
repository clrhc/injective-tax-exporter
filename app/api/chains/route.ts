// app/api/chains/route.ts
// Returns list of available chains

import { getAllChains } from '../../../chains';

export async function GET() {
  const chains = getAllChains().map(chain => ({
    id: chain.id,
    name: chain.name,
    symbol: chain.symbol,
    logo: chain.logo,
    chainId: chain.chainId,
    explorerUrl: chain.explorerUrl,
    theme: chain.theme,
    nativeToken: chain.nativeToken,
  }));

  return Response.json({ chains });
}
