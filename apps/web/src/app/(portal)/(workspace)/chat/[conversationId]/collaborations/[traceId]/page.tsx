import { CollaborationView } from "@/components/chat/collaboration-view";

export default async function CollaborationPage({
  params,
}: {
  params: Promise<{ conversationId: string; traceId: string }>;
}) {
  const { conversationId, traceId } = await params;
  return <CollaborationView key={`${conversationId}:${traceId}`} conversationId={conversationId} traceId={traceId} />;
}
