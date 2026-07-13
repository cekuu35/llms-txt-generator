# Site Context Forge — x402 service

Paid API adapter for generating review-ready llms.txt and optional llms-full.txt
content from a bounded crawl of a public HTTPS website.

## Current status

**This service is not live or monetized yet.** A deployment must not be listed on
OKX.AI until an unauthenticated request returns a real x402 v2 402 response and a
real paid replay returns 200 with the documented output. The public preview is a
static example and never performs a crawl.

## API

- GET /health — public readiness without secret values.
- GET /api/preview — public deterministic static example.
- POST /v1/generate-llms-files — paid endpoint, launch price 0.25 units of the
  configured six-decimal stablecoin asset.

Input:

~~~json
{
  "websiteUrl": "https://example.com/",
  "maxPages": 20,
  "includeFullText": true,
  "maxContentCharsPerPage": 12000
}
~~~

The response includes fileContents.llmsTxt and, when requested,
fileContents.llmsFullTxt. Durable download URLs are deliberately not claimed:
serverless local files do not persist.

## Local verification

~~~bash
npm install
npm test
npm run build
npm run dev
~~~

With payment variables absent, a valid paid request must fail closed:

~~~bash
curl -i -X POST http://127.0.0.1:3000/v1/generate-llms-files \
  -H "content-type: application/json" \
  -d "{\websiteUrl\:\https://example.com/\}"
~~~

Expected: 503 PAYMENT_NOT_CONFIGURED. Invalid input is rejected before any
payment middleware call.

## Required server-only variables

Copy .env.example to a local secret store. Never commit values.

- OKX_API_KEY
- OKX_SECRET_KEY
- OKX_PASSPHRASE
- PAY_TO_ADDRESS
- OKX_BASE_URL
- X402_NETWORK (eip155:196 for X Layer mainnet)
- X402_ASSET_ADDRESS — verified mainnet USDT contract chosen in the OKX flow
- X402_ASSET_DECIMALS — currently 6

Configuration is considered incomplete if any credential, receiving address,
network, or explicit asset address is missing. This prevents an accidental free
fallback or an ambiguous stablecoin listing.

## Security model

- Strict JSON with an 8kb body limit.
- HTTPS only; credentials and custom ports are rejected.
- Loopback, private, link-local, multicast, reserved, documentation, CGNAT and
  IPv4-mapped IPv6 ranges are blocked.
- Every DNS answer is validated. Requests are pinned to validated addresses.
- Redirects are manual, same-origin, re-resolved and capped at three.
- Responses are restricted to HTML/plain text and one megabyte per page.
- Page timeout, including DNS resolution, is eight seconds; overall crawl timeout is 25 seconds; page cap is 25.
- Crawl discovery is bounded and same-origin. A successfully fetched robots.txt
  disallow rule is honored. Robots fetch failure does not expand crawl scope.
- Client responses never contain stack traces or credential values.

The crawler is sequential today, which is stricter than the maximum concurrency
of three and keeps resource use predictable for the first paid calls.

## Pre-deploy gates

1. npm test and npm run build pass without internet-dependent tests.
2. Confirm X402_ASSET_ADDRESS is the intended mainnet USDT asset.
3. Deploy with server-only variables; verify /health says payment configured.
4. Valid request without a payment signature returns real HTTP 402 and a
   decodable x402 v2 PAYMENT-REQUIRED header.
5. Perform one controlled real payment and replay; verify HTTP 200, settlement
   evidence, the exact price and recipient, and one execution of generation.
6. Test two public sites and a redirect/private-IP rejection case.
7. Only then create the OKX.AI listing, record the <=90 second demo and publish
   the bounded claim. There is no ranking, indexing, citation, traffic or revenue
   guarantee.

## Known operational limits

Payment settlement is handled by the official OKX x402 packages. Replay and
settlement behavior still requires a real facilitator smoke test. Vercel does not
provide durable local files, so the API returns file contents. Persistent,
signed download links would require a separately configured object store.
