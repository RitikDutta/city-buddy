import { ChatRoom } from "@/components/talk";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  return (
    <ChatRoom mode="on_site_guide" sessionId={(await searchParams).session} />
  );
}
