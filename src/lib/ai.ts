import Anthropic from "@anthropic-ai/sdk";
import type { Account, Event, Media } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getMediaBytes } from "@/lib/media";

const PLATFORMS = ["instagram", "facebook", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const VARIANTS_PER_PLATFORM = 2;

export interface MediaScores {
  energyScore: number;
  visualQualityScore: number;
  momentRarityScore: number;
  scoreSummary: string;
}

export interface AnalysisResult {
  scores: MediaScores;
  captions: Record<Platform, string[]>;
}

let client: Anthropic | null | undefined;

// A key is only usable if it can go in an HTTP header — i.e. pure ASCII.
// The failure this guards against: pasting a *masked* key (the "sk-ant-a••••"
// form a site shows when hiding a secret) puts U+2022 bullets in the value.
// The client constructs fine, then every request dies deep in the fetch layer
// with "Cannot convert argument to a ByteString", which surfaces to users as
// nothing more than placeholder captions and 50/50/50 scores.
function keyLooksUsable(key: string): boolean {
  return /^[\x20-\x7E]+$/.test(key);
}

export function getAnthropicClient(): Anthropic | null {
  if (client !== undefined) return client;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.warn("[ai] ANTHROPIC_API_KEY is not set — captions and scores will be placeholders.");
    client = null;
    return client;
  }
  if (!keyLooksUsable(key)) {
    console.error(
      "[ai] ANTHROPIC_API_KEY contains non-ASCII characters and cannot be used. " +
        "This usually means a masked/obscured version of the key was copied " +
        "instead of the real one. Captions and scores will be placeholders.",
    );
    client = null;
    return client;
  }

  client = new Anthropic();
  return client;
}

function placeholderAnalysis(event: Event): AnalysisResult {
  return {
    scores: {
      energyScore: 50,
      visualQualityScore: 50,
      momentRarityScore: 50,
      scoreSummary: "Scoring unavailable — connect an Anthropic API key to enable real AI analysis.",
    },
    captions: {
      instagram: [
        `${event.name} was one for the books. ✨ More to come — stay tuned!`,
        `Loved every second of ${event.name}. 🎉`,
      ],
      facebook: [
        `Thank you to everyone who made ${event.name} so memorable. We loved capturing every moment with you.`,
        `${event.name} was such a special day — thank you for letting us be part of it.`,
      ],
      tiktok: [`${event.name} recap incoming 🎉`, `wait for it... ${event.name} 👀`],
    },
  };
}

