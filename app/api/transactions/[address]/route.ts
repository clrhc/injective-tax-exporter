// app/api/transactions/[address]/route.js
// Simplified - just proxies to Injective Explorer API

const EXPLORER_API = 'https://sentry.exchange.grpc-web.injective.network/api/explorer/v1';

export async function GET(request, { params }) {
  const resolvedParams = await params;
  const address = resolvedParams.address;
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get('limit') || '100';
  const skip = searchParams.get('skip') || '0';

  if (!address || !address.startsWith('inj1')) {
    return Response.json({ error: 'Invalid Injective address' }, { status: 400 });
  }

  try {
    const url = `${EXPLORER_API}/accountTxs/${address}?limit=${limit}&skip=${skip}`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return Response.json(
        { error: `Injective API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return Response.json(data);

  } catch (error) {
    return Response.json(
      { error: error.message || 'Failed to fetch data' },
      { status: 500 }
    );
  }
}