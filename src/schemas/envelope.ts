import { z } from 'zod';

export const WarningSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1),
    language: z.string().optional(),
  })
  .strict();
export type Warning = z.infer<typeof WarningSchema>;

export const MetaSchema = z
  .object({
    version: z.string(),
    generatedAt: z.iso.datetime(),
  })
  .strict();
export type Meta = z.infer<typeof MetaSchema>;

export const SuccessEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    command: z.string(),
    data: z.unknown(),
    warnings: z.array(WarningSchema),
    limitations: z.array(z.string()),
    meta: MetaSchema,
  })
  .strict();
export type SuccessEnvelope = z.infer<typeof SuccessEnvelopeSchema>;

export const ErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    command: z.string().nullable(),
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        message: z.string().min(1),
        hint: z.string().optional(),
        details: z.unknown().optional(),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const EnvelopeSchema = z.discriminatedUnion('ok', [SuccessEnvelopeSchema, ErrorEnvelopeSchema]);
export type Envelope = z.infer<typeof EnvelopeSchema>;
