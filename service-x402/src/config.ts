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
// Verified against the official OKX USDT0 FAQ and the OnchainOS v4.2.4
// payment requirements returned for eip155:196 on 2026-07-13.
export const X_LAYER_USDT0_ASSET = '0x779ded0c9e1022225f8e0630b35a9b54be713736';

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

  // A common placeholder in .env.example. Treat the all-zero address as "unset"
  // so an unedited example file cannot accidentally look configured.
  const payToIsValid = /^0x[0-9a-f]{40}$/i.test(payTo) && !/^0x0{40}$/i.test(payTo);

  if (
    !okxApiKey ||
    !okxSecretKey ||
    !okxPassphrase ||
    !payToIsValid
  ) {
    return null;
  }

  return {
    okxApiKey,
    okxSecretKey,
    okxPassphrase,
    payTo,
    okxBaseUrl: OKX_FACILITATOR_URL,
    network: X_LAYER_MAINNET,
    amountAtomic: '250000', // 0.25 * 10^6
    assetAddress: X_LAYER_USDT0_ASSET,
  };
}

export function isPaymentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getPaymentConfig(env) !== null;
}

export const PROTECTED_ROUTE = 'POST /v1/generate-llms-files';