function extToMimeType(storagePath: string): string {
  const ext = storagePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

// Pulls the account's own approved/edited captions so future drafts match
// the voice they've actually signed off on, not just their stated tone.
async function getBrandVoiceExamples(accountId: string): Promise<string[]> {
  const recent = await prisma.draft.findMany({
    where: { accountId, status: { in: ["approved", "edited"] } },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  return recent.map((d) => d.editedCaption ?? d.generatedCaption);
}

// Claude's structured-outputs JSON schema subset rejects minItems/maxItems
// above 1 ("complex array constraints" aren't supported) — the exact count
// is enforced via the prompt instruction instead, and handled defensively
// below in case Claude returns a different number of options.
const CAPTION_SCHEMA_PROPS = {
  type: "array" as const,
  items: { type: "string" as const },
};

async function callClaude(
  media: Media,
  event: Event,
  account: Account,
  examples: string[],
  imageBufferOverride?: Buffer,
): Promise<AnalysisResult | null> {
  const anthropic = getAnthropicClient();
  if (!anthropic) return null;

  const buffer = imageBufferOverride ?? (await getMediaBytes(media));
  const imageData = buffer.toString("base64");

  const exampleBlock =
    examples.length > 0
      ? `\nCaptions this client has previously approved (match this voice):\n${examples.map((e) => `- ${e}`).join("\n")}`
      : "";

  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5",
    // Claude Opus 5 thinks by default even at effort "low" — this has to be
    // generous enough to cover thinking *plus* the full structured JSON
    // output (3 scores + 3 platforms x 2 caption variants), or thinking
    // alone consumes the whole budget and the call ends with no text block.
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            energyScore: { type: "integer", description: "0-100: motion, crowd size, action in frame" },
            visualQualityScore: { type: "integer", description: "0-100: lighting, focus, composition" },
            momentRarityScore: { type: "integer", description: "0-100: candid reaction or key moment vs. generic shot" },
            scoreSummary: { type: "string", description: "One sentence explaining the scores" },
            captions: {
              type: "object",
              properties: {
                instagram: CAPTION_SCHEMA_PROPS,
                facebook: CAPTION_SCHEMA_PROPS,
                tiktok: CAPTION_SCHEMA_PROPS,
              },
              required: ["instagram", "facebook", "tiktok"],
              additionalProperties: false,
            },
          },
          required: ["energyScore", "visualQualityScore", "momentRarityScore", "scoreSummary", "captions"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: (imageBufferOverride ? "image/jpeg" : extToMimeType(media.storagePath)) as
                | "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/gif",
              data: imageData,
            },
          },
          {
            type: "text",
            text: [
              `Analyze this photo from "${event.name}", a ${event.eventType} event hosted by ${account.businessName}.`,
              "",
              "First, score it 0-100 on three dimensions:",
              "- energyScore: motion, crowd size, action in frame",
              "- visualQualityScore: lighting, focus, composition",
              "- momentRarityScore: candid reactions or a key moment, vs. a generic/posed shot",
              "",
              `Then write social media captions. Brand voice: ${account.brandTone}.${exampleBlock}`,
              `Write exactly ${VARIANTS_PER_PLATFORM} distinct caption options per platform, matched to how people actually write there:`,
              "- instagram: short, punchy, 1-2 relevant hashtags",
              "- facebook: warmer and a bit longer, no hashtags",
              "- tiktok: casual, trend-aware, very short",
              "The options for a platform should feel like real alternatives (different angle or tone), not minor rewordings.",
            ].join("\n"),
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    console.error("[ai] Claude refused the caption/scoring request", response.stop_details);
    return null;
  }

  const parsed = response.content.find((block) => block.type === "text");
  if (!parsed || parsed.type !== "text") {
    // Most common cause: max_tokens was too tight and thinking consumed the
    // whole budget, leaving no room for the structured JSON output.
    console.error("[ai] No text block in Claude response", { stopReason: response.stop_reason, usage: response.usage });
    return null;
  }

  try {
    const json = JSON.parse(parsed.text) as {
      energyScore: number;
      visualQualityScore: number;
      momentRarityScore: number;
      scoreSummary: string;
      captions: Partial<Record<Platform, string[]>>;
    };

    // Without a schema-enforced item count (see CAPTION_SCHEMA_PROPS above),
    // Claude occasionally pads an array with empty/junk strings — filter
    // those out and cap to the intended count rather than trusting length.
    const clean = (arr: string[] | undefined) =>
      (arr ?? []).map((s) => s.trim()).filter(Boolean).slice(0, VARIANTS_PER_PLATFORM);

    const captions: Record<Platform, string[]> = {
      instagram: clean(json.captions.instagram),
      facebook: clean(json.captions.facebook),
      tiktok: clean(json.captions.tiktok),
    };

    if (!captions.instagram.length || !captions.facebook.length || !captions.tiktok.length) {
      console.error("[ai] Claude response missing usable captions for one or more platforms", json.captions);
      return null;
    }

    return {
      scores: {
        energyScore: json.energyScore,
        visualQualityScore: json.visualQualityScore,
        momentRarityScore: json.momentRarityScore,
        scoreSummary: json.scoreSummary,
      },
      captions,
    };
  } catch (err) {
    console.error("[ai] Failed to parse Claude JSON response", err, parsed.text);
    return null;
  }
}

export async function analyzeMedia(media: Media, event: Event, account: Account): Promise<AnalysisResult> {
  if (media.mediaType !== "photo") return placeholderAnalysis(event);

  try {
    const examples = await getBrandVoiceExamples(account.id);
    const result = await callClaude(media, event, account, examples);
    return result ?? placeholderAnalysis(event);
  } catch (err) {
    // Network error, rate limit, or any other API failure — never let a
    // caption-generation hiccup block the upload itself, but log it so a
    // real failure doesn't look identical to "no API key configured".
    console.error("[ai] analyzeMedia failed, falling back to placeholder", err);
    return placeholderAnalysis(event);
  }
}

// For video clips: we don't have the clip's own bytes handy as an "image",
// so caption generation runs against a representative frame the caller
// already extracted (see lib/video.ts).
export async function analyzeClip(
  media: Media,
  event: Event,
  account: Account,
  representativeFrame: Buffer,
): Promise<AnalysisResult> {
  try {
    const examples = await getBrandVoiceExamples(account.id);
    const result = await callClaude(media, event, account, examples, representativeFrame);
    return result ?? placeholderAnalysis(event);
  } catch (err) {
    console.error("[ai] analyzeClip failed, falling back to placeholder", err);
    return placeholderAnalysis(event);
  }
}

// Regenerate always targets one specific draft, so we only need the first
// fresh option for that platform — not a full new variant set.
export async function regenerateCaption(
  media: Media,
  event: Event,
  account: Account,
  platform: Platform,
): Promise<string> {
  const analysis = await analyzeMedia(media, event, account);
  return analysis.captions[platform][0];
}

// Optional per-event blog post. Never generated from photos alone — the
// client's own notes are the substance; approved captions/scores just add
// grounded detail about specific moments so it doesn't read as filler.
export async function generateBlogPost(
  event: Event,
  account: Account,
  inputNotes: string,
  approvedCaptions: string[],
): Promise<string> {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return `${event.name}\n\n${inputNotes}\n\n(Connect an Anthropic API key to generate a full write-up from these notes.)`;
  }

  const capsBlock =
    approvedCaptions.length > 0
      ? `\n\nApproved social captions from this event, for specific details/moments to reference:\n${approvedCaptions.map((c) => `- ${c}`).join("\n")}`
      : "";

  try {
    const response = await anthropic.beta.messages.create({
      model: "claude-opus-5",
      // Same thinking-budget headroom concern as the caption call above.
      max_tokens: 4096,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [
        {
          role: "user",
          content: [
            `Write a blog post for "${event.name}", a ${event.eventType} event hosted by ${account.businessName}.`,
            `Brand voice: ${account.brandTone}.`,
            "",
            `The client's own notes on the event (the substance of the post — expand on these, don't ignore them):`,
            inputNotes,
            capsBlock,
            "",
            "Write a substantive post (400-600 words) with a title, grounded in the client's actual notes above — not generic event-planner filler. This is for local SEO, so it's fine to naturally mention the business name and location if the notes suggest one.",
          ].join("\n"),
        },
      ],
    });

    if (response.stop_reason === "refusal") throw new Error("refused");
    const parsed = response.content.find((block) => block.type === "text");
    if (!parsed || parsed.type !== "text") {
      throw new Error(`no text block (stop_reason=${response.stop_reason})`);
    }
    return parsed.text;
  } catch (err) {
    console.error("[ai] generateBlogPost failed, falling back to notes-only", err);
    return `${event.name}\n\n${inputNotes}\n\n(Generation failed — try again in a moment.)`;
  }
}

export { PLATFORMS };
