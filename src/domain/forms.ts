/**
 * Custom registration questions. An event's ``form`` is a list of fields; registrations
 * are validated against it on the server, whatever the client sent.
 */
import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and _");
const base = { id, label: z.string().min(1).max(200), required: z.boolean().default(false) };

export const Field = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), max_length: z.number().int().min(1).max(2000).default(300) }),
  z.object({ ...base, type: z.literal("select"), options: z.array(z.string().min(1).max(100)).min(1).max(50) }),
  // A required checkbox must be ticked: "I agree to the code of conduct".
  z.object({ ...base, type: z.literal("checkbox") }),
]);
export type Field = z.infer<typeof Field>;

export const Form = z
  .array(Field)
  .max(30)
  .refine((fs) => new Set(fs.map((f) => f.id)).size === fs.length, "field ids must be unique");
export type Form = z.infer<typeof Form>;

export type Answers = Record<string, string | boolean>;

export function validateAnswers(form: Form, raw: unknown): { answers: Answers; errors: Record<string, string> } {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const answers: Answers = {};
  const errors: Record<string, string> = {};
  for (const f of form) {
    const v = given[f.id];
    if (f.type === "checkbox") {
      const ticked = v === true || v === "true" || v === "on";
      if (f.required && !ticked) errors[f.id] = "must be ticked";
      answers[f.id] = ticked;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    if (!s) {
      if (f.required) errors[f.id] = "required";
      continue;
    }
    if (f.type === "text" && s.length > f.max_length) errors[f.id] = `at most ${f.max_length} characters`;
    else if (f.type === "select" && !f.options.includes(s)) errors[f.id] = "not one of the options";
    else answers[f.id] = s;
  }
  return { answers, errors };
}
