// Fitbit → fly-tracker auto-log
// Runs on a schedule (Supabase cron). Reads the day's exercise sessions from the
// Google Health API and fills the `logs` table:
//   strength / gym session only        → 'active'
//   sport / cardio session only        → 'recovery'  (Active Recovery)
//   both kinds on the same day         → 'both'
//   nothing recorded                   → nothing written
// It NEVER touches a day that already has a log (manual entries, Injured, etc. win).
//
// Secrets (set with `supabase secrets set`):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, CRON_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRENGTH_KEYWORDS = ["WEIGHT", "STRENGTH", "CALISTHENIC", "CROSSFIT", "GYM", "CIRCUIT", "HIIT", "BOOTCAMP"];
const IGNORE_KEYWORDS = ["WALK", "UNKNOWN", "OTHER_UNSPECIFIED"]; // auto-detected walks are not training
const MIN_MINUTES = 15; // shorter sessions are ignored

function classify(type: string): "strength" | "sport" | null {
  const t = (type || "").toUpperCase();
  if (IGNORE_KEYWORDS.some((k) => t.includes(k))) return null;
  if (STRENGTH_KEYWORDS.some((k) => t.includes(k))) return "strength";
  return "sport";
}

function minutes(interval: { startTime?: string; endTime?: string }): number {
  if (!interval?.startTime || !interval?.endTime) return 0;
  return (Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 60000;
}

async function googleAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function sessionsForDay(token: string, day: string): Promise<any[]> {
  const next = new Date(day + "T00:00:00Z");
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);
  const filter = `exercise.interval.civil_start_time >= "${day}" AND exercise.interval.civil_start_time < "${nextDay}"`;
  const out: any[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints");
    url.searchParams.set("filter", filter);
    url.searchParams.set("pageSize", "25");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Google Health API error: ${JSON.stringify(json)}`);
    out.push(...(json.dataPoints || []));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Local calendar date (YYYY-MM-DD) in the given IANA time zone, offset by `delta` days.
function localDay(tz: string, delta = 0): string {
  const d = new Date(Date.now() + delta * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const tz = Deno.env.get("TRACKER_TZ") || "Asia/Beirut";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = await googleAccessToken();

  // Today + the previous 2 days, so late watch syncs still get picked up.
  const days = [localDay(tz, 0), localDay(tz, -1), localDay(tz, -2)];
  const report: Record<string, unknown> = {};

  for (const day of days) {
    const { data: existing } = await db.from("logs").select("date").eq("date", day).maybeSingle();
    if (existing) { report[day] = "already logged — skipped"; continue; }

    const sessions = await sessionsForDay(token, day);
    let strength = false, sport = false;
    const seen: string[] = [];
    for (const dp of sessions) {
      const ex = dp.exercise || {};
      seen.push(`${ex.exerciseType} ${Math.round(minutes(ex.interval))}min`);
      if (minutes(ex.interval) < MIN_MINUTES) continue;
      const kind = classify(ex.exerciseType);
      if (kind === "strength") strength = true;
      if (kind === "sport") sport = true;
    }

    const activity = strength && sport ? "both" : strength ? "active" : sport ? "recovery" : null;
    if (activity) {
      const { error } = await db.from("logs").insert({ date: day, activity });
      report[day] = error ? `insert failed: ${error.message}` : `logged ${activity} (${seen.join(", ")})`;
    } else {
      report[day] = seen.length ? `no qualifying session (${seen.join(", ")})` : "no sessions";
    }
  }

  return new Response(JSON.stringify(report, null, 2), { headers: { "Content-Type": "application/json" } });
});
