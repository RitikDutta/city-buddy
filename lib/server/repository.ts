import { createHash, randomBytes } from "node:crypto";
import {
  Prisma,
  type ChatMessage,
  type ChatSession,
  type ShoppingItem,
} from "@prisma/client";
import { db } from "./db";
import { AppError, conflict, notFound } from "./errors";
import {
  emptyGeo,
  type GeoContext,
  type Item,
  type ItemValues,
  type Location,
  type Message,
  type MessageMeta,
  type Mode,
  type Session,
  type SessionSummary,
} from "../contracts";

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function itemView(row: ShoppingItem): Item {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    notes: row.notes,
    status: row.status as Item["status"],
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
type SessionRow = ChatSession & {
  messages: Pick<ChatMessage, "content">[];
  _count: { messages: number };
};
function summary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    mode: row.mode as Mode,
    status: row.status as Session["status"],
    location: row.selectedLocation as Location | null,
    updated_at: row.updatedAt.toISOString(),
    title: row.messages[0]?.content ?? "",
    message_count: row._count.messages,
  };
}
const summaryInclude = {
  messages: {
    take: 1,
    orderBy: { id: "asc" as const },
    select: { content: true },
  },
  _count: { select: { messages: true } },
};

export type ItemChange = { before?: Item; after?: Item };
type TurnResult = {
  content: string;
  metadata: MessageMeta;
  context: GeoContext;
  changes: ItemChange[];
  end?: boolean;
};

