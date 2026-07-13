/**
 * Environment-derived configuration.
 *
 * All payment credentials are read here and nowhere else so that no other
 * module can accidentally read a secret. `getPaymentConfig` returns `null`
 * (rather than a partial object) whenever any required secret is missing, so
 * callers cannot construct a half-configured payment gate — that is the
 * "fail closed" contract the rest of the service relies on.
 */

export interface PaymentConfig {
  readonly okxApiKey: string;
  readonly okxSecretKey: string;
  readonly okxPassphrase: string;
  readonly payTo: string;
  readonly okxBaseUrl: string;
  readonly network: string;
  /** Atomic-unit price string, always "250000" (0.25 USDT at 6 decimals). */
  readonly amountAtomic: string;
  /** Exact verified USDT contract address; ambiguous dollar fallback is forbidden. */
  readonly assetAddress: string;
}

export const OKX_FACILITATOR_URL = 'https://web3.okx.com';
export const X_LAYER_MAINNET = 'eip155:196';
export const X_LAYER_USDT0_ATTESTATION = 'USDT0@eip155:196';

/**
 * Returns a fully-populated PaymentConfig, or null if payment is not
 * configured. Payment is considered configured only when every required OKX
 * credential plus the pay-to address are present and non-empty.
 */
export function getPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig | null {
  const okxApiKey = (env.OKX_API_KEY ?? '').trim();
  const okxSecretKey = (env.OKX_SECRET_KEY ?? '').trim();
  const okxPassphrase = (env.OKX_PASSPHRASE ?? '').trim();
  const payTo = (env.PAY_TO_ADDRESS ?? '').trim();
  const network = (env.X402_NETWORK ?? '').trim();
  const assetAddress = (env.X402_ASSET_ADDRESS ?? '').trim();
  const assetAttestation = (env.X402_ASSET_ATTESTATION ?? '').trim();

  // A common placeholder in .env.example. Treat the all-zero address as "unset"
  // so an unedited example file cannot accidentally look configured.
  const payToIsValid = /^0x[0-9a-f]{40}$/i.test(payTo) && !/^0x0{40}$/i.test(payTo);

  const assetIsValid = /^0x[0-9a-f]{40}$/i.test(assetAddress) && !/^0x0{40}$/i.test(assetAddress);
  if (
    !okxApiKey ||
    !okxSecretKey ||
    !okxPassphrase ||
    !payToIsValid ||
    network !== X_LAYER_MAINNET ||
    !assetIsValid ||
    assetAttestation !== X_LAYER_USDT0_ATTESTATION
  ) {
    return null;
  }

  const assetDecimalsRaw = (env.X402_ASSET_DECIMALS ?? '').trim();
  const assetDecimals = /^\d+$/.test(assetDecimalsRaw) ? Number(assetDecimalsRaw) : 6;
  if (assetDecimals !== 6) return null;

  return {
    okxApiKey,
    okxSecretKey,
    okxPassphrase,
    payTo,
    okxBaseUrl: OKX_FACILITATOR_URL,
    network,
    amountAtomic: '250000', // 0.25 * 10^6
    assetAddress,
  };
}

export function isPaymentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getPaymentConfig(env) !== null;
}

export const PROTECTED_ROUTE = 'POST /v1/generate-llms-files';
