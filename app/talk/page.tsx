import { ChatRoom } from "@/components/talk";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  return <ChatRoom mode="live_talk" sessionId={(await searchParams).session} />;
}
