/** Configuration, entirely from the environment. See `.env.example` at the repo root. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export interface Config {
  port: number;
  rpcUrl: string;
  tollgateAddress: string;
  /** Key the server signs settlements with. Registered as the service's `settler`. */
  settlerPrivateKey: string;
  anthropicApiKey: string | undefined;
  /** When true, run against a deterministic fake model instead of the Anthropic API. */
  useFakeModel: boolean;
}

export function loadConfig(): Config {
  const useFakeModel = process.env.USE_FAKE_MODEL === "true";
  return {
    port: Number(process.env.PORT ?? 4000),
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    tollgateAddress: required("TOLLGATE_ADDRESS"),
    settlerPrivateKey: required("SETTLER_PRIVATE_KEY"),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    useFakeModel,
  };
}
