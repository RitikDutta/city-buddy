import { z } from "zod";

export const modes = ["my_items", "live_talk", "on_site_guide"] as const;
export const modeSchema = z.enum(modes);
export type Mode = z.infer<typeof modeSchema>;
export const modeInfo = {
  my_items: {
    name: "My Items",
    path: "/items",
    description: "Manage your checklist and find nearby stores.",
  },
  live_talk: {
    name: "Live Talk",
    path: "/talk",
    description: "Ask CityBuddy anything about your selected city.",
  },
  on_site_guide: {
    name: "On-Site Guide",
    path: "/guide",
    description: "Discover history, landmarks, and nearby experiences.",
  },
} as const;

export const sourceSchema = z.object({ title: z.string(), url: z.httpUrl() });
export type Source = z.infer<typeof sourceSchema>;
export const placeSchema = z.object({
  place_id: z.string().min(1),
  name: z.string().min(1),
  formatted_address: z.string().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  maps_url: z.httpUrl().optional(),
  directions_url: z.httpUrl().optional(),
  summary: z.string().optional(),
  sources: z.array(sourceSchema),
});
export type Place = z.infer<typeof placeSchema>;
export const locationSchema = placeSchema.extend({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: z.literal("manual"),
});
export type Location = z.infer<typeof locationSchema>;
export type RouteResult = {
  distance_meters?: number;
  duration_seconds?: number;
  mode: string;
  navigation_url?: string;
  encoded_polyline?: string;
  sources: Source[];
};
export type MapResult = {
  places: Place[];
  routes: RouteResult[];
  summary: string;
  sources: Source[];
  resolved: { id: string; label?: string }[];
  save_url?: string;
};
export type GeoContext = {
  places: Place[];
  known: Place[];
  focus: Place | null;
  routes: RouteResult[];
  summary: string;
  sources: Source[];
};
export const emptyGeo = (): GeoContext => ({
  places: [],
  known: [],
  focus: null,
  routes: [],
  summary: "",
  sources: [],
});

export const itemFields = z.object({
  name: z.string().trim().min(1).max(160),
  quantity: z.number().int().min(1).max(9999),
  notes: z.string().trim().max(1200),
  status: z.enum(["pending", "purchased"]),
});
export const createItemSchema = itemFields
  .partial()
  .required({ name: true })
  .strict();
export const updateItemSchema = itemFields
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Include an item field to update.",
  );
export type ItemValues = z.infer<typeof itemFields>;
export type Item = ItemValues & {
  id: string;
  created_at: string;
  updated_at: string;
};
export type MessageMeta = {
  history_excerpt?: string;
  suggestion?: string;
  tools: string[];
  places: Place[];
  routes: RouteResult[];
  sources: Source[];
  save_url?: string;
};
export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata: MessageMeta | null;
};
export type SessionSummary = {
  id: string;
  mode: Mode;
  status: "active" | "ended";
  location: Location | null;
  updated_at: string;
  title: string;
  message_count: number;
};
export type Session = SessionSummary & {
  context: GeoContext;
  messages: Message[];
};
export type Workspace = {
  user_id: string;
  location: Location | null;
  items: Item[];
  sessions: SessionSummary[];
  configured: { gemini: boolean; maps: boolean; browserMap: boolean };
};
export const incomingSchema = z
  .object({
    user_id: z.uuid(),
    session_id: z.uuid(),
    mode: modeSchema,
    message: z.string().trim().min(1).max(4000),
    location: z
      .object({
        name: z.string().max(600),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        source: z.literal("manual"),
        place_id: z.string().optional(),
      })
      .passthrough()
      .nullable(),
    request_id: z.uuid().optional(),
  })
  .strict();
export type Incoming = z.infer<typeof incomingSchema>;
