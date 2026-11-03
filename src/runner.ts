import type { Ctx } from "./context.ts";
import { runRsvp } from "./domain/rsvp.ts";
import { deliverDue } from "./email/worker.ts";

/** The background loop: deliver due emails, run RSVP reminders and releases. */
export function startBackground(ctx: Ctx, everyMs = 5000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const rsvp = await runRsvp(ctx);
      let sent = 0;
      for (;;) {
        const r = await deliverDue(ctx);
        sent += r.sent;
        if (r.sent + r.dropped + r.failed + r.retried === 0) break;
      }
      if (sent || rsvp.reminded || rsvp.released) {
        console.log(JSON.stringify({ level: "info", msg: "background", sent, ...rsvp }));
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "background tick failed", err: (err as Error).message }));
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; clearTimeout(timer); };
}
