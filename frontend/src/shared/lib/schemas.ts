import { z } from "zod";

/**
 * Review form validation. Mirrors the backend's only hard rule: `name` is
 * required (non-empty after trim). Email/phone are intentionally NOT
 * format-validated — the backend doesn't validate them, and strict client
 * checks would reject cards the pipeline would happily save.
 */
export const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  designation: z.string(),
  email: z.string(),
  company: z.string(),
  category: z.string(),
  note: z.string(),
  phones: z.array(z.object({ value: z.string() })),
  addresses: z.array(z.object({ value: z.string() })),
});

/** Form shape uses `{ value }` objects so react-hook-form useFieldArray works. */
export type ContactFormValues = z.infer<typeof contactSchema>;
