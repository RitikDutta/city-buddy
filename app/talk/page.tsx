import { TalkPage } from "@/components/talk";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  return <TalkPage mode="live_talk" sessionId={(await searchParams).session} />;
}
