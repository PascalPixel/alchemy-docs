// Plausible's event endpoint, relayed with the visitor's address.
// A rewrite in vercel.json reaches Plausible from Vercel's own servers, so
// Plausible placed every visitor where that server was.

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || '';
  const upstream = await fetch('https://plausible.io/api/event', {
    method: 'POST',
    headers: {
      'Content-Type': request.headers.get('content-type') ?? 'text/plain',
      'User-Agent': request.headers.get('user-agent') ?? '',
      'X-Forwarded-For': ip,
    },
    body: await request.text(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain' },
  });
}
