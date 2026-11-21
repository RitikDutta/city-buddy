import { z } from "zod";
import type { Location, Place } from "./contracts";

export const modesOfTravel = ["walking", "cycling", "driving"] as const;
export const travelMode = z.enum(modesOfTravel);
export const categories = [
  "attraction",
  "museum",
  "park",
  "meal",
  "cafe",
  "electronics",
  "footwear",
  "grocery",
  "household",
  "market",
] as const;
export const category = z.enum(categories);
export type Category = z.infer<typeof category>;
export type TravelMode = z.infer<typeof travelMode>;

export const preferencesSchema = z
  .object({
    mode: travelMode.default("walking"),
    maxDistanceMeters: z.number().int().min(250).max(30000).default(4500),
    availableMinutes: z.number().int().min(10).max(840).default(180),
    interests: z.array(category).max(categories.length).default([]),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaults = preferencesSchema.parse({});
export const coordinates = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export const simulatedLocation = coordinates
  .extend({
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export const nearbyInput = z
  .object({
    query: z.string().trim().max(160).default(""),
    categories: z.array(category).max(categories.length).default([]),
    limit: z.number().int().min(1).max(30).default(8),
    radius: z.number().int().min(100).max(30000).optional(),
    explore: z.boolean().default(false),
  })
  .strict();
export type NearbyInput = z.infer<typeof nearbyInput>;
export type Candidate = Place & {
  latitude: number;
  longitude: number;
  category: Category;
  distanceMeters: number;
  travelMinutes: number;
  reason: string;
  score: number;
};
export type Nearby = {
  places: Candidate[];
  radius: number;
  radii: number[];
  candidateCount: number;
  distanceBasis: "straight_line";
};

const minute = z.number().int().min(0).max(1440);
export const tripConstraintsSchema = z
  .object({
    startMinute: minute,
    endMinute: minute,
    availableMinutes: z.number().int().min(10).max(840),
    mode: travelMode,
    maxDistanceMeters: z.number().int().min(250).max(30000),
    interests: z.array(category).max(categories.length),
    mandatoryIds: z.array(z.string().min(1).max(180)).max(10).default([]),
    optionalIds: z.array(z.string().min(1).max(180)).max(15).default([]),
    includeShopping: z.boolean().default(true),
    meal: z.enum(["none", "breakfast", "lunch", "dinner"]).default("none"),
    mealPreference: z.string().trim().max(80).default(""),
    budgetINR: z.number().nonnegative().max(1000000).optional(),
  })
  .strict()
  .refine(
    (c) => c.startMinute < c.endMinute && c.startMinute < 1440,
    "The outing must end after it starts on the same day.",
  );
export const planInput = z
  .object({
    requestId: z.uuid(),
    sessionId: z.uuid().optional(),
    constraints: tripConstraintsSchema,
  })
  .strict();
export const replanInput = z
  .object({
    version: z.number().int().min(1),
    action: z.enum([
      "skip_next",
      "visit_next",
      "lunch_first",
      "shorten",
      "remove_shopping",
      "refresh",
      "skip_stop",
      "visit_stop",
    ]),
    stopId: z.uuid().optional(),
    remainingMinutes: z.number().int().min(10).max(840).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "shorten" && !value.remainingMinutes)
      ctx.addIssue({
        code: "custom",
        path: ["remainingMinutes"],
        message: "Enter the remaining time.",
      });
    if (
      (value.action === "skip_stop" || value.action === "visit_stop") &&
      !value.stopId
    )
      ctx.addIssue({
        code: "custom",
        path: ["stopId"],
        message: "Choose a stop.",
      });
  });
export type TripConstraints = z.infer<typeof tripConstraintsSchema>;
export type PlanInput = z.infer<typeof planInput>;
export type ReplanInput = z.infer<typeof replanInput>;
export type StopKind = "sightseeing" | "shopping" | "meal" | "break";
export type StopDraft = {
  place: Place | null;
  kind: StopKind;
  label: string;
  mandatory: boolean;
  itemIds: string[];
  visitMinutes: number;
  arrivalMinute: number;
  travelMinutes: number;
  travelMeters: number;
};
export type Stop = StopDraft & {
  id: string;
  position: number;
  status: "pending" | "visited" | "skipped";
};
export type TripView = {
  id: string;
  version: number;
  status: string;
  origin: Location;
  constraints: TripConstraints;
  stops: Stop[];
  notes: string[];
  feasible: boolean;
};
export type Prepared = {
  at: string;
  nextStop: string | null;
  overview?: string;
  recommendations: Candidate[];
  suggestion?: string;
  radius: number;
  candidateCount: number;
  pendingShopping: number;
  recommendationAnchor?: string;
};
export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";
