import { id as keccakId } from "ethers";

/**
 * The service catalog.
 *
 * Three services, all of which genuinely work. They are chosen to make the metering
 * visible rather than to pad a list: their output/input ratios differ by roughly an
 * order of magnitude, so the gap between what a buyer escrows and what they actually
 * pay differs sharply between them.
 *
 * Note what is *not* here: the output ceiling and the prices. Those live in the
 * on-chain rate card and are read from it. `maxOutputTokens` is the number the
 * contract multiplies by the output rate to produce the worst-case quote, and it is
 * also the `max_tokens` the API enforces on the call. If a local copy of it drifted
 * from the on-chain one, the quote would stop being an upper bound — so there is no
 * local copy. The chain is authoritative for everything that affects billing; this
 * file only supplies what the model needs to do the work.
 */

export interface ServiceDefinition {
  /** Stable, human-readable slug. Hashed to a bytes32 service id on-chain. */
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  /** Rejected before quoting, so an oversized input fails fast and free. */
  maxInputTokens: number;
  demoInput: string;
}

/**
 * Thinking is disabled for every service here, which is a deliberate metering choice
 * rather than a quality one: `max_tokens` bounds thinking and visible output together,
 * so with thinking on, a buyer can pay for a full budget and receive a truncated
 * answer. Disabling it makes the budget the buyer escrows the budget they get.
 *
 * The trailing instruction is the documented mitigation for the one failure mode that
 * comes with thinking disabled — internal tags occasionally leaking into the response.
 */
const OUTPUT_HYGIENE = "Do not include internal or system XML tags in your response.";

export const SERVICES: ServiceDefinition[] = [
  {
    slug: "summarize",
    name: "Summarizer",
    description: "Condense a document into a short brief. Output stays small however long the input runs.",
    model: "claude-opus-5",
    systemPrompt: [
      "Summarize the user's text in at most five sentences.",
      "Lead with the single most important point. No preamble, no restating the request.",
      OUTPUT_HYGIENE,
    ].join(" "),
    maxInputTokens: 100_000,
    demoInput:
      "Distributed consensus protocols coordinate a set of processes so that they agree on a single value even when some of them fail. Paxos, introduced by Leslie Lamport, established the theoretical foundation but is famously difficult to implement correctly. Raft was designed later with understandability as an explicit goal: it decomposes consensus into leader election, log replication, and safety, and it constrains the ways logs may diverge so that reasoning about correctness is tractable. In practice most production systems that need consensus today run Raft or a derivative of it, often through an off-the-shelf library rather than a bespoke implementation.",
  },
  {
    slug: "explain-code",
    name: "Code Explainer",
    description: "Walk through what a snippet does and flag anything surprising. Output scales with the code.",
    model: "claude-opus-5",
    systemPrompt: [
      "Explain what the user's code does, then note any bug, edge case, or surprising behavior you see.",
      "Be concrete and skip pleasantries. If the code is fine, say so plainly rather than inventing concerns.",
      OUTPUT_HYGIENE,
    ].join(" "),
    maxInputTokens: 50_000,
    demoInput: [
      "function withdraw(uint256 amount) external {",
      "    require(balances[msg.sender] >= amount);",
      '    (bool ok, ) = msg.sender.call{value: amount}("");',
      "    require(ok);",
      "    balances[msg.sender] -= amount;",
      "}",
    ].join("\n"),
  },
  {
    slug: "translate",
    name: "Translator",
    description: "Translate text while preserving tone. Output length tracks input length almost exactly.",
    model: "claude-opus-5",
    systemPrompt: [
      "Translate the user's text into the target language named on the first line.",
      "Preserve tone and formatting. Return only the translation, with no notes or commentary.",
      OUTPUT_HYGIENE,
    ].join(" "),
    maxInputTokens: 20_000,
    demoInput:
      "Target language: French\n\nThe meter runs only while the service is doing work. When the call finishes, you are charged for what it actually used and the rest comes back.",
  },
];

/** bytes32 service id used on-chain. Derived from the slug so it is reproducible. */
export function serviceId(slug: string): string {
  return keccakId(slug);
}

export function findService(slug: string): ServiceDefinition | undefined {
  return SERVICES.find((s) => s.slug === slug);
}
