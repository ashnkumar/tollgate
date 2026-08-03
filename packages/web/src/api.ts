/**
 * The metering server's HTTP surface, typed.
 *
 * The page is served by that same server, so every request here is same-origin and
 * relative — there is no host to configure and no CORS to arrange.
 */

export interface Health {
  ok: boolean;
  settler: string;
  contract: string;
}

export interface RateCard {
  provider: string;
  active: boolean;
  baseFeeWei: string;
  perInputTokenWei: string;
  perOutputTokenWei: string;
}

export interface ListedService {
  slug: string;
  name: string;
  description: string;
  model: string;
  maxOutputTokens: number | null;
  maxInputTokens: number;
  demoInput: string;
  registered: boolean;
  rateCard: RateCard | null;
}

export interface Quote {
  callId: string;
  serviceId: string;
  service: string;
  inputTokens: number;
  maxOutputTokens: number;
  quoteWei: string;
}

export interface RunResult {
  callId: string;
  service: string;
  output: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    maxOutputTokens: number;
    observedInputTokens: number;
  };
  settlement: {
    escrowedWei: string;
    costWei: string;
    refundWei: string;
    txHash: string;
  };
}

/** An error the server reported, carrying its status so callers can explain it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Not JSON. The raw body is the best message available.
    }
    throw new ApiError(response.status, message);
  }
  return JSON.parse(text) as T;
}

export const api = {
  health: () => request<Health>("/health"),
  services: () => request<{ services: ListedService[] }>("/services"),
  quote: (service: string, input: string) => request<Quote>("/quote", { service, input }),
  run: (callId: string, signature: string) => request<RunResult>("/run", { callId, signature }),
};
