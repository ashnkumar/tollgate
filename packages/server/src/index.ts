import { loadConfig } from "./config.js";
import { AnthropicClient, FakeAiClient, type AiClient } from "./ai.js";
import { TollgateChain } from "./chain.js";
import { createApp } from "./app.js";

const config = loadConfig();

let ai: AiClient;
if (config.useFakeModel) {
  ai = new FakeAiClient();
  console.log("model:    fake (USE_FAKE_MODEL=true) — no Anthropic calls will be made");
} else {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required unless USE_FAKE_MODEL=true");
  }
  ai = new AnthropicClient(config.anthropicApiKey);
  console.log("model:    Anthropic API");
}

const chain = new TollgateChain(config.rpcUrl, config.tollgateAddress, config.settlerPrivateKey);
const app = createApp({
  ai,
  chain,
  contractAddress: config.tollgateAddress,
  webRoot: config.webRoot,
});

app.listen(config.port, () => {
  console.log(`tollgate  http://localhost:${config.port}`);
  console.log(`rpc:      ${config.rpcUrl}`);
  console.log(`contract: ${config.tollgateAddress}`);
  console.log(`settler:  ${chain.settlerAddress}`);
  console.log(
    config.webRoot
      ? `web:      http://localhost:${config.port} — browser walkthrough`
      : "web:      not built (run `pnpm web` for the browser walkthrough)",
  );
  if (config.usingLocalDefaults) {
    console.log("\n  Using local development defaults (deployment.json and the Hardhat dev key).");
    console.log("  Set TOLLGATE_ADDRESS and SETTLER_PRIVATE_KEY for anything else.");
  }
});
