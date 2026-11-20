import { TalkPage } from "@/components/talk";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  return (
    <TalkPage mode="on_site_guide" sessionId={(await searchParams).session} />
  );
}
