import { getAddress } from "viem";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  decodeHeader,
  encodeHeader,
  type PaymentRequired,
  type SettleResponse,
} from "../core/x402";
import type { PaymentRecord } from "./store";
import type { ZeroupWallet } from "./wallet";

export interface PaidResponse {
  response: Response;
  payment?: { record: PaymentRecord; settlement?: SettleResponse };
}

/**
 * fetch() that answers HTTP 402 automatically: picks a compatible "exact"
 * option, pays it privately from the shielded balance and retries once with
 * PAYMENT-SIGNATURE.
 */
export function createPrivateFetch(wallet: ZeroupWallet) {
  return async function privateFetch(url: string, init: RequestInit = {}): Promise<PaidResponse> {
    const first = await fetch(url, init);
    if (first.status !== 402) return { response: first };
    const header = first.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!header) return { response: first };

    const required = decodeHeader<PaymentRequired>(header);
    const token = getAddress(wallet.deployment.token);
    const option = required.accepts.find((a) => {
      try {
        return a.scheme === "exact" && a.network === wallet.network && getAddress(a.asset) === token;
      } catch {
        return false;
      }
    });
    if (!option) throw new Error(`no payment option this wallet supports (wallet: ${wallet.network})`);

    const { payload, record } = await wallet.pay(option, required.resource ?? { url });
    const headers = new Headers(init.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, encodeHeader(payload));
    const response = await fetch(url, { ...init, headers });
    const settleHeader = response.headers.get(HEADER_PAYMENT_RESPONSE);
    const settlement = settleHeader ? decodeHeader<SettleResponse>(settleHeader) : undefined;
    await wallet.recordSettlement(record.id, settlement, response.status);
    return { response, payment: { record: { ...record, status: settlement?.success ? "paid" : "failed", settleTx: settlement?.transaction }, settlement } };
  };
}
