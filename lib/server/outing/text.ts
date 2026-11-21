import { randomUUID } from "node:crypto";
import {
  emptyGeo,
  type GeoContext,
  type Item,
  type MessageMeta,
  type Place,
  type Session,
} from "../../contracts";
import {
  nearbyInput,
  planInput,
  replanInput,
  type ReplanInput,
  type TripView,
} from "../../outing-contracts";
import { db } from "../db";
import { type ItemChange, repository } from "../repository";
import { localCatalog, localPlaces, resolveLocal } from "./catalog";
import {
  getPreparation,
  loadPreferences,
  queuePreparation,
  seenPlaces,
  type Database,
} from "./context";
import {
  discover,
  distance,
  normalize,
  queryCategories,
  travelEstimate,
} from "./geo";
import { createTrip, getTrip, replanTrip, tripReply } from "./trips";
import { recordMetric } from "../metrics";
import {
  inLanguage,
  replyLanguage,
  type ReplyLanguage,
} from "../reply-language";
import { asksDistance, asksRoute, placeReference } from "./place-follow-up";

const numbers: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  half: 0.5,
};
function timeLimit(text: string) {
  const m =
    /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|half)\s*(hours?|hrs?|minutes?|mins?)\b/i.exec(
      text,
    );
  if (!m) return undefined;
  const n =
    (numbers[m[1].toLowerCase()] ?? Number(m[1])) * (/^h/i.test(m[2]) ? 60 : 1);
  return n >= 10 && n <= 840 ? Math.round(n) : undefined;
}
function startMinute(message: string) {
  const time =
    /\b(?:at|start(?:ing)?(?: at)?|from)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(
      message,
    );
  if (time) return Number(time[1]) * 60 + Number(time[2]);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.CITYBUDDY_TIME_ZONE || "Asia/Kolkata",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  })
    .format(new Date())
    .split(":")
    .map(Number);
  return Math.min(1439, parts[0] * 60 + parts[1]);
}
function updateAction(message: string): ReplanInput["action"] | undefined {
  if (/\bskip (?:the )?next (?:place|stop)\b/i.test(message))
    return "skip_next";
  if (
    /\b(?:already visited this|visited (?:this|the next) (?:place|stop)|mark (?:this|next) stop visited)\b/i.test(
      message,
    )
  )
    return "visit_next";
  if (/\blunch first\b/i.test(message)) return "lunch_first";
  if (/\bremove shopping\b/i.test(message)) return "remove_shopping";
  if (
    /\b(?:only have|time left|remaining|shorten)\b/i.test(message) &&
    timeLimit(message) &&
    !/\b(?:between meetings|plan an?|new outing)\b/i.test(message)
  )
    return "shorten";
}
export function isLocalOutingCommand(message: string) {
  return (
    !!updateAction(message) ||
    /\b(?:itinerary|outing|between meetings|day trip|prefetch|prepared context|prepare (?:context|recommendations|next location))\b|^(?:set|change|move|update) (?:my )?location\b/i.test(
      message,
    ) ||
    (!!timeLimit(message) &&
      (queryCategories(message).length > 0 || additions(message).length > 0))
  );
}
function additions(message: string) {
  const match =
    /\b(?:add|i need to (?:buy|pick up)|i need|want to buy|need to buy|buy|pick up)\s+(.+?)(?=[.,!?;]|\s+\b(?:and\s+)?(?:see|visit|explore|have|eat|before|nearby|near|to (?:my|the) (?:list|checklist))\b|$)/i.exec(
      message,
    );
  if (
    !match ||
    /\b(?:where|shops?|stores?)\b.*\bbuy\b/i.test(message) ||
    /\b(?:how|can i)\b.*\bbuy\b/i.test(message)
  )
    return [];
  return match[1]
    .split(/\s+and\s+/i)
    .flatMap((value) => {
      const q = /^(\d+)\s+/.exec(value.trim());
      const quantity = q ? Number(q[1]) : 1;
      const name = value
        .trim()
        .replace(/^(?:(?:a|an|some)\s+|\d+\s+)/i, "")
        .trim();
      return name && name.length <= 160 && quantity >= 1 && quantity <= 9999
        ? [{ name, quantity }]
        : [];
    })
    .slice(0, 8);
}
function namedLocation(query: string) {
  const choices = resolveLocal(query);
  const exact = choices.filter(
    (p) => normalize(p.name) === normalize(query.replace(/,\s*jaipur$/i, "")),
  );
  return exact.length === 1
    ? exact[0]
    : choices.length === 1
      ? choices[0]
      : undefined;
}

