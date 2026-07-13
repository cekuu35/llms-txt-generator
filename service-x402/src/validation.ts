import { z } from "zod";
import { assertUrlAllowedStatic, SsrfError } from "./ssrf.js";

export const generationInputSchema = z.object({
  websiteUrl: z.string().url().max(2_048),
  maxPages: z.number().int().min(1).max(25).default(20),
  includeFullText: z.boolean().default(true),
  maxContentCharsPerPage: z.number().int().min(1_000).max(20_000).default(12_000),
}).strict();

export type GenerationInput = z.infer<typeof generationInputSchema>;

export type ValidationResult =
  | { success: true; data: GenerationInput }
  | { success: false; code: "INVALID_INPUT" | "URL_NOT_ALLOWED"; message: string };

export function validateGenerationInput(body: unknown): ValidationResult {
  const parsed = generationInputSchema.safeParse(body);
  if (!parsed.success) {
    return { success: false, code: "INVALID_INPUT", message: "Request body does not match the input contract." };
  }

  try {
    assertUrlAllowedStatic(new URL(parsed.data.websiteUrl));
  } catch (error) {
    if (error instanceof SsrfError) {
      return { success: false, code: "URL_NOT_ALLOWED", message: "The requested URL is not allowed." };
    }
    return { success: false, code: "INVALID_INPUT", message: "websiteUrl is invalid." };
  }

  return { success: true, data: parsed.data };
}
