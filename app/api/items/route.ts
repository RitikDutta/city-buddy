import { type NextRequest, NextResponse } from "next/server";
import { createItemSchema } from "@/lib/contracts";
import { body, withUser } from "@/lib/server/http";
import { repository } from "@/lib/server/repository";

export function GET(req: NextRequest) {
  return withUser(req, async (user) => ({
    items: await repository.listItems(user.id),
  }));
}
export function POST(req: NextRequest) {
  return withUser(req, async (user) =>
    NextResponse.json(
      {
        item: await repository.addItem(
          user.id,
          await body(req, createItemSchema),
        ),
      },
      { status: 201 },
    ),
  );
}