export const repository = {
  async identity(cookie?: string) {
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      const user = await db.user.findUnique({
        where: { identityHash: hash(cookie) },
      });
      if (user) return { user, token: null };
    }
    const token = randomBytes(32).toString("hex");
    const user = await db.user.create({ data: { identityHash: hash(token) } });
    return { user, token };
  },
  async listItems(userId: string) {
    return (
      await db.shoppingItem.findMany({
        where: { userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).map(itemView);
  },
  async addItem(
    userId: string,
    values: Partial<ItemValues> & { name: string },
  ) {
    return itemView(
      await db.shoppingItem.create({ data: { ...values, userId } }),
    );
  },
  async editItem(userId: string, id: string, values: Partial<ItemValues>) {
    return db.$transaction(async (tx) => {
      const changed = await tx.shoppingItem.updateMany({
        where: { id, userId },
        data: values,
      });
      if (!changed.count) throw notFound();
      return itemView(
        await tx.shoppingItem.findFirstOrThrow({ where: { id, userId } }),
      );
    });
  },
  async removeItem(userId: string, id: string) {
    if (!(await db.shoppingItem.deleteMany({ where: { id, userId } })).count)
      throw notFound();
  },
  async rememberChoices(userId: string, choices: Location[]) {
    await db.user.update({
      where: { id: userId },
      data: {
        locationCandidates: json({
          choices,
          expires: Date.now() + 15 * 60_000,
        }),
      },
    });
  },
  async selectLocation(userId: string, placeId: string) {
    return db.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const candidates = user.locationCandidates as {
        choices: Location[];
        expires: number;
      } | null;
      const selected = candidates?.choices.find((x) => x.place_id === placeId);
      if (!selected || !candidates || candidates.expires < Date.now()) {
        if ((user.selectedLocation as Location | null)?.place_id === placeId)
          return user.selectedLocation as Location;
        throw new AppError(
          400,
          "Search for this location again and choose a current match.",
          "invalid_choice",
        );
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          selectedLocation: json(selected),
          locationCandidates: Prisma.DbNull,
        },
      });
      if ((user.selectedLocation as Location | null)?.place_id !== placeId) {
        await tx.chatSession.updateMany({
          where: { userId, status: "active" },
          data: {
            selectedLocation: json(selected),
            context: json(emptyGeo()),
            turnToken: null,
            turnExpiresAt: null,
          },
        });
      }
      return selected;
    });
  },
  async sessions(userId: string) {
    return (
      await db.chatSession.findMany({
        where: { userId },
        include: summaryInclude,
        orderBy: { updatedAt: "desc" },
      })
    ).map(summary);
  },
  async session(userId: string, id: string): Promise<Session> {
    const row = await db.chatSession.findFirst({
      where: { id, userId },
      include: {
        messages: { orderBy: { id: "asc" } },
        _count: { select: { messages: true } },
      },
    });
    if (!row) throw notFound();
    return {
      ...summary(row),
      context: (row.context as GeoContext | null) ?? emptyGeo(),
      messages: row.messages.map((m) => ({
        id: m.id,
        role: m.role as Message["role"],
        content: m.content,
        metadata: m.relevantToolMetadata as MessageMeta | null,
        created_at: m.createdAt.toISOString(),
      })),
    };
  },
  async openSession(userId: string, mode: Mode) {
    const active = { userId, mode, status: "active" };
    let row;
    try {
      row = await db.$transaction(async (tx) => {
        const existing = await tx.chatSession.findFirst({ where: active });
        if (existing) return existing;
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        return tx.chatSession.create({
          data: {
            ...active,
            selectedLocation: user.selectedLocation ?? Prisma.DbNull,
            context: json(emptyGeo()),
          },
        });
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      )
        throw err;
      row = await db.chatSession.findFirstOrThrow({ where: active });
    }
    return this.session(userId, row.id);
  },
  async endSession(userId: string, id: string) {
    if (
      !(
        await db.chatSession.updateMany({
          where: { id, userId },
          data: { status: "ended", turnToken: null, turnExpiresAt: null },
        })
      ).count
    )
      throw notFound();
    return this.session(userId, id);
  },
  async completed(userId: string, id: string, requestId: string) {
    return !!(await db.chatMessage.findFirst({
      where: {
        sessionId: id,
        requestId,
        role: "assistant",
        session: { userId },
      },
      select: { id: true },
    }));
  },
  async acquire(userId: string, id: string, token: string) {
    const result = await db.chatSession.updateMany({
      where: {
        id,
        userId,
        status: "active",
        OR: [{ turnToken: null }, { turnExpiresAt: { lt: new Date() } }],
      },
      data: { turnToken: token, turnExpiresAt: new Date(Date.now() + 180_000) },
    });
    if (!result.count)
      throw conflict(
        "This conversation is busy or has ended. Refresh it before sending another message.",
      );
  },
  async release(userId: string, id: string, token: string) {
    await db.chatSession.updateMany({
      where: { id, userId, turnToken: token },
      data: { turnToken: null, turnExpiresAt: null },
    });
  },
  async commitTurn(
    userId: string,
    id: string,
    token: string,
    requestId: string,
    message: string,
    result: TurnResult,
  ) {
    await db.$transaction(async (tx) => {
      const lock = await tx.chatSession.updateMany({
        where: { id, userId, turnToken: token, status: "active" },
        data: {
          context: json(result.context),
          status: result.end ? "ended" : "active",
          turnToken: null,
          turnExpiresAt: null,
        },
      });
      if (!lock.count)
        throw conflict(
          "Your location or conversation changed. Send your message again with the current location.",
        );
      for (const { before, after } of result.changes) {
        if (!before && after) {
          await tx.shoppingItem.create({
            data: {
              id: after.id,
              userId,
              name: after.name,
              quantity: after.quantity,
              notes: after.notes,
              status: after.status,
            },
          });
        } else if (before) {
          const where = {
            id: before.id,
            userId,
            updatedAt: new Date(before.updated_at),
          };
          const changed = after
            ? await tx.shoppingItem.updateMany({
                where,
                data: {
                  name: after.name,
                  quantity: after.quantity,
                  notes: after.notes,
                  status: after.status,
                },
              })
            : await tx.shoppingItem.deleteMany({ where });
          if (!changed.count)
            throw conflict(
              "Your checklist changed during this reply. Please try again.",
            );
        }
      }
      await tx.chatMessage.create({
        data: { sessionId: id, requestId, role: "user", content: message },
      });
      await tx.chatMessage.create({
        data: {
          sessionId: id,
          requestId,
          role: "assistant",
          content: result.content,
          relevantToolMetadata: json(result.metadata),
        },
      });
    });
  },
};
