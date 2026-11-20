"use client";
import { createContext, useContext } from "react";
import type { Workspace } from "@/lib/contracts";

export const WorkspaceContext = createContext<{
  data: Workspace | null;
  refresh: () => Promise<void>;
  changeLocation: () => void;
  connections: () => void;
}>({
  data: null,
  refresh: async () => {},
  changeLocation: () => {},
  connections: () => {},
});
export const useWorkspace = () => useContext(WorkspaceContext);
