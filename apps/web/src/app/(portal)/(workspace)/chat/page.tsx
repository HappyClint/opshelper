import { ChatApp } from "@/components/chat/chat-app";
import { getChatModels } from "@/lib/api";

export default async function ChatPage() {
  const directory = process.env.OPENCODE_WORKING_DIR ?? "/workspace";
  const chatModels = await getChatModels().catch(() => ({
    models: [],
    defaultModel: "",
  }));

  return (
    <ChatApp
      directory={directory}
      defaultModel={chatModels.defaultModel}
      models={chatModels.models}
    />
  );
}
