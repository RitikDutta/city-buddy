import { ItemsPage } from "@/components/items";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  return <ItemsPage sessionId={(await searchParams).session} />;
}
