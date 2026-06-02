// Open-tracking pixel endpoint.
//
// Embedded in outgoing emails as <img src=".../track-open?t=<tracking_id>">.
// When the recipient's mail client loads the image, this function logs an
// `email_opens` row and returns a 1x1 transparent GIF.
//
// Deployed with: supabase functions deploy track-open
// (verify_jwt = false is set in supabase/config.toml so Gmail can load it.)
//
// Caveat: Gmail proxies and caches images through Google's servers, so the
// recorded time is approximate and repeat opens may not always register.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 1x1 transparent GIF.
const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

const pixelResponse = () =>
  new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // Defeat caching so opens are recorded as often as the client allows.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });

Deno.serve(async (req) => {
  // Always return the pixel, even on errors — never break the email render.
  try {
    const url = new URL(req.url);
    const trackingId = url.searchParams.get("t");

    if (trackingId) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        // Service role bypasses RLS; the function is the only writer.
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      await supabase.from("email_opens").insert({
        tracking_id: trackingId,
        user_agent: req.headers.get("user-agent"),
        ip: req.headers.get("x-forwarded-for"),
      });
    }
  } catch (err) {
    console.error("track-open error:", err);
  }

  return pixelResponse();
});
