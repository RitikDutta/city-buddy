import type { GeoContext, Place } from "../../contracts";
import { localCatalog } from "./catalog";
import { normalize } from "./geo";

export function asksDistance(message: string) {
  return /\b(?:how far|(?:what(?:['’]s| is)|tell me) the distance|kit+t?n[aei] (?:door|dur|distance)|kit+t[aei] (?:door|dur)|(?:doori|duri|distance) kit+t?n[aei])\b|कितन[ाीे]\s*दूर|दूरी\s*कितनी/i.test(
    message,
  );
}

export function asksRoute(message: string) {
  return (
    /\b(?:how (?:do|can) (?:i|we) get|how long (?:is|to|get|would|does|will)|directions|can (?:i|we) walk|(?:street|road|driving|walking) (?:route|distance)|kit+t?n[aei] (?:time|samay)|kit+t[aei] time|kaise (?:ja(?:a|au|un|na|ye|yega)|pahu[nm]?ch(?:u|e|na)))\b|कैसे (?:जाएँ|जाएं|जाऊँ|जाना|पहुँचें|पहुंचें)|रास्ता बत|कितना समय|सड़क से|पैदल कितन/i.test(
      message,
    ) ||
    (asksDistance(message) &&
      /\b(?:by (?:road|car|bike|bus|train)|on foot|paidal|pedal|gaadi se|car se|road se)\b/i.test(
        message,
      ))
  );
}

const ordinalGroups = [
  /\b(?:first|pehl[ai]|pahl[ai])\b|पहल[ाीे]/i,
  /\b(?:second|doosr[ai]|dusr[ai])\b|दूसर[ाीे]/i,
  /\b(?:third|teesr[ai]|tisr[ai])\b|तीसर[ाीे]/i,
  /\b(?:fourth|chauth[ai])\b|चौथ[ाीे]/i,
  /\b(?:fifth|paanchv[ai]|panchv[ai])\b|पाँचव[ाीे]/i,
];

export function placeReference(message: string, context: GeoContext) {
  const normalized = " " + normalize(message) + " ";
  const rows = localCatalog.entries();
  function bestMatch(places: (Place & { aliases?: string[] })[]) {
    let match: Place | undefined;
    let length = 0;
    for (const place of places) {
      const names = [
        place.name,
        place.name.split(",")[0],
        ...(place.aliases ?? []),
      ];
      for (const candidate of names) {
        const name = normalize(candidate);
        if (
          name.length < 3 ||
          name.length <= length ||
          !normalized.includes(" " + name + " ")
        )
          continue;
        match = place;
        length = name.length;
      }
    }
    return match;
  }
  const remembered = [
    ...context.places,
    ...context.known,
    ...(context.focus ? [context.focus] : []),
  ];
  const match = bestMatch([...remembered, ...rows]);
  const named =
    match &&
    (remembered.find(
      (place) =>
        normalize(place.name.split(",")[0]) ===
        normalize(match.name.split(",")[0]),
    ) ??
      match);
  const index = ordinalGroups.findIndex((pattern) => pattern.test(message));
  const referenced = index >= 0 ? context.places[index] : undefined;
  const selected = named ?? referenced;
  if (selected || index >= 0) return { selected, named, ordinal: index >= 0 };
  // An unrelated place name must not silently reuse the last focused place.
  const implicit =
    /\b(?:it|there|that (?:place|one)|this (?:place|one)|waha?n?|us (?:jagah|place)|is jagah)\b|वहाँ|वहां|उस जगह|इस जगह|यह जगह/u.test(
      message,
    ) ||
    /^(?:how far|how long|kitn[aei] (?:door|dur)|कितन[ाीे] दूर)(?:[\s?.!।]+(?:hai|h|है))?[\s?.!।]*$/i.test(
      message.trim(),
    );
  return {
    selected: implicit ? (context.focus ?? undefined) : undefined,
    named,
    ordinal: false,
  };
}