function catalogMatch(place: Place) {
  const name = normalize(place.name.replace(/,\s*jaipur$/i, ""));
  const points = localCatalog.entries();
  return (
    points.find((p) => p.place_id === place.place_id) ??
    points.find(
      (p) =>
        place.latitude !== null &&
        place.longitude !== null &&
        (normalize(p.name) === name ||
          p.aliases?.some((alias) => normalize(alias) === name)) &&
        distance(p, { latitude: place.latitude, longitude: place.longitude }) <=
          200,
    )
  );
}
function changeShopping(
  message: string,
  items: Item[],
  language: ReplyLanguage,
) {
  const say = inLanguage(language);
  const changes: ItemChange[] = [];
  const feedback: string[] = [];
  const update =
    /\b(?:i (?:bought|purchased|got)|mark|skip(?: buying)?|remove|set)\s+(.+)$/i.exec(
      message,
    );
  if (update && !updateAction(message)) {
    const target = normalize(
      update[1].replace(
        /\b(?:from (?:my|the) list|as (?:purchased|pending|skipped)|purchased|pending|skipped|to \d+)\b/gi,
        "",
      ),
    );
    const candidates = items.filter((i) => {
      const name = normalize(i.name);
      return (
        target === name ||
        target === "the " + name ||
        target === "my " + name ||
        (target.length >= 4 &&
          name.includes(target.replace(/^(?:the|my) /, "")))
      );
    });
    if (candidates.length > 1)
      return {
        changes,
        feedback: [
          say(
            "Which checklist item? ",
            "Checklist ka kaunsa item? ",
            "सूची का कौन-सा सामान? ",
          ) +
            candidates.map((i) => i.name).join(", ") +
            ".",
        ],
      };
    const before = candidates[0];
    if (before) {
      const quantity = /\bto\s+(\d+)\s*[.!?]?$/i.exec(message);
      if (/^\s*remove\b/i.test(message)) {
        changes.push({ before });
        feedback.push(
          say(
            `Removed ${before.name} from your checklist.`,
            `${before.name} ko checklist se hata diya.`,
            `${before.name} को सूची से हटा दिया।`,
          ),
        );
      } else if (
        quantity &&
        Number(quantity[1]) > 0 &&
        Number(quantity[1]) <= 9999
      ) {
        changes.push({
          before,
          after: { ...before, quantity: Number(quantity[1]) },
        });
        feedback.push(
          say(
            `Updated the quantity for ${before.name}.`,
            `${before.name} ki quantity update kar di.`,
            `${before.name} की मात्रा बदल दी।`,
          ),
        );
      } else if (
        /\b(?:purchased|bought|got|pending|skipp?ed|skip)\b/i.test(message)
      ) {
        const status = /\bpending\b/i.test(message)
          ? "pending"
          : /\bskip/i.test(message)
            ? "skipped"
            : "purchased";
        changes.push({ before, after: { ...before, status } });
        const state = {
          pending: say("pending", "pending", "बाकी"),
          skipped: say("skipped", "skip", "छोड़ा गया"),
          purchased: say("purchased", "purchased", "खरीदा गया"),
        }[status];
        feedback.push(
          say(
            `Marked ${before.name} ${state}.`,
            `${before.name} ko ${state} mark kar diya.`,
            `${before.name} की स्थिति '${state}' कर दी।`,
          ),
        );
      }
    } else if (/\b(?:bought|purchased|skip(?:ped)?)\b/i.test(message))
      feedback.push(
        say(
          "I couldn’t match that to a checklist item.",
          "Yeh item aapki checklist mein nahi mila.",
          "यह सामान आपकी सूची में नहीं मिला।",
        ),
      );
  }
  const seen = new Set(items.map((i) => normalize(i.name)));
  for (const item of additions(message)) {
    if (seen.has(normalize(item.name))) continue;
    seen.add(normalize(item.name));
    const now = new Date().toISOString();
    changes.push({
      after: {
        id: randomUUID(),
        ...item,
        status: "pending",
        notes: "",
        created_at: now,
        updated_at: now,
      },
    });
    const label = item.name + (item.quantity > 1 ? " × " + item.quantity : "");
    feedback.push(
      say(
        `Added ${label}.`,
        `${label} ko checklist mein add kar diya.`,
        `${label} को सूची में जोड़ दिया।`,
      ),
    );
  }
  return { changes, feedback };
}
function toolTrip(trip: TripView, metadata: MessageMeta, tool: string) {
  return {
    ...metadata,
    tripId: trip.id,
    tripVersion: trip.version,
    tools: [...metadata.tools, tool],
    places: trip.stops.flatMap((s) =>
      s.place && s.status === "pending" ? [s.place] : [],
    ),
    sources: [
      ...new Map(
        trip.stops
          .flatMap((s) => s.place?.sources ?? [])
          .map((s) => [s.url, s]),
      ).values(),
    ],
  };
}
export async function localTurn(
  userId: string,
  session: Session,
  message: string,
  requestId: string,
) {
  const language = replyLanguage(message);
  const say = inLanguage(language);
  const [items, preferences, trip] = await Promise.all([
    repository.listItems(userId),
    loadPreferences(db, userId),
    getTrip(userId),
  ]);
  const shopping = changeShopping(message, items, language);
  const list = new Map(items.map((i) => [i.id, i]));
  for (const change of shopping.changes) {
    if (change.after) list.set(change.after.id, change.after);
    else if (change.before) list.delete(change.before.id);
  }
  const metadata: MessageMeta = {
    tools: ["get_user_context"],
    places: [],
    routes: [],
    sources: [],
  };
  if (shopping.changes.length) metadata.tools.push("update_checklist");
  const text = shopping.feedback;
  const context = structuredClone(session.context);
  const result: {
    content: string;
    metadata: MessageMeta;
    context: GeoContext;
    changes: ItemChange[];
    finish?: (tx: Database) => Promise<{
      content: string;
      metadata?: MessageMeta;
      context?: GeoContext;
    }>;
  } = { content: "", metadata, context, changes: shopping.changes };

  const locationCommand =
    /^\s*(?:set|change|move|update) (?:my )?(?:location )?to\s+(.+?)\s*[.!?]?$/i.exec(
      message,
    );
  if (locationCommand) {
    const selected = namedLocation(locationCommand[1]);
    result.content = selected
      ? say(
          `Location updated to ${selected.name}.`,
          `Location ko ${selected.name} par set kar diya.`,
          `स्थान ${selected.name} पर सेट कर दिया।`,
        )
      : say(
          "Choose a matching local place or coordinates in the location selector.",
          "Location selector mein jagah chuno ya coordinates daalo.",
          "स्थान चयन में कोई जगह चुनें या निर्देशांक दर्ज करें।",
        );
    if (selected) {
      result.context = emptyGeo();
      result.finish = async (tx) => {
        await repository.setLocationInTurn(tx, userId, selected);
        return {
          content: result.content,
          metadata: {
            ...metadata,
            tools: [...metadata.tools, "update_user_location"],
          },
        };
      };
    }
    return result;
  }
  const action = updateAction(message);
  const duration = timeLimit(message);
  const desired = queryCategories(message);
  const wantsPlan =
    /\b(?:plan|itinerary|outing|schedule|between meetings|day trip)\b/i.test(
      message,
    ) ||
    (!!duration && (desired.length > 0 || shopping.changes.length > 0));
  const mentionedLocation =
    /\b(?:i am|i['’]m) (?:in|at|near) ([^.!?,;]+?)(?=[.!?,;]|\s+and\s|$)/i.exec(
      message,
    )?.[1];
  const planLocation =
    wantsPlan && mentionedLocation
      ? namedLocation(mentionedLocation)
      : undefined;
  if (action && trip && !(action === "shorten" && planLocation)) {
    const command = replanInput.parse({
      version: trip.version,
      action,
      remainingMinutes: duration,
    });
    result.finish = async (tx) => {
      const next = await replanTrip(tx, userId, trip.id, command);
      const output = toolTrip(next, metadata, "replan_trip");
      return {
        content: [...text, tripReply(next, language)].join("\n"),
        metadata: output,
        context: { ...context, places: output.places, routes: [], focus: null },
      };
    };
  } else if (action && action !== "shorten") {
    text.push(
      say(
        "Create an outing before updating its stops.",
        "Stops badalne se pehle ek outing plan karo.",
        "पड़ाव बदलने से पहले एक भ्रमण की योजना बनाएं।",
      ),
    );
  } else if (
    /\b(?:current|active|my|today.s) (?:itinerary|plan|outing)\b/i.test(
      message,
    ) &&
    !/\b(?:create|make|plan a|new)\b/i.test(message)
  ) {
    text.push(
      trip
        ? tripReply(trip, language)
        : say(
            "You don’t have an active outing.",
            "Abhi koi outing plan active nahi hai.",
            "अभी कोई भ्रमण योजना सक्रिय नहीं है।",
          ),
    );
    if (trip) result.metadata = toolTrip(trip, metadata, "get_active_trip");
  } else if (
    wantsPlan &&
    (planLocation || session.location) &&
    (!mentionedLocation || planLocation)
  ) {
    const start = startMinute(message);
    const availableMinutes = duration ?? preferences.availableMinutes;
    const mode = /\b(?:drive|driving|by car)\b/i.test(message)
      ? "driving"
      : /\b(?:cycling|bike)\b/i.test(message)
        ? "cycling"
        : /\b(?:walk|walking)\b/i.test(message)
          ? "walking"
          : preferences.mode;
    const meal = /\bbreakfast\b/i.test(message)
      ? "breakfast"
      : /\blunch\b/i.test(message)
        ? "lunch"
        : /\bdinner\b/i.test(message)
          ? "dinner"
          : "none";
    const budget = /(?:₹|\b(?:rs\.?|inr)\s*)([\d,]+)\b/i.exec(message);
    const constraints = planInput.parse({
      requestId,
      sessionId: session.id,
      constraints: {
        ...preferences,
        mode,
        availableMinutes,
        startMinute: start,
        endMinute: Math.min(1440, start + availableMinutes),
        interests: [...new Set([...preferences.interests, ...desired])],
        meal,
        ...(budget
          ? {
              budgetINR: Math.min(
                1000000,
                Number(budget[1].replaceAll(",", "")),
              ),
            }
          : {}),
        mealPreference: /vegetarian/i.test(message) ? "vegetarian" : "",
      },
    });
    result.finish = async (tx) => {
      if (planLocation) {
        await repository.setLocationInTurn(tx, userId, planLocation);
        metadata.tools.push("update_user_location");
      }
      const next = await createTrip(tx, userId, constraints, [
        ...list.values(),
      ]);
      const output = toolTrip(next, metadata, "create_trip_plan");
      return {
        content: [...text, tripReply(next, language)].join("\n"),
        metadata: output,
        context: {
          ...(planLocation ? emptyGeo() : context),
          places: output.places,
          routes: [],
          focus: null,
        },
      };
    };
  } else if (wantsPlan) {
    text.push(
      say(
        "Set a location to plan the outing.",
        "Outing plan karne ke liye location set karo.",
        "भ्रमण की योजना बनाने के लिए स्थान चुनें।",
      ),
    );
  } else if (action === "shorten") {
    text.push(
      say(
        "Create an outing before updating its available time.",
        "Time badalne se pehle ek outing plan karo.",
        "समय बदलने से पहले एक भ्रमण की योजना बनाएं।",
      ),
    );
  } else if (
    /\bprepare (?:context|recommendations|next location)\b/i.test(message)
  ) {
    if (!session.location)
      text.push(
        say(
          "Set a location to prepare nearby suggestions.",
          "Aas-paas ki jagah suggest karne ke liye location set karo.",
          "आस-पास के सुझाव तैयार करने के लिए स्थान चुनें।",
        ),
      );
    else {
      metadata.tools.push("prepare_next_location_context");
      result.finish = async (tx) => {
        const job = await queuePreparation(tx, userId);
        return {
          content: job
            ? say(
                "Preparation is queued for your current outing.",
                "Current outing ke liye suggestions taiyar ho rahe hain.",
                "मौजूदा भ्रमण के लिए सुझाव तैयार हो रहे हैं।",
              )
            : say(
                "Prepared context is already available.",
                "Suggestions pehle se taiyar hain.",
                "सुझाव पहले से तैयार हैं।",
              ),
        };
      };
    }
  } else if (
    /\b(?:prefetch|prepared context|what.s next|suggestions)\b/i.test(message)
  ) {
    const { prepared } = await getPreparation(userId);
    if (prepared) recordMetric("preparation_used_in_chat");
    const next = prepared?.nextStop;
    const option = prepared?.recommendations[0]?.name;
    const pending = say(
      "No prepared suggestion is ready yet.",
      "Abhi koi suggestion taiyar nahi hai.",
      "अभी कोई सुझाव तैयार नहीं है।",
    );
    text.push(
      (language === "en" ? prepared?.suggestion : undefined) ??
        (next
          ? say(
              `Next stop: ${next}`,
              `Agla stop ${next} hai.`,
              `अगला पड़ाव ${next} है।`,
            )
          : option
            ? say(
                `Nearby suggestion: ${option}`,
                `Aas-paas ${option} dekh sakte ho.`,
                `आस-पास ${option} देख सकते हैं।`,
              )
            : pending),
    );
    metadata.tools.push("get_prefetched_context");
  } else {
    const { selected, named, ordinal } = placeReference(message, context);
    const roadRoute = asksRoute(message);
    const nearbyInHindi =
      /\b(?:aas[ -]?paas|nazdeek|paas m(?:e|ein)|ghu+mn[ea] ki jagah|kya dekh)\b|आस[ -]?पास|नज़दीक|नजदीक|घूमने की जगह|क्या देखें/i.test(
        message,
      );
    const broadNearby =
      nearbyInHindi ||
      /^(?:what(?:['’]s| is) (?:around|near) (?:me|here)|what(?:['’]s| is) nearby|what(?:['’]s| is) around here|show (?:me )?(?:what(?:['’]s| is) )?nearby|what is there to see)[.!?\s]*$/i.test(
        message,
      );
    const asksNearby =
      broadNearby ||
      desired.length > 0 ||
      /\b(?:nearby|near (?:me|here|there)|around (?:me|here|there)|recommend|find|discover)\b/i.test(
        message,
      );
    if (asksDistance(message) || roadRoute) {
      if (!session.location)
        text.push(
          say(
            "Set your starting location and tell me where you want to go.",
            "Apni starting location set karo aur batao kahan jana hai.",
            "अपना शुरुआती स्थान चुनें और बताएं कि कहाँ जाना है।",
          ),
        );
      else if (selected?.latitude == null || selected.longitude == null)
        text.push(
          say(
            "Where do you want to go? Tell me the place name or refer to a result above.",
            "Kahan jana hai? Jagah ka naam batao ya upar diye gaye options mein se ek chuno.",
            "आप कहाँ जाना चाहते हैं? जगह का नाम बताएं या ऊपर दिए गए विकल्पों में से एक चुनें।",
          ),
        );
      else {
        const meters = Math.round(
          distance(session.location, {
            latitude: selected.latitude,
            longitude: selected.longitude,
          }),
        );
        const value = meters >= 1000 ? Math.round(meters / 100) / 10 : meters;
        const units =
          meters >= 1000 ? say("km", "km", "किमी") : say("m", "m", "मीटर");
        const name = selected.name;
        const measurement = "**" + value + " " + units + "**";
        text.push(
          say(
            `${name} is about ${measurement} away in a straight line.`,
            `Yahan se ${name} seedhi line mein lagbhag ${measurement} door hai.`,
            `यहाँ से ${name} की सीधी दूरी लगभग ${measurement} है।`,
          ),
        );
        if (roadRoute) {
          const mode = /\b(?:walk|on foot|paidal|pedal)\b|पैदल/i.test(message)
            ? "walking"
            : /\b(?:bike|cycle|cycling)\b|साइकिल/i.test(message)
              ? "cycling"
              : /\b(?:car|drive|driving|gaa?di)\b|गाड़ी/i.test(message)
                ? "driving"
                : preferences.mode;
          const minutes = travelEstimate(meters, mode);
          const travel = {
            walking: say("walking", "paidal", "पैदल"),
            cycling: say("cycling", "cycle se", "साइकिल से"),
            driving: say("driving", "gaadi se", "गाड़ी से"),
          }[mode];
          text.push(
            say(
              `Estimated ${travel} time is about ${minutes} min. A verified street route is unavailable.`,
              `${travel} jaane mein kareeb ${minutes} min lag sakte hain. Sadak ka verified route abhi available nahi hai.`,
              `${travel} जाने में करीब ${minutes} मिनट लग सकते हैं। सड़क का सत्यापित रास्ता उपलब्ध नहीं है।`,
            ),
          );
        } else
          text.push(
            say(
              "Road distance may differ.",
              "Sadak se distance alag ho sakta hai.",
              "सड़क से दूरी अलग हो सकती है।",
            ),
          );
        metadata.places = [selected];
        metadata.sources = selected.sources;
        metadata.tools.push("estimate_distance");
        context.focus = selected;
        context.routes = [];
      }
    } else if (
      /\b(?:tell me (?:more )?about|tell me more|describe|history|historical facts|what makes|what(?:['’]s| is) special about|what am i looking at|why was it built|who (?:built|made)|when was)\b/i.test(
        message,
      ) ||
      (!!named &&
        /\b(?:what (?:is|was)|information|details|famous for)\b/i.test(
          message,
        )) ||
      /\b(?:what(?:['’]s| is) (?:this|that) (?:place|building|monument)|(?:ke )?baare (?:mein|me)|itihas|itihaas|kisne banaya)\b|के बारे में|इतिहास|किसने बनाय/i.test(
        message,
      ) ||
      (ordinal && !asksNearby)
    ) {
      const place = selected ?? session.location;
      if (place) {
        const record = catalogMatch(place);
        const sourceSummary = record?.summary || place.summary;
        const summary =
          language === "en" ? sourceSummary : record?.translations?.[language];
        text.push(
          summary ||
            (sourceSummary
              ? say(
                  "",
                  `${place.name} ki details source link par milengi.`,
                  `${place.name} का विवरण नीचे दिए गए स्रोत में है।`,
                )
              : say(
                  `${place.name}. The local catalog has no sourced description for this place.`,
                  `${place.name} ke baare mein local catalog mein verified details nahi hain.`,
                  `स्थानीय सूची में ${place.name} का सत्यापित विवरण उपलब्ध नहीं है।`,
                )),
        );
        metadata.places = [place];
        metadata.sources = [
          ...new Map(
            [...(record?.sources ?? []), ...place.sources].map((source) => [
              source.url,
              source,
            ]),
          ).values(),
        ];
        metadata.tools.push("get_place_details");
        metadata.suggestion = say(
          "What else can I visit nearby?",
          "Aas-paas aur kya dekh sakte hain?",
          "आस-पास और क्या देख सकते हैं?",
        );
        context.focus = place;
      } else
        text.push(
          say(
            "Choose a place to open the local guide.",
            "Guide ke liye ek jagah chuno.",
            "गाइड खोलने के लिए कोई जगह चुनें।",
          ),
        );
    } else if (asksNearby && !shopping.changes.length && !session.location) {
      text.push(
        say(
          "Set your location so I can find places around you.",
          "Location set karo, phir main aas-paas ki jagah bata sakta hoon.",
          "अपना स्थान चुनें, ताकि मैं आस-पास की जगहें बता सकूँ।",
        ),
      );
    } else if (session.location && asksNearby && !shopping.changes.length) {
      const anchor =
        (/\b(?:around there|near there|near that place)\b|उस जगह के पास|\bus jagah ke (?:aas[ -]?)?paas\b/i.test(
          message,
        ) ||
          (nearbyInHindi && named)) &&
        selected?.latitude != null &&
        selected.longitude != null
          ? { latitude: selected.latitude, longitude: selected.longitude }
          : session.location;
      const found = discover(
        anchor,
        {
          ...preferences,
          availableMinutes: duration ?? preferences.availableMinutes,
        },
        nearbyInput.parse({
          query: desired.length || broadNearby ? "" : message.slice(0, 160),
          categories: desired,
          explore: broadNearby || /hidden|lesser|novel/i.test(message),
        }),
        localPlaces(),
        await seenPlaces(db, userId),
      );
      metadata.tools.push(
        "search_nearby_places",
        "calculate_search_radius",
        "rank_recommendations",
      );
      metadata.places = found.places;
      metadata.sources = found.places
        .flatMap((p) => p.sources)
        .filter((s, i, a) => a.findIndex((v) => v.url === s.url) === i);
      context.places = found.places;
      context.focus = found.places.length === 1 ? found.places[0] : null;
      context.known = [
        ...new Map(
          [...context.known, ...found.places].map((p) => [p.place_id, p]),
        ).values(),
      ].slice(-40);
      text.push(
        found.places.length
          ? [
              say(
                `I found these places within ${Math.round(found.radius)} m in the local catalog.`,
                `Local catalog mein ${Math.round(found.radius)} m ke andar ye jagah mili:`,
                `स्थानीय सूची में ${Math.round(found.radius)} मीटर के अंदर ये जगहें मिलीं:`,
              ),
              ...found.places.map(
                (p) =>
                  `- **${p.name}** · ` +
                  say(
                    `${p.category} · ${p.distanceMeters} m straight-line · ${p.reason}`,
                    `${p.category} · seedhi line mein ${p.distanceMeters} m`,
                    `सीधी दूरी ${p.distanceMeters} मीटर`,
                  ),
              ),
              say(
                "Shop stock, opening hours and travel routes are unverified.",
                "Shop stock, opening hours aur raste verify nahi hue hain.",
                "दुकान का स्टॉक, खुलने का समय और रास्ते सत्यापित नहीं हैं।",
              ),
            ].join("\n")
          : say(
              `No places in the available catalog match that search within ${Math.round(found.radius)} m.`,
              `${Math.round(found.radius)} m ke andar local catalog mein koi matching jagah nahi mili.`,
              `${Math.round(found.radius)} मीटर के अंदर स्थानीय सूची में कोई मेल नहीं मिला।`,
            ),
      );
      if (found.places.length)
        metadata.suggestion = say(
          "Tell me about the first place.",
          "Pehli jagah ke baare mein batao.",
          "पहली जगह के बारे में बताएं।",
        );
      if (found.places.length)
        result.finish = async (tx) => {
          await tx.recommendationEvent.createMany({
            data: found.places.map((p) => ({
              userId,
              placeId: p.place_id,
              action: "shown",
            })),
          });
          return { content: result.content };
        };
    }
  }
  if (
    /\b(?:pending|checklist|shopping list|my items|my list|still need|left to buy|what (?:do )?(?:i|we) need to buy|meri list|kya (?:kharidna|khareedna) (?:hai|h|baaki))\b|मेरी (?:लिस्ट|सूची)|क्या खरीदना बाकी/i.test(
      message,
    )
  ) {
    const pending = [...list.values()].filter((i) => i.status === "pending");
    metadata.tools.push("get_items");
    const remaining = pending
      .map((i) => i.name + (i.quantity > 1 ? " × " + i.quantity : ""))
      .join(", ");
    text.push(
      remaining
        ? say(
            `Pending: ${remaining}.`,
            `Kharidna baaki hai: ${remaining}.`,
            `खरीदना बाकी है: ${remaining}।`,
          )
        : say(
            "Nothing is pending on your checklist.",
            "Checklist mein ab kuch kharidna baaki nahi hai.",
            "आपकी सूची में अब कुछ खरीदना बाकी नहीं है।",
          ),
    );
  }
  if (!text.length && !result.finish) {
    const greeting = /^(?:hi|hello|hey|namaste|नमस्ते)[.!?\s।]*$/i.test(message);
    const hello = greeting ? say("Hi! ", "Namaste! ", "नमस्ते! ") : "";
    if (
      /^(?:thanks|thank you|thank you so much|shukriya|dhanyavaad|dhanyavad|शुक्रिया|धन्यवाद)[.!?\s।]*$/i.test(
        message,
      )
    ) {
      text.push(say("You’re welcome.", "Koi baat nahi!", "आपका स्वागत है।"));
    } else if (session.mode === "my_items") {
      text.push(
        hello +
          say(
            "Which item would you like to add or update? I can also show what’s still pending.",
            "Kaunsa item add ya update karna hai? Main bata sakta hoon kya kharidna baaki hai.",
            "कौन-सा सामान जोड़ना या बदलना चाहते हैं? मैं बता सकता हूँ कि क्या खरीदना बाकी है।",
          ),
      );
      metadata.suggestion = say(
        "What is still pending?",
        "Kya kharidna baaki hai?",
        "क्या खरीदना बाकी है?",
      );
    } else if (!session.location) {
      text.push(
        hello +
          say(
            "Where are you exploring? Select a place or enter coordinates to start.",
            "Kahan ghoom rahe ho? Shuru karne ke liye jagah chuno ya coordinates daalo.",
            "आप कहाँ घूम रहे हैं? शुरू करने के लिए जगह चुनें या निर्देशांक दर्ज करें।",
          ),
      );
    } else {
      text.push(
        greeting
          ? hello +
              say(
                `What would you like to explore around ${session.location.name}?`,
                `${session.location.name} ke aas-paas kya dekhna chahoge?`,
                `${session.location.name} के आस-पास क्या देखना चाहेंगे?`,
              )
          : say(
              "Are you asking about the selected place, looking for nearby options, or planning an outing?",
              "Is jagah ke baare mein jaanna hai, aas-paas ki jagah dekhni hain, ya outing plan karni hai?",
              "क्या आप इस जगह की जानकारी, आस-पास के विकल्प या घूमने की योजना चाहते हैं?",
            ),
      );
      metadata.suggestion =
        session.mode === "on_site_guide"
          ? say(
              "Tell me about this place.",
              "Is jagah ke baare mein batao.",
              "इस जगह के बारे में बताएं।",
            )
          : say("What’s around me?", "Aas-paas kya hai?", "आस-पास क्या है?");
    }
  }
  result.content = text.join("\n");
  return result;
}
