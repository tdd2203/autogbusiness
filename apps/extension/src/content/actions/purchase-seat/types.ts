/** Subset của PaymentChainResult — content script không import được type từ background. */
export type PaymentChainResultLite = {
  ok: boolean;
  stage: string;
  error_code?: string;
  error_message?: string;
  stripe_result?: { ok: boolean; data?: { note?: string } & Record<string, unknown> };
  link_result?: { ok: boolean; data?: { note?: string } & Record<string, unknown> };
};
